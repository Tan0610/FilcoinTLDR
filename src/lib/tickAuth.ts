/**
 * Authentication for `POST|GET /api/tick`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `/api/tick` is the one endpoint that can make the agent SPEND. Locally that
 * is harmless: the server is on localhost and, in the default mock mode, no
 * funds exist. On a public deployment it is a hole with money behind it — the
 * Function holds a funded Calibration key in its environment, so anyone who
 * guesses the path can force deposits until the wallet is empty.
 *
 * THE MODEL
 * ---------
 * One shared secret, `CRON_SECRET`, checked in constant time.
 *
 * `CRON_SECRET` rather than a name of our own because that is the variable
 * Vercel Cron itself uses: when it is set on the project, Vercel sends
 * `Authorization: Bearer $CRON_SECRET` on every cron invocation. Inventing a
 * second name would mean either the cron cannot authenticate or the deployment
 * carries two secrets that must be kept equal. An operator ticking by hand
 * sends the same header (or `x-filrunway-tick-secret`, which exists only so a
 * caller behind a proxy that rewrites `Authorization` has a way through).
 *
 * WHEN IT IS ENFORCED
 * -------------------
 * Under the cron driver — i.e. on Vercel. Locally the endpoint stays open, so
 * `npm run dev` and the RUN TICK NOW button behave exactly as they did.
 * `FILRUNWAY_REQUIRE_TICK_AUTH` forces the check on or off for testing.
 *
 * A deployment with the check required and no secret configured REFUSES every
 * tick (503) rather than falling open. A misconfigured deployment that does
 * nothing is recoverable; a misconfigured deployment that lets the internet
 * spend the wallet is not.
 *
 * CONSTANT TIME
 * -------------
 * Both sides are hashed to a fixed 32 bytes before `timingSafeEqual`, so the
 * comparison never leaks the secret's length and never throws on a
 * length mismatch — which is what a naive `timingSafeEqual` on raw buffers
 * does, turning the length into an oracle by way of a 500.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { agentDriver, type DeploymentEnv } from "./deployment";

/** The environment variable holding the shared secret. Vercel Cron's own name. */
export const TICK_SECRET_ENV = "CRON_SECRET";

/** Force the check on (`1`/`true`) or off (`0`/`false`) regardless of driver. */
export const REQUIRE_TICK_AUTH_ENV = "FILRUNWAY_REQUIRE_TICK_AUTH";

/** Fallback header, for callers behind a proxy that eats `Authorization`. */
export const TICK_SECRET_HEADER = "x-filrunway-tick-secret";

/** How the caller proved itself, or `open` when no proof was required. */
export type TickAuthVia = "open" | "bearer" | "header";

export type TickAuthResult =
  | { ok: true; via: TickAuthVia }
  | { ok: false; status: 401 | 503; error: string };

/**
 * Constant-time secret comparison.
 *
 * Digesting first is deliberate: it fixes both operands at 32 bytes, so the
 * comparison is defined for inputs of different lengths and its duration is
 * independent of how much of the secret the caller guessed.
 */
export function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Whether a request to `/api/tick` must carry the shared secret here. */
export function requiresTickAuth(env: DeploymentEnv = process.env): boolean {
  const override = env[REQUIRE_TICK_AUTH_ENV]?.trim().toLowerCase();
  if (override === "1" || override === "true") return true;
  if (override === "0" || override === "false") return false;
  return agentDriver(env) === "cron";
}

/** The secret this deployment expects, or null when none is configured. */
export function configuredSecret(env: DeploymentEnv = process.env): string | null {
  const raw = env[TICK_SECRET_ENV]?.trim();
  return raw ? raw : null;
}

/** The secret a request presents, and how, or null when it presents none. */
export function presentedSecret(
  headers: Headers,
): { value: string; via: Exclude<TickAuthVia, "open"> } | null {
  const authorization = headers.get("authorization");
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1]) return { value: match[1].trim(), via: "bearer" };
  }
  const direct = headers.get(TICK_SECRET_HEADER)?.trim();
  if (direct) return { value: direct, via: "header" };
  return null;
}

/**
 * Decide whether a tick request may proceed.
 *
 * Every rejection says the same thing whatever went wrong, so the response
 * cannot be used to discover whether a secret is configured or how long it is.
 */
export function authorizeTick(
  headers: Headers,
  env: DeploymentEnv = process.env,
): TickAuthResult {
  if (!requiresTickAuth(env)) return { ok: true, via: "open" };

  const expected = configuredSecret(env);
  if (expected === null) {
    // Fail CLOSED. See the header comment: a deployment that cannot
    // authenticate must do nothing rather than spend on anyone's request.
    return {
      ok: false,
      status: 503,
      error:
        `The agent is not accepting ticks: ${TICK_SECRET_ENV} is not configured on this ` +
        "deployment, so no caller can be authenticated and none is trusted.",
    };
  }

  const presented = presentedSecret(headers);
  if (presented === null || !secretsMatch(presented.value, expected)) {
    return {
      ok: false,
      status: 401,
      error:
        "Unauthorized. /api/tick can move funds, so it requires the deployment's shared " +
        `secret as \`Authorization: Bearer <${TICK_SECRET_ENV}>\`.`,
    };
  }

  return { ok: true, via: presented.via };
}
