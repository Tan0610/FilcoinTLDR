/**
 * Mode separation in the ops CLI.
 *
 * `npm run decisions` is the artifact a judge is pointed at to check that the
 * AGENT, and not the operator's CLI, authored a transaction on chain. It used
 * to list MOCK and LIVE decisions together with nothing to tell them apart, and
 * its "transactions the agent authored" section printed five hashes the mock
 * adapter had invented beside the one real hash. That is the misrepresentation
 * these tests exist to prevent, so they are deliberately of two kinds:
 *
 *   - unit tests over the pure selection rules in `journalReport.ts`;
 *   - end-to-end runs of the real script against a real fixture file, because
 *     the property that matters ("a simulated hash never appears under that
 *     heading") is a property of the OUTPUT, not of a helper.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { JournalEntry } from "./journal";
import {
  evidenceEntries,
  parseModeArg,
  scopeFor,
  scopeNotice,
  simulatedEntries,
} from "./journalReport";
import type { AgentMode, Decision } from "./types";

/* ---------- fixtures ---------- */

/** The real LIVE record this project's central claim rests on. */
const REAL_DECISION_ID = "1b2d98ef-4984-482f-b394-498ea99b29a6";
const REAL_TX_HASH = "0x06e27a6a7fd532722727953b8d266f14d8109aaaa2c9edc8645bf17a1a2fcf6b";
/** A hash the mock adapter invented. On no chain, anywhere. */
const SIMULATED_TX_HASH = "0x4e32fb1b669d258647ec924a682feae7d9e4419d830f6980866eac527022a2c9";
const MOCK_DECISION_ID = "a9f6693f-ad58-4190-ba89-ebfca52ac77e";

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "dec-1",
    at: 1_756_000_000_000,
    snapshot: {
      takenAt: 1_756_000_000_000,
      epoch: 2_960_000,
      fundsAvailable: "11.33568",
      lockupRate: "0.00041",
      lockupCurrent: "0.84870",
      epochsRemaining: 27_648,
      daysRemaining: 9.6,
      walletUsdfc: "250",
      walletFil: "4.9823",
    },
    ruleFired: {
      id: "topup-7d",
      label: "SCHEDULED TOP-UP < 7d",
      thresholdDays: 7,
      action: "TOP_UP",
      topUpAmount: "5",
    },
    action: "TOP_UP",
    reasoning: "Runway 9.6 days is below the 7-day top-up threshold.",
    outcome: "PENDING",
    ...overrides,
  };
}

function entry(mode: AgentMode, overrides: Partial<Decision> = {}): JournalEntry {
  return { mode, decision: decision(overrides) };
}

function record(mode: AgentMode, seq: number, d: Decision): string {
  return JSON.stringify({ v: 1, seq, writtenAt: 1_756_000_000_000 + seq, mode, decision: d });
}

/**
 * The mixed journal, as `data/decisions.jsonl` actually is: an earlier MOCK
 * session's five simulated 15-USDFC top-ups, and one real 5-USDFC LIVE one.
 */
function mixedJournal(): string {
  const lines = [
    ...[0, 1, 2, 3, 4].map((i) =>
      record(
        "MOCK",
        i + 1,
        decision({
          id: i === 0 ? MOCK_DECISION_ID : `mock-${i}`,
          at: 1_756_000_000_000 + i,
          outcome: "EXECUTED",
          txHash: i === 0 ? SIMULATED_TX_HASH : `0xsimulated${i}`,
          ruleFired: {
            id: "topup-7d",
            label: "SCHEDULED TOP-UP < 2,660d ×380 DEMO",
            thresholdDays: 2660,
            action: "TOP_UP",
            topUpAmount: "15",
          },
        }),
      ),
    ),
    record(
      "LIVE",
      6,
      decision({ id: "live-hold", at: 1_756_000_000_010, outcome: "NO_ACTION", ruleFired: null }),
    ),
    record("LIVE", 7, decision({ id: REAL_DECISION_ID, at: 1_756_000_000_020 })),
    record(
      "LIVE",
      8,
      decision({
        id: REAL_DECISION_ID,
        at: 1_756_000_000_020,
        outcome: "EXECUTED",
        txHash: REAL_TX_HASH,
      }),
    ),
  ];
  return `${lines.join("\n")}\n`;
}

/* ---------- pure selection rules ---------- */

describe("parseModeArg", () => {
  it("defaults to the mode this project is configured for", () => {
    expect(parseModeArg(undefined, "LIVE")).toEqual({ scope: "LIVE" });
    expect(parseModeArg(undefined, "MOCK")).toEqual({ scope: "MOCK" });
  });

  it("accepts the three scopes, case-insensitively", () => {
    expect(parseModeArg("live", "MOCK").scope).toBe("LIVE");
    expect(parseModeArg("MOCK", "LIVE").scope).toBe("MOCK");
    expect(parseModeArg(" All ", "LIVE").scope).toBe("ALL");
  });

  it("rejects a typo instead of silently widening the scope", () => {
    // A typo that fell back to "everything" would put the mixed listing back.
    const parsed = parseModeArg("liev", "LIVE");
    expect(parsed.scope).toBeUndefined();
    expect(parsed.error).toContain("live, mock, all");
  });

  it("maps ALL onto the unscoped journal read", () => {
    expect(scopeFor("ALL")).toBeNull();
    expect(scopeFor("LIVE")).toBe("LIVE");
    expect(scopeFor("MOCK")).toBe("MOCK");
  });
});

describe("evidenceEntries", () => {
  const entries = [
    entry("LIVE", { id: "a", outcome: "EXECUTED", txHash: REAL_TX_HASH }),
    entry("MOCK", { id: "b", outcome: "EXECUTED", txHash: SIMULATED_TX_HASH }),
    entry("LIVE", { id: "c", outcome: "NO_ACTION", txHash: undefined }),
  ];

  it("admits only LIVE records that produced a hash", () => {
    expect(evidenceEntries(entries).map((e) => e.decision.id)).toEqual(["a"]);
  });

  it("excludes MOCK unconditionally, not by the caller's scope", () => {
    // Handed nothing but MOCK, it still yields nothing: there is no argument,
    // default or future refactor that can put a simulated hash in this list.
    const mockOnly = [entry("MOCK", { id: "b", outcome: "EXECUTED", txHash: SIMULATED_TX_HASH })];
    expect(evidenceEntries(mockOnly)).toEqual([]);
  });

  it("collects simulated hashes separately so they are shown, not hidden", () => {
    expect(simulatedEntries(entries).map((e) => e.decision.id)).toEqual(["b"]);
  });
});

describe("scopeNotice", () => {
  it("reports what a scope is hiding, and how to see it", () => {
    const notice = scopeNotice({ MOCK: 6, LIVE: 28 }, "LIVE");
    expect(notice).toEqual({
      shown: 28,
      hidden: 6,
      hiddenMode: "MOCK",
      hint: "npm run decisions -- --mode mock",
    });
  });

  it("distinguishes 'none exist' from 'some are out of scope'", () => {
    const none = scopeNotice({ MOCK: 0, LIVE: 28 }, "LIVE");
    expect(none.hidden).toBe(0);
    expect(none.hiddenMode).toBeNull();
    expect(none.hint).toBeNull();
  });

  it("hides nothing at --mode all", () => {
    expect(scopeNotice({ MOCK: 6, LIVE: 28 }, "ALL")).toMatchObject({ shown: 34, hidden: 0 });
  });
});

/* ---------- the script itself ---------- */

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SCRIPT = join(ROOT, "scripts", "decisions.ts");
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "filrunway-cli-"));
  file = join(dir, "decisions.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Run {
  out: string;
  status: number | null;
}

/**
 * Run the real CLI. `FILRUNWAY_DECISION_LOG` points at the fixture, which also
 * exercises the shared-file case the real project is in — one file, both modes.
 * Env vars set here win: `process.loadEnvFile` does not overwrite them.
 */
function run(args: string[], env: Record<string, string> = {}, cwd = ROOT): Run {
  const result = spawnSync(process.execPath, [TSX, SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, FILRUNWAY_DECISION_LOG: file, ...env },
  });
  return {
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`.replace(ANSI, ""),
    status: result.status,
  };
}

describe("npm run decisions", () => {
  beforeEach(() => {
    writeFileSync(file, mixedJournal(), "utf8");
  });

  it("totals only LIVE spend at --mode live, and says what it is hiding", () => {
    const { out } = run(["--mode", "live"]);

    expect(out).toContain("LIVE records only");
    expect(out).toMatch(/deposited\s+5 USDFC/);
    expect(out).toMatch(/^\s+decisions\s+2\s*$/m);
    expect(out).toMatch(/not shown\s+5 MOCK decisions/);
    expect(out).toContain("--mode mock");
    // Not 80 USDFC across 6 transactions.
    expect(out).not.toContain("80 USDFC");
  }, 60_000);

  it("keeps every simulated hash out of the evidence section", () => {
    const live = run(["--mode", "live"]).out;
    const evidence = live.slice(live.indexOf("transactions the agent authored"));

    expect(evidence).toContain(REAL_TX_HASH);
    expect(evidence).not.toContain(SIMULATED_TX_HASH);
    expect(evidence).not.toContain("0xsimulated");
    // …and the real one is still cited as onchain, with its explorer link.
    expect(evidence).toContain("calibration.filfox.info");
  }, 60_000);

  it("still excludes simulated hashes from that section at --mode all", () => {
    const all = run(["--mode", "all"]).out;
    const evidence = all.slice(
      all.indexOf("transactions the agent authored"),
      all.indexOf("simulated transaction hashes"),
    );

    expect(all).toContain("transactions the agent authored (LIVE, onchain)");
    expect(evidence).toContain(REAL_TX_HASH);
    expect(evidence).not.toContain(SIMULATED_TX_HASH);
    // The simulated ones are shown, under their own heading, marked as such.
    expect(all).toContain("simulated transaction hashes (MOCK — NOT onchain, not evidence)");
    expect(all.slice(all.indexOf("simulated transaction hashes"))).toContain(SIMULATED_TX_HASH);
  }, 60_000);

  it("labels every listed row with its mode", () => {
    const out = run(["--mode", "all"]).out;
    const table = out.slice(out.indexOf("most recent"), out.indexOf("transactions the agent"));

    expect(table).toContain("mode");
    expect(table.split("\n").filter((l) => l.includes("LIVE")).length).toBeGreaterThan(0);
    expect(table.split("\n").filter((l) => l.includes("MOCK")).length).toBe(5);
  }, 60_000);

  it("marks a MOCK scope as simulated and lists no onchain evidence", () => {
    const out = run(["--mode", "mock"]).out;

    expect(out).toContain("MOCK records only");
    expect(out).toContain("SIMULATED — MOCK ADAPTER");
    expect(out).toMatch(/deposited\s+75 USDFC \(simulated\)/);
    expect(out).toMatch(/not shown\s+2 LIVE decisions/);
    // The evidence heading is present but empty of MOCK hashes — a simulated
    // hash must never be reachable through it.
    const evidence = out.slice(
      out.indexOf("transactions the agent authored"),
      out.indexOf("simulated transaction hashes"),
    );
    expect(evidence).not.toContain(SIMULATED_TX_HASH);
    expect(evidence).not.toContain("0xsimulated");
  }, 60_000);

  it("keeps --executed mode-scoped too", () => {
    const out = run(["--mode", "live", "--executed"]).out;
    const table = out.slice(out.indexOf("most recent"), out.indexOf("transactions the agent"));

    expect(table).toContain("EXECUTED");
    expect(table).not.toContain("0xsimulated");
    expect(table).not.toContain(SIMULATED_TX_HASH.slice(0, 18));
  }, 60_000);

  it("finds the real record by id and attributes it to LIVE", () => {
    const out = run(["--id", REAL_DECISION_ID]).out;

    expect(out).toContain(`decision ${REAL_DECISION_ID}`);
    expect(out).toMatch(/^\s+mode\s+LIVE\s*$/m);
    expect(out).toMatch(new RegExp(String.raw`^\s+tx hash\s+${REAL_TX_HASH}\s*$`, "m"));
    expect(out).toContain(`calibration.filfox.info/en/message/${REAL_TX_HASH}`);
    expect(out).toContain("EXECUTED");
    expect(out).not.toContain("SIMULATED");
  }, 60_000);

  it("finds a MOCK record by id too, and says loudly what it is", () => {
    // Searched across every mode: an id that exists must never read as absent.
    const out = run(["--id", MOCK_DECISION_ID], { FILRUNWAY_MODE: "live" }).out;

    expect(out).toMatch(/^\s+mode\s+MOCK\s*$/m);
    expect(out).toContain("SIMULATED — MOCK ADAPTER");
    expect(out).toContain("tx hash (simulated)");
    // No explorer link is offered for a hash that is on no chain.
    expect(out).not.toContain("filfox");
  }, 60_000);

  it("carries the mode in --json", () => {
    const out = run(["--mode", "all", "--json"]).out;
    const parsed = JSON.parse(out) as JournalEntry[];

    expect(parsed).toHaveLength(7);
    expect(parsed.every((e) => e.mode === "LIVE" || e.mode === "MOCK")).toBe(true);
    expect(parsed.find((e) => e.decision.id === REAL_DECISION_ID)?.mode).toBe("LIVE");
  }, 60_000);

  it("rejects an unknown --mode", () => {
    const { out, status } = run(["--mode", "liev"]);
    expect(status).toBe(1);
    expect(out).toContain("Unknown --mode");
  }, 60_000);
});

describe("npm run decisions -- --split", () => {
  it("copies MOCK records out without touching the source", () => {
    // A scratch working directory, so the per-mode default paths are used and
    // the real data/ directory is never involved.
    const live = join(dir, "data", "decisions.jsonl");
    const mock = join(dir, "data", "decisions.mock.jsonl");
    rmSync(join(dir, "data"), { recursive: true, force: true });
    writeFileSync(file, mixedJournal(), "utf8");
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(live, mixedJournal(), "utf8");
    const before = readFileSync(live, "utf8");

    const dry = run(["--split"], { FILRUNWAY_DECISION_LOG: "" }, dir);
    expect(dry.out).toMatch(/mock lines to copy\s+5/);
    expect(dry.out).toContain("Dry run");
    expect(readFileSync(live, "utf8")).toBe(before);

    const applied = run(["--split", "--write"], { FILRUNWAY_DECISION_LOG: "" }, dir);
    expect(applied.out).toContain("Copied 5 MOCK records");
    // The evidentiary file is byte-for-byte unchanged.
    expect(readFileSync(live, "utf8")).toBe(before);

    const copied = readFileSync(mock, "utf8").trim().split("\n");
    expect(copied).toHaveLength(5);
    expect(copied.every((l) => JSON.parse(l).mode === "MOCK")).toBe(true);
    expect(copied.every((l) => JSON.parse(l).importedFrom === live)).toBe(true);
    // The real LIVE record is not among them.
    expect(readFileSync(mock, "utf8")).not.toContain(REAL_TX_HASH);

    // Running it again is a no-op rather than a duplication.
    const again = run(["--split", "--write"], { FILRUNWAY_DECISION_LOG: "" }, dir);
    expect(again.out).toContain("already in target");
    expect(readFileSync(mock, "utf8").trim().split("\n")).toHaveLength(5);
  }, 120_000);
});
