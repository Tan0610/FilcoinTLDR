/**
 * FilRunway decision-log reader.
 *
 *   npm run decisions                 # summary + the 20 most recent decisions
 *   npm run decisions -- --mode all   # MOCK and LIVE together, each labelled
 *   npm run decisions -- --limit 100  # more of them
 *   npm run decisions -- --executed   # only decisions that moved money
 *   npm run decisions -- --id <id>    # one decision in full: reading, rule,
 *                                     # reasoning, outcome, tx hash
 *   npm run decisions -- --json       # the raw records, for jq
 *   npm run decisions -- --split      # copy MOCK records out of the LIVE file
 *
 * WHY IT EXISTS
 * -------------
 * A top-up made by the agent and a top-up made by `npm run bootstrap -- fund 5`
 * are byte-identical on chain. The only thing that distinguishes them is the
 * decision that preceded the agent's: the reading it was taken from, the rule
 * that fired, the reasoning, and the tx hash it produced. This prints that
 * record, so "the agent did this, not the operator" can be checked rather than
 * asserted — line up the hash below with the same transaction on the explorer.
 *
 * MODE
 * ----
 * That argument only holds for a LIVE record. A MOCK decision is a real record
 * of a real decision, but its transaction hash was invented by the mock adapter
 * and is on no chain anywhere. So:
 *
 *   - every listed row carries its mode;
 *   - the scope defaults to the mode this project is configured for
 *     (`FILRUNWAY_MODE`), and the summary says how many records the scope is
 *     hiding and how to see them — never a silent omission;
 *   - "transactions the agent authored" lists LIVE records ONLY, whatever the
 *     scope. Simulated hashes get their own section, under their own heading,
 *     marked as not being onchain.
 *
 * VERIFICATION
 * ------------
 * The mode stamp is this project's own bookkeeping, and bookkeeping can be
 * wrong: `data/decisions.jsonl` still carries eleven MOCK records at its head,
 * written into the LIVE path before the two modes had separate files, five of
 * them holding hashes the mock adapter invented. Scoping keeps them out of the
 * evidence section — but a filter we wrote is a weaker guarantee than an answer
 * from the chain.
 *
 * So every hash this tool is about to present as evidence is looked up first
 * with `eth_getTransactionByHash` and labelled with what came back. A hash that
 * is not confirmed is never printed as proof.
 *
 * A NULL ANSWER IS NOT A DENIAL. Filecoin keeps the Ethereum-hash -> message
 * mapping for about three days and the public Calibration endpoint is not
 * archival, so this project's own genuine top-up stops resolving once it ages
 * out — measured, not assumed; see `src/lib/txVerify.ts`. An unresolved hash is
 * therefore reported as unconfirmed rather than as fake, EXCEPT where the
 * record is young enough that the node would still hold the mapping, which is
 * the one case that is a real accusation and the one case that exits non-zero.
 *
 * `--no-verify` skips the lookup and says on screen that it did. Uses
 * `FILECOIN_RPC_URL` (point it at an archival node for older records) or the
 * public Calibration node; still no key.
 *
 * Reads the journal files the server writes — `FILRUNWAY_DECISION_LOG` when
 * set, otherwise `data/decisions.jsonl` (LIVE) and `data/decisions.mock.jsonl`
 * (MOCK) — and needs no key, no RPC and no running server. Both are read
 * whatever mode this process is in, so a record is never unreachable.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { EPOCHS_PER_DAY, isUnboundedEpochs } from "../src/lib/constants";
import { explorerTxUrl } from "../src/lib/explorer";
import { blobPrefix, readBlobJournal } from "../src/lib/blobJournal";
import {
  JOURNAL_VERSION,
  journalMode,
  journalPathFor,
  journalPaths,
  readJournalFiles,
  totalsFor,
  type JournalEntry,
  type JournalRecord,
} from "../src/lib/journal";
import {
  evidenceEntries,
  parseModeArg,
  scopeFor,
  scopeNotice,
  simulatedEntries,
  type ModeArg,
} from "../src/lib/journalReport";
import {
  ETH_TX_INDEX_LIFETIME_DAYS,
  explorerTxHash,
  hashRewritten,
  isDenied,
  verdictLabel,
  verifyRpcUrl,
  verifyTxHash,
  verifyTxHashes,
  type TxCheck,
} from "../src/lib/txVerify";
import type { AgentMode, Decision } from "../src/lib/types";

/** `.env.local` wins over `.env`, matching Next.js. Node 20.6+ has loadEnvFile. */
function loadEnv(): void {
  for (const file of [".env.local", ".env"]) {
    const path = resolve(process.cwd(), file);
    if (!existsSync(path)) continue;
    try {
      process.loadEnvFile(path);
    } catch {
      // A malformed env file is not fatal here; the default path still works.
    }
  }
}

/** ANSI escape, built rather than embedded so no control byte lives in source. */
const ESC = String.fromCharCode(27);
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const RED = `${ESC}[31m`;

const OUTCOME_COLOR: Record<string, string> = {
  EXECUTED: GREEN,
  PENDING: YELLOW,
  FAILED: RED,
  NO_ACTION: DIM,
};

/** MOCK borrows the dashboard's hazard yellow; LIVE the same green as EXECUTED. */
const MODE_COLOR: Record<AgentMode, string> = { MOCK: YELLOW, LIVE: GREEN };

function heading(text: string): void {
  console.log(`\n${BOLD}${text}${RESET}\n${DIM}${"-".repeat(text.length)}${RESET}`);
}

function row(label: string, value: string): void {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

function when(at: number): string {
  return new Date(at).toISOString().replace("T", " ").slice(0, 19);
}

function days(decision: Decision): string {
  if (isUnboundedEpochs(decision.snapshot.epochsRemaining)) return "unbounded";
  return `${(decision.snapshot.epochsRemaining / EPOCHS_PER_DAY).toFixed(2)}d`;
}

function modeTag(mode: AgentMode): string {
  return `${MODE_COLOR[mode]}${mode}${RESET}`;
}

/**
 * One line per decision, widest fields last so the table stays readable.
 *
 * The mode column is always present, at every scope. A row that does not say
 * which mode it came from is the defect this file exists to fix, and a column
 * that appears only sometimes trains a reader to stop looking for it.
 */
function line(entry: JournalEntry): string {
  const { decision } = entry;
  const colour = OUTCOME_COLOR[decision.outcome] ?? "";
  const tx = decision.txHash ? decision.txHash.slice(0, 18) + "…" : "—";
  return (
    `  ${DIM}${when(decision.at)}${RESET} ` +
    `${modeTag(entry.mode)} ` +
    `${decision.action.padEnd(18)} ` +
    `${colour}${decision.outcome.padEnd(9)}${RESET} ` +
    `${days(decision).padStart(11)}  ${tx}`
  );
}

/** Everything about one decision, which is the evidentiary view. */
async function detail(entry: JournalEntry, verify: boolean): Promise<void> {
  const { decision } = entry;
  heading(`decision ${decision.id}`);
  row("mode", modeTag(entry.mode));
  if (entry.mode === "MOCK") {
    console.log(
      `\n  ${YELLOW}${BOLD}SIMULATED — MOCK ADAPTER.${RESET} ${YELLOW}No funds moved and the ` +
        `hash below is\n  not onchain. This record is not evidence of agent authorship.${RESET}`,
    );
  }
  row("taken at", `${when(decision.at)} UTC`);
  row("action", decision.action);
  row("outcome", `${OUTCOME_COLOR[decision.outcome] ?? ""}${decision.outcome}${RESET}`);
  row("rule fired", decision.ruleFired ? `${decision.ruleFired.label} (${decision.ruleFired.id})` : "—");
  row("top-up amount", decision.ruleFired ? `${decision.ruleFired.topUpAmount} USDFC` : "—");
  if (decision.txHash) {
    row(entry.mode === "MOCK" ? "tx hash (simulated)" : "tx hash", decision.txHash);
    if (entry.mode === "LIVE") {
      // This view is what a judge is pointed at by name, so the claim it makes
      // is checked here rather than asserted from the record. A MOCK hash is
      // not looked up: it was invented locally and the banner above already
      // says so.
      let check: TxCheck | undefined;
      if (verify) {
        check = await verifyTxHash(decision.txHash);
        const accusation = isDenied(check, decision.at);
        const color = check.verdict === "CONFIRMED" ? GREEN : accusation ? RED : YELLOW;
        row("onchain", `${color}${verdictLabel(check, decision.at)}${RESET}`);
        if (accusation) process.exitCode = 1;
      } else {
        row("onchain", `${YELLOW}not re-checked (--no-verify)${RESET}`);
      }
      // The link uses whatever hash the CHAIN filed this transaction under,
      // which is usually the recorded one and occasionally is not. The row
      // above still shows the journal's hash unchanged — that is the string
      // being attested to. See `explorerTxHash()` in src/lib/txVerify.ts.
      row("explorer", explorerTxUrl(explorerTxHash(decision.txHash, check)));
      if (hashRewritten(decision.txHash, check)) {
        row("onchain hash", check!.onchainHash!);
        row(
          "",
          `${DIM}The chain indexes this message under that hash rather than the
` +
            `${" ".repeat(22)}recorded one. Both resolve to one message; a node accepts
` +
            `${" ".repeat(22)}either, an explorer only the canonical one.${RESET}`,
        );
      }
    }
  }
  if (decision.error) row("error", `${RED}${decision.error}${RESET}`);

  heading("reading the decision was taken from");
  row("epoch", String(decision.snapshot.epoch));
  row("funds available", `${decision.snapshot.fundsAvailable} USDFC`);
  row("lockup rate", `${decision.snapshot.lockupRate} USDFC/epoch`);
  row("lockup current", `${decision.snapshot.lockupCurrent} USDFC`);
  row("runway", `${days(decision)} (${decision.snapshot.epochsRemaining} epochs)`);
  row("wallet", `${decision.snapshot.walletUsdfc} USDFC / ${decision.snapshot.walletFil} FIL`);

  heading("reasoning");
  console.log(`  ${decision.reasoning}`);
  console.log();
}

const USAGE = `
FilRunway decision log reader.

  npm run decisions                  summary + the most recent decisions
  npm run decisions -- --mode all    MOCK and LIVE together, each labelled
  npm run decisions -- --mode mock   simulated decisions only
  npm run decisions -- --limit 100   show more
  npm run decisions -- --executed    only decisions that moved money
  npm run decisions -- --id <id>     one decision in full (searches every mode)
  npm run decisions -- --json        raw {mode, decision} records
  npm run decisions -- --remote      read the DEPLOYED agent's journal out of
                                     Vercel Blob instead of the local files
  npm run decisions -- --split       copy MOCK records out of the LIVE journal
                                     into the MOCK one (add --write to apply)
  npm run decisions -- --no-verify   skip the onchain re-check (offline)

--mode defaults to FILRUNWAY_MODE. Whatever the scope, "transactions the agent
authored" lists LIVE records only: a MOCK hash was invented by the mock adapter
and is on no chain.

Every hash in that section is re-checked against the chain with
eth_getTransactionByHash before it is printed, and labelled with what came
back. A hash this tool cannot resolve is never presented as proof.

Note that a null answer is not a denial: Filecoin keeps the Ethereum tx-hash
index for about three days and the public endpoint is not archival, so an older
transaction stops resolving while remaining on chain. Those read as UNCONFIRMED.
Only a record young enough that the node would still hold the mapping is
reported as NOT ON CHAIN, and only that exits non-zero. Set FILECOIN_RPC_URL to
an archival node to confirm older records; no key is used.

Reads FILRUNWAY_DECISION_LOG when set, otherwise data/decisions.jsonl (LIVE)
and data/decisions.mock.jsonl (MOCK). No key required.

--remote reads the deployed agent's journal out of Vercel Blob instead. It needs
BLOB_READ_WRITE_TOKEN in .env.local (\`vercel env pull .env.local\`), and still
needs no private key and no running server.
`;

/** The value that follows a flag, or undefined when the flag is absent. */
function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

/**
 * Copy the MOCK records sitting in the LIVE journal file into the MOCK one.
 *
 * Explicit, opt-in, and additive. The source file is opened read-only and never
 * written: it holds the agent's real onchain record and is append-only
 * evidence. Records already present in the target are skipped, so running this
 * twice is a no-op rather than a duplication.
 */
function split(apply: boolean): number {
  const source = journalPathFor("LIVE");
  const target = journalPathFor("MOCK");

  if (source === null || target === null) {
    console.error("\nDecision persistence is off (FILRUNWAY_DECISION_LOG=off).\n");
    return 1;
  }
  if (source === target) {
    console.error(
      `\nBoth modes are configured to use the same file (${source}), so there is nothing` +
        "\nto split into. Unset FILRUNWAY_DECISION_LOG to get the per-mode defaults.\n",
    );
    return 1;
  }

  let sourceText: string;
  try {
    sourceText = readFileSync(source, "utf8");
  } catch {
    console.log(`\n${DIM}No LIVE journal at ${source}; nothing to split.${RESET}\n`);
    return 0;
  }

  const existing = new Set(readJournalFiles([target], null).entries.map((e) => e.decision.id));
  let targetLines = 0;
  try {
    targetLines = readFileSync(target, "utf8").split("\n").filter((l) => l.trim() !== "").length;
  } catch {
    // No target file yet: the sequence starts at 1.
  }

  const copied: string[] = [];
  let alreadyThere = 0;
  const at = Date.now();

  for (const raw of sourceText.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    let record: JournalRecord;
    try {
      record = JSON.parse(trimmed) as JournalRecord;
    } catch {
      continue;
    }
    if (record.mode === "LIVE" || typeof record.decision?.id !== "string") continue;
    if (existing.has(record.decision.id)) {
      alreadyThere += 1;
      continue;
    }
    copied.push(
      JSON.stringify({
        ...record,
        v: JOURNAL_VERSION,
        // Renumber into the target's own sequence; the decision is untouched.
        seq: targetLines + copied.length + 1,
        importedFrom: source,
        importedAt: at,
      } satisfies JournalRecord),
    );
  }

  heading("split MOCK records out of the LIVE journal");
  row("source (read only)", source);
  row("target", target);
  row("mock lines to copy", String(copied.length));
  if (alreadyThere > 0) row("already in target", `${alreadyThere} ${DIM}(skipped)${RESET}`);

  if (copied.length === 0) {
    console.log(`\n  ${DIM}Nothing to do.${RESET}\n`);
    return 0;
  }
  if (!apply) {
    console.log(
      `\n  ${DIM}Dry run. Nothing was written. Re-run with --split --write to apply.${RESET}` +
        `\n  ${DIM}${source} is never modified.${RESET}\n`,
    );
    return 0;
  }

  try {
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, `${copied.join("\n")}\n`, "utf8");
  } catch (error) {
    console.error(`\n${RED}Could not write ${target}: ${String(error)}${RESET}\n`);
    return 1;
  }
  console.log(
    `\n  ${GREEN}Copied ${copied.length} MOCK record${copied.length === 1 ? "" : "s"}.${RESET}` +
      `\n  ${DIM}${source} was not modified.${RESET}\n`,
  );
  return 0;
}

async function main(): Promise<void> {
  loadEnv();

  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }

  if (args.includes("--split")) {
    process.exitCode = split(args.includes("--write"));
    return;
  }

  const configured = journalMode();
  const parsed = parseModeArg(flagValue(args, "--mode"), configured);
  if (parsed.scope === undefined) {
    console.error(`\n${parsed.error}\n`);
    process.exitCode = 1;
    return;
  }
  const arg: ModeArg = parsed.scope;

  // `--remote` reads the DEPLOYED agent's journal out of Vercel Blob instead of
  // the local files. Same parser, same records, same mode scoping — the only
  // difference is where the bytes came from. It needs BLOB_READ_WRITE_TOKEN,
  // which `vercel env pull .env.local` writes and `loadEnv()` has already read;
  // it still needs no private key and no running server.
  const remote = args.includes("--remote");

  const paths = remote ? [`blob:${blobPrefix()}/`] : journalPaths();
  if (paths.length === 0) {
    console.error(
      "\nDecision persistence is off (FILRUNWAY_DECISION_LOG=off), so there is no log to read.\n",
    );
    process.exitCode = 1;
    return;
  }

  // Everything, always, unscoped: the scope decides what is SHOWN, not what is
  // opened, so `--mode mock` still finds MOCK records living in the LIVE file
  // and `--id` can find any record at all.
  const all = remote ? await readBlobJournal(null) : readJournalFiles(paths, null);
  for (const failure of all.errors) {
    console.error(`${YELLOW}Could not read ${failure.path}: ${failure.error}${RESET}`);
  }
  if (all.read === 0 && all.skipped === 0) {
    console.log(`\n${DIM}No decisions recorded yet at ${paths.join(" or ")}.${RESET}`);
    console.log(
      remote
        ? `${DIM}Deploy, let the cron job tick, then read again.${RESET}\n`
        : `${DIM}Start the server (npm run dev) and let the agent tick.${RESET}\n`,
    );
    return;
  }

  const wantedId = flagValue(args, "--id");
  if (args.includes("--id") && wantedId) {
    // Searched across every mode: an id that exists must never read as absent
    // just because the current scope excludes it. The detail view says which.
    const found = all.entries.find(
      (e) => e.decision.id === wantedId || e.decision.id.startsWith(wantedId),
    );
    if (!found) {
      console.error(`\nNo decision with id ${wantedId} in ${paths.join(" or ")}\n`);
      process.exitCode = 1;
      return;
    }
    await detail(found, !args.includes("--no-verify"));
    return;
  }

  const scope = scopeFor(arg);
  const inScope = scope === null ? all.entries : all.entries.filter((e) => e.mode === scope);
  const totals = totalsFor(inScope.map((e) => e.decision));

  let shown = inScope;
  if (args.includes("--executed")) {
    shown = shown.filter((e) => e.decision.outcome === "EXECUTED");
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(shown, null, 2));
    return;
  }

  const limitArg = Number(flagValue(args, "--limit"));
  const limit = args.includes("--limit") && Number.isFinite(limitArg) ? limitArg : 20;
  const notice = scopeNotice(all.byMode, arg);

  heading("decision log");
  for (const [index, path] of all.files.entries()) {
    row(index === 0 ? "file" : "", path);
  }
  row(
    "showing",
    arg === "ALL" ? `${modeTag("LIVE")} + ${modeTag("MOCK")}` : `${modeTag(arg)} records only`,
  );
  row("decisions", String(totals.decisions));
  row("executed", String(totals.executed));
  row(
    "deposited",
    arg === "MOCK"
      ? `${YELLOW}${totals.depositedUsdfc} USDFC (simulated)${RESET}`
      : `${totals.depositedUsdfc} USDFC`,
  );
  row(
    "covering",
    totals.firstAt === null
      ? "—"
      : `${when(totals.firstAt)} .. ${when(totals.lastAt ?? totals.firstAt)} UTC`,
  );
  if (notice.hiddenMode) {
    // Never a silent omission: say what is out of scope and how to see it.
    row(
      "not shown",
      `${notice.hidden} ${modeTag(notice.hiddenMode)} decision${notice.hidden === 1 ? "" : "s"} ` +
        `${DIM}(${notice.hint})${RESET}`,
    );
  }
  if (all.skipped > 0) {
    row("unreadable lines", `${YELLOW}${all.skipped}${RESET} (skipped)`);
  }

  if (arg === "MOCK") {
    console.log(
      `\n  ${YELLOW}${BOLD}SIMULATED — MOCK ADAPTER.${RESET} ${YELLOW}Nothing below moved real ` +
        `funds, and no\n  hash below is onchain.${RESET}`,
    );
  }

  heading(`most recent ${Math.min(limit, shown.length)} of ${shown.length}`);
  console.log(
    `  ${DIM}${"taken at".padEnd(19)} ${"mode".padEnd(4)} ${"action".padEnd(18)} ` +
      `${"outcome".padEnd(9)} ${"runway".padStart(11)}  tx${RESET}`,
  );
  for (const entry of shown.slice(0, limit)) console.log(line(entry));

  /* ---- evidence: LIVE only, whatever the scope ---- */

  // `evidenceEntries` is handed the WHOLE file and drops everything that is not
  // a LIVE record with a hash. The scope narrows the listing above; it can
  // never widen this section, and nothing can put a simulated hash in it.
  const evidence = evidenceEntries(all.entries);
  const shownTx = evidence.slice(0, 10);

  // Ask the chain before printing. A LIVE stamp is our own bookkeeping; only
  // `eth_getTransactionByHash` can turn it into evidence, and a hash that does
  // not come back gets said so out loud rather than dropped. See
  // `src/lib/txVerify.ts` for why the failure case is its own third answer.
  const verifying = !args.includes("--no-verify") && arg !== "MOCK" && shownTx.length > 0;
  let checks = new Map<string, TxCheck>();
  if (verifying) {
    checks = await verifyTxHashes(shownTx.map(({ decision }) => decision.txHash!));
  }

  heading(
    evidence.length > shownTx.length
      ? `transactions the agent authored (LIVE, onchain — most recent ${shownTx.length} of ${evidence.length})`
      : "transactions the agent authored (LIVE, onchain)",
  );

  if (arg === "MOCK") {
    // Out of scope rather than absent, and the difference is stated.
    console.log(
      evidence.length === 0
        ? `  ${DIM}None recorded.${RESET}`
        : `  ${DIM}${evidence.length} recorded, not listed at --mode mock.${RESET}\n` +
            `  ${DIM}npm run decisions -- --mode live${RESET}`,
    );
  } else if (shownTx.length === 0) {
    console.log(`  ${DIM}None recorded. No LIVE decision has produced a transaction.${RESET}`);
  } else {
    if (verifying) {
      console.log(`  ${DIM}re-checked against ${verifyRpcUrl()} just now${RESET}\n`);
    } else {
      console.log(
        `  ${YELLOW}Not re-checked against the chain (--no-verify).${RESET}\n` +
          `  ${DIM}These hashes are this log's own claim, unconfirmed here.${RESET}\n`,
      );
    }

    let denied = 0;
    for (const { decision } of shownTx) {
      const check = checks.get(decision.txHash!);
      // Green only for proof. An unresolved hash is not painted as a failure
      // either: on a non-archival node that is usually the node's limitation,
      // not the record's, and the label says which.
      const accusation = isDenied(check, decision.at);
      if (accusation) denied += 1;
      const color = check?.verdict === "CONFIRMED" ? GREEN : accusation ? RED : YELLOW;
      console.log(`  ${decision.txHash}`);
      if (check) console.log(`  ${color}${verdictLabel(check, decision.at)}${RESET}`);
      console.log(`  ${DIM}${explorerTxUrl(explorerTxHash(decision.txHash!, check))}${RESET}`);
      if (hashRewritten(decision.txHash!, check)) {
        console.log(
          `  ${DIM}chain indexes this as ${check!.onchainHash} — the link uses that${RESET}`,
        );
      }
      console.log(`  ${DIM}decision ${decision.id} · ${when(decision.at)} UTC${RESET}`);
      console.log(`  ${DIM}npm run decisions -- --id ${decision.id}${RESET}\n`);
    }

    // A LIVE record the node actively denies — young enough that it would still
    // hold the mapping — is the one failure this whole mechanism exists to make
    // impossible. It gets stated loudly rather than left as an odd label above.
    if (denied > 0) {
      console.log(
        `  ${RED}${BOLD}${denied} hash${denied === 1 ? "" : "es"} above ` +
          `${denied === 1 ? "is" : "are"} recorded LIVE and denied by the node.${RESET}\n` +
          `  ${RED}${denied === 1 ? "It is" : "They are"} not evidence of anything. Treat the ` +
          `rest of this log as sound\n  only where the label says confirmed.${RESET}\n`,
      );
      process.exitCode = 1;
    }

    // Not a defect, and it must not read as one: the public Calibration node
    // keeps the eth-hash mapping for about three days and serves no archival
    // history, so the project's own genuine evidence stops resolving with age.
    const stale = shownTx.filter(
      ({ decision }) =>
        checks.get(decision.txHash!)?.verdict === "UNRESOLVED" && !isDenied(checks.get(decision.txHash!), decision.at),
    ).length;
    if (stale > 0) {
      console.log(
        `  ${DIM}${stale} hash${stale === 1 ? "" : "es"} above could not be resolved at this ` +
          `node. Filecoin keeps the\n  Ethereum tx-hash index for about ` +
          `${ETH_TX_INDEX_LIFETIME_DAYS} days and this endpoint is not archival, so an\n` +
          `  older transaction stops resolving while remaining on chain. Point\n` +
          `  FILECOIN_RPC_URL at an archival node, or open the explorer link.${RESET}\n`,
      );
    }
  }

  /* ---- simulated hashes: their own section, never the one above ---- */

  if (arg !== "LIVE") {
    const simulated = simulatedEntries(shown);
    if (simulated.length > 0) {
      heading("simulated transaction hashes (MOCK — NOT onchain, not evidence)");
      for (const { decision } of simulated.slice(0, 10)) {
        console.log(`  ${YELLOW}${decision.txHash}${RESET}`);
        console.log(
          `  ${DIM}decision ${decision.id} · ${when(decision.at)} UTC · ` +
            `invented by the mock adapter${RESET}\n`,
        );
      }
    }
  }

  console.log();
}

void main();
