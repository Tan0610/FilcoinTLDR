/**
 * The operator withdrawal cap, end to end through `squeezeRunway`.
 *
 * `squeezeGuard.test.ts` proves the arithmetic. These prove the endpoint USES
 * it, and prove the one property everything else rests on: a refused squeeze
 * NEVER reaches `withdraw()`. A cap that refuses after the money has moved is
 * not a cap, it is a receipt.
 *
 * They also pin the two design decisions that are easy to lose in a refactor:
 * the window is counted from the DURABLE journal, so it survives the Function
 * instance churn a serverless deployment guarantees; and a squeeze is recorded
 * as an `OperatorSqueeze` record and never as a `Decision`, so an operator
 * action can never end up in the decision feed or the deposits tile.
 *
 * Everything runs against a scripted `ChainAdapter`. No network, no key, no
 * timers, no filesystem.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { squeezeRunway } from "./agent";
import { resetChainAdapter, setChainAdapter, type ChainAdapter } from "./chain";
import { EPOCHS_PER_DAY } from "./constants";
import {
  JOURNAL_VERSION,
  emptyLoad,
  parseJournal,
  type DecisionJournal,
  type JournalLoad,
  type JournalScope,
  type OperatorSqueeze,
  type SqueezeRecord,
} from "./journal";
import {
  MAX_SQUEEZES_ENV,
  MAX_SQUEEZE_USDFC_ENV,
  SQUEEZE_CAP_ENV,
  SQUEEZE_RESERVE_ENV,
  SQUEEZE_WINDOW_MS_ENV,
} from "./squeezeGuard";
import { SQUEEZE_AMOUNT_ENV, SQUEEZE_MAX_ENV } from "./squeeze";
import { resetStore, type AgentStore } from "./store";
import type {
  AgentMode,
  Decision,
  RunwaySnapshot,
  StorageListing,
  TxStatus,
} from "./types";

const HOUR = 60 * 60 * 1000;

/** A comfortable, healthy account: nothing here can be the reason for a refusal. */
function snapshot(fundsAvailable = "40"): RunwaySnapshot {
  return {
    takenAt: Date.now(),
    epoch: 2_960_000,
    fundsAvailable,
    lockupRate: "0.00041",
    lockupCurrent: "0.84870",
    epochsRemaining: Math.round(3_966 * EPOCHS_PER_DAY),
    daysRemaining: 3_966,
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

interface Recorder {
  /** Every amount that actually reached `withdraw()`. The whole point. */
  withdrawals: string[];
}

interface AdapterOptions {
  mode?: AgentMode;
  fundsAvailable?: string;
  confirmation?: { status: TxStatus; error?: string };
  /** Omit `withdraw` entirely, as the mock adapter used to. */
  canWithdraw?: boolean;
  failWithdrawal?: string;
}

function fakeAdapter(recorder: Recorder, opts: AdapterOptions = {}): ChainAdapter {
  const adapter: ChainAdapter = {
    mode: opts.mode ?? "LIVE",
    getAddress: async () => "0xagent",
    getSnapshot: async () => snapshot(opts.fundsAvailable),
    deposit: async () => ({ txHash: `0x${"d".repeat(64)}` }),
    getStoredItems: async () => [],
    listStorage: async () => EMPTY_STORAGE,
    uploadFile: async () => {
      throw new Error("not used");
    },
  };
  if (opts.canWithdraw !== false) {
    adapter.withdraw = async (amount: string) => {
      if (opts.failWithdrawal) throw new Error(opts.failWithdrawal);
      recorder.withdrawals.push(amount);
      return { txHash: `0x${recorder.withdrawals.length.toString(16).padStart(64, "0")}` };
    };
  }
  if (opts.confirmation) {
    adapter.waitForTransaction = async () => opts.confirmation!;
  }
  return adapter;
}

/* ---------- a journal that records, and can be pre-seeded ---------- */

/** One durable operator-withdrawal line, as it appears in the journal file. */
function squeezeLine(
  id: string,
  at: number,
  amountUsdfc = "1",
  mode: AgentMode = "LIVE",
): string {
  const record: SqueezeRecord = {
    v: JOURNAL_VERSION,
    kind: "squeeze",
    seq: 1,
    writtenAt: at,
    mode,
    squeeze: { id, at, amountUsdfc, txHash: `0x${id}` },
  };
  return JSON.stringify(record);
}

class RecordingJournal implements DecisionJournal {
  readonly path = "memory://decisions";
  readonly enabled = true;
  readonly lastError = null;
  readonly synchronous = true;
  readonly appended: Decision[] = [];
  readonly appendedSqueezes: OperatorSqueeze[] = [];

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

  appendSqueeze(squeeze: OperatorSqueeze): void {
    this.appendedSqueezes.push(squeeze);
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
  recorder = { withdrawals: [] };
  setEnv(MAX_SQUEEZES_ENV, "2");
  setEnv(MAX_SQUEEZE_USDFC_ENV, "10");
  setEnv(SQUEEZE_WINDOW_MS_ENV, String(24 * HOUR));
  setEnv(SQUEEZE_RESERVE_ENV, "1");
  setEnv(SQUEEZE_AMOUNT_ENV, "1");
  setEnv(SQUEEZE_MAX_ENV, "5");
  setEnv(SQUEEZE_CAP_ENV, undefined);
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete saved[key];
  }
  resetChainAdapter();
});

/** Install a store and adapter, then ask for one withdrawal. */
function install(journal: DecisionJournal, opts: AdapterOptions = {}): void {
  store = resetStore(journal);
  store.loopStarted = true;
  setChainAdapter(fakeAdapter(recorder, opts));
}

describe("the operator withdrawal cap", () => {
  it("withdraws normally while under the cap", async () => {
    install(new RecordingJournal("LIVE"));

    const outcome = await squeezeRunway("1");

    expect(outcome.ok).toBe(true);
    expect(recorder.withdrawals).toEqual(["1"]);
  });

  it("allows the call that lands exactly ON the limit", async () => {
    // Two is the maximum, and one is already recorded, so this second one must
    // go through. A cap of 2 that only ever permitted 1 would be a cap of 1.
    const now = Date.now();
    install(new RecordingJournal("LIVE", [squeezeLine("aaaa", now - 1 * HOUR)]));

    const outcome = await squeezeRunway("1");

    expect(outcome.ok).toBe(true);
    expect(recorder.withdrawals).toEqual(["1"]);
  });

  it("refuses the call one OVER the limit, and never reaches withdraw()", async () => {
    // THE test. Everything else in this file is context for this line.
    const now = Date.now();
    install(
      new RecordingJournal("LIVE", [
        squeezeLine("aaaa", now - 1 * HOUR),
        squeezeLine("bbbb", now - 2 * HOUR),
      ]),
    );

    const outcome = await squeezeRunway("1");

    expect(outcome.ok).toBe(false);
    expect(recorder.withdrawals).toEqual([]);
  });

  it("refuses with 429 and an honest message naming the limit and the reset", async () => {
    const now = Date.now();
    install(
      new RecordingJournal("LIVE", [
        squeezeLine("aaaa", now - 1 * HOUR),
        squeezeLine("bbbb", now - 2 * HOUR),
      ]),
    );

    const outcome = await squeezeRunway("1");
    const error = !outcome.ok ? outcome.error : "";

    // 429, not 400 and not 500: the request was fine, the budget is spent.
    expect(!outcome.ok && outcome.status).toBe(429);
    expect(error).toContain("2 of a maximum 2 squeezes");
    expect(error).toContain("last 24h");
    expect(error).toContain("No transaction was attempted and no funds moved");
    expect(error).toContain("relaxes");
    expect(error).toContain("UTC");
    // And it says the agent is fine, because that is the actual question a
    // judge who just got a red line on the dashboard is asking.
    expect(error).toContain("still ticking");
  });

  it("refuses on the cumulative AMOUNT even when the count allows it", async () => {
    setEnv(MAX_SQUEEZES_ENV, "10");
    setEnv(MAX_SQUEEZE_USDFC_ENV, "6");
    install(new RecordingJournal("LIVE", [squeezeLine("aaaa", Date.now() - HOUR, "5")]));

    const outcome = await squeezeRunway("2");

    expect(!outcome.ok && outcome.status).toBe(429);
    expect(recorder.withdrawals).toEqual([]);
    expect(!outcome.ok && outcome.error).toContain("against a cap of 6.00 USDFC");
  });

  it("counts the window from the durable journal, so a restart does not reset it", async () => {
    // The difference between a cap and a suggestion. On Vercel consecutive
    // calls land on different Function instances; a limit held only in process
    // memory would be reset by each one.
    const now = Date.now();
    install(
      new RecordingJournal("LIVE", [
        squeezeLine("aaaa", now - 20 * HOUR),
        squeezeLine("bbbb", now - 23 * HOUR),
      ]),
    );

    expect((await squeezeRunway("1")).ok).toBe(false);
    expect(recorder.withdrawals).toEqual([]);
  });

  it("lets the window roll: withdrawals older than 24h stop counting", async () => {
    const now = Date.now();
    install(
      new RecordingJournal("LIVE", [
        squeezeLine("aaaa", now - 25 * HOUR),
        squeezeLine("bbbb", now - 30 * HOUR),
      ]),
    );

    expect((await squeezeRunway("1")).ok).toBe(true);
    expect(recorder.withdrawals).toEqual(["1"]);
  });

  it("does not count a MOCK withdrawal against a LIVE cap", async () => {
    // Scoped reads are what keep simulated history out of a real limit, the
    // same way they keep simulated spend off the deposits tile.
    const now = Date.now();
    install(
      new RecordingJournal("LIVE", [
        squeezeLine("aaaa", now - 1 * HOUR, "1", "MOCK"),
        squeezeLine("bbbb", now - 2 * HOUR, "1", "MOCK"),
      ]),
    );

    expect((await squeezeRunway("1")).ok).toBe(true);
  });

  it("consumes the budget within one process too, without waiting for a reload", async () => {
    // A loop against a published secret runs inside one Function instance and
    // is far faster than a chain round trip. The slot is taken before the
    // transaction, so the second call is already refused.
    install(new RecordingJournal("LIVE"));

    expect((await squeezeRunway("1")).ok).toBe(true);
    expect((await squeezeRunway("1")).ok).toBe(true);
    const third = await squeezeRunway("1");

    expect(!third.ok && third.status).toBe(429);
    expect(recorder.withdrawals).toEqual(["1", "1"]);
  });
});

describe("the reserve floor", () => {
  it("refuses a withdrawal that would leave the account below the reserve", async () => {
    setEnv(SQUEEZE_RESERVE_ENV, "1");
    install(new RecordingJournal("LIVE"), { fundsAvailable: "1.5" });

    const outcome = await squeezeRunway("1");

    // 400, not 429: this one is "ask for less", not "come back later".
    expect(!outcome.ok && outcome.status).toBe(400);
    expect(!outcome.ok && outcome.error).toContain("reserve floor");
    expect(recorder.withdrawals).toEqual([]);
  });

  it("allows a withdrawal that leaves exactly the reserve behind", async () => {
    setEnv(SQUEEZE_RESERVE_ENV, "1");
    install(new RecordingJournal("LIVE"), { fundsAvailable: "2" });

    expect((await squeezeRunway("1")).ok).toBe(true);
  });
});

describe("what a squeeze records", () => {
  it("journals a confirmed withdrawal as a squeeze, and as no decision at all", async () => {
    const journal = new RecordingJournal("LIVE");
    install(journal);

    const outcome = await squeezeRunway("2");

    expect(outcome.ok).toBe(true);
    expect(journal.appendedSqueezes).toHaveLength(1);
    expect(journal.appendedSqueezes[0]?.amountUsdfc).toBe("2");
    expect(journal.appendedSqueezes[0]?.txHash).toMatch(/^0x/);
    // The honesty property: an operator action is never an agent decision.
    expect(journal.appended).toEqual([]);
    expect(store.decisions).toEqual([]);
    expect(store.totals.decisions).toBe(0);
    expect(store.totals.depositedUsdfc).toBe("0");
  });

  it("does not charge the window for a withdrawal that failed to confirm", async () => {
    setEnv(MAX_SQUEEZES_ENV, "1");
    const journal = new RecordingJournal("LIVE");
    install(journal, { confirmation: { status: "FAILED", error: "reverted" } });

    expect((await squeezeRunway("1")).ok).toBe(false);
    // Nothing stands, so nothing is recorded and the budget is untouched.
    expect(journal.appendedSqueezes).toEqual([]);

    setChainAdapter(fakeAdapter(recorder));
    expect((await squeezeRunway("1")).ok).toBe(true);
  });

  it("does not charge the window for a withdrawal the chain refused", async () => {
    setEnv(MAX_SQUEEZES_ENV, "1");
    const journal = new RecordingJournal("LIVE");
    install(journal, { failWithdrawal: "insufficient gas" });

    expect((await squeezeRunway("1")).ok).toBe(false);
    expect(journal.appendedSqueezes).toEqual([]);

    setChainAdapter(fakeAdapter(recorder));
    expect((await squeezeRunway("1")).ok).toBe(true);
  });
});

describe("scope", () => {
  it("does not cap MOCK, so the local demo behaves exactly as before", async () => {
    const now = Date.now();
    install(
      new RecordingJournal("MOCK", [
        squeezeLine("aaaa", now - 1 * HOUR, "1", "MOCK"),
        squeezeLine("bbbb", now - 2 * HOUR, "1", "MOCK"),
        squeezeLine("cccc", now - 3 * HOUR, "1", "MOCK"),
      ]),
      { mode: "MOCK" },
    );

    expect((await squeezeRunway("1")).ok).toBe(true);
  });

  it("can be forced on in MOCK for a rehearsal", async () => {
    setEnv(SQUEEZE_CAP_ENV, "on");
    const now = Date.now();
    install(
      new RecordingJournal("MOCK", [
        squeezeLine("aaaa", now - 1 * HOUR, "1", "MOCK"),
        squeezeLine("bbbb", now - 2 * HOUR, "1", "MOCK"),
      ]),
      { mode: "MOCK" },
    );

    const outcome = await squeezeRunway("1");
    expect(!outcome.ok && outcome.status).toBe(429);
    expect(recorder.withdrawals).toEqual([]);
  });

  it("still refuses an adapter that cannot withdraw at all, before any cap", async () => {
    install(new RecordingJournal("LIVE"), { canWithdraw: false });

    const outcome = await squeezeRunway("1");
    expect(!outcome.ok && outcome.status).toBe(501);
  });

  it("still enforces the single-call ceiling ahead of the rolling cap", async () => {
    install(new RecordingJournal("LIVE"));

    const outcome = await squeezeRunway("50");
    expect(!outcome.ok && outcome.status).toBe(400);
    expect(recorder.withdrawals).toEqual([]);
  });
});
