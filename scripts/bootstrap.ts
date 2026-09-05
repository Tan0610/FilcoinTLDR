/**
 * FilRunway bootstrap / ops CLI.
 *
 *   npx tsx scripts/bootstrap.ts status
 *   npx tsx scripts/bootstrap.ts approve
 *   npx tsx scripts/bootstrap.ts fund <amountUsdfc>
 *   npx tsx scripts/bootstrap.ts upload <path>
 *   npx tsx scripts/bootstrap.ts upload --demo [--size=1MiB]
 *   npx tsx scripts/bootstrap.ts datasets
 *
 * or via the npm script: `npm run bootstrap -- status`.
 *
 * `status` is the operator smoke test: it proves the key is valid, the RPC is
 * reachable, the wallet has gas and USDFC, Warm Storage is approved, and the
 * account summary reads. Run it before anything else.
 *
 * This file and `src/lib/chain/synapse.ts` are the ONLY two places that touch
 * FILECOIN_PRIVATE_KEY. It is never printed — only the derived address is.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { SynapseChainAdapter } from "../src/lib/chain/synapse";
import { EPOCHS_PER_DAY, isUnboundedEpochs } from "../src/lib/constants";
import { explorerTxUrl } from "../src/lib/explorer";
import { DEMO_SCALE, suggestDemoScale } from "../src/lib/demo";
import { formatUnits } from "../src/lib/units";

/* ---------- env ---------- */

/** `.env.local` wins over `.env`, matching Next.js. Node 20.6+ has loadEnvFile. */
function loadEnv(): void {
  for (const file of [".env.local", ".env"]) {
    const path = resolve(process.cwd(), file);
    if (!existsSync(path)) continue;
    try {
      process.loadEnvFile(path);
    } catch {
      // A malformed env file should not be fatal; the key check below is louder.
    }
  }
}

/* ---------- formatting ---------- */

/** ANSI escape, built rather than embedded so no control byte lives in source. */
const ESC = String.fromCharCode(27);
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const RED = `${ESC}[31m`;

function heading(text: string): void {
  console.log(`\n${BOLD}${text}${RESET}\n${DIM}${"-".repeat(text.length)}${RESET}`);
}

function row(label: string, value: string): void {
  console.log(`  ${label.padEnd(26)} ${value}`);
}

/** bigint base units -> a padded, readable USDFC/FIL figure. */
function amount(value: bigint, decimals = 6): string {
  const asString = formatUnits(value, 18);
  const n = Number(asString);
  return Number.isFinite(n) ? n.toFixed(decimals) : asString;
}

function bytes(value: bigint): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let n = Number(value);
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function epochsText(epochs: number): string {
  if (isUnboundedEpochs(epochs)) return "unbounded (burn rate is zero)";
  return `${epochs.toLocaleString("en-US")} epochs  =  ${(epochs / EPOCHS_PER_DAY).toFixed(2)} days`;
}

/** Parse "1MiB", "500KiB", "262144". */
function parseSize(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB)?$/i.exec(raw.trim());
  if (!match) throw new Error(`--size: cannot parse ${JSON.stringify(raw)}`);
  const scale: Record<string, number> = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 };
  return Math.floor(Number(match[1]) * scale[(match[2] ?? "B").toLowerCase()]);
}

function txLink(hash: string): string {
  return `${GREEN}${explorerTxUrl(hash)}${RESET}`;
}

/* ---------- commands ---------- */

async function cmdStatus(adapter: SynapseChainAdapter): Promise<void> {
  const report = await adapter.describe();
  const { summary, approval, snapshot } = report;

  heading("IDENTITY");
  row("address", report.address);
  row("chain", `${report.chainName} (${report.chainId})`);
  row("filecoin pay", report.contracts.filecoinPay);
  row("warm storage", report.contracts.warmStorage);
  row("usdfc", report.contracts.usdfc);

  heading("WALLET");
  row("FIL (gas)", `${amount(report.walletFil)} FIL`);
  row("USDFC", `${amount(report.walletUsdfc)} USDFC`);
  if (report.walletFil === 0n) {
    console.log(`  ${RED}no FIL: every transaction will fail. Use the Calibration faucet.${RESET}`);
  }

  heading("FILECOIN PAY ACCOUNT");
  row("epoch", summary.epoch.toString());
  row("funds (total)", `${amount(summary.funds)} USDFC`);
  row("available", `${amount(summary.availableFunds)} USDFC`);
  row("in-contract balance", `${amount(report.contractBalance)} USDFC`);
  row("debt", `${amount(summary.debt)} USDFC`);
  row("total lockup", `${amount(summary.totalLockup)} USDFC`);
  row("  fixed", `${amount(summary.totalFixedLockup)} USDFC`);
  row("  rate-based", `${amount(summary.totalRateBasedLockup)} USDFC`);
  row("burn / epoch", `${amount(summary.lockupRatePerEpoch, 18)} USDFC`);
  row("burn / month", `${amount(summary.lockupRatePerMonth)} USDFC`);

  heading("RUNWAY");
  row("runwayInEpochs (raw)", summary.runwayInEpochs.toString());
  row("runway", epochsText(snapshot.epochsRemaining));
  row("gross coverage", summary.grossCoverageInEpochs.toString());
  if (summary.debt > 0n) {
    console.log(`  ${RED}account is in deficit; runway reads 0 until the debt is settled.${RESET}`);
  }

  heading("WARM STORAGE OPERATOR APPROVAL");
  row("approved", approval.isApproved ? `${GREEN}yes${RESET}` : `${YELLOW}no${RESET}`);
  row("rate allowance", approval.rateAllowance.toString());
  row("rate usage", approval.rateUsage.toString());
  row("lockup allowance", approval.lockupAllowance.toString());
  row("lockup usage", approval.lockupUsage.toString());
  row("max lockup period", `${approval.maxLockupPeriod.toString()} epochs`);
  if (!approval.isApproved) {
    console.log(`  ${YELLOW}run: npm run bootstrap -- approve${RESET}`);
  }

  heading("DEMO TIMESCALE");
  const suggested = suggestDemoScale(snapshot.daysRemaining);
  row("FILRUNWAY_DEMO_SCALE", DEMO_SCALE.toLocaleString("en-US"));
  if (isUnboundedEpochs(snapshot.epochsRemaining)) {
    console.log(
      `  ${DIM}Nothing is being stored yet, so there is no burn rate and no runway to watch.\n` +
        `  Run "upload --demo" to create a real cost stream first.${RESET}`,
    );
  } else if (suggested > DEMO_SCALE) {
    console.log(
      `  ${YELLOW}Runway is ${snapshot.daysRemaining.toFixed(0)} days; the gauge tops out at 14.${RESET}\n` +
        `  ${DIM}Set NEXT_PUBLIC_FILRUNWAY_DEMO_SCALE=${suggested} to scale the POLICY THRESHOLDS\n` +
        `  and gauge graduations by ${suggested}x. Readings stay exactly as printed above.${RESET}`,
    );
  } else {
    console.log(`  ${GREEN}current scale puts the runway inside the gauge range.${RESET}`);
  }

  console.log("");
}

async function cmdApprove(adapter: SynapseChainAdapter): Promise<void> {
  heading("APPROVE WARM STORAGE AS OPERATOR");
  const result = await adapter.ensureApproved();
  if (result.alreadyApproved) {
    console.log(`  ${GREEN}already approved with maximal allowances; nothing to do.${RESET}\n`);
    return;
  }
  console.log(`  submitted: ${txLink(result.txHash!)}`);
  const status = await adapter.waitForTransaction(result.txHash!);
  console.log(`  ${status.status === "CONFIRMED" ? GREEN : RED}${status.status}${RESET}`);
  if (status.error) console.log(`  ${RED}${status.error}${RESET}`);
  console.log("");
}

async function cmdFund(adapter: SynapseChainAdapter, raw: string | undefined): Promise<void> {
  if (!raw) throw new Error("usage: bootstrap fund <amountUsdfc>   e.g. fund 5");
  heading(`DEPOSIT ${raw} USDFC INTO FILECOIN PAY`);
  console.log(
    `  ${DIM}payments.fund() auto-routes: deposit+approve on first run, deposit thereafter.${RESET}`,
  );

  const { txHash } = await adapter.deposit(raw);
  console.log(`  submitted: ${txLink(txHash)}`);

  const status = await adapter.waitForTransaction(txHash);
  console.log(`  ${status.status === "CONFIRMED" ? GREEN : RED}${status.status}${RESET}`);
  if (status.error) console.log(`  ${RED}${status.error}${RESET}`);

  const after = await adapter.getSnapshot();
  row("available now", `${after.fundsAvailable} USDFC`);
  row("runway now", epochsText(after.epochsRemaining));
  console.log("");
}

/** Deterministic, incompressible-enough filler so the piece is a real payload. */
function demoPayload(size: number): Uint8Array {
  const data = new Uint8Array(size);
  const banner = new TextEncoder().encode(
    "FilRunway demo payload — autonomous storage-runway agent, Filecoin Calibration. ",
  );
  for (let i = 0; i < size; i += 1) {
    data[i] = banner[i % banner.length] ^ (i & 0xff);
  }
  return data;
}

async function cmdUpload(adapter: SynapseChainAdapter, args: string[]): Promise<void> {
  const sizeArg = args.find((a) => a.startsWith("--size="));
  const target = args.find((a) => !a.startsWith("--"));

  let name: string;
  let data: Uint8Array;

  if (args.includes("--demo")) {
    const size = sizeArg ? parseSize(sizeArg.slice("--size=".length)) : 1024 * 1024;
    name = `filrunway-demo-${size}b.bin`;
    data = demoPayload(size);
  } else {
    if (!target) throw new Error("usage: bootstrap upload <path> | bootstrap upload --demo");
    const path = resolve(process.cwd(), target);
    if (!existsSync(path)) throw new Error(`no such file: ${path}`);
    name = basename(path);
    data = new Uint8Array(readFileSync(path));
  }

  heading(`UPLOAD ${name} (${bytes(BigInt(data.byteLength))})`);
  console.log(
    `  ${DIM}storage.prepare() covers the new cost stream, then storage.upload() stores 2 copies.${RESET}`,
  );

  const before = await adapter.getSnapshot();
  const item = await adapter.uploadFile(name, data);

  row("pieceCid", item.pieceCid);
  row("dataSetId", item.dataSetId ?? "(pending)");
  row("size", bytes(BigInt(item.sizeBytes)));

  const after = await adapter.getSnapshot();
  heading("COST STREAM");
  row("burn before", `${before.lockupRate} USDFC/epoch`);
  row("burn after", `${after.lockupRate} USDFC/epoch`);
  row("runway", epochsText(after.epochsRemaining));
  console.log("");
}

async function cmdDataSets(adapter: SynapseChainAdapter): Promise<void> {
  heading("DATA SETS");
  const { dataSets, totalSizeBytes, dataSetCount } = await adapter.listDataSets();

  if (dataSets.length === 0) {
    console.log(`  ${YELLOW}none. Run "upload --demo" to create one.${RESET}\n`);
    return;
  }

  for (const set of dataSets) {
    console.log(
      `  #${set.dataSetId.toString().padEnd(6)} pdp=${set.pdpVerifierDataSetId.toString().padEnd(8)} ` +
        `provider=${set.serviceProvider} ` +
        `${set.isLive ? "live" : "dead"} ${set.isManaged ? "managed" : "unmanaged"} ` +
        `${set.hasActivePieces ? "pieces" : "empty"}${set.withCDN ? " cdn" : ""}`,
    );
  }

  heading("TOTALS");
  row("data sets", dataSetCount.toString());
  row("stored", `${bytes(totalSizeBytes)} (${totalSizeBytes.toString()} bytes)`);
  console.log("");
}

/* ---------- entry ---------- */

const USAGE = `
FilRunway ops CLI

  status                     read-only smoke test: identity, balances, runway, approval
  approve                    approve Warm Storage as a Filecoin Pay operator
  fund <amountUsdfc>         deposit USDFC (auto-approves on first run)
  upload <path>              upload a file, creating a real cost stream
  upload --demo [--size=1MiB]  upload generated filler instead
  datasets                   list data sets and total stored size

Requires FILECOIN_PRIVATE_KEY in .env.local (Calibration only, never a mainnet key).
`;

async function main(): Promise<void> {
  loadEnv();

  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }

  const adapter = new SynapseChainAdapter();
  console.log(`${DIM}agent address: ${await adapter.getAddress()}${RESET}`);

  switch (command) {
    case "status":
      await cmdStatus(adapter);
      break;
    case "approve":
      await cmdApprove(adapter);
      break;
    case "fund":
      await cmdFund(adapter, args[0]);
      break;
    case "upload":
      await cmdUpload(adapter, args);
      break;
    case "datasets":
      await cmdDataSets(adapter);
      break;
    default:
      console.error(`unknown command: ${command}`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n${RED}${message}${RESET}\n`);
  process.exitCode = 1;
});
