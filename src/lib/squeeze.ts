/**
 * Bounds for the operator's SQUEEZE RUNWAY control.
 *
 * WHAT THE CONTROL IS FOR
 * -----------------------
 * The agent's real position on Calibration is ~2,970 days of runway against a
 * burn of about a day per day. Nothing the policy engine can do will ever fire
 * on that inside a demo, so a judge watching the deployed dashboard sees HOLD,
 * forever, and has no way to tell a working agent from a screensaver.
 *
 * The honest fix is not to fake a crisis but to CAUSE one. `payments.withdraw`
 * moves USDFC out of Filecoin Pay and back to the agent's own wallet: the funds
 * are not lost, but `availableFunds` really falls, so `runwayInEpochs` really
 * collapses and the agent's next reading is a true reading of a genuinely short
 * runway. Nothing is simulated, and nothing about the display changes.
 *
 * WHOSE ACTION IT IS
 * ------------------
 * The operator's. This is the one control on the dashboard that a human uses to
 * manufacture the situation the agent then responds to, and everything about it
 * — the label, the trace lines, the fact that it produces no `Decision` — is
 * built so it can never be read as the agent acting. The autonomy on show is
 * the response, not the squeeze.
 *
 * WHY IT IS BOUNDED
 * -----------------
 * It moves money from a funded wallet, so it is behind the same shared secret
 * as `/api/tick` (see `src/lib/tickAuth.ts`) AND behind a ceiling. An operator
 * who fat-fingers an amount, or a caller who has the secret and a bad idea,
 * cannot drain the account in one call — and a withdrawal larger than the
 * unlocked balance is refused rather than submitted, because Filecoin Pay would
 * revert it and the failure would look like the agent's.
 *
 * CONFIGURATION
 * -------------
 *   FILRUNWAY_SQUEEZE_USDFC      (default "1")  amount when none is requested
 *   FILRUNWAY_MAX_SQUEEZE_USDFC  (default "5")  hard ceiling per call
 *
 * Set the default to whatever actually collapses the runway of the account in
 * question; `npm run bootstrap -- status` prints the balance to size it from.
 */

import { parseUnits, toFixedString } from "./units";

/** The slice of the environment this module reads. */
export type SqueezeEnv = Record<string, string | undefined>;

export const SQUEEZE_AMOUNT_ENV = "FILRUNWAY_SQUEEZE_USDFC";
export const SQUEEZE_MAX_ENV = "FILRUNWAY_MAX_SQUEEZE_USDFC";

export const DEFAULT_SQUEEZE_USDFC = "1";
export const DEFAULT_MAX_SQUEEZE_USDFC = "5";

export interface SqueezeLimits {
  /** Withdrawn when the caller names no amount. */
  defaultUsdfc: string;
  /** Never exceeded, whatever the caller asks for. */
  maxUsdfc: string;
}

export type SqueezePlan =
  | { ok: true; amountUsdfc: string; note: string }
  | { ok: false; reason: string };

/** A positive decimal string, or null when the value is unusable. */
function positiveDecimal(raw: string | undefined | null): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    return parseUnits(trimmed) > 0n ? trimmed : null;
  } catch {
    return null;
  }
}

/** The bounds in force. Never throws on a malformed value; falls back instead. */
export function squeezeLimits(env: SqueezeEnv = process.env): SqueezeLimits {
  return {
    defaultUsdfc: positiveDecimal(env[SQUEEZE_AMOUNT_ENV]) ?? DEFAULT_SQUEEZE_USDFC,
    maxUsdfc: positiveDecimal(env[SQUEEZE_MAX_ENV]) ?? DEFAULT_MAX_SQUEEZE_USDFC,
  };
}

/**
 * Decide what may actually be withdrawn.
 *
 * Pure: the caller supplies the request, the account's unlocked balance and the
 * bounds. Every refusal names the number that caused it, so a 400 from this
 * endpoint tells an operator what to change.
 *
 * `available` is `RunwaySnapshot.fundsAvailable`, i.e. Filecoin Pay's own
 * `availableFunds` — the portion not already locked against commitments.
 * Withdrawing more than that is what "leaving the account in debt" means here,
 * and it is refused outright rather than clamped: an operator who asked for 5
 * and silently got 0.31 would misread the runway that followed.
 */
export function planSqueeze(
  requested: string | undefined | null,
  available: string,
  limits: SqueezeLimits,
): SqueezePlan {
  const asked = requested === undefined || requested === null || requested.trim() === ""
    ? limits.defaultUsdfc
    : positiveDecimal(requested);

  if (asked === null) {
    return {
      ok: false,
      reason:
        `Refused: ${JSON.stringify(requested)} is not a positive USDFC amount. Send ` +
        `{"amountUsdfc":"1"} or omit the body to use the configured default of ` +
        `${limits.defaultUsdfc} USDFC.`,
    };
  }

  if (parseUnits(asked) > parseUnits(limits.maxUsdfc)) {
    return {
      ok: false,
      reason:
        `Refused: ${asked} USDFC exceeds the ${limits.maxUsdfc} USDFC ceiling on a single ` +
        `squeeze. Raise ${SQUEEZE_MAX_ENV} if that ceiling is genuinely too low.`,
    };
  }

  let availableUnits: bigint;
  try {
    availableUnits = parseUnits(available);
  } catch {
    return {
      ok: false,
      reason:
        "Refused: the account's unlocked balance could not be read, so no withdrawal can " +
        "be shown to be safe. Nothing was submitted.",
    };
  }

  if (availableUnits <= 0n) {
    return {
      ok: false,
      reason:
        "Refused: Filecoin Pay reports no unlocked funds on this account, so there is " +
        "nothing to withdraw and the runway is already at its floor.",
    };
  }

  if (parseUnits(asked) > availableUnits) {
    return {
      ok: false,
      reason:
        `Refused: withdrawing ${asked} USDFC would leave the account in debt — Filecoin Pay ` +
        `reports only ${toFixedString(available, 6)} USDFC unlocked. Ask for that much or ` +
        "less. Nothing was submitted.",
    };
  }

  return {
    ok: true,
    amountUsdfc: asked,
    note:
      `Operator withdrawal of ${asked} USDFC from Filecoin Pay to the agent wallet, against ` +
      `${toFixedString(available, 6)} USDFC unlocked. This is a HUMAN action that shortens ` +
      "the runway on purpose; the agent's response to it on the next tick is the autonomous " +
      "part. No funds leave the agent's control.",
  };
}
