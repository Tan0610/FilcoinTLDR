/**
 * `/api/squeeze` — the other endpoint that moves money.
 *
 * `squeeze.test.ts` proves the bounds. These prove the HANDLER: that it is
 * behind the shared secret — on a stricter rule than `/api/tick`, because in
 * LIVE mode it demands the secret on every host including localhost — that a
 * refused request reaches nothing (no adapter, no RPC, no withdrawal), and that
 * a permitted one produces a withdrawal and NOT a decision.
 *
 * That last point is the one a judge is being asked to trust. The squeeze is a
 * human manufacturing a crisis; if it left a Decision behind, the record would
 * credit the agent with an action a person took.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST } from "./route";
import { resetChainAdapter, setChainAdapter, type ChainAdapter } from "@/lib/chain";
import { EPOCHS_PER_DAY } from "@/lib/constants";
import { nullJournal } from "@/lib/journal";
import { SQUEEZE_AMOUNT_ENV, SQUEEZE_MAX_ENV } from "@/lib/squeeze";
import { resetStore, type AgentStore } from "@/lib/store";
import { DRIVER_ENV_VAR, VERCEL_ENV_VAR } from "@/lib/deployment";
import {
  CHAIN_MODE_ENV,
  REQUIRE_TICK_AUTH_ENV,
  TICK_SECRET_ENV,
  TICK_SECRET_HEADER,
} from "@/lib/tickAuth";
import type { ApiError, RunwaySnapshot, SqueezeResponse, StorageListing } from "@/lib/types";

const SECRET = "test-only-fixture-not-a-real-secret-do-not-use-in-production";

function snapshot(fundsAvailable = "10"): RunwaySnapshot {
  return {
    takenAt: 1_756_000_000_000,
    epoch: 3_000_000,
    fundsAvailable,
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
  withdrawals: string[];
}

function fakeAdapter(calls: Calls, available = "10", canWithdraw = true): ChainAdapter {
  const adapter: ChainAdapter = {
    mode: "MOCK",
    getAddress: async () => "0xabc",
    getSnapshot: async () => {
      calls.snapshots += 1;
      return snapshot(available);
    },
    deposit: async () => ({ txHash: "0xdeadbeef" }),
    getStoredItems: async () => [],
    listStorage: async () => EMPTY_STORAGE,
    uploadFile: async () => {
      throw new Error("not used");
    },
  };
  if (canWithdraw) {
    adapter.withdraw = async (amountUsdfc: string) => {
      calls.withdrawals.push(amountUsdfc);
      return { txHash: `0x${"ab".repeat(32)}` };
    };
  }
  return adapter;
}

function squeezeRequest(headers: Record<string, string> = {}, body?: unknown): Request {
  return new Request("http://localhost:3000/api/squeeze", {
    method: "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

let store: AgentStore;
let calls: Calls;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  // Every env var the handler's authorisation and bounds read, cleared so each
  // test states its own world. VERCEL and the driver override are in the list
  // because "local" has to be genuinely local for the LIVE-on-localhost cases
  // below to be testing what they claim to test.
  for (const key of [
    REQUIRE_TICK_AUTH_ENV,
    TICK_SECRET_ENV,
    CHAIN_MODE_ENV,
    VERCEL_ENV_VAR,
    DRIVER_ENV_VAR,
    SQUEEZE_AMOUNT_ENV,
    SQUEEZE_MAX_ENV,
  ]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  store = resetStore(nullJournal());
  store.loopStarted = true;
  calls = { snapshots: 0, withdrawals: [] };
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetChainAdapter();
});

/* ---------- authentication ---------- */

describe("authentication", () => {
  it("refuses an unauthenticated request BEFORE touching the chain", async () => {
    process.env[REQUIRE_TICK_AUTH_ENV] = "1";
    process.env[TICK_SECRET_ENV] = SECRET;
    setChainAdapter(fakeAdapter(calls));

    const response = await POST(squeezeRequest());

    expect(response.status).toBe(401);
    // The whole point: a 401 that arrives AFTER the withdrawal is not a 401.
    expect(calls.withdrawals).toEqual([]);
    expect(calls.snapshots).toBe(0);
  });

  it("refuses a wrong secret", async () => {
    process.env[REQUIRE_TICK_AUTH_ENV] = "1";
    process.env[TICK_SECRET_ENV] = SECRET;
    setChainAdapter(fakeAdapter(calls));

    const response = await POST(squeezeRequest({ [TICK_SECRET_HEADER]: "not-the-secret" }));

    expect(response.status).toBe(401);
    expect(calls.withdrawals).toEqual([]);
  });

  it("fails CLOSED when the check is required and no secret is configured", async () => {
    process.env[REQUIRE_TICK_AUTH_ENV] = "1";
    setChainAdapter(fakeAdapter(calls));

    const response = await POST(squeezeRequest({ [TICK_SECRET_HEADER]: SECRET }));

    expect(response.status).toBe(503);
    expect(calls.withdrawals).toEqual([]);
  });

  it("accepts the secret as a bearer token, as Vercel Cron sends it", async () => {
    process.env[REQUIRE_TICK_AUTH_ENV] = "1";
    process.env[TICK_SECRET_ENV] = SECRET;
    setChainAdapter(fakeAdapter(calls));

    const response = await POST(squeezeRequest({ authorization: `Bearer ${SECRET}` }));

    expect(response.status).toBe(200);
    expect(calls.withdrawals).toEqual(["1"]);
  });

  it("is open on a local MOCK run, exactly as /api/tick is", async () => {
    // No override, no VERCEL marker, no FILRUNWAY_MODE: a plain `npm run dev`.
    // There are no funds behind the mock adapter, so the demo and the tests
    // stay frictionless.
    setChainAdapter(fakeAdapter(calls));

    const response = await POST(squeezeRequest());
    expect(response.status).toBe(200);
    expect(calls.withdrawals).toEqual(["1"]);
  });

  it("still requires the secret on a DEPLOYED mock build", async () => {
    process.env[VERCEL_ENV_VAR] = "1";
    process.env[TICK_SECRET_ENV] = SECRET;
    setChainAdapter(fakeAdapter(calls));

    expect((await POST(squeezeRequest())).status).toBe(401);
    expect(calls.withdrawals).toEqual([]);
  });
});

/* ---------- LIVE mode: the secret is not optional anywhere ---------- */

describe("LIVE mode authentication", () => {
  /**
   * The gap these close.
   *
   * `/api/tick` only demands the secret under the cron driver, which is right
   * for it: an unauthenticated local tick runs the cycle that was about to run
   * anyway, and its worst case is an early decision. This endpoint's worst case
   * is `payments.withdraw()` — real USDFC leaving Filecoin Pay in an amount the
   * CALLER named. When it shared the tick's rule, `next dev` with
   * FILRUNWAY_MODE=live was a funded wallet on a listening port that any
   * unauthenticated POST could drain up to the ceiling.
   *
   * Note what is NOT set in these tests: no VERCEL marker, no driver override.
   * Every one of them is localhost under the interval driver, i.e. exactly the
   * arrangement that used to be open.
   */

  it("refuses an unauthenticated LIVE squeeze on localhost, before any chain read", async () => {
    process.env[CHAIN_MODE_ENV] = "live";
    process.env[TICK_SECRET_ENV] = SECRET;
    setChainAdapter(fakeAdapter(calls));

    const response = await POST(squeezeRequest());

    expect(response.status).toBe(401);
    // A refusal that arrives after the withdrawal is not a refusal.
    expect(calls.withdrawals).toEqual([]);
    expect(calls.snapshots).toBe(0);
  });

  it("refuses a wrong secret in LIVE mode on localhost", async () => {
    process.env[CHAIN_MODE_ENV] = "live";
    process.env[TICK_SECRET_ENV] = SECRET;
    setChainAdapter(fakeAdapter(calls));

    const response = await POST(squeezeRequest({ [TICK_SECRET_HEADER]: "not-the-secret" }));

    expect(response.status).toBe(401);
    expect(calls.withdrawals).toEqual([]);
  });

  it("cannot be opened by FILRUNWAY_REQUIRE_TICK_AUTH=0", async () => {
    // The override exists for tests and for a self-hosted mock deployment. It
    // must not be a switch that turns a live withdrawal endpoint public.
    process.env[CHAIN_MODE_ENV] = "live";
    process.env[TICK_SECRET_ENV] = SECRET;
    process.env[REQUIRE_TICK_AUTH_ENV] = "0";
    setChainAdapter(fakeAdapter(calls));

    const response = await POST(squeezeRequest());

    expect(response.status).toBe(401);
    expect(calls.withdrawals).toEqual([]);
  });

  it("fails CLOSED with a 503 when LIVE and no secret is configured", async () => {
    // A live deployment (or dev server) that cannot authenticate anyone must be
    // unsqueezable, not wide open. Withdrawing on the strength of a missing
    // check is the one outcome that is not recoverable.
    process.env[CHAIN_MODE_ENV] = "live";
    setChainAdapter(fakeAdapter(calls));

    const response = await POST(squeezeRequest({ [TICK_SECRET_HEADER]: SECRET }));
    const body = (await response.json()) as ApiError;

    expect(response.status).toBe(503);
    expect(body.error).toContain(TICK_SECRET_ENV);
    expect(calls.withdrawals).toEqual([]);
    expect(calls.snapshots).toBe(0);
  });

  it("lets the operator through on localhost WITH the secret", async () => {
    // The control still has to work: this is the path a judge uses.
    process.env[CHAIN_MODE_ENV] = "live";
    process.env[TICK_SECRET_ENV] = SECRET;
    setChainAdapter(fakeAdapter(calls));

    const response = await POST(squeezeRequest({ authorization: `Bearer ${SECRET}` }));

    expect(response.status).toBe(200);
    expect(calls.withdrawals).toEqual(["1"]);
  });

  it("never reaches withdraw() on ANY refusal", async () => {
    // One assertion over every way the endpoint can say no, so a future branch
    // that returns an error AFTER submitting cannot pass unnoticed.
    process.env[CHAIN_MODE_ENV] = "live";

    const refusals: Array<Record<string, string>> = [
      {}, // no credential, secret configured
      { [TICK_SECRET_HEADER]: "wrong" },
      { authorization: "Bearer wrong" },
      { authorization: `Basic ${SECRET}` }, // not a scheme we accept
    ];

    for (const headers of refusals) {
      process.env[TICK_SECRET_ENV] = SECRET;
      calls = { snapshots: 0, withdrawals: [] };
      setChainAdapter(fakeAdapter(calls));

      const response = await POST(squeezeRequest(headers));
      expect(response.status).toBe(401);
      expect(calls.withdrawals).toEqual([]);
      expect(calls.snapshots).toBe(0);
    }

    // ...and the same when the refusal is the fail-closed one.
    delete process.env[TICK_SECRET_ENV];
    calls = { snapshots: 0, withdrawals: [] };
    setChainAdapter(fakeAdapter(calls));

    expect((await POST(squeezeRequest())).status).toBe(503);
    expect(calls.withdrawals).toEqual([]);
  });
});

/* ---------- what it does when permitted ---------- */

describe("a permitted squeeze", () => {
  beforeEach(() => {
    process.env[REQUIRE_TICK_AUTH_ENV] = "0";
  });

  it("withdraws the configured default and reports both readings", async () => {
    process.env[SQUEEZE_AMOUNT_ENV] = "2";
    setChainAdapter(fakeAdapter(calls));

    const response = await POST(squeezeRequest());
    const body = (await response.json()) as SqueezeResponse;

    expect(response.status).toBe(200);
    expect(calls.withdrawals).toEqual(["2"]);
    expect(body.amountUsdfc).toBe("2");
    expect(body.txHash).toMatch(/^0x/);
    expect(body.explorerUrl).toContain(body.txHash);
    expect(body.before.fundsAvailable).toBe("10");
  });

  it("honours an explicit amount inside the ceiling", async () => {
    process.env[SQUEEZE_MAX_ENV] = "8";
    setChainAdapter(fakeAdapter(calls));

    await POST(squeezeRequest({}, { amountUsdfc: "7" }));
    expect(calls.withdrawals).toEqual(["7"]);
  });

  it("creates NO decision — a withdrawal is not the agent acting", async () => {
    setChainAdapter(fakeAdapter(calls));

    await POST(squeezeRequest());

    expect(store.decisions).toEqual([]);
    expect(store.totals.decisions).toBe(0);
    expect(store.totals.depositedUsdfc).toBe("0");
  });

  it("pins a disclosure saying an operator did this", async () => {
    setChainAdapter(fakeAdapter(calls));

    await POST(squeezeRequest());

    const notice = store.notices.find((n) => n.key === "operator-squeeze");
    expect(notice).toBeDefined();
    // A judge arriving after the crisis must still be able to tell who caused
    // it. This is the only durable place that says so.
    expect(notice?.message).toContain("OPERATOR");
    expect(notice?.message).toContain("human action");
  });
});

/* ---------- refusals that are not authentication ---------- */

describe("bounds", () => {
  beforeEach(() => {
    process.env[REQUIRE_TICK_AUTH_ENV] = "0";
  });

  it("refuses an amount over the ceiling with a 400 and submits nothing", async () => {
    process.env[SQUEEZE_MAX_ENV] = "5";
    setChainAdapter(fakeAdapter(calls));

    const response = await POST(squeezeRequest({}, { amountUsdfc: "50" }));
    const body = (await response.json()) as ApiError;

    expect(response.status).toBe(400);
    expect(body.error).toContain(SQUEEZE_MAX_ENV);
    expect(calls.withdrawals).toEqual([]);
  });

  it("refuses a withdrawal that would leave the account in debt", async () => {
    setChainAdapter(fakeAdapter(calls, "0.31"));

    const response = await POST(squeezeRequest({}, { amountUsdfc: "5" }));
    const body = (await response.json()) as ApiError;

    expect(response.status).toBe(400);
    expect(body.error).toContain("leave the account in debt");
    expect(calls.withdrawals).toEqual([]);
  });

  it("refuses when the adapter cannot withdraw at all", async () => {
    setChainAdapter(fakeAdapter(calls, "10", false));

    const response = await POST(squeezeRequest());
    expect(response.status).toBe(501);
  });

  it("treats an absent body as 'use the default', not as an error", async () => {
    setChainAdapter(fakeAdapter(calls));

    const response = await POST(squeezeRequest());
    expect(response.status).toBe(200);
    expect(calls.withdrawals).toEqual(["1"]);
  });
});
