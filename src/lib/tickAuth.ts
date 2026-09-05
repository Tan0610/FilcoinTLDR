/**
 * Authentication for the two endpoints that move money: `POST|GET /api/tick`
 * and `POST /api/squeeze`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `/api/tick` is the endpoint that can make the agent SPEND. Locally that is
 * harmless: the server is on localhost and, in the default mock mode, no funds
 * exist. On a public deployment it is a hole with money behind it — the
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
 * WHEN IT IS ENFORCED — AND WHY THE TWO ENDPOINTS DIFFER
 * ------------------------------------------------------
 * One secret, two thresholds for demanding it, because what is behind each door
 * in the worst case is not the same thing.
 *
 *   /api/tick     Enforced under the cron driver — i.e. on a deployment.
 *                 Locally it stays open, so `npm run dev` and the RUN TICK NOW
 *                 button behave exactly as they always have. The worst an
 *                 unauthenticated local tick can do is run the cycle that was
 *                 going to run seconds later anyway: the agent senses, the
 *                 policy engine decides, and anything it spends is bounded by
 *                 the spend cap and is a deposit INTO the agent's own Filecoin
 *                 Pay account. An early decision is not a loss.
 *
 *   /api/squeeze  Enforced whenever the chain adapter is LIVE — whatever the
 *                 driver, whatever the host, localhost included — and, in mock
 *                 mode, wherever the tick check applies. Its worst case is not
 *                 an early decision: `payments.withdraw()` moves real USDFC OUT
 *                 of Filecoin Pay, in an amount the CALLER names. "It is only
 *                 localhost" is not a boundary here — a dev server in LIVE mode
 *                 is a funded wallet listening on a port, reachable by anything
 *                 else running on the machine and by any page that can be made
 *                 to POST to it. So LIVE means the secret, always. See
 *                 `requiresSqueezeAuth()`.
 *
 * `FILRUNWAY_REQUIRE_TICK_AUTH` forces the check on or off for testing. It can
 * force it ON for either endpoint, but it can only force it OFF in mock mode:
 * an override able to open a LIVE withdrawal endpoint would be the hole this
 * arrangement exists to close.
 *
 * A deployment with the check required and no secret configured REFUSES (503)
 * rather than falling open. A misconfigured deployment that does nothing is
 * recoverable; a misconfigured deployment that lets the internet spend — or
 * withdraw — the wallet is not.
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

/** Selects the chain adapter. `live` means a real, funded Calibration account. */
export const CHAIN_MODE_ENV = "FILRUNWAY_MODE";

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

/**
 * Whether this process is pointed at the real chain.
 *
 * Mirrors `getChainMode()` in `src/lib/chain` (and `journalMode()` in
 * `journal.ts`); it is read straight from the environment here so that
 * authentication — which every route resolves before anything else — never
 * has to pull in the chain adapters or the Synapse SDK.
 *
 * Deliberately LOOSER than `getChainMode()`'s exact `=== "live"`: a value like
 * `" LIVE\n"` selects the mock adapter but counts as live here. Every
 * disagreement in that direction ends in demanding a secret that was not
 * strictly needed, which is the harmless way round. There is no value this
 * reads as mock that the adapter reads as live, and that is the only direction
 * that could leave a funded account unguarded.
 */
export function isLiveChain(env: DeploymentEnv = process.env): boolean {
  return env[CHAIN_MODE_ENV]?.trim().toLowerCase() === "live";
}

/** The explicit override, or null when it is unset or unrecognised. */
function authOverride(env: DeploymentEnv): boolean | null {
  const override = env[REQUIRE_TICK_AUTH_ENV]?.trim().toLowerCase();
  if (override === "1" || override === "true") return true;
  if (override === "0" || override === "false") return false;
  return null;
}

/**
 * Whether the dashboard's operator controls must ask for the secret before
 * they will do anything.
 *
 * TRUE when EITHER endpoint behind those controls demands it, because the strip
 * has one secret input serving both buttons. In LIVE mode on localhost that
 * means the input appears even though RUN TICK NOW would have been let through
 * without it: sending a secret to an endpoint that is not checking one costs
 * nothing, whereas the reverse — no input rendered, and SQUEEZE RUNWAY 401ing
 * forever — is a control that cannot work. The ANSWER is the environment's, not
 * the browser's — a page cannot be trusted to decide whether it needs to
 * authenticate — and the checks that matter still run in the route handlers.
 *
 * `src/app/page.tsx` resolves it on the server and hands it to the client, so
 * the controls render in the right state on the first painted frame instead of
 * offering a button that turns out to 401.
 */
export function operatorAuthRequired(env: DeploymentEnv = process.env): boolean {
  return requiresTickAuth(env) || requiresSqueezeAuth(env);
}

/** Whether a request to `/api/tick` must carry the shared secret here. */
export function requiresTickAuth(env: DeploymentEnv = process.env): boolean {
  return authOverride(env) ?? agentDriver(env) === "cron";
}

/**
 * Whether a request to `/api/squeeze` must carry the shared secret here.
 *
 * UNCONDITIONAL in LIVE mode. `/api/squeeze` is the only endpoint that takes
 * money OUT of the agent's Filecoin Pay account, in an amount the caller names,
 * so the question it has to answer is not "is this a deployment?" but "is there
 * a funded account behind this process?". A `next dev` in LIVE mode is as much
 * a funded account as a Vercel Function is; the only difference is who can
 * reach the port, and that is not something the handler can verify.
 *
 * In MOCK mode it falls back to the tick's own rule — open under the interval
 * driver, required under cron — so the local demo and the tests stay
 * frictionless, while a DEPLOYED mock build is still not a public button.
 *
 * The LIVE branch comes first on purpose: `FILRUNWAY_REQUIRE_TICK_AUTH=0` can
 * open the mock endpoint but can never open the live one.
 */
export function requiresSqueezeAuth(env: DeploymentEnv = process.env): boolean {
  if (isLiveChain(env)) return true;
  return requiresTickAuth(env);
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

/** How one endpoint names itself in its own refusals. */
interface AuthEndpoint {
  /** Route path, quoted back to the caller in the 401. */
  path: string;
  /** Plural noun for the 503: "ticks", "squeezes". */
  requests: string;
}

/**
 * The shared decision, once the caller has settled whether the secret is
 * required here. One body for both endpoints, so there is a single comparison
 * and a single fail-closed branch to get right; only the threshold differs.
 *
 * Every rejection says the same thing whatever went wrong, so the response
 * cannot be used to discover whether a secret is configured or how long it is.
 */
function authorize(
  headers: Headers,
  env: DeploymentEnv,
  required: boolean,
  endpoint: AuthEndpoint,
): TickAuthResult {
  if (!required) return { ok: true, via: "open" };

  const expected = configuredSecret(env);
  if (expected === null) {
    // Fail CLOSED. See the header comment: a deployment that cannot
    // authenticate must do nothing rather than spend on anyone's request.
    return {
      ok: false,
      status: 503,
      error:
        `The agent is not accepting ${endpoint.requests}: ${TICK_SECRET_ENV} is not ` +
        "configured on this deployment, so no caller can be authenticated and none is " +
        "trusted.",
    };
  }

  const presented = presentedSecret(headers);
  if (presented === null || !secretsMatch(presented.value, expected)) {
    return {
      ok: false,
      status: 401,
      error:
        `Unauthorized. ${endpoint.path} can move funds, so it requires the deployment's ` +
        `shared secret as \`Authorization: Bearer <${TICK_SECRET_ENV}>\`.`,
    };
  }

  return { ok: true, via: presented.via };
}

/** Decide whether a tick request may proceed. */
export function authorizeTick(
  headers: Headers,
  env: DeploymentEnv = process.env,
): TickAuthResult {
  return authorize(headers, env, requiresTickAuth(env), {
    path: "/api/tick",
    requests: "ticks",
  });
}

/**
 * Decide whether a squeeze request may proceed.
 *
 * Same secret, same constant-time comparison, same fail-closed 503 — and a
 * strictly higher bar for when it is demanded. See `requiresSqueezeAuth()`.
 */
export function authorizeSqueeze(
  headers: Headers,
  env: DeploymentEnv = process.env,
): TickAuthResult {
  return authorize(headers, env, requiresSqueezeAuth(env), {
    path: "/api/squeeze",
    requests: "squeezes",
  });
}
