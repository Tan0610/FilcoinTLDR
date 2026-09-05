/**
 * The operator withdrawal cap's arithmetic.
 *
 * `agentSqueezeCap.test.ts` proves the endpoint USES this. These prove it is
 * right: that the boundary is where it says it is, that the window really
 * rolls, that a refusal names the limit and the reset, and that a malformed
 * environment variable widens nothing.
 *
 * Pure — no clock, no filesystem, no network. Every input is an argument.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_SQUEEZES,
  DEFAULT_MAX_SQUEEZE_USDFC_24H,
  DEFAULT_SQUEEZE_RESERVE_USDFC,
  DEFAULT_SQUEEZE_WINDOW_MS,
  MAX_SQUEEZES_ENV,
  MAX_SQUEEZE_USDFC_ENV,
  SQUEEZE_CAP_ENV,
  SQUEEZE_RESERVE_ENV,
  SQUEEZE_WINDOW_MS_ENV,
  checkSqueezeCap,
  describeSqueezeCap,
  squeezeCapEnabled,
  squeezeCapLimits,
  squeezeEntriesFrom,
  squeezeWindow,
  type SqueezeCapLimits,
  type SqueezeEntry,
} from "./squeezeGuard";

const HOUR = 60 * 60 * 1000;
const NOW = 1_756_000_000_000;

/** Deliberately small, so the boundaries are easy to sit exactly on. */
const LIMITS: SqueezeCapLimits = {
  maxSqueezes: 3,
  maxUsdfc: "6",
  windowMs: 24 * HOUR,
  reserveUsdfc: "1",
};

/** Plenty of unlocked balance, so only the rolling limits can be the cause. */
const RICH = "1000";

function entry(id: string, hoursAgo: number, amountUsdfc = "1"): SqueezeEntry {
  return { id, at: NOW - hoursAgo * HOUR, amountUsdfc };
}

describe("squeezeCapLimits", () => {
  it("falls back to the shipped defaults when unset", () => {
    expect(squeezeCapLimits({})).toEqual({
      maxSqueezes: DEFAULT_MAX_SQUEEZES,
      maxUsdfc: DEFAULT_MAX_SQUEEZE_USDFC_24H,
      windowMs: DEFAULT_SQUEEZE_WINDOW_MS,
      reserveUsdfc: DEFAULT_SQUEEZE_RESERVE_USDFC,
    });
  });

  it("ships defaults sized to allow three crisis-and-recovery cycles and no more", () => {
    // One cycle costs ~2 USDFC of withdrawal on the deployed account, and the
    // agent's own cap allows only three 5 USDFC top-ups per 24h — so there is
    // no fourth recovery to withdraw towards. The ceiling is also strictly
    // below the 15 USDFC the agent may put back in the same window, which is
    // what makes a fully exercised demo day unable to net-drain the account.
    expect(DEFAULT_MAX_SQUEEZES).toBe(6);
    expect(Number(DEFAULT_MAX_SQUEEZE_USDFC_24H)).toBeLessThan(3 * 5);
    expect(Number(DEFAULT_MAX_SQUEEZE_USDFC_24H)).toBeGreaterThanOrEqual(3 * 2);
  });

  it("reads every bound from the environment", () => {
    expect(
      squeezeCapLimits({
        [MAX_SQUEEZES_ENV]: "9",
        [MAX_SQUEEZE_USDFC_ENV]: "12.5",
        [SQUEEZE_WINDOW_MS_ENV]: "3600000",
        [SQUEEZE_RESERVE_ENV]: "0.25",
      }),
    ).toEqual({
      maxSqueezes: 9,
      maxUsdfc: "12.5",
      windowMs: 3_600_000,
      reserveUsdfc: "0.25",
    });
  });

  it("ignores a malformed value rather than throwing or widening the cap", () => {
    // A typo in an env var must not take the endpoint down, and must never be
    // the reason a cap turns out to be larger than anyone intended.
    const limits = squeezeCapLimits({
      [MAX_SQUEEZES_ENV]: "banana",
      [MAX_SQUEEZE_USDFC_ENV]: "-4",
      [SQUEEZE_WINDOW_MS_ENV]: "0",
      [SQUEEZE_RESERVE_ENV]: "not-a-number",
    });
    expect(limits.maxSqueezes).toBe(DEFAULT_MAX_SQUEEZES);
    expect(limits.maxUsdfc).toBe(DEFAULT_MAX_SQUEEZE_USDFC_24H);
    expect(limits.windowMs).toBe(DEFAULT_SQUEEZE_WINDOW_MS);
    expect(limits.reserveUsdfc).toBe(DEFAULT_SQUEEZE_RESERVE_USDFC);
  });

  it("allows a cap of zero, which closes the control entirely", () => {
    expect(squeezeCapLimits({ [MAX_SQUEEZES_ENV]: "0" }).maxSqueezes).toBe(0);
  });
});

describe("squeezeCapEnabled", () => {
  it("is on in LIVE and off in MOCK by default", () => {
    expect(squeezeCapEnabled("LIVE", {})).toBe(true);
    expect(squeezeCapEnabled("MOCK", {})).toBe(false);
  });

  it("honours an explicit override in both directions", () => {
    expect(squeezeCapEnabled("MOCK", { [SQUEEZE_CAP_ENV]: "on" })).toBe(true);
    expect(squeezeCapEnabled("LIVE", { [SQUEEZE_CAP_ENV]: "off" })).toBe(false);
    expect(squeezeCapEnabled("MOCK", { [SQUEEZE_CAP_ENV]: "1" })).toBe(true);
    expect(squeezeCapEnabled("LIVE", { [SQUEEZE_CAP_ENV]: "false" })).toBe(false);
  });

  it("falls back to the mode for an unrecognised override", () => {
    expect(squeezeCapEnabled("LIVE", { [SQUEEZE_CAP_ENV]: "maybe" })).toBe(true);
  });
});

describe("squeezeWindow", () => {
  it("counts and totals only what is inside the window", () => {
    const window = squeezeWindow(
      [entry("a", 1), entry("b", 10, "2"), entry("c", 30, "4")],
      NOW,
      24 * HOUR,
    );
    expect(window.count).toBe(2);
    expect(window.totalUsdfc).toBe("3");
    expect(window.oldestAt).toBe(NOW - 10 * HOUR);
    expect(window.relaxesAt).toBe(NOW - 10 * HOUR + 24 * HOUR);
  });

  it("treats a withdrawal exactly one window old as aged out", () => {
    expect(squeezeWindow([entry("a", 24)], NOW, 24 * HOUR).count).toBe(0);
    expect(squeezeWindow([entry("a", 23.99)], NOW, 24 * HOUR).count).toBe(1);
  });

  it("is empty, with no reset time, when nothing is inside it", () => {
    const window = squeezeWindow([], NOW, 24 * HOUR);
    expect(window).toEqual({ count: 0, totalUsdfc: "0", oldestAt: null, relaxesAt: null });
  });
});

describe("checkSqueezeCap — the withdrawal COUNT", () => {
  it("allows one under the limit", () => {
    const verdict = checkSqueezeCap([entry("a", 1), entry("b", 2)], "1", RICH, NOW, LIMITS);
    expect(verdict.allowed).toBe(true);
    expect(verdict.window.count).toBe(2);
  });

  it("allows the call that lands exactly ON the limit", () => {
    // Three is the maximum, so the third call must go through: a cap of 3 that
    // only ever permitted 2 would silently be a cap of 2.
    const verdict = checkSqueezeCap([entry("a", 1), entry("b", 2)], "1", RICH, NOW, LIMITS);
    expect(verdict.allowed).toBe(true);
  });

  it("refuses the call one OVER the limit", () => {
    const verdict = checkSqueezeCap(
      [entry("a", 1), entry("b", 2), entry("c", 3)],
      "1",
      RICH,
      NOW,
      LIMITS,
    );
    expect(verdict.allowed).toBe(false);
    expect(!verdict.allowed && verdict.limit).toBe("COUNT");
  });

  it("names the limit, what is used, and when it relaxes", () => {
    // A judge who hits this has to be able to tell a spent demo budget from a
    // broken deployment, without reading the source.
    const verdict = checkSqueezeCap(
      [entry("a", 1), entry("b", 2), entry("c", 3)],
      "1",
      RICH,
      NOW,
      LIMITS,
    );
    const reason = !verdict.allowed ? verdict.reason : "";
    expect(reason).toContain("3 of a maximum 3 squeezes");
    expect(reason).toContain("last 24h");
    expect(reason).toContain("No transaction was attempted");
    expect(reason).toContain("still ticking");
    expect(reason).toContain(MAX_SQUEEZES_ENV);
    // The oldest of the three is 3h old, so the window relaxes 21h from now.
    expect(reason).toContain(
      new Date(NOW - 3 * HOUR + 24 * HOUR).toISOString().slice(0, 10),
    );
  });

  it("lets the window roll: withdrawals older than 24h stop counting", () => {
    const verdict = checkSqueezeCap(
      [entry("a", 25), entry("b", 26), entry("c", 27)],
      "1",
      RICH,
      NOW,
      LIMITS,
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.window.count).toBe(0);
  });

  it("refuses everything when the cap is zero", () => {
    const verdict = checkSqueezeCap([], "1", RICH, NOW, { ...LIMITS, maxSqueezes: 0 });
    expect(verdict.allowed).toBe(false);
    expect(!verdict.allowed && verdict.limit).toBe("COUNT");
  });
});

describe("checkSqueezeCap — the withdrawal AMOUNT", () => {
  it("allows a request that lands exactly on the total", () => {
    // 4 already out plus 2 requested is exactly the 6 USDFC ceiling.
    const verdict = checkSqueezeCap([entry("a", 1, "4")], "2", RICH, NOW, LIMITS);
    expect(verdict.allowed).toBe(true);
  });

  it("allows one base unit under the total", () => {
    const verdict = checkSqueezeCap(
      [entry("a", 1, "4")],
      "1.999999999999999999",
      RICH,
      NOW,
      LIMITS,
    );
    expect(verdict.allowed).toBe(true);
  });

  it("refuses one base unit over the total, even when the count allows it", () => {
    const verdict = checkSqueezeCap(
      [entry("a", 1, "4")],
      "2.000000000000000001",
      RICH,
      NOW,
      LIMITS,
    );
    expect(verdict.allowed).toBe(false);
    expect(!verdict.allowed && verdict.limit).toBe("AMOUNT");
    const reason = !verdict.allowed ? verdict.reason : "";
    expect(reason).toContain("4.00 USDFC already withdrawn");
    expect(reason).toContain("against a cap of 6.00 USDFC");
    expect(reason).toContain(MAX_SQUEEZE_USDFC_ENV);
  });

  it("does the arithmetic in base units, not floats", () => {
    // 0.1 + 0.2 must not be 0.30000000000000004 anywhere near a money cap.
    const verdict = checkSqueezeCap(
      [entry("a", 1, "0.1"), entry("b", 2, "0.2")],
      "5.7",
      RICH,
      NOW,
      LIMITS,
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.window.totalUsdfc).toBe("0.3");
  });
});

describe("checkSqueezeCap — the reserve FLOOR", () => {
  it("allows a withdrawal that leaves exactly the reserve behind", () => {
    expect(checkSqueezeCap([], "1", "2", NOW, LIMITS).allowed).toBe(true);
  });

  it("refuses one base unit below the reserve", () => {
    const verdict = checkSqueezeCap([], "1.000000000000000001", "2", NOW, LIMITS);
    expect(verdict.allowed).toBe(false);
    expect(!verdict.allowed && verdict.limit).toBe("RESERVE");
    const reason = !verdict.allowed ? verdict.reason : "";
    expect(reason).toContain("reserve floor");
    expect(reason).toContain("1.00 USDFC");
    expect(reason).toContain("No transaction was attempted");
    expect(reason).toContain(SQUEEZE_RESERVE_ENV);
  });

  it("refuses a withdrawal that would empty the account outright", () => {
    // The floor is the difference between a demo that can recover and a
    // dashboard stuck on a true, permanent zero.
    const verdict = checkSqueezeCap([], "2", "2", NOW, LIMITS);
    expect(verdict.allowed).toBe(false);
    expect(!verdict.allowed && verdict.limit).toBe("RESERVE");
  });

  it("refuses rather than guesses when the unlocked balance is unreadable", () => {
    const verdict = checkSqueezeCap([], "1", "not-a-number", NOW, LIMITS);
    expect(verdict.allowed).toBe(false);
    expect(!verdict.allowed && verdict.reason).toContain("could not be read");
  });

  it("checks the rolling limits BEFORE the floor", () => {
    // Both are violated here. The window answer is the useful one: "come back
    // later" is actionable, "ask for less" is not when the budget is spent.
    const verdict = checkSqueezeCap(
      [entry("a", 1), entry("b", 2), entry("c", 3)],
      "50",
      "0.5",
      NOW,
      LIMITS,
    );
    expect(!verdict.allowed && verdict.limit).toBe("COUNT");
  });

  it("can be switched off with a zero reserve", () => {
    expect(
      checkSqueezeCap([], "2", "2", NOW, { ...LIMITS, reserveUsdfc: "0" }).allowed,
    ).toBe(true);
  });
});

describe("describeSqueezeCap", () => {
  it("states every bound, and that it never changes what the agent decides", () => {
    const line = describeSqueezeCap(LIMITS);
    expect(line).toContain("at most 3 squeezes");
    expect(line).toContain("6.00 USDFC out per 24h");
    expect(line).toContain("1.00 USDFC unlocked reserve");
    expect(line).toContain("never changes what the agent decides");
  });
});

describe("squeezeEntriesFrom", () => {
  it("keeps a recorded withdrawal, with its id, time and amount", () => {
    expect(
      squeezeEntriesFrom([{ id: "sqz_1", at: NOW, amountUsdfc: "1", txHash: "0xabc" }]),
    ).toEqual([{ id: "sqz_1", at: NOW, amountUsdfc: "1" }]);
  });

  it("drops a record whose amount is zero, negative or unparseable", () => {
    expect(
      squeezeEntriesFrom([
        { id: "a", at: NOW, amountUsdfc: "0" },
        { id: "b", at: NOW, amountUsdfc: "-1" },
        { id: "c", at: NOW, amountUsdfc: "banana" },
      ]),
    ).toEqual([]);
  });
});
