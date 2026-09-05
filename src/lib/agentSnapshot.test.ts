/**
 * `getSnapshot()` freshness tests.
 *
 * Locally a 2-second timer re-reads the chain and this function is a pure
 * cache lookup. Under the cron driver there is no timer, so the same function
 * has to keep the reading fresh itself — but from an endpoint anyone can GET,
 * which means it must be a shared, rate-limited cache and not a chain read per
 * request.
 *
 * The two properties that matter, and are asserted here:
 *   - LOCAL BEHAVIOUR IS UNCHANGED. No extra read, ever.
 *   - The refresh is a READ. It can never take a decision or spend.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getSnapshot } from "./agent";
import { resetChainAdapter, setChainAdapter, type ChainAdapter } from "./chain";
import { EPOCHS_PER_DAY } from "./constants";
import { DRIVER_ENV_VAR } from "./deployment";
import { nullJournal } from "./journal";
import { resetStore } from "./store";
import type { RunwaySnapshot, StorageListing } from "./types";

const EMPTY_STORAGE: StorageListing = {
  takenAt: 0,
  dataSets: [],
  totalSizeBytes: null,
  items: [],
};

interface Counter {
  reads: number;
  deposits: number;
}

function snapshotAt(takenAt: number): RunwaySnapshot {
  return {
    takenAt,
    epoch: 2_960_000,
    fundsAvailable: "11.33568",
    lockupRate: "0.00041",
    lockupCurrent: "0.84870",
    epochsRemaining: Math.round(30 * EPOCHS_PER_DAY),
    daysRemaining: 30,
    walletUsdfc: "250",
    walletFil: "4.9823",
  };
}

function adapterFor(counter: Counter): ChainAdapter {
  return {
    mode: "MOCK",
    getAddress: async () => "0xagent",
    getSnapshot: async () => {
      counter.reads += 1;
      return snapshotAt(Date.now());
    },
    deposit: async () => {
      counter.deposits += 1;
      return { txHash: "0xnope" };
    },
    getStoredItems: async () => [],
    listStorage: async () => EMPTY_STORAGE,
    uploadFile: async () => {
      throw new Error("not used");
    },
  };
}

let counter: Counter;
const savedDriver = process.env[DRIVER_ENV_VAR];

beforeEach(() => {
  counter = { reads: 0, deposits: 0 };
  setChainAdapter(adapterFor(counter));
  resetStore(nullJournal()).loopStarted = true;
});

afterEach(() => {
  if (savedDriver === undefined) delete process.env[DRIVER_ENV_VAR];
  else process.env[DRIVER_ENV_VAR] = savedDriver;
  resetChainAdapter();
});

describe("getSnapshot under the interval driver (local)", () => {
  beforeEach(() => {
    process.env[DRIVER_ENV_VAR] = "interval";
  });

  it("reads once when there is nothing cached, then never again", async () => {
    await getSnapshot();
    expect(counter.reads).toBe(1);

    // Even with a deliberately ancient reading in the store, the local path
    // does not read: the 2-second sense timer owns that job and always did.
    const store = resetStore(nullJournal());
    store.loopStarted = true;
    store.setSnapshot(snapshotAt(0));
    await getSnapshot();
    await getSnapshot();
    expect(counter.reads).toBe(1);
  });
});

describe("getSnapshot under the cron driver (deployed)", () => {
  beforeEach(() => {
    process.env[DRIVER_ENV_VAR] = "cron";
  });

  it("serves a fresh reading from cache without touching the chain", async () => {
    const store = resetStore(nullJournal());
    store.loopStarted = true;
    store.setSnapshot(snapshotAt(Date.now()));

    await getSnapshot();
    await getSnapshot();
    expect(counter.reads).toBe(0);
  });

  it("re-reads once the cached reading has gone stale", async () => {
    // No timer exists here, so a page showing one reading a minute would sit
    // still between ticks.
    const store = resetStore(nullJournal());
    store.loopStarted = true;
    store.setSnapshot(snapshotAt(Date.now() - 60_000));

    const fresh = await getSnapshot();
    expect(counter.reads).toBe(1);
    expect(fresh.takenAt).toBeGreaterThan(Date.now() - 5_000);
  });

  it("coalesces concurrent refreshes into one chain read", async () => {
    const store = resetStore(nullJournal());
    store.loopStarted = true;
    store.setSnapshot(snapshotAt(Date.now() - 60_000));

    await Promise.all([getSnapshot(), getSnapshot(), getSnapshot()]);
    expect(counter.reads).toBe(1);
  });

  it("never deposits — refreshing a reading is not a decision", async () => {
    const store = resetStore(nullJournal());
    store.loopStarted = true;
    store.setSnapshot(snapshotAt(0));

    await getSnapshot();
    expect(counter.deposits).toBe(0);
    expect(store.decisions).toEqual([]);
  });

  it("falls back to the last true reading when the chain read fails", async () => {
    const stale = snapshotAt(1_000);
    const store = resetStore(nullJournal());
    store.loopStarted = true;
    store.setSnapshot(stale);
    setChainAdapter({
      ...adapterFor(counter),
      getSnapshot: async () => {
        throw new Error("RPC down");
      },
    });

    // A previously-read value, not an invented one, and not a 500 that would
    // take the dashboard's gauge down with it.
    await expect(getSnapshot()).resolves.toEqual(stale);
  });
});
