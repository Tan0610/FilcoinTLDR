/**
 * Spending-cap tests.
 *
 * The cap is the only thing standing between an unattended agent on a public
 * URL and an empty wallet, so the properties that matter are arithmetic ones:
 * the window really rolls, the total really includes the deposit being asked
 * for, and a deposit that did not stand does not count against it.
 *
 * `checkSpend` is pure — history, clock and limits are all arguments — so all
 * of that is testable without a chain, a store or a timer.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_DEPOSITS,
  DEFAULT_MAX_USDFC,
  DEFAULT_WINDOW_MS,
  MAX_DEPOSITS_ENV,
  MAX_USDFC_ENV,
  SPEND_CAP_ENV,
  WINDOW_MS_ENV,
  checkSpend,
  describeLimits,
  spendCapEnabled,
  spendEntriesFrom,
  spendLimits,
  spendWindow,
  type SpendEntry,
  type SpendLimits,
} from "./spendGuard";
import type { Decision, DecisionOutcome, PolicyRule } from "./types";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

const LIMITS: SpendLimits = {
  maxDeposits: 3,
  maxUsdfc: "20",
  windowMs: DEFAULT_WINDOW_MS,
};

function entry(id: string, hoursAgo: number, amountUsdfc: string): SpendEntry {
  return { id, at: NOW - hoursAgo * HOUR, amountUsdfc };
}

const RULE: PolicyRule = {
  id: "topup-7d",
  label: "SCHEDULED TOP-UP < 7d",
  thresholdDays: 7,
  action: "TOP_UP",
  topUpAmount: "5",
};

function decision(id: string, outcome: DecisionOutcome, at = NOW): Decision {
  return {
    id,
    at,
    snapshot: {
      takenAt: at,
      epoch: 2_960_000,
      fundsAvailable: "11.33568",
      lockupRate: "0.00041",
      lockupCurrent: "0.84870",
      epochsRemaining: 27_648,
      daysRemaining: 9.6,
      walletUsdfc: "250",
      walletFil: "4.9823",
    },
    ruleFired: RULE,
    action: "TOP_UP",
    reasoning: "fixture",
    outcome,
  };
}

describe("spendLimits", () => {
  it("defaults to a cap the shipped rule set can reach exactly once a day", () => {
    // One EMERGENCY_TOP_UP (15) plus one TOP_UP (5) is 20 USDFC: the agent can
    // answer a genuine emergency in full and must then stop.
    const limits = spendLimits({});
    expect(limits.maxDeposits).toBe(DEFAULT_MAX_DEPOSITS);
    expect(limits.maxUsdfc).toBe(DEFAULT_MAX_USDFC);
    expect(limits.windowMs).toBe(DEFAULT_WINDOW_MS);
  });

  it("reads overrides from the environment", () => {
    expect(
      spendLimits({
        [MAX_DEPOSITS_ENV]: "7",
        [MAX_USDFC_ENV]: "12.5",
        [WINDOW_MS_ENV]: "3600000",
      }),
    ).toEqual({ maxDeposits: 7, maxUsdfc: "12.5", windowMs: HOUR });
  });

  it("falls back to the defaults on a malformed value rather than throwing", () => {
    // A typo in an env var must not take the agent down, and must not silently
    // become an unlimited cap either.
    const limits = spendLimits({
      [MAX_DEPOSITS_ENV]: "lots",
      [MAX_USDFC_ENV]: "twenty",
      [WINDOW_MS_ENV]: "-1",
    });
    expect(limits).toEqual({
      maxDeposits: DEFAULT_MAX_DEPOSITS,
      maxUsdfc: DEFAULT_MAX_USDFC,
      windowMs: DEFAULT_WINDOW_MS,
    });
  });

  it("allows an explicit zero-deposit cap (a full stop)", () => {
    expect(spendLimits({ [MAX_DEPOSITS_ENV]: "0" }).maxDeposits).toBe(0);
  });
});

describe("spendCapEnabled", () => {
  it("is on in LIVE and off in MOCK, so the local demo is unchanged", () => {
    expect(spendCapEnabled("LIVE", {})).toBe(true);
    expect(spendCapEnabled("MOCK", {})).toBe(false);
  });

  it("honours an explicit override in both directions", () => {
    expect(spendCapEnabled("MOCK", { [SPEND_CAP_ENV]: "on" })).toBe(true);
    expect(spendCapEnabled("LIVE", { [SPEND_CAP_ENV]: "off" })).toBe(false);
  });
});

describe("spendWindow", () => {
  it("counts only deposits inside the window", () => {
    const window = spendWindow(
      [entry("a", 1, "5"), entry("b", 23, "5"), entry("c", 25, "5")],
      NOW,
      DEFAULT_WINDOW_MS,
    );
    expect(window.count).toBe(2);
    expect(window.totalUsdfc).toBe("10");
  });

  it("reports when the cap next relaxes", () => {
    const window = spendWindow([entry("a", 20, "5"), entry("b", 2, "5")], NOW, DEFAULT_WINDOW_MS);
    expect(window.oldestAt).toBe(NOW - 20 * HOUR);
    expect(window.relaxesAt).toBe(NOW - 20 * HOUR + DEFAULT_WINDOW_MS);
  });

  it("is empty, not broken, with no history", () => {
    expect(spendWindow([], NOW, DEFAULT_WINDOW_MS)).toEqual({
      count: 0,
      totalUsdfc: "0",
      oldestAt: null,
      relaxesAt: null,
    });
  });

  it("ignores a deposit stamped in the future", () => {
    expect(spendWindow([entry("a", -1, "5")], NOW, DEFAULT_WINDOW_MS).count).toBe(0);
  });
});

describe("checkSpend", () => {
  it("allows a deposit well inside both limits", () => {
    const verdict = checkSpend([entry("a", 2, "5")], "5", NOW, LIMITS);
    expect(verdict.allowed).toBe(true);
  });

  it("declines on the deposit COUNT", () => {
    const history = [entry("a", 1, "1"), entry("b", 2, "1"), entry("c", 3, "1")];
    const verdict = checkSpend(history, "1", NOW, LIMITS);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error("unreachable");
    expect(verdict.limit).toBe("COUNT");
    expect(verdict.reason).toContain("safety cap");
    expect(verdict.reason).toContain("No transaction was attempted");
    expect(verdict.reason).toContain(MAX_DEPOSITS_ENV);
  });

  it("declines on the cumulative AMOUNT, counting the deposit being asked for", () => {
    // 18 already spent, cap 20, this rule wants 5 -> 23. The amount under
    // consideration has to be included or the cap is only ever enforced one
    // deposit too late.
    const verdict = checkSpend([entry("a", 1, "18")], "5", NOW, LIMITS);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error("unreachable");
    expect(verdict.limit).toBe("AMOUNT");
    expect(verdict.reason).toContain("23.00");
    expect(verdict.reason).toContain("20.00");
  });

  it("allows a deposit that lands exactly on the amount cap", () => {
    const verdict = checkSpend([entry("a", 1, "15")], "5", NOW, LIMITS);
    expect(verdict.allowed).toBe(true);
  });

  it("lets the window roll: an aged-out deposit stops counting", () => {
    const history = [entry("a", 25, "5"), entry("b", 26, "5"), entry("c", 27, "5")];
    expect(checkSpend(history, "5", NOW, LIMITS).allowed).toBe(true);
  });

  it("declines everything at a zero cap", () => {
    const verdict = checkSpend([], "5", NOW, { ...LIMITS, maxDeposits: 0 });
    expect(verdict.allowed).toBe(false);
  });

  it("names when the cap relaxes, so the refusal is actionable", () => {
    const history = [entry("a", 6, "1"), entry("b", 2, "1"), entry("c", 1, "1")];
    const verdict = checkSpend(history, "1", NOW, LIMITS);
    if (verdict.allowed) throw new Error("unreachable");
    expect(verdict.reason).toContain(
      new Date(NOW - 6 * HOUR + DEFAULT_WINDOW_MS).toISOString().slice(0, 10),
    );
  });
});

describe("spendEntriesFrom", () => {
  it("counts EXECUTED decisions only", () => {
    const entries = spendEntriesFrom([
      decision("x", "EXECUTED"),
      decision("y", "PENDING"),
      decision("z", "FAILED"),
      decision("w", "NO_ACTION"),
    ]);
    expect(entries.map((e) => e.id)).toEqual(["x"]);
    expect(entries[0].amountUsdfc).toBe("5");
  });

  it("ignores an executed decision with no rule or a zero amount", () => {
    const noRule = { ...decision("n", "EXECUTED"), ruleFired: null };
    const zero = {
      ...decision("z", "EXECUTED"),
      ruleFired: { ...RULE, topUpAmount: "0" },
    };
    expect(spendEntriesFrom([noRule, zero])).toEqual([]);
  });
});

describe("describeLimits", () => {
  it("states the limits and that reaching them is a decision, not a failure", () => {
    const text = describeLimits(LIMITS);
    expect(text).toContain("3 deposits");
    expect(text).toContain("20.00 USDFC");
    expect(text).toContain("24h");
    expect(text).toContain("never transacts");
  });
});
