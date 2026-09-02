/**
 * FilRunway policy engine.
 *
 * `evaluate()` is a PURE function: given a snapshot and a rule set it returns a
 * Decision. No chain calls, no clock reads unless you let it (pass `opts.now`),
 * no I/O. Everything the agent does that a judge might question happens here,
 * in one testable place.
 */

import { EPOCHS_PER_DAY, isUnboundedDays, isUnboundedEpochs } from "./constants";
import { DEMO_SCALE, demoScaleNote } from "./demo";
import type { Decision, DecisionAction, PolicyRule, RunwaySnapshot } from "./types";
import {
  addDecimal,
  epochsFor,
  groupDigits,
  parseUnits,
  subDecimalFloor,
  toFixedString,
} from "./units";

/**
 * Sentinel threshold for a catch-all rule. Deliberately a large finite number
 * rather than Infinity so a rule survives JSON round-tripping over SSE.
 */
export const ALWAYS_THRESHOLD_DAYS = Number.MAX_SAFE_INTEGER;

/**
 * Default policy: hold above 7 days, top up 5 USDFC below 7 days, and dump
 * 15 USDFC in below 2 days. Ordered lowest threshold first — most severe wins.
 */
export const DEFAULT_RULES: PolicyRule[] = [
  {
    id: "emergency-2d",
    label: "EMERGENCY TOP-UP < 2d",
    thresholdDays: 2,
    action: "EMERGENCY_TOP_UP",
    topUpAmount: "15",
  },
  {
    id: "topup-7d",
    label: "SCHEDULED TOP-UP < 7d",
    thresholdDays: 7,
    action: "TOP_UP",
    topUpAmount: "5",
  },
  {
    id: "hold",
    label: "HOLD >= 7d",
    thresholdDays: ALWAYS_THRESHOLD_DAYS,
    action: "HOLD",
    topUpAmount: "0",
  },
];

export interface EvaluateOptions {
  /** Wall-clock ms stamped on the Decision. Pass it in tests. */
  now?: number;
  /** Decision id. Pass it in tests; otherwise a uuid. */
  id?: string;
  /** Override for exotic chains. Defaults to 2880. */
  epochsPerDay?: number;
  /**
   * The demo timescale the `rules` were scaled by, used only to disclose that
   * scaling in the reasoning text. Defaults to the process-wide `DEMO_SCALE`.
   * Pass it explicitly whenever you hand `evaluate` a pre-scaled rule set.
   */
  demoScale?: number;
}

/** Decision id generator. Exported so the agent runner can stamp FAILED reads. */
export function newDecisionId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `dec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function fmtDays(days: number): string {
  // Covers both Infinity and the finite UNBOUNDED_DAYS sentinel the live
  // adapter uses when Filecoin Pay reports a zero burn rate (maxUint256 runway).
  if (isUnboundedDays(days)) return "unbounded";
  return days.toFixed(1);
}

function fmtEpochs(epochs: number): string {
  if (isUnboundedEpochs(epochs)) return "unbounded";
  return groupDigits(Math.floor(epochs));
}

/** Pick the first (lowest-threshold) rule the runway has fallen below. */
export function selectRule(
  daysRemaining: number,
  rules: PolicyRule[],
): PolicyRule | null {
  const ordered = [...rules].sort((a, b) => a.thresholdDays - b.thresholdDays);
  return ordered.find((rule) => daysRemaining < rule.thresholdDays) ?? null;
}

/** The tightest non-HOLD threshold in the rule set, for HOLD copy. */
function highestActionThreshold(rules: PolicyRule[]): number | null {
  const thresholds = rules
    .filter((r) => r.action !== "HOLD" && r.thresholdDays < ALWAYS_THRESHOLD_DAYS)
    .map((r) => r.thresholdDays);
  return thresholds.length > 0 ? Math.max(...thresholds) : null;
}

/**
 * Sense -> decide. Returns a Decision whose `outcome` is PENDING for anything
 * that needs a transaction and NO_ACTION for a hold; the agent runner flips it
 * to EXECUTED / FAILED after it acts.
 *
 * One case never reaches the chain: if the rule that fired calls for a deposit
 * the wallet cannot cover, the decision is INSUFFICIENT_FUNDS with outcome
 * NO_ACTION. Recognising a constraint is a better decision than submitting a
 * transaction that is known in advance to fail, so the shortfall is stated here
 * rather than discovered as a FAILED tx.
 */
export function evaluate(
  snapshot: RunwaySnapshot,
  rules: PolicyRule[] = DEFAULT_RULES,
  opts: EvaluateOptions = {},
): Decision {
  const epochsPerDay = opts.epochsPerDay ?? EPOCHS_PER_DAY;
  const demoScale = opts.demoScale ?? DEMO_SCALE;
  const at = opts.now ?? Date.now();
  const id = opts.id ?? newDecisionId();

  const days = snapshot.daysRemaining;
  const rule = selectRule(days, rules);
  let action: DecisionAction = rule?.action ?? "HOLD";

  const base =
    `Runway ${fmtDays(days)} days (${fmtEpochs(snapshot.epochsRemaining)} epochs)`;
  const burn =
    `Burn rate ${snapshot.lockupRate} USDFC/epoch against ` +
    `${toFixedString(snapshot.fundsAvailable, 2)} USDFC available.`;

  let reasoning: string;

  if (action === "HOLD") {
    const threshold = highestActionThreshold(rules);
    const clause =
      threshold === null
        ? "no top-up rule is configured"
        : `is at or above the ${threshold}-day top-up threshold`;
    reasoning =
      `${base} ${clause}. ${burn} No deposit required.` +
      demoScaleNote(threshold === null ? null : threshold / demoScale, demoScale);
  } else {
    const amount = rule?.topUpAmount ?? "0";
    const kind = action === "EMERGENCY_TOP_UP" ? "emergency" : "top-up";
    const trigger = `${base} is below the ${rule?.thresholdDays}-day ${kind} threshold.`;
    // The rule that fired is what the scaled figure in `trigger` came from.
    const note = demoScaleNote(rule ? rule.thresholdDays / demoScale : null, demoScale);

    if (parseUnits(snapshot.walletUsdfc) < parseUnits(amount)) {
      // The rule fired and the agent cannot pay for it. Say so; do not submit a
      // transaction that is guaranteed to revert.
      const wallet = toFixedString(snapshot.walletUsdfc, 2);
      const missing = toFixedString(subDecimalFloor(amount, snapshot.walletUsdfc), 2);
      action = "INSUFFICIENT_FUNDS";
      reasoning =
        `${trigger} ${burn} The rule calls for a ${amount} USDFC deposit but the wallet ` +
        `holds ${wallet} USDFC — a shortfall of ${missing} USDFC. No deposit attempted: ` +
        `fund the agent wallet with at least ${missing} USDFC for this rule to execute.` +
        note;
    } else {
      const projectedEpochs = epochsFor(
        addDecimal(snapshot.fundsAvailable, amount),
        snapshot.lockupRate,
      );
      const projectedDays = projectedEpochs / epochsPerDay;
      const projection = Number.isFinite(projectedDays)
        ? `Depositing ${amount} USDFC extends runway to ~${fmtDays(projectedDays)} days.`
        : `Depositing ${amount} USDFC; burn rate is zero so runway is unbounded.`;

      reasoning = `${trigger} ${burn} ${projection}` + note;
    }
  }

  return {
    id,
    at,
    snapshot,
    ruleFired: rule,
    action,
    reasoning,
    outcome: action === "HOLD" || action === "INSUFFICIENT_FUNDS" ? "NO_ACTION" : "PENDING",
  };
}
