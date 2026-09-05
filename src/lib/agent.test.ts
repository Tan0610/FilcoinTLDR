/**
 * Agent runner tests.
 *
 * `agent.ts` is the orchestration a judge is asked to trust for the autonomy
 * claim: it is what turns a reading into a decision and a decision into a
 * transaction. `policy.ts` is pure and well covered, but the interesting
 * failures are all here — a chain read that throws, a deposit that reverts, a
 * transaction that never confirms, two ticks racing each other.
 *
 * Everything below runs against a scripted `ChainAdapter` installed with
 * `setChainAdapter()`. No network, no key, no SDK, no timers. The store is
 * replaced per test with one backed by a journal that either records in memory
 * or does nothing, so no test touches the filesystem.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getStatus, runTick, sense } from "./agent";
import { MockChainAdapter, resetChainAdapter, setChainAdapter, type ChainAdapter } from "./chain";
import { EPOCHS_PER_DAY } from "./constants";
import { nullJournal, type DecisionJournal, type JournalLoad } from "./journal";
import { resetStore, type AgentStore } from "./store";
import type { AgentEvent, Decision, RunwaySnapshot, StorageListing, TxStatus } from "./types";

/* ---------- fixtures ---------- */

/** A reading with `days` of runway and `wallet` USDFC available to deposit. */
function snapshotWith(days: number, wallet = "250"): RunwaySnapshot {
  const epochs = Math.round(days * EPOCHS_PER_DAY);
  return {
    takenAt: 1_756_000_000_000,
    epoch: 2_960_000,
    fundsAvailable: "11.33568",
    lockupRate: "0.00041",
    lockupCurrent: "0.84870",
    epochsRemaining: epochs,
    daysRemaining: days,
    walletUsdfc: wallet,
    walletFil: "4.9823",
  };
}

/**
 * Let every already-scheduled microtask run.
 *
 * The coalescing tests need the tick under test to have reached a particular
 * point — past its own decision, or still inside `sense()` — before a second
 * caller arrives. That used to be two `await Promise.resolve()`, which is a
 * count of the awaits the cycle happened to contain at the time: adding one
 * more `await` anywhere in `executeTick` (the PDP proof read did exactly that)
 * silently changed where the test's second caller landed. Draining the queue
 * expresses the actual requirement and cannot rot the same way. Still no
 * timers, so nothing here depends on wall-clock.
 */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

const EMPTY_STORAGE: StorageListing = {
  takenAt: 0,
  dataSets: [],
  totalSizeBytes: null,
  items: [],
};

interface FakeAdapterOptions {
  /** Readings handed out by `getSnapshot`, in order; the last one repeats. */
  snapshots?: RunwaySnapshot[];
  /** When set, `getSnapshot` rejects with this instead of reading. */
  readError?: Error;
  /** When set, `deposit` rejects with this. */
  depositError?: Error;
  /** Omit to model an adapter that settles instantly (no confirmation walk). */
  confirmation?: { status: TxStatus; error?: string } | Error;
  /** Resolves before `deposit` returns, to hold a tick open on purpose. */
  depositGate?: Promise<void>;
  /** Resolves before the FIRST `getSnapshot` returns, to hold a tick in sense. */
  senseGate?: Promise<void>;
}

/** A `ChainAdapter` that does exactly what a test tells it to and nothing else. */
class FakeChainAdapter implements ChainAdapter {
  readonly mode = "MOCK" as const;

  senseCount = 0;
  depositCount = 0;
  depositedAmounts: string[] = [];

  private readonly options: FakeAdapterOptions;

  constructor(options: FakeAdapterOptions = {}) {
    this.options = options;
    if (options.confirmation !== undefined) {
      this.waitForTransaction = async (): Promise<{ status: TxStatus; error?: string }> => {
        if (options.confirmation instanceof Error) throw options.confirmation;
        return options.confirmation!;
      };
    }
  }

  waitForTransaction?: (txHash: string) => Promise<{ status: TxStatus; error?: string }>;

  async getAddress(): Promise<string> {
    return "0x0000000000000000000000000000000000000042";
  }

  async getSnapshot(): Promise<RunwaySnapshot> {
    this.senseCount += 1;
    if (this.senseCount === 1 && this.options.senseGate) await this.options.senseGate;
    if (this.options.readError) throw this.options.readError;
    const readings = this.options.snapshots ?? [snapshotWith(9.6)];
    return readings[Math.min(this.senseCount - 1, readings.length - 1)];
  }

  async deposit(amountUsdfc: string): Promise<{ txHash: string }> {
    if (this.options.depositGate) await this.options.depositGate;
    this.depositCount += 1;
    this.depositedAmounts.push(amountUsdfc);
    if (this.options.depositError) throw this.options.depositError;
    return { txHash: `0x${"ab".repeat(32)}` };
  }

  async getStoredItems() {
    return [];
  }

  async listStorage(): Promise<StorageListing> {
    return EMPTY_STORAGE;
  }

  async uploadFile(): Promise<never> {
    throw new Error("not used in tests");
  }
}

/** A journal that keeps its appends in memory, so persistence is observable. */
function recordingJournal(seed: Decision[] = []): DecisionJournal & { appended: Decision[] } {
  const appended: Decision[] = [];
  return {
    appended,
    path: "(memory)",
    mode: "MOCK",
    enabled: true,
    lastError: null,
    load: (): JournalLoad => ({
      decisions: [...seed].sort((a, b) => b.at - a.at || b.id.localeCompare(a.id)),
      entries: [...seed]
        .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
        .map((decision) => ({ mode: "MOCK" as const, decision })),
      byMode: { MOCK: seed.length, LIVE: 0 },
      scope: "MOCK",
      totals: {
        decisions: seed.length,
        executed: seed.filter((d) => d.outcome === "EXECUTED").length,
        depositedUsdfc: seed
          .filter((d) => d.outcome === "EXECUTED")
          .reduce((n, d) => n + Number(d.ruleFired?.topUpAmount ?? "0"), 0)
          .toString(),
        firstAt: seed.length ? Math.min(...seed.map((d) => d.at)) : null,
        lastAt: seed.length ? Math.max(...seed.map((d) => d.at)) : null,
      },
      skipped: 0,
      read: seed.length,
    }),
    append: (decision) => {
      // Structured-clone so a later mutation of the live object cannot
      // retroactively "fix" what the record says was written.
      appended.push(JSON.parse(JSON.stringify(decision)) as Decision);
    },
  };
}

function eventsOfType<T extends AgentEvent["type"]>(
  store: AgentStore,
  type: T,
): Extract<AgentEvent, { type: T }>[] {
  return store.events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
}

let store: AgentStore;

function install(options: FakeAdapterOptions = {}): FakeChainAdapter {
  const adapter = new FakeChainAdapter(options);
  setChainAdapter(adapter);
  return adapter;
}

beforeEach(() => {
  store = resetStore(nullJournal());
});

afterEach(() => {
  resetChainAdapter();
});

/* ---------- the happy path ---------- */

describe("runTick: HOLD", () => {
  it("records a decision and never touches the chain", async () => {
    const adapter = install({ snapshots: [snapshotWith(9.6)] });

    const { decision, coalesced } = await runTick();

    expect(decision.action).toBe("HOLD");
    expect(decision.outcome).toBe("NO_ACTION");
    expect(coalesced).toBe(false);
    expect(adapter.depositCount).toBe(0);
    expect(store.decisions[0]?.id).toBe(decision.id);
    // One read; a HOLD returns before the post-deposit re-sense.
    expect(adapter.senseCount).toBe(1);
    expect(eventsOfType(store, "tx")).toHaveLength(0);
  });
});

/* ---------- SUBMITTED -> CONFIRMED / FAILED ---------- */

describe("runTick: transaction walk", () => {
  it("walks SUBMITTED -> CONFIRMED and lands the decision on EXECUTED", async () => {
    const adapter = install({
      snapshots: [snapshotWith(5)],
      confirmation: { status: "CONFIRMED" },
    });

    const { decision } = await runTick();

    expect(decision.action).toBe("TOP_UP");
    expect(decision.outcome).toBe("EXECUTED");
    expect(decision.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(decision.error).toBeUndefined();
    expect(adapter.depositedAmounts).toEqual(["5"]);

    const tx = eventsOfType(store, "tx");
    expect(tx.map((e) => e.status)).toEqual(["SUBMITTED", "CONFIRMED"]);
    // Both events must name the same transaction, or the UI would show two.
    expect(new Set(tx.map((e) => e.txHash)).size).toBe(1);
    expect(tx[0].decisionId).toBe(decision.id);
  });

  it("walks SUBMITTED -> FAILED and records why, keeping the tx hash", async () => {
    install({
      snapshots: [snapshotWith(5)],
      confirmation: { status: "FAILED", error: "receipt status 0" },
    });

    const { decision } = await runTick();

    expect(decision.outcome).toBe("FAILED");
    expect(decision.error).toBe("receipt status 0");
    // The transaction WAS submitted; losing its hash would lose the evidence.
    expect(decision.txHash).toMatch(/^0x/);
    expect(eventsOfType(store, "tx").map((e) => e.status)).toEqual(["SUBMITTED", "FAILED"]);
  });

  it("treats a throwing waitForTransaction as a failure to confirm, not a crash", async () => {
    install({
      snapshots: [snapshotWith(5)],
      confirmation: new Error("rpc went away"),
    });

    const { decision } = await runTick();

    expect(decision.outcome).toBe("FAILED");
    expect(decision.error).toContain("rpc went away");
    expect(eventsOfType(store, "tx").map((e) => e.status)).toEqual(["SUBMITTED", "FAILED"]);
  });

  it("reports CONFIRMED immediately for an adapter that cannot track inclusion", async () => {
    // No `confirmation` option => no waitForTransaction, i.e. the mock adapter.
    install({ snapshots: [snapshotWith(5)] });

    const { decision } = await runTick();

    expect(decision.outcome).toBe("EXECUTED");
    // Exactly one tx event, and it must not claim a SUBMITTED state it can
    // never resolve — a pending badge that never settles is a lie.
    expect(eventsOfType(store, "tx").map((e) => e.status)).toEqual(["CONFIRMED"]);
  });

  it("records a reverting deposit as FAILED without a tx hash", async () => {
    install({
      snapshots: [snapshotWith(1)],
      depositError: new Error("ERC20: transfer amount exceeds allowance"),
    });

    const { decision } = await runTick();

    expect(decision.action).toBe("EMERGENCY_TOP_UP");
    expect(decision.outcome).toBe("FAILED");
    expect(decision.error).toContain("exceeds allowance");
    expect(decision.txHash).toBeUndefined();
    expect(eventsOfType(store, "tx")).toHaveLength(0);
  });
});

/* ---------- failed chain read ---------- */

describe("runTick: failed chain read", () => {
  it("produces a recorded decision rather than throwing", async () => {
    install({ readError: new Error("HTTP 502 from glif") });

    const { decision } = await runTick();

    expect(decision.outcome).toBe("FAILED");
    // HOLD, not a top-up: acting on a reading you could not take is worse than
    // not acting at all.
    expect(decision.action).toBe("HOLD");
    expect(decision.ruleFired).toBeNull();
    expect(decision.error).toContain("HTTP 502");
    expect(decision.reasoning).toContain("Chain read failed");
    expect(store.decisions[0]?.id).toBe(decision.id);
    expect(store.lastTickAt).toBe(decision.at);
    expect(eventsOfType(store, "log").some((e) => e.level === "error")).toBe(true);
  });

  it("carries the last good reading rather than inventing zeros", async () => {
    const adapter = install({ snapshots: [snapshotWith(9.6)] });
    await sense();

    setChainAdapter(new FakeChainAdapter({ readError: new Error("timeout") }));
    const { decision } = await runTick();

    expect(decision.snapshot.daysRemaining).toBe(9.6);
    expect(adapter.senseCount).toBe(1);
  });

  it("falls back to a zeroed stand-in when no reading has ever succeeded", async () => {
    install({ readError: new Error("timeout") });

    const { decision } = await runTick();

    expect(decision.snapshot.epoch).toBe(0);
    expect(decision.snapshot.fundsAvailable).toBe("0");
  });
});

/* ---------- INSUFFICIENT_FUNDS ---------- */

describe("runTick: INSUFFICIENT_FUNDS", () => {
  it("never calls deposit() when the wallet cannot cover the rule", async () => {
    // 5 days of runway fires the 5 USDFC top-up; the wallet holds 1.2.
    const adapter = install({ snapshots: [snapshotWith(5, "1.2")] });

    const { decision } = await runTick();

    expect(decision.action).toBe("INSUFFICIENT_FUNDS");
    expect(decision.outcome).toBe("NO_ACTION");
    expect(adapter.depositCount).toBe(0);
    expect(eventsOfType(store, "tx")).toHaveLength(0);
    // And it is a deliberate, explained decision, not a silent no-op.
    expect(decision.reasoning).toContain("shortfall");
    expect(eventsOfType(store, "log").some((e) => e.level === "warn")).toBe(true);
  });

  it("returns before the deposit path even in the emergency band", async () => {
    const adapter = install({ snapshots: [snapshotWith(0.5, "0")] });

    const { decision } = await runTick();

    expect(decision.action).toBe("INSUFFICIENT_FUNDS");
    expect(adapter.depositCount).toBe(0);
    // No re-sense either: nothing changed on chain, so there is nothing to re-read.
    expect(adapter.senseCount).toBe(1);
  });
});

/* ---------- the tickInFlight guard ---------- */

describe("runTick: tickInFlight guard", () => {
  it("labels the PREVIOUS decision as coalesced instead of passing it off as fresh", async () => {
    // A previous tick has completed, so there is something to serve fast.
    install({ snapshots: [snapshotWith(9.6)] });
    const first = await runTick();
    expect(first.coalesced).toBe(false);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Hold the next tick inside `sense()`, before it has decided anything, so
    // the only thing at the head of the ring is the tick that came before.
    const adapter = install({ snapshots: [snapshotWith(5)], senseGate: gate });

    const slow = runTick();
    await drainMicrotasks();

    const during = await runTick();

    // This is the crux. The caller is handed a decision it did not ask for —
    // minutes old on a live chain — and is now TOLD so. Before `coalesced` the
    // two cases were indistinguishable in the response.
    expect(during.coalesced).toBe(true);
    expect(during.decision.id).toBe(first.decision.id);
    expect(during.decision.action).toBe("HOLD");

    release();
    const settled = await slow;
    expect(settled.coalesced).toBe(false);
    expect(settled.decision.id).not.toBe(first.decision.id);
    expect(adapter.depositCount).toBe(1);
  });

  it("serves the in-flight decision once it exists, still labelled coalesced", async () => {
    install({ snapshots: [snapshotWith(9.6)] });
    const first = await runTick();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Gated at the deposit instead: by now the running tick has already stored
    // its own PENDING decision, so that — not the older one — is what a
    // coalesced caller sees. Either way it is not a decision taken for them.
    const adapter = install({ snapshots: [snapshotWith(5)], depositGate: gate });

    const slow = runTick();
    await drainMicrotasks();

    const during = await runTick();

    expect(during.coalesced).toBe(true);
    expect(during.decision.id).not.toBe(first.decision.id);
    expect(during.decision.outcome).toBe("PENDING");

    release();
    const settled = await slow;
    expect(settled.decision.id).toBe(during.decision.id);
    expect(settled.decision.outcome).toBe("EXECUTED");
    // One cycle ran, so exactly one deposit was submitted.
    expect(adapter.depositCount).toBe(1);
  });

  it("joins the running cycle when nothing has completed yet, instead of starting a second", async () => {
    // The hole in the old guard: `tickInFlight && decisions[0]` fell through on
    // the very first tick, so two cycles ran against the same reading and the
    // policy could deposit twice.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = install({ snapshots: [snapshotWith(5)], depositGate: gate });

    const first = runTick();
    await drainMicrotasks();
    const second = runTick();

    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a.coalesced).toBe(false);
    expect(b.coalesced).toBe(true);
    expect(b.decision.id).toBe(a.decision.id);
    expect(adapter.depositCount).toBe(1);
    expect(store.decisions.filter((d) => d.id === a.decision.id)).toHaveLength(1);
  });

  it("clears the guard even when the cycle fails, so the agent is not wedged", async () => {
    install({ readError: new Error("down") });
    await runTick();

    expect(store.tickInFlight).toBe(false);
    expect(store.inFlightTick).toBeNull();

    install({ snapshots: [snapshotWith(9.6)] });
    const next = await runTick();
    expect(next.coalesced).toBe(false);
  });
});

/* ---------- post-deposit re-sense ---------- */

describe("runTick: post-deposit re-sense", () => {
  it("re-reads the chain after a deposit so the gauge shows the new balance", async () => {
    const before = snapshotWith(5);
    const after = { ...snapshotWith(17), fundsAvailable: "16.33568" };
    const adapter = install({
      snapshots: [before, after],
      confirmation: { status: "CONFIRMED" },
    });

    await runTick();

    expect(adapter.senseCount).toBe(2);
    expect(store.snapshot?.fundsAvailable).toBe("16.33568");
    const snapshots = eventsOfType(store, "snapshot");
    expect(snapshots.at(-1)?.snapshot.daysRemaining).toBe(17);
  });

  it("does not undo an EXECUTED decision when the re-read fails", async () => {
    let reads = 0;
    const adapter: ChainAdapter = {
      mode: "MOCK",
      getAddress: async () => "0x1",
      getSnapshot: async () => {
        reads += 1;
        if (reads > 1) throw new Error("rpc flaked on the re-read");
        return snapshotWith(5);
      },
      deposit: async () => ({ txHash: `0x${"cd".repeat(32)}` }),
      getStoredItems: async () => [],
      listStorage: async () => EMPTY_STORAGE,
      uploadFile: async () => {
        throw new Error("not used");
      },
    };
    setChainAdapter(adapter);

    const { decision } = await runTick();

    expect(decision.outcome).toBe("EXECUTED");
    expect(reads).toBe(2);
    expect(store.decisions[0]?.outcome).toBe("EXECUTED");
    expect(eventsOfType(store, "log").some((e) => e.message.includes("Post-deposit"))).toBe(true);
  });
});

/* ---------- persistence ---------- */

describe("runTick: durable record", () => {
  it("journals every state a decision passes through, in order", async () => {
    const journal = recordingJournal();
    store = resetStore(journal);
    install({ snapshots: [snapshotWith(5)], confirmation: { status: "CONFIRMED" } });

    const { decision } = await runTick();

    const mine = journal.appended.filter((d) => d.id === decision.id);
    expect(mine.map((d) => d.outcome)).toEqual(["PENDING", "EXECUTED"]);
    // The PENDING line must not retroactively carry the hash it did not have.
    expect(mine[0].txHash).toBeUndefined();
    expect(mine[1].txHash).toBe(decision.txHash);
    // And every line is self-contained evidence.
    expect(mine[1].snapshot.daysRemaining).toBe(5);
    expect(mine[1].ruleFired?.id).toBe("topup-7d");
    expect(mine[1].reasoning).toContain("USDFC");
  });

  it("reports whole-history totals, not just this process's", async () => {
    const older: Decision = {
      id: "older",
      at: 1_700_000_000_000,
      snapshot: snapshotWith(5),
      ruleFired: { id: "topup-7d", label: "x", thresholdDays: 7, action: "TOP_UP", topUpAmount: "5" },
      action: "TOP_UP",
      reasoning: "from a previous run",
      outcome: "EXECUTED",
      txHash: `0x${"ef".repeat(32)}`,
    };
    store = resetStore(recordingJournal([older]));
    install({ snapshots: [snapshotWith(5)], confirmation: { status: "CONFIRMED" } });

    await runTick();
    const status = await getStatus();

    expect(status.totals.decisions).toBe(2);
    expect(status.totals.executed).toBe(2);
    expect(Number(status.totals.depositedUsdfc)).toBe(10);
    expect(status.journalPath).toBe("(memory)");
  });

  it("keeps ticking when the journal disables itself mid-run", async () => {
    const broken: DecisionJournal = {
      path: "/nope/decisions.jsonl",
      mode: "MOCK",
      enabled: true,
      lastError: null,
      load: () => ({
        decisions: [],
        entries: [],
        totals: store.totals,
        byMode: { MOCK: 0, LIVE: 0 },
        scope: "MOCK",
        skipped: 0,
        read: 0,
      }),
      append: () => {
        // Model the real journal: it swallows the error and switches itself off.
        (broken as { enabled: boolean }).enabled = false;
        (broken as { lastError: string | null }).lastError = "EACCES: permission denied";
      },
    };
    store = resetStore(broken);
    install({ snapshots: [snapshotWith(9.6)] });

    const { decision } = await runTick();

    expect(decision.action).toBe("HOLD");
    expect(store.decisions[0]?.id).toBe(decision.id);
    const warned = eventsOfType(store, "log").filter((e) => e.level === "warn");
    expect(warned.some((e) => e.message.includes("EACCES"))).toBe(true);
    // Warned once, not once per decision.
    await runTick();
    expect(warned.length).toBe(
      eventsOfType(store, "log").filter(
        (e) => e.level === "warn" && e.message.includes("EACCES"),
      ).length,
    );
  });
});

/* ---------- the mock adapter's injectable clock ---------- */

describe("sense with an injected clock", () => {
  it("drains the simulated runway across the policy's own threshold", async () => {
    let now = 1_756_000_000_000;
    const adapter = new MockChainAdapter({
      now: () => now,
      startedAt: now,
      epochsPerSecond: 2880, // one simulated day per real second
    });
    setChainAdapter(adapter);

    const opening = await sense();
    expect(opening.daysRemaining).toBeGreaterThan(9);

    // Four simulated days later the runway is inside the 7-day top-up band.
    now += 4_000;
    const later = await sense();

    expect(later.daysRemaining).toBeLessThan(7);
    expect(later.daysRemaining).toBeGreaterThan(0);
    expect(later.epoch).toBeGreaterThan(opening.epoch);
    // The clock is the only thing that moved: the burn rate is a constant.
    expect(later.lockupRate).toBe(opening.lockupRate);
  });
});

/* ---------- status ---------- */

describe("getStatus", () => {
  it("reports the adapter mode, address and tick schedule", async () => {
    install();
    const status = await getStatus();

    expect(status.mode).toBe("MOCK");
    expect(status.address).toMatch(/^0x/);
    expect(status.lastTickAt).toBeNull();
    expect(status.nextTickAt).toBeNull();
    expect(status.totals.decisions).toBe(0);
    // A null journal is off, so the UI must not claim the record is durable.
    expect(status.journalPath).toBeNull();
  });

  it("projects the next tick from the last one", async () => {
    install({ snapshots: [snapshotWith(9.6)] });
    await runTick();
    const status = await getStatus();

    expect(status.lastTickAt).not.toBeNull();
    expect(status.nextTickAt).toBe(status.lastTickAt! + status.tickIntervalMs);
  });
});

// Guard against a stray unhandled rejection escaping a test above.
afterEach(() => {
  vi.restoreAllMocks();
});

/* ---------- a journal that fails AFTER append returns ---------- */

/**
 * The failure mode that shipped, and why it was invisible.
 *
 * A filesystem journal writes inside `append()`, so a failure is known by the
 * time it returns — and the store's check ran right there. The deployed
 * journal is Blob-backed: `append()` queues an upload and returns, and the
 * store's rejection (the provisioned store was PRIVATE and every write was
 * sent as `public`) only landed later, inside `flush()`. The check therefore
 * always saw an enabled journal, never fired, and the dashboard went on
 * reporting a `blob:` path to a store that held zero objects.
 *
 * These pin the check to where the answer can actually have changed.
 */
describe("a journal that disables itself during flush, not during append", () => {
  const REJECTION =
    "Vercel Blob: Cannot use public access on a private store. " +
    "The store is configured with private access.";

  function lateFailingJournal(): DecisionJournal {
    let queued = 0;
    const journal: DecisionJournal = {
      // A live-looking path, exactly as the broken deployment reported.
      path: "blob:filrunway/journal/live/0001700000000-abc123-0000.jsonl",
      mode: "MOCK",
      enabled: true,
      lastError: null,
      // The remote journal's defining property: reads and writes are deferred.
      synchronous: false,
      load: (): JournalLoad => ({
        decisions: [],
        entries: [],
        totals: store.totals,
        byMode: { MOCK: 0, LIVE: 0 },
        scope: "MOCK",
        skipped: 0,
        read: 0,
      }),
      // `append` SUCCEEDS. That is the whole point.
      append: () => {
        queued += 1;
      },
      flush: async () => {
        if (queued === 0 || !journal.enabled) return;
        const mutable = journal as {
          enabled: boolean;
          lastError: string | null;
          path: string | null;
        };
        mutable.enabled = false;
        mutable.lastError = REJECTION;
        // As `BlobDecisionJournal.path` now does: stop naming a location that
        // is not being written.
        mutable.path = null;
      },
    };
    return journal;
  }

  it("pins the failure to the dashboard instead of swallowing it", async () => {
    store = resetStore(lateFailingJournal());
    install({ snapshots: [snapshotWith(9.6)] });

    const { decision } = await runTick();

    // The agent carried on, as it must.
    expect(decision.action).toBe("HOLD");

    // And it SAID SO. This is the assertion that fails against the old code:
    // the check ran only after `append()`, which never saw the failure.
    const pinned = store.notices.find((n) => n.key === "journal-write-failed");
    expect(pinned).toBeDefined();
    expect(pinned!.level).toBe("warn");
    expect(pinned!.message).toContain("private store");
    // The trace carries it too, for anyone watching live.
    const warned = eventsOfType(store, "log").filter(
      (e) => e.level === "warn" && e.message.includes("private store"),
    );
    expect(warned).toHaveLength(1);
  });

  it("reports no path and a reason, in the very response that failed to persist", async () => {
    store = resetStore(lateFailingJournal());
    install({ snapshots: [snapshotWith(9.6)] });

    await runTick();
    // `runTick` awaits the flush before the route reads the status, so the
    // response that carries the decision also carries the fact that the
    // decision was not persisted.
    const status = await getStatus();

    expect(status.journalPath).toBeNull();
    expect(status.journalError).toContain("private store");
    expect(status.notices.some((n) => n.key === "journal-write-failed")).toBe(true);
  });

  it("says it once, however many ticks follow", async () => {
    store = resetStore(lateFailingJournal());
    install({ snapshots: [snapshotWith(9.6)] });

    await runTick();
    await runTick();
    await getStatus();
    await getStatus();

    expect(store.notices.filter((n) => n.key === "journal-write-failed")).toHaveLength(1);
    expect(
      eventsOfType(store, "log").filter(
        (e) => e.level === "warn" && e.message.includes("private store"),
      ),
    ).toHaveLength(1);
  });

  it("says nothing when persistence is merely switched off", async () => {
    // `journal-off` already covers the deliberate case, and a configuration
    // choice is not a failure. Only an ERROR is worth pinning as one.
    store = resetStore(nullJournal());
    install({ snapshots: [snapshotWith(9.6)] });

    await runTick();
    const status = await getStatus();

    expect(status.journalPath).toBeNull();
    expect(status.journalError).toBeNull();
    expect(store.notices.some((n) => n.key === "journal-write-failed")).toBe(false);
  });

  it("keeps journalError null while the journal is healthy", async () => {
    store = resetStore(recordingJournal());
    install({ snapshots: [snapshotWith(9.6)] });

    await runTick();
    const status = await getStatus();

    expect(status.journalPath).toBe("(memory)");
    expect(status.journalError).toBeNull();
  });
});
