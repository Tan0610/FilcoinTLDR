/**
 * The agent's own spending cap.
 *
 * WHY THIS EXISTS
 * ---------------
 * Deployed, the agent runs unattended, on a public URL, holding a funded key,
 * and it is driven by a scheduler rather than by a human watching it. The
 * policy engine is bounded per DECISION (a rule deposits 5 or 15 USDFC) but
 * nothing bounded it per DAY. A misread burn rate, an RPC that reports a
 * runway of zero, or simply a schedule that fires more often than anyone
 * intended, and the agent would keep topping up — correctly, according to its
 * rules — until the wallet was empty.
 *
 * So the agent is given a limit it enforces on ITSELF, over a rolling window:
 * at most N deposits, and at most M USDFC in total, per 24 hours.
 *
 * IT IS A DECISION, NOT AN ERROR
 * ------------------------------
 * Hitting the cap produces a `SAFETY_CAP` decision with outcome `NO_ACTION`,
 * carrying the reading, the rule that fired, and reasoning that says exactly
 * which limit was reached and when it next relaxes. That is the same shape as
 * `INSUFFICIENT_FUNDS`: the agent recognised a constraint and declined to
 * transact. An agent that can say "I will not do this, and here is why" is a
 * better autonomy artifact than one that only ever says yes, so this path is
 * recorded in the journal like any other decision rather than swallowed as a
 * failure.
 *
 * SCOPE
 * -----
 * Enforced when there is real money at stake — LIVE mode. In MOCK nothing can
 * be spent, and capping a simulation would change the local demo (a mock run
 * ticks every 15 seconds and would hit any conservative daily cap within
 * minutes). `FILRUNWAY_SPEND_CAP=on|off` overrides for testing.
 *
 * The window is counted from the durable journal, not from this process's
 * memory: on Vercel each tick may run on a different Function instance, and a
 * cap that resets whenever an instance is recycled is not a cap. See
 * `AgentStore.spendEntries()`.
 *
 * CONFIGURATION
 * -------------
 *   FILRUNWAY_MAX_DEPOSITS_24H   (default 3)
 *   FILRUNWAY_MAX_DEPOSIT_USDFC_24H (default "20")
 *   FILRUNWAY_SPEND_WINDOW_MS    (default 86_400_000)
 *
 * The defaults are deliberately tight for the shipped rule set: one emergency
 * top-up (15) plus one scheduled top-up (5) is exactly 20 USDFC, so the agent
 * may respond fully to a genuine emergency and then must stop for the day.
 */

import { isDepositAction } from "./policy";
import type { AgentMode, Decision } from "./types";
import { addDecimal, groupDigits, parseUnits, toFixedString } from "./units";

/** The slice of the environment this module reads. */
export type SpendEnv = Record<string, string | undefined>;

export const MAX_DEPOSITS_ENV = "FILRUNWAY_MAX_DEPOSITS_24H";
export const MAX_USDFC_ENV = "FILRUNWAY_MAX_DEPOSIT_USDFC_24H";
export const WINDOW_MS_ENV = "FILRUNWAY_SPEND_WINDOW_MS";
export const SPEND_CAP_ENV = "FILRUNWAY_SPEND_CAP";

export const DEFAULT_MAX_DEPOSITS = 3;
export const DEFAULT_MAX_USDFC = "20";
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface SpendLimits {
  /** Deposits allowed inside the window. */
  maxDeposits: number;
  /** Total USDFC allowed inside the window, as a decimal string. */
  maxUsdfc: string;
  /** Length of the rolling window, in ms. */
  windowMs: number;
}

/** One deposit the agent has already made, as counted against the cap. */
export interface SpendEntry {
  /** The decision that authored it, so a retracted deposit can be removed. */
  id: string;
  at: number;
  amountUsdfc: string;
}

/** What the window currently holds. */
export interface SpendWindow {
  count: number;
  totalUsdfc: string;
  /** `at` of the oldest deposit still inside the window, or null. */
  oldestAt: number | null;
  /** When the oldest deposit leaves the window, or null when it is empty. */
  relaxesAt: number | null;
}

export type SpendVerdict =
  | { allowed: true; window: SpendWindow }
  | { allowed: false; limit: "COUNT" | "AMOUNT"; window: SpendWindow; reason: string };

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function decimal(raw: string | undefined, fallback: string): string {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  try {
    return parseUnits(trimmed) >= 0n ? trimmed : fallback;
  } catch {
    return fallback;
  }
}

/** The limits in force, from the environment. Never throws on a bad value. */
export function spendLimits(env: SpendEnv = process.env): SpendLimits {
  return {
    maxDeposits: positiveInt(env[MAX_DEPOSITS_ENV], DEFAULT_MAX_DEPOSITS),
    maxUsdfc: decimal(env[MAX_USDFC_ENV], DEFAULT_MAX_USDFC),
    windowMs: positiveInt(env[WINDOW_MS_ENV], DEFAULT_WINDOW_MS) || DEFAULT_WINDOW_MS,
  };
}

/**
 * Whether the cap applies. LIVE by default — see the header. An explicit
 * `FILRUNWAY_SPEND_CAP` wins in both directions so a test (or an operator who
 * wants the cap in a mock rehearsal) can say so.
 */
export function spendCapEnabled(mode: AgentMode, env: SpendEnv = process.env): boolean {
  const override = env[SPEND_CAP_ENV]?.trim().toLowerCase();
  if (override === "on" || override === "1" || override === "true") return true;
  if (override === "off" || override === "0" || override === "false") return false;
  return mode === "LIVE";
}

/** Deposits recorded inside the window ending at `now`, and their total. */
export function spendWindow(
  entries: readonly SpendEntry[],
  now: number,
  windowMs: number,
): SpendWindow {
  const since = now - windowMs;
  let count = 0;
  let totalUsdfc = "0";
  let oldestAt: number | null = null;

  for (const entry of entries) {
    // `>` not `>=`: a deposit exactly `windowMs` old has aged out.
    if (entry.at <= since || entry.at > now) continue;
    count += 1;
    totalUsdfc = addDecimal(totalUsdfc, entry.amountUsdfc);
    oldestAt = oldestAt === null ? entry.at : Math.min(oldestAt, entry.at);
  }

  return {
    count,
    totalUsdfc,
    oldestAt,
    relaxesAt: oldestAt === null ? null : oldestAt + windowMs,
  };
}

/** Human phrasing for the window length, e.g. "24h". */
function windowLabel(windowMs: number): string {
  const hours = windowMs / (60 * 60 * 1000);
  if (Number.isInteger(hours) && hours >= 1) return `${hours}h`;
  const minutes = Math.round(windowMs / 60_000);
  return `${minutes}m`;
}

function whenUtc(at: number): string {
  return `${new Date(at).toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

/**
 * May the agent deposit `amountUsdfc` right now?
 *
 * Pure: the caller supplies the history, the clock and the limits. The refusal
 * text is built here so the wording is identical wherever the cap fires, and so
 * it can be asserted in a test rather than eyeballed in a screenshot.
 */
export function checkSpend(
  entries: readonly SpendEntry[],
  amountUsdfc: string,
  now: number,
  limits: SpendLimits,
): SpendVerdict {
  const window = spendWindow(entries, now, limits.windowMs);
  const label = windowLabel(limits.windowMs);
  const spent = toFixedString(window.totalUsdfc, 2);
  const relaxes =
    window.relaxesAt === null
      ? ""
      : ` The cap relaxes as the oldest deposit ages out at ${whenUtc(window.relaxesAt)}.`;

  if (window.count >= limits.maxDeposits) {
    return {
      allowed: false,
      limit: "COUNT",
      window,
      reason:
        `Declined by the agent's own safety cap: ${groupDigits(window.count)} of a maximum ` +
        `${groupDigits(limits.maxDeposits)} deposits already made in the last ${label} ` +
        `(${spent} USDFC). No transaction was attempted and no funds moved.${relaxes} ` +
        `Raise ${MAX_DEPOSITS_ENV} to widen the cap.`,
    };
  }

  const projected = addDecimal(window.totalUsdfc, amountUsdfc);
  if (parseUnits(projected) > parseUnits(limits.maxUsdfc)) {
    return {
      allowed: false,
      limit: "AMOUNT",
      window,
      reason:
        `Declined by the agent's own safety cap: this rule calls for ${amountUsdfc} USDFC on ` +
        `top of ${spent} USDFC already deposited in the last ${label}, which would reach ` +
        `${toFixedString(projected, 2)} USDFC against a cap of ` +
        `${toFixedString(limits.maxUsdfc, 2)} USDFC. No transaction was attempted and no ` +
        `funds moved.${relaxes} Raise ${MAX_USDFC_ENV} to widen the cap.`,
    };
  }

  return { allowed: true, window };
}

/** One line describing the limits, for the agent trace at startup. */
export function describeLimits(limits: SpendLimits): string {
  return (
    `Safety cap in force: at most ${groupDigits(limits.maxDeposits)} deposits and ` +
    `${toFixedString(limits.maxUsdfc, 2)} USDFC per ${windowLabel(limits.windowMs)}. ` +
    "Reaching it records a declining decision; it never transacts."
  );
}

/**
 * Seed the window from recorded history.
 *
 * A deposit counts once it has EXECUTED, and for the amount the rule asked for
 * — the same definition `accumulate()` totals in `journal.ts`, so the cap and
 * the AUTONOMOUS DEPOSITS tile can never disagree about what was spent. Both
 * gate on `isDepositAction`, which is what keeps an executed `PRUNE_DATASET`
 * (which carries a top-up rule but deposits nothing) out of both figures.
 */
export function spendEntriesFrom(decisions: readonly Decision[]): SpendEntry[] {
  const entries: SpendEntry[] = [];
  for (const decision of decisions) {
    if (decision.outcome !== "EXECUTED") continue;
    if (!isDepositAction(decision.action)) continue;
    const amount = decision.ruleFired?.topUpAmount;
    if (!amount || parseUnits(amount) <= 0n) continue;
    entries.push({ id: decision.id, at: decision.at, amountUsdfc: amount });
  }
  return entries;
}
