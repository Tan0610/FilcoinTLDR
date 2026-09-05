/**
 * `/api/tick` route tests — the endpoint that can spend.
 *
 * `tickAuth.test.ts` proves the decision function. These prove the HANDLER
 * applies it, on BOTH verbs, and — the part that actually matters — that a
 * refused request reaches nothing: no agent loop, no chain adapter, no RPC, no
 * deposit. An endpoint that 401s only AFTER running the cycle would have moved
 * the funds already.
 *
 * The chain is a scripted adapter installed with `setChainAdapter()`, so there
 * is no network and no key anywhere in this file. `loopStarted` is pinned true
 * so nothing can schedule a timer.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET, POST } from "./route";
import { resetChainAdapter, setChainAdapter, type ChainAdapter } from "@/lib/chain";
import { EPOCHS_PER_DAY } from "@/lib/constants";
import { REQUIRE_TICK_AUTH_ENV, TICK_SECRET_ENV, TICK_SECRET_HEADER } from "@/lib/tickAuth";
import { emptyLoad, nullJournal, type DecisionJournal } from "@/lib/journal";
import { resetStore } from "@/lib/store";
import type { RunwaySnapshot, StorageListing, TickResponse } from "@/lib/types";

const SECRET = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";

/** Comfortably above every threshold, so a permitted tick HOLDs and spends nothing. */
function healthySnapshot(): RunwaySnapshot {
  return {
    takenAt: 1_756_000_000_000,
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

const EMPTY_STORAGE: StorageListing = {
  takenAt: 0,
  dataSets: [],
  totalSizeBytes: null,
  items: [],
};

/** Counts everything a refused request must NOT have caused. */
interface Calls {
  snapshots: number;
  deposits: number;
}

function fakeAdapter(calls: Calls): ChainAdapter {
  return {
    mode: "MOCK",
    getAddress: async () => "0xabc",
    getSnapshot: async () => {
      calls.snapshots += 1;
      return healthySnapshot();
    },
    deposit: async () => {
      calls.deposits += 1;
      return { txHash: "0xdeadbeef" };
    },
    getStoredItems: async () => [],
    listStorage: async () => EMPTY_STORAGE,
    uploadFile: async () => {
      throw new Error("not used");
    },
  };
}

function tickRequest(headers: Record<string, string> = {}, method = "POST"): Request {
  return new Request("http://localhost:3000/api/tick", { method, headers });
}

let calls: Calls;
const saved: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  calls = { snapshots: 0, deposits: 0 };
  setChainAdapter(fakeAdapter(calls));
  // `nullJournal()` keeps every test off the filesystem.
  resetStore(nullJournal()).loopStarted = true;
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete saved[key];
  }
  resetChainAdapter();
});

describe("POST /api/tick without authentication required (local)", () => {
  beforeEach(() => setEnv(REQUIRE_TICK_AUTH_ENV, "0"));

  it("runs a cycle exactly as it always did, with no credential", async () => {
    const response = await POST(tickRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as TickResponse;
    expect(body.decision.action).toBe("HOLD");
    expect(body.coalesced).toBe(false);
    expect(calls.snapshots).toBeGreaterThan(0);
    expect(calls.deposits).toBe(0);
  });
});

describe("with authentication required (deployed)", () => {
  beforeEach(() => {
    setEnv(REQUIRE_TICK_AUTH_ENV, "1");
    setEnv(TICK_SECRET_ENV, SECRET);
  });

  it("refuses an unauthenticated POST with 401 and runs NOTHING", async () => {
    const response = await POST(tickRequest());
    expect(response.status).toBe(401);
    // The point of the whole exercise: the refusal happened before any of the
    // machinery that could have spent.
    expect(calls.snapshots).toBe(0);
    expect(calls.deposits).toBe(0);
  });

  it("refuses an unauthenticated GET too — there is no read-only back door", async () => {
    const response = await GET(tickRequest({}, "GET"));
    expect(response.status).toBe(401);
    expect(calls.snapshots).toBe(0);
    expect(calls.deposits).toBe(0);
  });

  it("refuses a wrong secret", async () => {
    const response = await POST(tickRequest({ authorization: "Bearer wrong" }));
    expect(response.status).toBe(401);
    expect(calls.snapshots).toBe(0);
  });

  it("accepts the cron job's bearer token on GET", async () => {
    // This is the shape of the request Vercel Cron actually makes.
    const response = await GET(
      tickRequest({ authorization: `Bearer ${SECRET}` }, "GET"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as TickResponse;
    expect(body.decision.action).toBe("HOLD");
    expect(calls.snapshots).toBeGreaterThan(0);
  });

  it("accepts an operator's POST carrying the fallback header", async () => {
    const response = await POST(tickRequest({ [TICK_SECRET_HEADER]: SECRET }));
    expect(response.status).toBe(200);
  });

  it("never caches a tick response", async () => {
    const refused = await POST(tickRequest());
    const allowed = await POST(tickRequest({ authorization: `Bearer ${SECRET}` }));
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(allowed.headers.get("cache-control")).toBe("no-store");
  });
});

describe("durability before responding", () => {
  beforeEach(() => setEnv(REQUIRE_TICK_AUTH_ENV, "0"));

  it("does not respond until the journal write has actually landed", async () => {
    // A Function instance can be frozen or discarded the moment it responds, so
    // an upload still in flight at that point may simply never happen. For this
    // project that is not a dropped log line: it is a transaction with no
    // record behind it, which is the one thing the autonomy claim cannot lose.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let flushed = false;
    let appended = 0;

    const journal: DecisionJournal = {
      path: "blob:test/journal",
      mode: "MOCK",
      enabled: true,
      lastError: null,
      synchronous: false,
      load: () => emptyLoad("MOCK"),
      loadAsync: async () => emptyLoad("MOCK"),
      append: () => {
        appended += 1;
      },
      flush: async () => {
        await gate;
        flushed = true;
      },
    };

    resetStore(journal).loopStarted = true;

    const pending = POST(tickRequest());
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    // Long enough for the whole cycle to have finished if nothing were holding
    // it — the only thing outstanding is the queued write.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(appended).toBeGreaterThan(0);
    expect(flushed).toBe(false);
    expect(settled).toBe(false);

    release();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(flushed).toBe(true);
  });
});

describe("with authentication required and no secret configured", () => {
  beforeEach(() => {
    setEnv(REQUIRE_TICK_AUTH_ENV, "1");
    setEnv(TICK_SECRET_ENV, undefined);
  });

  it("refuses every tick with 503 rather than falling open", async () => {
    const anonymous = await POST(tickRequest());
    const credentialled = await POST(tickRequest({ authorization: `Bearer ${SECRET}` }));
    expect(anonymous.status).toBe(503);
    expect(credentialled.status).toBe(503);
    expect(calls.snapshots).toBe(0);
    expect(calls.deposits).toBe(0);
  });
});
