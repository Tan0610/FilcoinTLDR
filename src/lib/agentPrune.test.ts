/**
 * The agent runner's eviction path.
 *
 * `policyProof.test.ts` proves the DECISION. This proves what the runner does
 * with it — and above all what it refuses to do:
 *
 *   - it never calls `terminateDataSet` unless the environment opted in, even
 *     if it is handed a decision that says PENDING;
 *   - it never calls it on an adapter that does not implement it;
 *   - a withheld prune is still journalled, with its target and its reasoning;
 *   - a delinquency read from the storage listing reaches the decision, and an
 *     unreadable listing reaches it as an unknown rather than as a delinquency.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { invalidateStorageCache, runTick } from "./agent";
import { resetChainAdapter, setChainAdapter, type ChainAdapter } from "./chain";
import { EPOCHS_PER_DAY } from "./constants";
import { EVICTION_ENV } from "./eviction";
import { nullJournal } from "./journal";
import { classifyProofState, unreadableReading } from "./proof";
import { resetStore, type AgentStore } from "./store";
import type {
  DataSetProofState,
  RunwaySnapshot,
  StorageListing,
  StoredDataSet,
  TxStatus,
} from "./types";

const EPOCH = 3_000_000;

function proofState(id: string, kind: "healthy" | "delinquent" | "unreadable"): DataSetProofState {
  if (kind === "unreadable") {
    return classifyProofState(unreadableReading(id, "RPC timed out"), EPOCH);
  }
  return classifyProofState(
    {
      dataSetId: id,
      isLive: true,
      lastProvenEpoch: kind === "healthy" ? EPOCH - 120 : EPOCH - 5_760,
      nextChallengeEpoch: null,
      provingDeadline: kind === "healthy" ? EPOCH + 2_760 : EPOCH - 2_880,
      provenThisPeriod: kind === "healthy",
      errors: [],
    },
    EPOCH,
  );
}

function dataSet(id: string, kind: "healthy" | "delinquent" | "unreadable"): StoredDataSet {
  const proof = proofState(id, kind);
  return {
    id,
    pdpId: id,
    provider: "0xprovider",
    sizeBytes: 1_048_576,
    isLive: true,
    withCDN: false,
    pieceCids: [],
    proof,
  };
}

/** 5 days of runway: inside the 7-day top-up rule, outside the emergency. */
function shortSnapshot(): RunwaySnapshot {
  return {
    takenAt: 1_756_000_000_000,
    epoch: EPOCH,
    fundsAvailable: "1.5",
    lockupRate: "0.00041",
    lockupCurrent: "0.84870",
    epochsRemaining: Math.round(5 * EPOCHS_PER_DAY),
    daysRemaining: 5,
    walletUsdfc: "250",
    walletFil: "4.9823",
  };
}

interface Calls {
  terminated: string[];
  deposits: number;
}

interface AdapterOptions {
  dataSets?: StoredDataSet[];
  listStorageError?: Error;
  terminateError?: Error;
  /** Omit to model an adapter with no termination capability at all. */
  canTerminate?: boolean;
  confirmation?: { status: TxStatus; error?: string };
}

function fakeAdapter(calls: Calls, options: AdapterOptions = {}): ChainAdapter {
  const adapter: ChainAdapter = {
    mode: "MOCK",
    getAddress: async () => "0xabc",
    getSnapshot: async () => shortSnapshot(),
    deposit: async () => {
      calls.deposits += 1;
      return { txHash: `0x${"de".repeat(32)}` };
    },
    getStoredItems: async () => [],
    listStorage: async (): Promise<StorageListing> => {
      if (options.listStorageError) throw options.listStorageError;
      return {
        takenAt: 0,
        dataSets: options.dataSets ?? [],
        totalSizeBytes: null,
        items: [],
      };
    },
    uploadFile: async () => {
      throw new Error("not used");
    },
  };

  if (options.canTerminate !== false) {
    adapter.terminateDataSet = async (dataSetId: string) => {
      calls.terminated.push(dataSetId);
      if (options.terminateError) throw options.terminateError;
      return { txHash: `0x${"ab".repeat(32)}` };
    };
  }
  if (options.confirmation) {
    adapter.waitForTransaction = async () => options.confirmation!;
  }
  return adapter;
}

let store: AgentStore;
let calls: Calls;
const savedEviction = process.env[EVICTION_ENV];

beforeEach(() => {
  store = resetStore(nullJournal());
  store.loopStarted = true;
  calls = { terminated: [], deposits: 0 };
  invalidateStorageCache();
  delete process.env[EVICTION_ENV];
});

afterEach(() => {
  resetChainAdapter();
  invalidateStorageCache();
  if (savedEviction === undefined) delete process.env[EVICTION_ENV];
  else process.env[EVICTION_ENV] = savedEviction;
});

/* ---------- the gate ---------- */

describe("the environment gate is checked at the runner, not only in the policy", () => {
  it("submits nothing, and records the decision, when the opt-in is unset", () => {
    // The default. This is the state a demo runs in.
    setChainAdapter(fakeAdapter(calls, { dataSets: [dataSet("1", "delinquent")] }));

    return runTick().then(({ decision }) => {
      expect(decision.action).toBe("PRUNE_DATASET");
      expect(decision.outcome).toBe("NO_ACTION");
      expect(calls.terminated).toEqual([]);
      expect(calls.deposits).toBe(0);
      // Still a real record of a real decision, with its subject named.
      expect(decision.target?.dataSetId).toBe("1");
      expect(decision.reasoning).toContain(EVICTION_ENV);
      expect(decision.reasoning).toContain("recorded as made");
      expect(store.decisions[0]?.id).toBe(decision.id);
    });
  });

  it("refuses a half-set opt-in", async () => {
    process.env[EVICTION_ENV] = "enabled";
    setChainAdapter(fakeAdapter(calls, { dataSets: [dataSet("1", "delinquent")] }));

    const { decision } = await runTick();
    expect(decision.outcome).toBe("NO_ACTION");
    expect(calls.terminated).toEqual([]);
  });

  it("refuses when the adapter cannot terminate, and says so instead of failing", async () => {
    process.env[EVICTION_ENV] = "on";
    setChainAdapter(
      fakeAdapter(calls, { dataSets: [dataSet("1", "delinquent")], canTerminate: false }),
    );

    const { decision } = await runTick();
    expect(decision.action).toBe("PRUNE_DATASET");
    expect(decision.outcome).toBe("NO_ACTION");
    expect(decision.reasoning).toContain("no termination call");
    // Not a FAILED decision: nothing was attempted and nothing broke.
    expect(decision.error).toBeUndefined();
  });
});

/* ---------- execution ---------- */

describe("with the opt-in set", () => {
  it("terminates the delinquent data set and deposits nothing", async () => {
    process.env[EVICTION_ENV] = "on";
    setChainAdapter(
      fakeAdapter(calls, { dataSets: [dataSet("1", "healthy"), dataSet("2", "delinquent")] }),
    );

    const { decision } = await runTick();

    expect(decision.action).toBe("PRUNE_DATASET");
    expect(decision.outcome).toBe("EXECUTED");
    expect(decision.txHash).toMatch(/^0x/);
    expect(calls.terminated).toEqual(["2"]);
    // The whole point of the decision: it did NOT buy runway for dead weight.
    expect(calls.deposits).toBe(0);
  });

  it("records a termination that does not confirm as FAILED", async () => {
    process.env[EVICTION_ENV] = "on";
    setChainAdapter(
      fakeAdapter(calls, {
        dataSets: [dataSet("2", "delinquent")],
        confirmation: { status: "FAILED", error: "reverted onchain" },
      }),
    );

    const { decision } = await runTick();
    expect(decision.outcome).toBe("FAILED");
    expect(decision.error).toContain("reverted onchain");
  });

  it("records a termination that throws as FAILED rather than crashing the tick", async () => {
    process.env[EVICTION_ENV] = "on";
    setChainAdapter(
      fakeAdapter(calls, {
        dataSets: [dataSet("2", "delinquent")],
        terminateError: new Error("provider unreachable"),
      }),
    );

    const { decision } = await runTick();
    expect(decision.outcome).toBe("FAILED");
    expect(decision.error).toContain("provider unreachable");
  });
});

/* ---------- what reaches the decision ---------- */

describe("the proof reading the policy decides on", () => {
  it("comes from the storage listing, so the panel and the decision agree", async () => {
    process.env[EVICTION_ENV] = "on";
    setChainAdapter(
      fakeAdapter(calls, { dataSets: [dataSet("1", "healthy"), dataSet("2", "delinquent")] }),
    );

    const { decision } = await runTick();
    expect(decision.snapshot.proof?.dataSets.map((s) => s.dataSetId)).toEqual(["1", "2"]);
    expect(decision.snapshot.proof?.delinquent).toBe(1);
    expect(decision.snapshot.proof?.epoch).toBe(EPOCH);
  });

  it("degrades an unreadable listing to an unknown, never to a delinquency", async () => {
    // The failure this whole design exists to survive. Eviction is ARMED, the
    // runway is short, and the listing is down — and nothing may be cut.
    process.env[EVICTION_ENV] = "on";
    setChainAdapter(
      fakeAdapter(calls, { listStorageError: new Error("RPC 503 from listStorage") }),
    );

    const { decision } = await runTick();

    expect(decision.action).toBe("TOP_UP");
    expect(calls.terminated).toEqual([]);
    expect(decision.snapshot.proof?.listingError).toContain("RPC 503");
    expect(decision.reasoning).toContain("storage listing could not be read");
  });

  it("degrades an unreadable per-data-set proof state to an unknown", async () => {
    process.env[EVICTION_ENV] = "on";
    setChainAdapter(fakeAdapter(calls, { dataSets: [dataSet("2", "unreadable")] }));

    const { decision } = await runTick();

    expect(decision.action).toBe("TOP_UP");
    expect(calls.terminated).toEqual([]);
    expect(decision.snapshot.proof?.unreadable).toBe(1);
    expect(decision.snapshot.proof?.delinquent).toBe(0);
    expect(decision.reasoning).toContain("never as a missed proof");
  });

  it("leaves a healthy account on the ordinary top-up path", async () => {
    process.env[EVICTION_ENV] = "on";
    setChainAdapter(fakeAdapter(calls, { dataSets: [dataSet("1", "healthy")] }));

    const { decision } = await runTick();
    expect(decision.action).toBe("TOP_UP");
    expect(decision.outcome).toBe("EXECUTED");
    expect(calls.deposits).toBe(1);
    expect(calls.terminated).toEqual([]);
  });
});
