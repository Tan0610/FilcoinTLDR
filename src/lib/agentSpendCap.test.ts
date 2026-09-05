/**
 * The safety cap, end to end through the agent runner.
 *
 * `spendGuard.test.ts` proves the arithmetic. These prove the agent USES it:
 * that a capped tick submits nothing, that it is recorded as a decision rather
 * than swallowed, that the cap survives a restart because it is counted from
 * the durable journal rather than from process memory, and that a deposit which
 * failed to confirm stops counting against it.
 *
 * Everything runs against a scripted `ChainAdapter`. No network, no key, no
 * timers, no filesystem.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runTick } from "./agent";
import { resetChainAdapter, setChainAdapter, type ChainAdapter } from "./chain";
import { EPOCHS_PER_DAY } from "./constants";
import {
  JOURNAL_VERSION,
  emptyLoad,
  parseJournal,
  type DecisionJournal,
  type JournalLoad,
  type JournalRecord,
  type JournalScope,
} from "./journal";
import {
  MAX_DEPOSITS_ENV,
  MAX_USDFC_ENV,
  SPEND_CAP_ENV,
  WINDOW_MS_ENV,
} from "./spendGuard";
import { resetStore, type AgentStore } from "./store";
import type {
  AgentMode,
  Decision,
  DecisionOutcome,
  PolicyRule,
  RunwaySnapshot,
  StorageListing,
  TxStatus,
} from "./types";

const HOUR = 60 * 60 * 1000;

/** Below the 7-day threshold, so `TOP_UP` (5 USDFC) fires, and affordable. */
function lowSnapshot(days = 5): RunwaySnapshot {
  return {
    takenAt: Date.now(),
    epoch: 2_960_000,
    fundsAvailable: "2.5",
    lockupRate: "0.00041",
    lockupCurrent: "0.84870",
    epochsRemaining: Math.round(days * EPOCHS_PER_DAY),
    daysRemaining: days,
    walletUsdfc: "250",
    walletFil: "4.9823",
  };
}

const EMPTY_STORAGE: StorageListing = {
  takenAt: 0,
  dataSets: [],
  totalSizeBytes: null,
  items: [],
};

const TOP_UP_RULE: PolicyRule = {
  id: "topup-7d",
  label: "SCHEDULED TOP-UP < 7d",
  thresholdDays: 7,
  action: "TOP_UP",
  topUpAmount: "5",
};

interface AdapterOptions {
  mode?: AgentMode;
  confirmation?: { status: TxStatus; error?: string };
}

interface Recorder {
  deposits: string[];
}

function fakeAdapter(recorder: Recorder, opts: AdapterOptions = {}): ChainAdapter {
  const adapter: ChainAdapter = {
    mode: opts.mode ?? "LIVE",
    getAddress: async () => "0xagent",
    getSnapshot: async () => lowSnapshot(),
    deposit: async (amount) => {
      recorder.deposits.push(amount);
      return { txHash: `0x${recorder.deposits.length.toString(16).padStart(64, "0")}` };
    },
    getStoredItems: async () => [],
    listStorage: async () => EMPTY_STORAGE,
    uploadFile: async () => {
      throw new Error("not used");
    },
  };
  if (opts.confirmation) {
    adapter.waitForTransaction = async () => opts.confirmation!;
  }
  return adapter;
}

/* ---------- a journal that records, and can be pre-seeded ---------- */

function executedRecord(id: string, at: number, mode: AgentMode = "LIVE"): string {
  const decision: Decision = {
    id,
    at,
    snapshot: lowSnapshot(),
    ruleFired: TOP_UP_RULE,
    action: "TOP_UP",
    reasoning: "seeded history",
    outcome: "EXECUTED" satisfies DecisionOutcome,
    txHash: `0x${id}`,
  };
  const record: JournalRecord = {
    v: JOURNAL_VERSION,
    seq: 1,
    writtenAt: at,
    mode,
    decision,
  };
  return JSON.stringify(record);
}

class RecordingJournal implements DecisionJournal {
  readonly path = "memory://decisions";
  readonly enabled = true;
  readonly lastError = null;
  readonly synchronous = true;
  readonly appended: Decision[] = [];

  constructor(
    readonly mode: AgentMode,
    private readonly seedLines: string[] = [],
  ) {}

  load(scope: JournalScope = this.mode): JournalLoad {
    if (this.seedLines.length === 0) return emptyLoad(scope);
    return parseJournal(`${this.seedLines.join("\n")}\n`, scope);
  }

  append(decision: Decision): void {
    this.appended.push(decision);
  }
}

let recorder: Recorder;
let store: AgentStore;
const saved: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  recorder = { deposits: [] };
  setEnv(MAX_DEPOSITS_ENV, "2");
  setEnv(MAX_USDFC_ENV, "20");
  setEnv(WINDOW_MS_ENV, String(24 * HOUR));
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete saved[key];
  }
  resetChainAdapter();
});

/** Install a store and adapter, then run one cycle. */
async function tickWith(
  journal: DecisionJournal,
  opts: AdapterOptions = {},
): Promise<Decision> {
  store = resetStore(journal);
  store.loopStarted = true;
  setChainAdapter(fakeAdapter(recorder, opts));
  const { decision } = await runTick();
  return decision;
}

describe("the safety cap in the agent runner", () => {
  it("deposits normally while under the cap", async () => {
    const journal = new RecordingJournal("LIVE");
    const decision = await tickWith(journal);

    expect(decision.action).toBe("TOP_UP");
    expect(decision.outcome).toBe("EXECUTED");
    expect(recorder.deposits).toEqual(["5"]);
  });

  it("declines once the deposit COUNT is reached, and submits nothing", async () => {
    const now = Date.now();
    const journal = new RecordingJournal("LIVE", [
      executedRecord("aaaa", now - 1 * HOUR),
      executedRecord("bbbb", now - 2 * HOUR),
    ]);

    const decision = await tickWith(journal);

    expect(decision.action).toBe("SAFETY_CAP");
    expect(decision.outcome).toBe("NO_ACTION");
    // Nothing reached the chain. This is the whole point.
    expect(recorder.deposits).toEqual([]);
    expect(decision.txHash).toBeUndefined();
  });

  it("records the refusal as a decision, with the rule it declined to act on", async () => {
    const now = Date.now();
    const journal = new RecordingJournal("LIVE", [
      executedRecord("aaaa", now - 1 * HOUR),
      executedRecord("bbbb", now - 2 * HOUR),
    ]);

    const decision = await tickWith(journal);

    // The record has to show what the agent WANTED to do as well as why it
    // did not, or the journal cannot be read as evidence of judgement.
    expect(decision.ruleFired?.id).toBe("topup-7d");
    expect(decision.reasoning).toContain("below the 7-day top-up threshold");
    expect(decision.reasoning).toContain("safety cap");
    expect(decision.reasoning).toContain("No transaction was attempted");

    // And it is durable: it went to the journal like any other decision.
    const journalled = journal.appended.filter((d) => d.id === decision.id);
    expect(journalled.length).toBeGreaterThan(0);
    expect(journalled.at(-1)?.action).toBe("SAFETY_CAP");
  });

  it("declines on the cumulative AMOUNT even when the count allows it", async () => {
    setEnv(MAX_DEPOSITS_ENV, "10");
    setEnv(MAX_USDFC_ENV, "6");
    const journal = new RecordingJournal("LIVE", [
      executedRecord("aaaa", Date.now() - 1 * HOUR),
    ]);

    const decision = await tickWith(journal);

    expect(decision.action).toBe("SAFETY_CAP");
    expect(recorder.deposits).toEqual([]);
  });

  it("counts the window from the durable journal, so a restart does not reset it", async () => {
    // This is the difference between a cap and a suggestion. On a serverless
    // host every tick may run in a fresh process; a cap held only in memory
    // would be reset by each one.
    const now = Date.now();
    const journal = new RecordingJournal("LIVE", [
      executedRecord("aaaa", now - 20 * HOUR),
      executedRecord("bbbb", now - 23 * HOUR),
    ]);

    expect((await tickWith(journal)).action).toBe("SAFETY_CAP");
  });

  it("lets the window roll: deposits older than 24h stop counting", async () => {
    const now = Date.now();
    const journal = new RecordingJournal("LIVE", [
      executedRecord("aaaa", now - 25 * HOUR),
      executedRecord("bbbb", now - 30 * HOUR),
    ]);

    const decision = await tickWith(journal);

    expect(decision.action).toBe("TOP_UP");
    expect(recorder.deposits).toEqual(["5"]);
  });

  it("does not cap MOCK, so the local demo behaves exactly as before", async () => {
    const now = Date.now();
    const journal = new RecordingJournal("MOCK", [
      executedRecord("aaaa", now - 1 * HOUR, "MOCK"),
      executedRecord("bbbb", now - 2 * HOUR, "MOCK"),
      executedRecord("cccc", now - 3 * HOUR, "MOCK"),
    ]);

    const decision = await tickWith(journal, { mode: "MOCK" });

    expect(decision.action).toBe("TOP_UP");
    expect(recorder.deposits).toEqual(["5"]);
  });

  it("can be forced on in MOCK for a rehearsal", async () => {
    setEnv(SPEND_CAP_ENV, "on");
    const now = Date.now();
    const journal = new RecordingJournal("MOCK", [
      executedRecord("aaaa", now - 1 * HOUR, "MOCK"),
      executedRecord("bbbb", now - 2 * HOUR, "MOCK"),
    ]);

    expect((await tickWith(journal, { mode: "MOCK" })).action).toBe("SAFETY_CAP");
  });

  it("stops counting a deposit that failed to confirm", async () => {
    setEnv(MAX_DEPOSITS_ENV, "1");
    const journal = new RecordingJournal("LIVE");

    const first = await tickWith(journal, {
      confirmation: { status: "FAILED", error: "reverted" },
    });
    expect(first.outcome).toBe("FAILED");

    // One deposit was submitted and did not stand. The cap counts EXECUTED
    // decisions, so it must not have been consumed by a transaction that is
    // not in the journal as executed either.
    setChainAdapter(fakeAdapter(recorder));
    const second = await runTick();
    expect(second.decision.action).toBe("TOP_UP");
    expect(second.decision.outcome).toBe("EXECUTED");
    expect(recorder.deposits).toHaveLength(2);
  });

  it("consumes the cap when a deposit DOES stand", async () => {
    setEnv(MAX_DEPOSITS_ENV, "1");
    const journal = new RecordingJournal("LIVE");

    const first = await tickWith(journal);
    expect(first.outcome).toBe("EXECUTED");

    const second = await runTick();
    expect(second.decision.action).toBe("SAFETY_CAP");
    expect(recorder.deposits).toEqual(["5"]);
  });
});
