/**
 * Demo timescale — an honest fix for an unwatchable real number.
 *
 * THE PROBLEM
 * -----------
 * Filecoin Warm Storage on Calibration charges $2.50/TiB/month/copy plus
 * $0.024/data-set/month, per data set — and uploads default to 2 copies.
 * `synapse.storage.upload()` takes that default (`DEFAULT_COPY_COUNT` in
 * `@filoz/synapse-sdk`), and each copy is written through its own
 * `StorageContext`, which opens its own data set on first commit. So a single
 * demo upload opens TWO data sets, not one, and the per-data-set fee is
 * charged twice.
 *
 * Measured live on Calibration (wallet
 * 0x48c54EAb7039f43DcAEd14ba44b999E16a9309bD, 1 MiB uploaded at 2 copies ->
 * data sets 32836 and 32837):
 *
 *   burn/epoch   : 0.000002777832968892 USDFC
 *   burn/month   : 0.240005 USDFC
 *   fixed lockup : 0.928000 USDFC   (covers both data sets)
 *   rate lockup  : 0.240008 USDFC
 *
 * The fixed per-data-set lockup (0.928) is roughly 4x the rate-based lockup
 * (0.240): at this scale nearly all of the burn comes from having two data
 * sets open at all, not from the 1 MiB of actual data stored.
 *
 * Fund that account with a normal 5 USDFC top-up and the true runway is about
 * 5 / 0.240005 x 30 ≈ 625 days — under two years. A runway gauge scaled to 14
 * days would still peg at full and never move, and no policy threshold
 * expressed in days would ever fire. Uploading enough real data to make the
 * burn visible is not an option either: you would need roughly 7 TiB of live
 * storage to burn ~1.2 USDFC/day from the rate-based fee alone, which is
 * thousands of maximum-size uploads.
 *
 * THE FIX
 * -------
 * `FILRUNWAY_DEMO_SCALE` (default 1) multiplies the agent's POLICY THRESHOLDS
 * and the gauge's GRADUATIONS by N. It does not touch a single number read from
 * the chain.
 *
 *   - `RunwaySnapshot.daysRemaining`, `.epochsRemaining`, `.fundsAvailable`,
 *     `.lockupRate`, `.lockupCurrent`, `.walletUsdfc`, `.walletFil` and
 *     `.epoch` are always the exact values returned by
 *     `payments.accountSummary()` / `payments.walletBalance()`.
 *   - With N = 1000, "top up below 7 days" becomes "top up below 7,000 days"
 *     and the gauge's full scale becomes 14,000 days. The needle moves and the
 *     agent crosses its own thresholds, but the number printed in the middle of
 *     the gauge is still the true onchain runway.
 *
 * Read it as: "for this demo, treat a thousand days of runway the way a
 * production agent would treat one day." The agent's behaviour is real; only
 * its risk appetite is rescaled, and the rescaling is disclosed in three
 * independent places, so that no single cropped screenshot can hide it:
 *
 *   - the gauge header carries `DEMO_LABEL`;
 *   - every scaled rule label carries `demoRuleSuffix()`, and `ruleLabel()`
 *     adds it to the catch-all HOLD rule that `scaleRules` skips;
 *   - every decision's `reasoning` ends with `demoScaleNote()`, e.g.
 *     "Threshold shown is the 7-day rule at the x380 demo timescale.", so a
 *     decision card is self-disclosing with the gauge out of frame.
 *
 * At scale 1 all three are the empty string and nothing is added anywhere.
 *
 * TRADEOFF
 * --------
 * Scaling thresholds rather than readings is the only variant that keeps the
 * displayed chain data literally true. The cost is that the words "7-day
 * threshold" in the UI become "7,000-day threshold", which needs the one-line
 * explanation that the gauge header carries. The alternative — dividing
 * `daysRemaining` by N before display — would show a number that is not the
 * chain's, and is rejected for that reason.
 *
 * CONFIGURATION
 * -------------
 * Set `NEXT_PUBLIC_FILRUNWAY_DEMO_SCALE`. The gauge is a client component, and
 * Next.js only inlines `NEXT_PUBLIC_*` into client bundles, so the plain
 * `FILRUNWAY_DEMO_SCALE` is honoured on the server only (policy engine, agent
 * loop, bootstrap CLI). Setting only the server variable would make the agent
 * act on scaled thresholds while the gauge still drew a 14-day axis, so prefer
 * the public one — or set both to the same value.
 */

import { BAND_CRITICAL_DAYS, BAND_WARNING_DAYS, GAUGE_MAX_DAYS } from "./constants";
import type { PolicyRule } from "./types";

/** Anything at or above this is the policy engine's catch-all and is never scaled. */
const CATCH_ALL_THRESHOLD_DAYS = Number.MAX_SAFE_INTEGER;

function readRawScale(): string | undefined {
  if (typeof process === "undefined") return undefined;
  // Both literals must be written out in full: Next.js replaces the exact text
  // `process.env.NEXT_PUBLIC_*` at build time and cannot see a computed key.
  return process.env.NEXT_PUBLIC_FILRUNWAY_DEMO_SCALE ?? process.env.FILRUNWAY_DEMO_SCALE;
}

/** Parse + clamp. Anything unusable falls back to 1 (i.e. no scaling at all). */
export function parseDemoScale(raw: string | undefined | null): number {
  if (raw == null || raw.trim() === "") return 1;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return 1;
  // Keep the scaled catch-all threshold comfortably inside Number.MAX_SAFE_INTEGER.
  return Math.min(value, 1e9);
}

/** Multiplier applied to policy thresholds and gauge graduations. 1 = off. */
export const DEMO_SCALE = parseDemoScale(readRawScale());

/** True when a demo timescale is in force and the UI must say so. */
export const DEMO_SCALED = DEMO_SCALE !== 1;

export const DEMO_BAND_CRITICAL_DAYS = BAND_CRITICAL_DAYS * DEMO_SCALE;
export const DEMO_BAND_WARNING_DAYS = BAND_WARNING_DAYS * DEMO_SCALE;
export const DEMO_GAUGE_MAX_DAYS = GAUGE_MAX_DAYS * DEMO_SCALE;

/** Human-readable banner, e.g. "DEMO TIMESCALE x1,000". */
export const DEMO_LABEL = DEMO_SCALED
  ? `DEMO TIMESCALE ×${DEMO_SCALE.toLocaleString("en-US")}`
  : "";

/**
 * Suffix appended to a scaled rule's label, e.g. " ×1,000 DEMO". Exported so
 * the display layer can recognise it (and add it to the catch-all HOLD rule,
 * which `scaleRules` deliberately leaves untouched) instead of re-deriving the
 * wording in two places.
 */
export function demoRuleSuffix(scale: number = DEMO_SCALE): string {
  return scale === 1 ? "" : ` ×${scale.toLocaleString("en-US")} DEMO`;
}

/** The suffix for the scale actually in force. Empty when scaling is off. */
export const DEMO_RULE_SUFFIX = demoRuleSuffix();

/**
 * The trailing disclosure sentence appended to a decision's `reasoning` while a
 * demo timescale is in force.
 *
 * A decision card is routinely screenshotted on its own, with the gauge header
 * (and its `DEMO_LABEL`) out of frame. Without this, such a card reads "below
 * the 2,660-day top-up threshold" with nothing to say that 2,660 is 7 x 380 —
 * the disclosure would be gone entirely. So each decision carries its own.
 *
 * `baseThresholdDays` is the UNSCALED rule threshold, i.e. the scaled figure
 * already printed in the reasoning divided by `scale`. Pass `null` when the
 * decision cites no threshold at all.
 *
 * Returns "" at scale 1, which makes the whole feature an identity: a decision
 * taken with no demo timescale reads exactly as it always did.
 */
export function demoScaleNote(
  baseThresholdDays: number | null,
  scale: number = DEMO_SCALE,
): string {
  if (scale === 1) return "";
  const timescale = `×${scale.toLocaleString("en-US")} demo timescale`;
  if (baseThresholdDays === null || !Number.isFinite(baseThresholdDays)) {
    return ` Policy thresholds run at the ${timescale}; chain readings are unscaled.`;
  }
  // toPrecision first: 2660 / 380 is 7.000000000000001 in binary floating point.
  const base = Number(baseThresholdDays.toPrecision(12)).toLocaleString("en-US");
  return ` Threshold shown is the ${base}-day rule at the ${timescale}.`;
}

/**
 * Scale a rule set's thresholds. Pure: returns new objects and never mutates
 * the input. The catch-all HOLD rule keeps its sentinel threshold so it stays
 * finite and JSON-serialisable.
 */
export function scaleRules(rules: PolicyRule[], scale: number = DEMO_SCALE): PolicyRule[] {
  if (scale === 1) return rules;
  return rules.map((rule) => {
    if (!Number.isFinite(rule.thresholdDays) || rule.thresholdDays >= CATCH_ALL_THRESHOLD_DAYS) {
      return rule;
    }
    return {
      ...rule,
      thresholdDays: rule.thresholdDays * scale,
      label: `${rule.label}${demoRuleSuffix(scale)}`,
    };
  });
}

/**
 * Suggest a scale that puts the current runway near the middle of the gauge, so
 * an operator can pick a defensible number instead of guessing. Returns 1 when
 * the runway is already inside the gauge's native 14-day range.
 */
export function suggestDemoScale(trueDaysRemaining: number): number {
  if (!Number.isFinite(trueDaysRemaining) || trueDaysRemaining <= GAUGE_MAX_DAYS) return 1;
  const target = trueDaysRemaining / (GAUGE_MAX_DAYS / 2);
  // Round up to a tidy power of ten so the axis labels stay readable.
  return 10 ** Math.ceil(Math.log10(target));
}

/* ---------- client / server agreement ---------- */

/**
 * What the two halves of the app each resolve the demo scale to.
 *
 * The policy engine runs on the server and reads either variable. The gauge is
 * a client component, and Next.js inlines only `NEXT_PUBLIC_*` into the browser
 * bundle — `process.env.FILRUNWAY_DEMO_SCALE` is simply `undefined` there. So
 * setting ONLY the server-side variable makes the agent act on ×N thresholds
 * while the browser still draws a ×1 axis, and the gauge silently contradicts
 * the decisions beside it.
 *
 * This cannot be asserted by comparing the two `DEMO_SCALE` constants in a unit
 * test: the test runs in one process, where both `process.env` values are
 * visible and the two would always agree. The divergence is a property of the
 * BUILD, so it is expressed here as a pure function of the two raw values and
 * checked that way — and the agent loop logs it at startup.
 */
export interface DemoScaleAgreement {
  /** What the browser bundle will resolve, seeing only `NEXT_PUBLIC_*`. */
  client: number;
  /** What the server resolves, seeing both variables. */
  server: number;
  agree: boolean;
}

/**
 * `publicRaw` is `NEXT_PUBLIC_FILRUNWAY_DEMO_SCALE`, `serverRaw` is the plain
 * `FILRUNWAY_DEMO_SCALE`. Mirrors `readRawScale()`'s precedence exactly.
 */
export function demoScaleAgreement(
  publicRaw: string | undefined | null,
  serverRaw: string | undefined | null,
): DemoScaleAgreement {
  const client = parseDemoScale(publicRaw);
  const server = parseDemoScale(publicRaw ?? serverRaw);
  return { client, server, agree: client === server };
}

/** The agreement for this process's environment. */
export const DEMO_SCALE_AGREEMENT: DemoScaleAgreement =
  typeof process === "undefined"
    ? { client: DEMO_SCALE, server: DEMO_SCALE, agree: true }
    : demoScaleAgreement(
        // Written out in full: Next.js substitutes the literal text and cannot
        // see a computed key.
        process.env.NEXT_PUBLIC_FILRUNWAY_DEMO_SCALE,
        process.env.FILRUNWAY_DEMO_SCALE,
      );
