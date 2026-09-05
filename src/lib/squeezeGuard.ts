/**
 * The operator's withdrawal cap.
 *
 * WHY THIS EXISTS
 * ---------------
 * `src/lib/spendGuard.ts` bounds what the AGENT may put into Filecoin Pay.
 * This bounds what an OPERATOR may take out of it.
 *
 * `/api/squeeze` performs a real `payments.withdraw()` from Filecoin Pay back
 * to the agent's own wallet. Nothing can be stolen with it — both ends of that
 * transfer are the same account — and `src/lib/squeeze.ts` already refuses a
 * single call larger than the ceiling or larger than the unlocked balance. What
 * it did NOT bound was how OFTEN it could be called.
 *
 * That was survivable while the secret was private. It stops being survivable
 * the moment the operator secret is published so that judges can drive the live
 * demo themselves: anyone looping the endpoint would walk `availableFunds` down
 * to nothing, the agent would exhaust its own 3-deposit daily allowance trying
 * to answer, and the public dashboard would settle into a true reading of a
 * dead agent. The readings would still be honest. There would just be nothing
 * left to read.
 *
 * So the operator, like the agent, gets a limit over a rolling window: at most
 * N withdrawals, and at most M USDFC in total, per 24 hours — plus a floor
 * under the balance itself.
 *
 * IT IS A REFUSAL, NOT A DECISION
 * -------------------------------
 * This is the one deliberate difference from `spendGuard.ts`. A capped DEPOSIT
 * is the agent recognising a constraint, so it is recorded as a `SAFETY_CAP`
 * decision. A capped WITHDRAWAL is a human being told no, and the squeeze
 * produces no `Decision` by design — conflating an operator action with an
 * autonomous one is the single most misleading thing this dashboard could do.
 * So the cap answers the HTTP call instead: a 429 whose body names the limit,
 * what has already been used, and when it relaxes. The dashboard's operator
 * strip already renders `ApiError.error` verbatim, so the refusal reaches the
 * screen through the feedback line that was already there.
 *
 * THE FLOOR
 * ---------
 * A rate cap alone still permits three well-sized withdrawals that between them
 * empty the account. `reserveUsdfc` is the floor: a withdrawal that would leave
 * Filecoin Pay with less than this much UNLOCKED is refused outright.
 *
 * Two floors were considered and only this one was taken:
 *
 *   - LOCKED FUNDS are already safe and need nothing here. `planSqueeze` bounds
 *     every request against `RunwaySnapshot.fundsAvailable`, which is Filecoin
 *     Pay's own `availableFunds` — the portion NOT locked against commitments.
 *     A withdrawal can therefore never eat into lockup, whatever this module
 *     does.
 *   - A RUNWAY-THRESHOLD floor ("refuse anything that would cross the emergency
 *     threshold") was rejected. The emergency rule is a real capability the
 *     agent has, and forbidding the runway from ever reaching it would mean the
 *     one policy branch nobody could ever demonstrate is the one that matters
 *     most. The floor is set on the BALANCE instead, low enough that the
 *     emergency branch stays reachable and high enough that the gauge always
 *     has a live, positive, genuinely-read number on it.
 *
 * SCOPE
 * -----
 * Enforced wherever a withdrawal is real — LIVE mode. The mock adapter has no
 * `withdraw()` at all, so a mock squeeze is already a 501 and there is nothing
 * to cap. `FILRUNWAY_SQUEEZE_CAP=on|off` overrides in both directions for a
 * test or a rehearsal, exactly as `FILRUNWAY_SPEND_CAP` does.
 *
 * The window is counted from the durable journal, not from this process's
 * memory. On Vercel each call may land on a different Function instance, and a
 * cap that resets whenever an instance is recycled is not a cap — it is a
 * suggestion with a stopwatch. Squeezes are journalled as their own record kind
 * (`OperatorSqueeze` in `src/lib/journal.ts`), beside the decisions and
 * explicitly not among them, so the count survives instance churn without a
 * withdrawal ever masquerading as something the agent decided. See
 * `AgentStore.squeezeEntries()`.
 *
 * CONFIGURATION
 * -------------
 *   FILRUNWAY_MAX_SQUEEZES_24H        (default 6)
 *   FILRUNWAY_MAX_SQUEEZE_USDFC_24H   (default "8")
 *   FILRUNWAY_SQUEEZE_WINDOW_MS       (default 86_400_000)
 *   FILRUNWAY_SQUEEZE_RESERVE_USDFC   (default "1")
 *   FILRUNWAY_SQUEEZE_CAP             (on|off; default: on in LIVE)
 *
 * WHERE THE DEFAULTS COME FROM
 * ----------------------------
 * They are sized off the demo they have to allow, and off the agent's own cap.
 *
 * On the deployed account a healthy runway is ~3,966 days against a ×480 demo
 * timescale whose top-up threshold sits at 3,360 days, and it takes about
 * 2 USDFC of withdrawal to cross that gap. One crisis-and-recovery cycle is
 * therefore ~2 USDFC out, answered by one 5 USDFC top-up back in.
 *
 *   - 8 USDFC / 24h  = three full cycles (6 USDFC) with headroom for one
 *     mis-sized first attempt, and no fourth cycle.
 *   - 6 squeezes / 24h = the same three cycles at the shipped 1 USDFC default
 *     amount, where a cycle takes two calls.
 *
 * Both numbers are anchored to the deposit cap rather than chosen freely.
 * `FILRUNWAY_MAX_DEPOSITS_24H` is 3, so the agent can only demonstrate recovery
 * three times in a window anyway; a withdrawal allowance larger than that would
 * buy nothing except a stretch of dashboard with a flat, unanswerable crisis on
 * it. And the ceiling is deliberately strictly below what the agent may restore
 * in the same window — 8 USDFC out against 3 × 5 = 15 USDFC in — so a fully
 * exercised demo day cannot leave Filecoin Pay lower than it started.
 *
 * The 1 USDFC reserve is roughly 125 days of runway at the ×480 demo timescale
 * — well inside the 960-day emergency threshold, so the EMERGENCY_TOP_UP branch
 * stays demonstrable, and safely above zero, so the account never lands in the
 * one state the agent cannot dig itself out of. It is a backstop rather than a
 * bound anyone should meet: the agent may put 15 USDFC back per window against
 * the 8 USDFC this lets out, so the balance recovers faster than it can fall.
 */

import type { OperatorSqueeze } from "./journal";
import type { AgentMode } from "./types";
import { addDecimal, formatUnits, groupDigits, parseUnits, toFixedString } from "./units";

/** The slice of the environment this module reads. */
export type SqueezeCapEnv = Record<string, string | undefined>;

export const MAX_SQUEEZES_ENV = "FILRUNWAY_MAX_SQUEEZES_24H";
export const MAX_SQUEEZE_USDFC_ENV = "FILRUNWAY_MAX_SQUEEZE_USDFC_24H";
export const SQUEEZE_WINDOW_MS_ENV = "FILRUNWAY_SQUEEZE_WINDOW_MS";
export const SQUEEZE_RESERVE_ENV = "FILRUNWAY_SQUEEZE_RESERVE_USDFC";
export const SQUEEZE_CAP_ENV = "FILRUNWAY_SQUEEZE_CAP";

export const DEFAULT_MAX_SQUEEZES = 6;
export const DEFAULT_MAX_SQUEEZE_USDFC_24H = "8";
export const DEFAULT_SQUEEZE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SQUEEZE_RESERVE_USDFC = "1";

export interface SqueezeCapLimits {
  /** Withdrawals allowed inside the window. */
  maxSqueezes: number;
  /** Total USDFC allowed out inside the window, as a decimal string. */
  maxUsdfc: string;
  /** Length of the rolling window, in ms. */
  windowMs: number;
  /** USDFC that must remain UNLOCKED in Filecoin Pay after a withdrawal. */
  reserveUsdfc: string;
}

/** One withdrawal already made, as counted against the cap. */
export interface SqueezeEntry {
  /** The durable squeeze record that authored it. */
  id: string;
  at: number;
  amountUsdfc: string;
}

/** What the window currently holds. */
export interface SqueezeWindow {
  count: number;
  totalUsdfc: string;
  /** `at` of the oldest withdrawal still inside the window, or null. */
  oldestAt: number | null;
  /** When the oldest withdrawal leaves the window, or null when it is empty. */
  relaxesAt: number | null;
}

export type SqueezeCapVerdict =
  | { allowed: true; window: SqueezeWindow }
  | {
      allowed: false;
      limit: "COUNT" | "AMOUNT" | "RESERVE";
      window: SqueezeWindow;
      reason: string;
    };

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
export function squeezeCapLimits(env: SqueezeCapEnv = process.env): SqueezeCapLimits {
  return {
    maxSqueezes: positiveInt(env[MAX_SQUEEZES_ENV], DEFAULT_MAX_SQUEEZES),
    maxUsdfc: decimal(env[MAX_SQUEEZE_USDFC_ENV], DEFAULT_MAX_SQUEEZE_USDFC_24H),
    windowMs:
      positiveInt(env[SQUEEZE_WINDOW_MS_ENV], DEFAULT_SQUEEZE_WINDOW_MS) ||
      DEFAULT_SQUEEZE_WINDOW_MS,
    reserveUsdfc: decimal(env[SQUEEZE_RESERVE_ENV], DEFAULT_SQUEEZE_RESERVE_USDFC),
  };
}

/**
 * Whether the cap applies. LIVE by default — see the header. An explicit
 * `FILRUNWAY_SQUEEZE_CAP` wins in both directions so a test (or an operator
 * rehearsing against the mock) can say so.
 */
export function squeezeCapEnabled(mode: AgentMode, env: SqueezeCapEnv = process.env): boolean {
  const override = env[SQUEEZE_CAP_ENV]?.trim().toLowerCase();
  if (override === "on" || override === "1" || override === "true") return true;
  if (override === "off" || override === "0" || override === "false") return false;
  return mode === "LIVE";
}

/** Withdrawals recorded inside the window ending at `now`, and their total. */
export function squeezeWindow(
  entries: readonly SqueezeEntry[],
  now: number,
  windowMs: number,
): SqueezeWindow {
  const since = now - windowMs;
  let count = 0;
  let totalUsdfc = "0";
  let oldestAt: number | null = null;

  for (const entry of entries) {
    // `>` not `>=`: a withdrawal exactly `windowMs` old has aged out.
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
 * May the operator withdraw `amountUsdfc` right now?
 *
 * Pure: the caller supplies the history, the unlocked balance, the clock and
 * the limits. The refusal text is built here so the wording is identical
 * wherever the cap fires, and so it can be asserted in a test rather than
 * eyeballed in a screenshot. Every refusal names the limit that stopped it,
 * what has already been used, and when the window relaxes — a judge who hits
 * this must be able to tell "the demo budget is spent, come back at 14:12" from
 * "the deployment is broken".
 *
 * `available` is `RunwaySnapshot.fundsAvailable`, i.e. Filecoin Pay's own
 * `availableFunds`. Locked funds are excluded from it by the contract, so the
 * reserve is a floor under the UNLOCKED balance and lockup is never at risk.
 */
export function checkSqueezeCap(
  entries: readonly SqueezeEntry[],
  amountUsdfc: string,
  available: string,
  now: number,
  limits: SqueezeCapLimits,
): SqueezeCapVerdict {
  const window = squeezeWindow(entries, now, limits.windowMs);
  const label = windowLabel(limits.windowMs);
  const withdrawn = toFixedString(window.totalUsdfc, 2);
  const relaxes =
    window.relaxesAt === null
      ? ""
      : ` The cap relaxes as the oldest withdrawal ages out at ${whenUtc(window.relaxesAt)}.`;

  if (window.count >= limits.maxSqueezes) {
    return {
      allowed: false,
      limit: "COUNT",
      window,
      reason:
        `Refused by the operator withdrawal cap: ${groupDigits(window.count)} of a maximum ` +
        `${groupDigits(limits.maxSqueezes)} squeezes already made in the last ${label} ` +
        `(${withdrawn} USDFC withdrawn). No transaction was attempted and no funds ` +
        `moved.${relaxes} The agent is unharmed and still ticking. Raise ` +
        `${MAX_SQUEEZES_ENV} if this demo genuinely needs a wider budget.`,
    };
  }

  const projected = addDecimal(window.totalUsdfc, amountUsdfc);
  if (parseUnits(projected) > parseUnits(limits.maxUsdfc)) {
    return {
      allowed: false,
      limit: "AMOUNT",
      window,
      reason:
        `Refused by the operator withdrawal cap: ${amountUsdfc} USDFC on top of ${withdrawn} ` +
        `USDFC already withdrawn in the last ${label} would reach ` +
        `${toFixedString(projected, 2)} USDFC against a cap of ` +
        `${toFixedString(limits.maxUsdfc, 2)} USDFC. No transaction was attempted and no ` +
        `funds moved.${relaxes} The agent is unharmed and still ticking. Raise ` +
        `${MAX_SQUEEZE_USDFC_ENV} if this demo genuinely needs a wider budget.`,
    };
  }

  let availableUnits: bigint;
  try {
    availableUnits = parseUnits(available);
  } catch {
    return {
      allowed: false,
      limit: "RESERVE",
      window,
      reason:
        "Refused: the account's unlocked balance could not be read, so no withdrawal can be " +
        "shown to stay above the reserve floor. Nothing was submitted.",
    };
  }

  const remaining = availableUnits - parseUnits(amountUsdfc);
  if (remaining < parseUnits(limits.reserveUsdfc)) {
    return {
      allowed: false,
      limit: "RESERVE",
      window,
      reason:
        `Refused by the reserve floor: withdrawing ${amountUsdfc} USDFC would leave ` +
        `${toFixedString(formatUnits(remaining), 6)} USDFC ` +
        `unlocked in Filecoin Pay, below the ${toFixedString(limits.reserveUsdfc, 2)} USDFC ` +
        "that must stay behind so the runway gauge keeps reading a live account the agent " +
        "can still recover. Ask for less. No transaction was attempted and no funds moved. " +
        `Lower ${SQUEEZE_RESERVE_ENV} if this floor is genuinely too high.`,
    };
  }

  return { allowed: true, window };
}

/** One line describing the limits, for the agent trace and the pinned notices. */
export function describeSqueezeCap(limits: SqueezeCapLimits): string {
  return (
    `Operator withdrawal cap in force: at most ${groupDigits(limits.maxSqueezes)} squeezes and ` +
    `${toFixedString(limits.maxUsdfc, 2)} USDFC out per ${windowLabel(limits.windowMs)}, and ` +
    `never below a ${toFixedString(limits.reserveUsdfc, 2)} USDFC unlocked reserve. ` +
    "SQUEEZE is an operator action, so reaching the cap refuses the request; it never " +
    "changes what the agent decides."
  );
}

/**
 * Seed the window from recorded history.
 *
 * A withdrawal counts once it has CONFIRMED on chain, which is the only kind
 * `journalSqueeze()` ever writes — the same relationship `spendEntriesFrom()`
 * has with EXECUTED deposits, so the cap and the durable record can never
 * disagree about how much has been taken out.
 */
export function squeezeEntriesFrom(squeezes: readonly OperatorSqueeze[]): SqueezeEntry[] {
  const entries: SqueezeEntry[] = [];
  for (const squeeze of squeezes) {
    let units: bigint;
    try {
      units = parseUnits(squeeze.amountUsdfc);
    } catch {
      continue;
    }
    if (units <= 0n) continue;
    entries.push({ id: squeeze.id, at: squeeze.at, amountUsdfc: squeeze.amountUsdfc });
  }
  return entries;
}
