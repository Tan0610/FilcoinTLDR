/**
 * Bounds on the operator's squeeze.
 *
 * The control exists to move real money out of Filecoin Pay on a demo account.
 * Two things must hold: it can never exceed its configured ceiling, and it can
 * never ask for more than the account has unlocked — because Filecoin Pay would
 * revert that, and a reverted transaction on the explorer would look like the
 * agent's mistake rather than the operator's.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_SQUEEZE_USDFC,
  DEFAULT_SQUEEZE_USDFC,
  SQUEEZE_AMOUNT_ENV,
  SQUEEZE_MAX_ENV,
  planSqueeze,
  squeezeLimits,
} from "./squeeze";

const LIMITS = { defaultUsdfc: "1", maxUsdfc: "5" };

describe("squeezeLimits", () => {
  it("falls back to the shipped defaults when unset", () => {
    expect(squeezeLimits({})).toEqual({
      defaultUsdfc: DEFAULT_SQUEEZE_USDFC,
      maxUsdfc: DEFAULT_MAX_SQUEEZE_USDFC,
    });
  });

  it("reads both bounds from the environment", () => {
    expect(
      squeezeLimits({ [SQUEEZE_AMOUNT_ENV]: "2.5", [SQUEEZE_MAX_ENV]: "10" }),
    ).toEqual({ defaultUsdfc: "2.5", maxUsdfc: "10" });
  });

  it("ignores a malformed or non-positive bound rather than throwing", () => {
    // A typo in an env var must not take the endpoint down, and must not
    // silently widen the ceiling either.
    expect(squeezeLimits({ [SQUEEZE_MAX_ENV]: "banana" }).maxUsdfc).toBe(
      DEFAULT_MAX_SQUEEZE_USDFC,
    );
    expect(squeezeLimits({ [SQUEEZE_MAX_ENV]: "0" }).maxUsdfc).toBe(DEFAULT_MAX_SQUEEZE_USDFC);
    expect(squeezeLimits({ [SQUEEZE_AMOUNT_ENV]: "-3" }).defaultUsdfc).toBe(
      DEFAULT_SQUEEZE_USDFC,
    );
  });
});

describe("planSqueeze", () => {
  it("uses the configured default when the caller names no amount", () => {
    for (const requested of [undefined, null, "", "   "]) {
      const plan = planSqueeze(requested, "10", LIMITS);
      expect(plan.ok && plan.amountUsdfc).toBe("1");
    }
  });

  it("allows an explicit amount inside both bounds", () => {
    const plan = planSqueeze("4", "10", LIMITS);
    expect(plan.ok && plan.amountUsdfc).toBe("4");
    expect(plan.ok && plan.note).toContain("HUMAN action");
  });

  it("allows exactly the ceiling, and refuses a hair above it", () => {
    expect(planSqueeze("5", "10", LIMITS).ok).toBe(true);
    const over = planSqueeze("5.000000000000000001", "10", LIMITS);
    expect(over.ok).toBe(false);
    expect(!over.ok && over.reason).toContain(SQUEEZE_MAX_ENV);
  });

  it("refuses an amount larger than the unlocked balance rather than clamping", () => {
    // Clamping would be worse than refusing: an operator who asked for 5 and
    // silently got 0.31 would misread every runway figure that followed.
    const plan = planSqueeze("5", "0.31", LIMITS);
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.reason).toContain("leave the account in debt");
    expect(!plan.ok && plan.reason).toContain("0.310000");
    expect(!plan.ok && plan.reason).toContain("Nothing was submitted");
  });

  it("allows a withdrawal of exactly the unlocked balance", () => {
    // The boundary is "would leave it in debt", not "would leave it empty".
    expect(planSqueeze("2", "2", LIMITS).ok).toBe(true);
  });

  it("refuses when the account has no unlocked funds at all", () => {
    const plan = planSqueeze(undefined, "0", LIMITS);
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.reason).toContain("no unlocked funds");
  });

  it("refuses a malformed or non-positive request, quoting what it was given", () => {
    for (const bad of ["banana", "0", "-1", "1e18"]) {
      const plan = planSqueeze(bad, "10", LIMITS);
      expect(plan.ok).toBe(false);
      expect(!plan.ok && plan.reason).toContain(JSON.stringify(bad));
    }
  });

  it("refuses when the unlocked balance itself is unreadable", () => {
    const plan = planSqueeze("1", "not-a-number", LIMITS);
    expect(plan.ok).toBe(false);
    expect(!plan.ok && plan.reason).toContain("could not be read");
  });
});
