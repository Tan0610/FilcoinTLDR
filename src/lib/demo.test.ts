/**
 * The demo timescale must never touch a chain reading — only thresholds. These
 * tests pin that property down, because it is the whole honesty argument.
 */

import { describe, expect, it } from "vitest";

import { GAUGE_MAX_DAYS } from "./constants";
import {
  DEMO_SCALE_AGREEMENT,
  demoScaleAgreement,
  demoScaleNote,
  parseDemoScale,
  scaleRules,
  suggestDemoScale,
} from "./demo";
import { ALWAYS_THRESHOLD_DAYS, DEFAULT_RULES, evaluate, selectRule } from "./policy";
import type { RunwaySnapshot } from "./types";

describe("parseDemoScale", () => {
  it("defaults to 1 for anything unusable", () => {
    for (const raw of [undefined, null, "", "   ", "abc", "0", "-5", "NaN"]) {
      expect(parseDemoScale(raw)).toBe(1);
    }
  });

  it("accepts a positive numeric scale", () => {
    expect(parseDemoScale("1000")).toBe(1000);
    expect(parseDemoScale("2.5")).toBe(2.5);
  });

  it("clamps absurd values so the catch-all threshold stays a safe integer", () => {
    expect(parseDemoScale("1e30")).toBe(1e9);
  });
});

describe("scaleRules", () => {
  it("is the identity at scale 1", () => {
    expect(scaleRules(DEFAULT_RULES, 1)).toBe(DEFAULT_RULES);
  });

  it("multiplies finite thresholds and labels the scaling", () => {
    const scaled = scaleRules(DEFAULT_RULES, 1000);
    const emergency = scaled.find((r) => r.id === "emergency-2d");
    const topUp = scaled.find((r) => r.id === "topup-7d");

    expect(emergency?.thresholdDays).toBe(2000);
    expect(topUp?.thresholdDays).toBe(7000);
    expect(topUp?.label).toContain("DEMO");
  });

  it("leaves the catch-all HOLD threshold alone so it stays JSON-safe", () => {
    const hold = scaleRules(DEFAULT_RULES, 1000).find((r) => r.id === "hold");
    expect(hold?.thresholdDays).toBe(ALWAYS_THRESHOLD_DAYS);
    expect(Number.isFinite(hold?.thresholdDays)).toBe(true);
  });

  it("never mutates the input rules", () => {
    const frozen = JSON.stringify(DEFAULT_RULES);
    scaleRules(DEFAULT_RULES, 1000);
    expect(JSON.stringify(DEFAULT_RULES)).toBe(frozen);
  });

  it("does not change top-up amounts, only thresholds", () => {
    const scaled = scaleRules(DEFAULT_RULES, 1000);
    expect(scaled.map((r) => r.topUpAmount)).toEqual(DEFAULT_RULES.map((r) => r.topUpAmount));
  });

  it("fires the same rules a thousand days out that the base set fires one day out", () => {
    const scaled = scaleRules(DEFAULT_RULES, 1000);
    expect(selectRule(1_000, scaled)?.action).toBe("EMERGENCY_TOP_UP");
    expect(selectRule(5_000, scaled)?.action).toBe("TOP_UP");
    expect(selectRule(30_000, scaled)?.action).toBe("HOLD");
  });
});

describe("scaled policy still reasons over the TRUE reading", () => {
  const snapshot: RunwaySnapshot = {
    takenAt: 1_700_000_000_000,
    epoch: 2_960_000,
    fundsAvailable: "5",
    lockupRate: "0.00000095",
    lockupCurrent: "0.1",
    epochsRemaining: 5_263_157,
    daysRemaining: 1_827.48,
    walletUsdfc: "250",
    walletFil: "5",
  };

  it("cites the real day count, not a rescaled one", () => {
    const decision = evaluate(snapshot, scaleRules(DEFAULT_RULES, 1000), {
      now: 1,
      id: "d",
      demoScale: 1000,
    });
    expect(decision.action).toBe("EMERGENCY_TOP_UP");
    expect(decision.reasoning).toContain("Runway 1827.5 days");
    expect(decision.reasoning).toContain("below the 2000-day emergency threshold");
    expect(decision.snapshot.daysRemaining).toBe(1_827.48);
  });

  // A decision card is routinely screenshotted without the gauge header in
  // frame. If the scaling is not stated in the reasoning itself, that crop
  // carries no disclosure at all.
  it("discloses the timescale in the reasoning, naming the unscaled rule", () => {
    const decision = evaluate(snapshot, scaleRules(DEFAULT_RULES, 1000), {
      now: 1,
      id: "d",
      demoScale: 1000,
    });
    expect(decision.reasoning).toContain(
      "Threshold shown is the 2-day rule at the ×1,000 demo timescale.",
    );
  });

  it("discloses the timescale on a HOLD as well as on an action", () => {
    const healthy: RunwaySnapshot = { ...snapshot, daysRemaining: 30_000 };
    const decision = evaluate(healthy, scaleRules(DEFAULT_RULES, 1000), {
      now: 1,
      id: "d",
      demoScale: 1000,
    });
    expect(decision.action).toBe("HOLD");
    expect(decision.reasoning).toContain("at or above the 7000-day top-up threshold");
    expect(decision.reasoning).toContain(
      "Threshold shown is the 7-day rule at the ×1,000 demo timescale.",
    );
  });

  it("adds nothing at all at scale 1 — the disclosure is an identity there", () => {
    const unscaled = evaluate(snapshot, DEFAULT_RULES, { now: 1, id: "d", demoScale: 1 });
    expect(unscaled.reasoning).not.toContain("demo timescale");
    expect(unscaled.reasoning).not.toContain("Threshold shown");
  });

  it("survives a scale that does not divide the threshold evenly", () => {
    // x380 is the scale the live demo actually runs at: 7 x 380 = 2,660, and
    // 2660 / 380 is 7.000000000000001 in binary floating point.
    const scaled = scaleRules(DEFAULT_RULES, 380);
    const decision = evaluate({ ...snapshot, daysRemaining: 2_000 }, scaled, {
      now: 1,
      id: "d",
      demoScale: 380,
    });
    expect(decision.reasoning).toContain("below the 2660-day top-up threshold");
    expect(decision.reasoning).toContain(
      "Threshold shown is the 7-day rule at the ×380 demo timescale.",
    );
  });
});

describe("demoScaleNote", () => {
  it("is the empty string at scale 1, whatever the threshold", () => {
    expect(demoScaleNote(7, 1)).toBe("");
    expect(demoScaleNote(null, 1)).toBe("");
  });

  it("names the unscaled rule and the scale", () => {
    expect(demoScaleNote(7, 380)).toBe(
      " Threshold shown is the 7-day rule at the ×380 demo timescale.",
    );
  });

  it("falls back to a threshold-free wording when there is no rule to cite", () => {
    expect(demoScaleNote(null, 1000)).toContain("Policy thresholds run at the");
    expect(demoScaleNote(null, 1000)).toContain("chain readings are unscaled");
  });
});

describe("suggestDemoScale", () => {
  it("suggests no scaling when the runway already fits the gauge", () => {
    expect(suggestDemoScale(9.6)).toBe(1);
    expect(suggestDemoScale(GAUGE_MAX_DAYS)).toBe(1);
  });

  it("suggests a tidy power of ten that lands the runway inside the gauge", () => {
    const scale = suggestDemoScale(5_200);
    expect(scale).toBe(1000);
    expect(5_200 / scale).toBeLessThan(GAUGE_MAX_DAYS);
  });

  it("handles a non-finite runway without proposing nonsense", () => {
    expect(suggestDemoScale(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

/**
 * CLIENT / SERVER AGREEMENT
 *
 * The gauge draws its axis in the browser and the policy engine picks its
 * thresholds on the server. They read the same setting, but not the same
 * environment: Next.js inlines only `NEXT_PUBLIC_*` into the client bundle, so
 * a server-only `FILRUNWAY_DEMO_SCALE` leaves the browser resolving 1 while the
 * agent runs at N — a 14-day axis under a 7,000-day policy, with every decision
 * card citing a threshold the gauge cannot show.
 *
 * This CANNOT be asserted by comparing the two `DEMO_SCALE` constants directly.
 * A unit test runs in one Node process where both `process.env` values are
 * visible, so the client-side constant would resolve to the server's value and
 * the two would agree no matter how the app is configured. The divergence is a
 * property of the BUILD, not of the module. So it is expressed as a pure
 * function of the two raw values and checked here — and `ensureAgentLoop()`
 * logs it at startup, which is where a real misconfiguration gets caught.
 */
describe("demoScaleAgreement", () => {
  it("agrees when the public variable is the one that is set", () => {
    expect(demoScaleAgreement("380", undefined)).toEqual({
      client: 380,
      server: 380,
      agree: true,
    });
  });

  it("agrees when both are set to the same value", () => {
    expect(demoScaleAgreement("1000", "1000").agree).toBe(true);
  });

  it("agrees when neither is set: both sides resolve to 1", () => {
    expect(demoScaleAgreement(undefined, undefined)).toEqual({
      client: 1,
      server: 1,
      agree: true,
    });
  });

  it("catches the trap: a server-only scale the gauge will never see", () => {
    const result = demoScaleAgreement(undefined, "380");
    expect(result.server).toBe(380);
    expect(result.client).toBe(1);
    expect(result.agree).toBe(false);
  });

  it("mirrors readRawScale's precedence, so the public value wins outright", () => {
    // `??` on a set-but-different public value: the server uses the public one,
    // which is exactly what the browser will use too.
    expect(demoScaleAgreement("10", "1000")).toEqual({ client: 10, server: 10, agree: true });
  });

  it("agrees on values both sides would reject the same way", () => {
    expect(demoScaleAgreement("nonsense", "nonsense").agree).toBe(true);
    expect(demoScaleAgreement("", "380")).toEqual({ client: 1, server: 1, agree: true });
  });

  it("reports this process's own configuration", () => {
    // Whatever the test environment is, the two constants are derived the same
    // way, so the process-wide reading is internally consistent.
    expect(DEMO_SCALE_AGREEMENT.agree).toBe(
      DEMO_SCALE_AGREEMENT.client === DEMO_SCALE_AGREEMENT.server,
    );
  });
});
