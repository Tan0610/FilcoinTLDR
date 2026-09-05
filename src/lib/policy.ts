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
import { delinquentSets, describeProof, liveSetCount } from "./proof";
import type {
  DataSetProofState,
  Decision,
  DecisionAction,
  PolicyRule,
  PruneTarget,
  RunwaySnapshot,
} from "./types";
import {
  addDecimal,
  epochsFor,
  formatUnits,
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
  /**
   * Whether a `PRUNE_DATASET` decision may actually be submitted here.
   *
   * An EXPLICIT INPUT rather than an environment read, because `evaluate` is
   * pure and must stay that way — the agent runner supplies
   * `evictionEnabled()` from `src/lib/eviction.ts`. Defaults to `false`, so a
   * caller that forgets it gets the safe answer.
   *
   * It changes the decision in two ways, and neither of them is "decide
   * something else quietly":
   *
   *   - When off, a prune decision is still made, still names its target and
   *     still carries its full reasoning; only its `outcome` is NO_ACTION and
   *     its text says which variable would arm it.
   *   - When off AND the runway is inside the emergency threshold, the agent
   *     falls back to the emergency top-up instead. Sitting on its hands while
   *     the account dies, because the one remedy it preferred is not permitted,
   *     would be a worse decision than the second-best one it can still take.
   */
  evictionEnabled?: boolean;
}

/**
 * Whether an action means "money left the wallet for Filecoin Pay".
 *
 * The single definition of what counts as a deposit, and it exists because
 * `PRUNE_DATASET` broke the old assumption that `outcome === "EXECUTED"` was
 * enough. A prune keeps `ruleFired` — the top-up rule it was taken INSTEAD of,
 * which is exactly what makes the decision legible — and it executes a
 * transaction. Counting it the old way would have added that rule's
 * `topUpAmount` to the AUTONOMOUS DEPOSITS tile and to the safety cap's ledger
 * for a deposit that never happened: a dashboard claiming USDFC was spent when
 * none was.
 *
 * Both `journal.ts` (the tile) and `spendGuard.ts` (the cap) funnel through
 * this, so the two figures cannot drift apart again.
 */
export function isDepositAction(action: DecisionAction): boolean {
  return action === "TOP_UP" || action === "EMERGENCY_TOP_UP";
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
 * Re-size a deposit over the payment rails that survive a cut.
 *
 * Pro-rata by rail COUNT, deliberately, and labelled as such wherever it is
 * printed. Filecoin Pay reports one aggregate `lockupRatePerEpoch` for the
 * account and offers no per-rail breakdown, so the exact rate that remains
 * after a termination is not readable in advance — it is knowable only from the
 * next reading. Rather than invent a per-data-set burn rate and present it as
 * measured, the agent states a count-based bound and says it will re-decide
 * against the real figure. Exported for its test.
 */
export function resizeTopUp(amount: string, liveDataSets: number, pruned = 1): string {
  if (!Number.isFinite(liveDataSets) || liveDataSets <= 0) return "0";
  const surviving = Math.max(0, Math.floor(liveDataSets) - pruned);
  if (surviving <= 0) return "0";
  const units = parseUnits(amount);
  return formatUnits((units * BigInt(surviving)) / BigInt(Math.floor(liveDataSets)));
}

/** "#30291, last proven at epoch 2,960,120, deadline 2,960,180" */
function describeTarget(state: DataSetProofState): string {
  const bits = [
    `last proven at epoch ${fmtOptional(state.lastProvenEpoch)}`,
    `proving deadline epoch ${fmtOptional(state.provingDeadline)}`,
    `next challenge epoch ${fmtOptional(state.nextChallengeEpoch)}`,
  ];
  return `data set #${state.dataSetId} (${bits.join(", ")})`;
}

function fmtOptional(value: number | null): string {
  return value === null ? "unread" : groupDigits(Math.floor(value));
}

/**
 * Sense -> decide. Returns a Decision whose `outcome` is PENDING for anything
 * that needs a transaction and NO_ACTION for a hold; the agent runner flips it
 * to EXECUTED / FAILED after it acts.
 *
 * THREE CONCLUSIONS NO RULE CAN ASK FOR
 * -------------------------------------
 * A rule may only say TOP_UP, EMERGENCY_TOP_UP or HOLD. The agent reaches three
 * further conclusions on its own, and each of them is a decision rather than a
 * failure:
 *
 *   - INSUFFICIENT_FUNDS — the rule fired and the wallet cannot cover the
 *     deposit, so nothing is attempted and the shortfall is stated. Recognising
 *     a constraint beats discovering it as a reverted transaction.
 *   - SAFETY_CAP — applied outside this file, in `agent.ts`, because it needs
 *     durable history that a pure function must not read.
 *   - PRUNE_DATASET — the runway is short AND a data set has been READ to be
 *     past its proving deadline without a proof. Buying runway to keep paying
 *     for storage that is not proving is the worse of the two available moves,
 *     so the agent proposes cutting it instead. See the eviction block below,
 *     and `src/lib/proof.ts` for why an unread proof state can never get here.
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
  const evictionEnabled = opts.evictionEnabled ?? false;

  const days = snapshot.daysRemaining;
  const rule = selectRule(days, rules);
  let action: DecisionAction = rule?.action ?? "HOLD";

  const base =
    `Runway ${fmtDays(days)} days (${fmtEpochs(snapshot.epochsRemaining)} epochs)`;
  const burn =
    `Burn rate ${snapshot.lockupRate} USDFC/epoch against ` +
    `${toFixedString(snapshot.fundsAvailable, 2)} USDFC available.`;

  // Every entry here was READ; `classifyProofState` cannot put an unknown one
  // in this list. That property is the whole safety argument for this branch.
  const delinquent = delinquentSets(snapshot.proof);
  const proofNote = describeProof(snapshot.proof);
  const liveDataSets = liveSetCount(snapshot.proof);

  /* ---------- the eviction branch ---------- */

  // Cutting is preferred over funding when a rule has fired AND something is
  // demonstrably not earning its cost. The one exception is an emergency the
  // agent is not permitted to solve by cutting: see `EvaluateOptions`.
  const emergencyWithoutOptIn = action === "EMERGENCY_TOP_UP" && !evictionEnabled;

  if (action !== "HOLD" && delinquent.length > 0 && !emergencyWithoutOptIn) {
    const victim = delinquent[0];
    const deferred = rule?.topUpAmount ?? "0";
    const resized = resizeTopUp(deferred, liveDataSets);
    const target: PruneTarget = {
      dataSetId: victim.dataSetId,
      epochsOverdue: victim.epochsOverdue ?? 0,
      liveDataSets,
      deferredTopUpAmount: deferred,
      resizedTopUpAmount: resized,
      executionEnabled: evictionEnabled,
    };

    const trigger =
      `${base} is below the ${rule?.thresholdDays}-day top-up threshold. ${burn}`;
    const evidence =
      `${describeTarget(victim)} is live and ${groupDigits(target.epochsOverdue)} epochs ` +
      `past its proving deadline at epoch ${fmtOptional(snapshot.proof?.epoch ?? null)}, ` +
      "with no proof filed this period — it is being paid for and is not earning its cost.";
    const choice =
      `Terminating its payment rail is a better use of a short runway than the ` +
      `${deferred} USDFC deposit this rule calls for, so that deposit is NOT made on this ` +
      `reading. ${groupDigits(Math.max(0, liveDataSets - 1))} of ${groupDigits(liveDataSets)} ` +
      "live rails survive the cut; pro-rata by rail count the same policy would then need " +
      `about ${toFixedString(resized, 2)} USDFC rather than ${deferred} USDFC. That figure ` +
      "is a bound, not a measurement — Filecoin Pay reports one aggregate lockup rate for " +
      "the account with no per-rail split, so the next reading re-decides against the true " +
      "post-termination burn rate.";
    const closing = evictionEnabled
      ? "Submitting terminateService on the Warm Storage contract."
      : "";

    return {
      id,
      at,
      snapshot,
      ruleFired: rule,
      action: "PRUNE_DATASET",
      target,
      reasoning:
        `${trigger} ${evidence} ${choice} ${closing}`.trim() +
        proofNote +
        demoScaleNote(rule ? rule.thresholdDays / demoScale : null, demoScale),
      // The gate is applied here rather than by mutating a PENDING decision
      // afterwards, so the journal holds one record saying exactly what
      // happened. `agent.ts` checks the environment again before submitting.
      outcome: evictionEnabled ? "PENDING" : "NO_ACTION",
    };
  }

  /**
   * The delinquency the agent saw and did not act on. Always said out loud:
   * an agent that noticed dead weight and left it alone has to show that it
   * noticed, or the decision is indistinguishable from not looking.
   */
  const flagged =
    delinquent.length === 0
      ? ""
      : action === "HOLD"
        ? ` ${describeTarget(delinquent[0])} is past its proving deadline, but the runway is ` +
          "above the top-up threshold: the agent is not taking an irreversible action it is " +
          "not forced into, and will reconsider if the runway falls."
        : ` ${describeTarget(delinquent[0])} is past its proving deadline and would be cut ` +
          "in preference to this deposit, but the runway is inside the emergency threshold " +
          "and eviction is not armed on this deployment — so the account is funded rather " +
          "than left to die on an option the agent may not take.";

  let reasoning: string;

  if (action === "HOLD") {
    const threshold = highestActionThreshold(rules);
    const clause =
      threshold === null
        ? "no top-up rule is configured"
        : `is at or above the ${threshold}-day top-up threshold`;
    reasoning =
      `${base} ${clause}. ${burn} No deposit required.` +
      flagged +
      proofNote +
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
        flagged +
        proofNote +
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

      reasoning = `${trigger} ${burn} ${projection}` + flagged + proofNote + note;
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
