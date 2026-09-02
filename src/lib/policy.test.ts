import { describe, expect, it } from "vitest";

import { EPOCHS_PER_DAY } from "./constants";
import { ALWAYS_THRESHOLD_DAYS, DEFAULT_RULES, evaluate, selectRule } from "./policy";
import type { PolicyRule, RunwaySnapshot } from "./types";
import { formatUnits, parseUnits } from "./units";

const RATE = "0.00041";
const FIXED = { now: 1_700_000_000_000, id: "dec_test" } as const;

/** Build a self-consistent snapshot with exactly `epochsRemaining` of runway. */
function snapAtEpochs(
  epochsRemaining: number,
  overrides: Partial<RunwaySnapshot> = {},
): RunwaySnapshot {
  const rate = overrides.lockupRate ?? RATE;
  const fundsAvailable =
    overrides.fundsAvailable ?? formatUnits(parseUnits(rate) * BigInt(epochsRemaining));
  return {
    takenAt: FIXED.now,
    epoch: 2_960_000,
    fundsAvailable,
    lockupRate: rate,
    lockupCurrent: "0.84870",
    epochsRemaining,
    daysRemaining: epochsRemaining / EPOCHS_PER_DAY,
    walletUsdfc: "250",
    walletFil: "4.9823",
    ...overrides,
  };
}

const days = (d: number) => d * EPOCHS_PER_DAY;

describe("selectRule", () => {
  it("picks the most severe matching rule regardless of input order", () => {
    const shuffled = [...DEFAULT_RULES].reverse();
    expect(selectRule(1, shuffled)?.action).toBe("EMERGENCY_TOP_UP");
    expect(selectRule(5, shuffled)?.action).toBe("TOP_UP");
    expect(selectRule(30, shuffled)?.action).toBe("HOLD");
  });

  it("returns null when no rule matches", () => {
    const rules: PolicyRule[] = [
      { id: "a", label: "a", thresholdDays: 1, action: "TOP_UP", topUpAmount: "5" },
    ];
    expect(selectRule(10, rules)).toBeNull();
  });
});

describe("evaluate — threshold boundaries", () => {
  it("holds comfortably above the 7-day threshold", () => {
    const decision = evaluate(snapAtEpochs(days(9.6)), DEFAULT_RULES, FIXED);
    expect(decision.action).toBe("HOLD");
    expect(decision.outcome).toBe("NO_ACTION");
    expect(decision.ruleFired?.id).toBe("hold");
    expect(decision.txHash).toBeUndefined();
  });

  it("holds at exactly 7.0 days (threshold is strict less-than)", () => {
    const decision = evaluate(snapAtEpochs(days(7)), DEFAULT_RULES, FIXED);
    expect(decision.snapshot.daysRemaining).toBe(7);
    expect(decision.action).toBe("HOLD");
  });

  it("tops up one epoch below 7 days", () => {
    const decision = evaluate(snapAtEpochs(days(7) - 1), DEFAULT_RULES, FIXED);
    expect(decision.action).toBe("TOP_UP");
    expect(decision.outcome).toBe("PENDING");
    expect(decision.ruleFired?.id).toBe("topup-7d");
    expect(decision.ruleFired?.topUpAmount).toBe("5");
  });

  it("still uses the standard top-up at exactly 2.0 days", () => {
    const decision = evaluate(snapAtEpochs(days(2)), DEFAULT_RULES, FIXED);
    expect(decision.snapshot.daysRemaining).toBe(2);
    expect(decision.action).toBe("TOP_UP");
    expect(decision.ruleFired?.topUpAmount).toBe("5");
  });

  it("escalates to an emergency top-up one epoch below 2 days", () => {
    const decision = evaluate(snapAtEpochs(days(2) - 1), DEFAULT_RULES, FIXED);
    expect(decision.action).toBe("EMERGENCY_TOP_UP");
    expect(decision.outcome).toBe("PENDING");
    expect(decision.ruleFired?.id).toBe("emergency-2d");
    expect(decision.ruleFired?.topUpAmount).toBe("15");
  });

  it("escalates when the runway is fully exhausted", () => {
    const decision = evaluate(snapAtEpochs(0), DEFAULT_RULES, FIXED);
    expect(decision.action).toBe("EMERGENCY_TOP_UP");
  });
});

describe("evaluate — reasoning", () => {
  it("cites days, epochs, burn rate, threshold and the projected runway", () => {
    // 4.2 days of runway.
    const decision = evaluate(snapAtEpochs(days(4.2)), DEFAULT_RULES, FIXED);
    expect(decision.reasoning).toContain("Runway 4.2 days");
    expect(decision.reasoning).toContain("12,096 epochs");
    expect(decision.reasoning).toContain("below the 7-day top-up threshold");
    expect(decision.reasoning).toContain("0.00041 USDFC/epoch");
    expect(decision.reasoning).toContain("Depositing 5 USDFC extends runway to ~8.4 days");
  });

  it("labels the emergency threshold distinctly", () => {
    const decision = evaluate(snapAtEpochs(days(1.5)), DEFAULT_RULES, FIXED);
    expect(decision.reasoning).toContain("below the 2-day emergency threshold");
    expect(decision.reasoning).toContain("Depositing 15 USDFC");
  });

  it("explains a hold against the top-up threshold", () => {
    const decision = evaluate(snapAtEpochs(days(9.6)), DEFAULT_RULES, FIXED);
    expect(decision.reasoning).toContain("at or above the 7-day top-up threshold");
    expect(decision.reasoning).toContain("No deposit required.");
  });

  it("adds no demo-timescale clause when nothing is scaled", () => {
    for (const days_ of [1, 4.2, 9.6]) {
      const decision = evaluate(snapAtEpochs(days(days_)), DEFAULT_RULES, FIXED);
      expect(decision.reasoning).not.toContain("demo timescale");
    }
  });

  it("states the shortfall, and the remedy, when the wallet cannot cover the deposit", () => {
    const decision = evaluate(
      snapAtEpochs(days(1), { walletUsdfc: "3.5" }),
      DEFAULT_RULES,
      FIXED,
    );
    expect(decision.reasoning).toBe(
      "Runway 1.0 days (2,880 epochs) is below the 2-day emergency threshold. " +
        "Burn rate 0.00041 USDFC/epoch against 1.18 USDFC available. " +
        "The rule calls for a 15 USDFC deposit but the wallet holds 3.50 USDFC — " +
        "a shortfall of 11.50 USDFC. No deposit attempted: fund the agent wallet with " +
        "at least 11.50 USDFC for this rule to execute.",
    );
  });
});

describe("evaluate — insufficient wallet funds", () => {
  it("proceeds when the wallet exactly equals the deposit amount", () => {
    const decision = evaluate(
      snapAtEpochs(days(4.2), { walletUsdfc: "5" }),
      DEFAULT_RULES,
      FIXED,
    );
    expect(decision.action).toBe("TOP_UP");
    expect(decision.outcome).toBe("PENDING");
    expect(decision.reasoning).toContain("Depositing 5 USDFC extends runway");
    expect(decision.reasoning).not.toContain("shortfall");
  });

  it("blocks one base unit below the deposit amount", () => {
    const decision = evaluate(
      snapAtEpochs(days(4.2), { walletUsdfc: "4.999999999999999999" }),
      DEFAULT_RULES,
      FIXED,
    );
    expect(decision.action).toBe("INSUFFICIENT_FUNDS");
    expect(decision.outcome).toBe("NO_ACTION");
    expect(decision.ruleFired?.id).toBe("topup-7d");
    expect(decision.txHash).toBeUndefined();
    expect(decision.error).toBeUndefined();
  });

  it("blocks on a zero wallet balance and quotes the whole deposit as the shortfall", () => {
    const decision = evaluate(
      snapAtEpochs(days(4.2), { walletUsdfc: "0" }),
      DEFAULT_RULES,
      FIXED,
    );
    expect(decision.action).toBe("INSUFFICIENT_FUNDS");
    expect(decision.outcome).toBe("NO_ACTION");
    expect(decision.reasoning).toContain("the wallet holds 0.00 USDFC");
    expect(decision.reasoning).toContain("a shortfall of 5.00 USDFC");
    expect(decision.reasoning).toContain("fund the agent wallet with at least 5.00 USDFC");
  });

  it("routes an unaffordable EMERGENCY_TOP_UP here too", () => {
    const decision = evaluate(
      snapAtEpochs(days(1), { walletUsdfc: "3.5" }),
      DEFAULT_RULES,
      FIXED,
    );
    expect(decision.ruleFired?.id).toBe("emergency-2d");
    expect(decision.ruleFired?.action).toBe("EMERGENCY_TOP_UP");
    expect(decision.action).toBe("INSUFFICIENT_FUNDS");
    expect(decision.outcome).toBe("NO_ACTION");
  });

  it("never promises a projected runway it cannot buy", () => {
    const decision = evaluate(
      snapAtEpochs(days(1), { walletUsdfc: "0" }),
      DEFAULT_RULES,
      FIXED,
    );
    expect(decision.reasoning).not.toContain("extends runway");
    expect(decision.reasoning).toContain("No deposit attempted");
  });

  it("still cites the runway reading that triggered the rule", () => {
    const decision = evaluate(
      snapAtEpochs(days(4.2), { walletUsdfc: "1" }),
      DEFAULT_RULES,
      FIXED,
    );
    expect(decision.reasoning).toContain("Runway 4.2 days (12,096 epochs)");
    expect(decision.reasoning).toContain("below the 7-day top-up threshold");
    expect(decision.reasoning).toContain("0.00041 USDFC/epoch");
  });

  it("is pure and leaves the snapshot untouched", () => {
    const snapshot = snapAtEpochs(days(1), { walletUsdfc: "3.5" });
    const frozen = JSON.stringify(snapshot);
    const a = evaluate(snapshot, DEFAULT_RULES, FIXED);
    const b = evaluate(snapshot, DEFAULT_RULES, FIXED);
    expect(a).toEqual(b);
    expect(JSON.stringify(snapshot)).toBe(frozen);
  });
});

describe("evaluate — edge cases and purity", () => {
  it("holds when the burn rate is zero (runway is unbounded)", () => {
    const snapshot = snapAtEpochs(0, {
      lockupRate: "0",
      fundsAvailable: "10",
      epochsRemaining: Number.POSITIVE_INFINITY,
      daysRemaining: Number.POSITIVE_INFINITY,
    });
    const decision = evaluate(snapshot, DEFAULT_RULES, FIXED);
    expect(decision.action).toBe("HOLD");
    expect(decision.reasoning).toContain("unbounded");
  });

  it("returns ruleFired=null and HOLD when no rule matches", () => {
    const rules: PolicyRule[] = [
      { id: "only", label: "only", thresholdDays: 1, action: "TOP_UP", topUpAmount: "5" },
    ];
    const decision = evaluate(snapAtEpochs(days(5)), rules, FIXED);
    expect(decision.ruleFired).toBeNull();
    expect(decision.action).toBe("HOLD");
    expect(decision.outcome).toBe("NO_ACTION");
    expect(decision.reasoning).toContain("at or above the 1-day top-up threshold");
  });

  it("says so when the rule set contains no top-up rule at all", () => {
    const decision = evaluate(snapAtEpochs(days(5)), [], FIXED);
    expect(decision.ruleFired).toBeNull();
    expect(decision.action).toBe("HOLD");
    expect(decision.reasoning).toContain("no top-up rule is configured");
  });

  it("is pure: same inputs produce identical output and inputs are untouched", () => {
    const snapshot = snapAtEpochs(days(3));
    const frozenSnapshot = JSON.stringify(snapshot);
    const frozenRules = JSON.stringify(DEFAULT_RULES);

    const a = evaluate(snapshot, DEFAULT_RULES, FIXED);
    const b = evaluate(snapshot, DEFAULT_RULES, FIXED);

    expect(a).toEqual(b);
    expect(JSON.stringify(snapshot)).toBe(frozenSnapshot);
    expect(JSON.stringify(DEFAULT_RULES)).toBe(frozenRules);
    expect(a.at).toBe(FIXED.now);
    expect(a.id).toBe(FIXED.id);
  });

  it("keeps the catch-all HOLD rule JSON-serialisable", () => {
    const decision = evaluate(snapAtEpochs(days(20)), DEFAULT_RULES, FIXED);
    const roundTripped = JSON.parse(JSON.stringify(decision)) as typeof decision;
    expect(roundTripped.ruleFired?.thresholdDays).toBe(ALWAYS_THRESHOLD_DAYS);
    expect(Number.isFinite(roundTripped.ruleFired?.thresholdDays)).toBe(true);
  });
});
