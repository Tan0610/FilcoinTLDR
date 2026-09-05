/**
 * Where this process is running, and what that changes.
 *
 * THE PROBLEM
 * -----------
 * The agent loop is a `setInterval` (see `ensureAgentLoop()` in `agent.ts`).
 * That is correct for `next dev` and `next start`, where one long-lived process
 * owns the timer. It is meaningless on Vercel: a Serverless Function exists for
 * the duration of a request, so a timer scheduled inside one either never fires
 * or fires on an instance nobody is looking at. An agent whose autonomy depends
 * on a timer that does not exist is not autonomous.
 *
 * So the DRIVER is chosen from the environment rather than assumed:
 *
 *   - `interval` — a `setInterval` in this process. Local development. This is
 *     exactly what the project did before, unchanged.
 *   - `cron`     — an external scheduler calls `/api/tick`. On Vercel that is a
 *     Cron Job declared in `vercel.ts`. Nothing schedules a timer, and NO route
 *     may start a cycle as a side effect of being read.
 *
 * DETECTION
 * ---------
 * `VERCEL=1` is set by Vercel in the build environment and in every Function at
 * runtime — it is the platform's own marker, documented as a System Environment
 * Variable, and it is what `vercel dev` sets too. We do not sniff for the
 * absence of a filesystem or guess from `NODE_ENV`: those are proxies for the
 * question, and a wrong answer here silently decides whether the agent ticks at
 * all. `FILRUNWAY_AGENT_DRIVER` overrides it, which is how the driver is tested
 * and how a self-hosted long-running deployment can keep the interval.
 */

export type AgentDriver = "interval" | "cron";

/** The slice of the environment this module reads. */
export type DeploymentEnv = Record<string, string | undefined>;

/** Vercel's own environment marker. Set in builds and in every Function. */
export const VERCEL_ENV_VAR = "VERCEL";

/** Explicit override, for tests and for self-hosted long-running deployments. */
export const DRIVER_ENV_VAR = "FILRUNWAY_AGENT_DRIVER";

/**
 * How often the cron driver is scheduled, in ms. Vercel Cron's finest
 * granularity is one minute, which is what `vercel.ts` asks for by default.
 * Surfaced on `AgentStatus.tickIntervalMs` so the dashboard's NEXT TICK
 * countdown describes the schedule actually in force rather than the local one.
 */
export const CRON_TICK_INTERVAL_MS = 60_000;

/** Override for a cron schedule that is not once a minute. */
export const CRON_INTERVAL_ENV_VAR = "FILRUNWAY_CRON_INTERVAL_MS";

/** How often a cron-driven dashboard re-reads the shared journal, in ms. */
export const REMOTE_POLL_MS = 5_000;

/** True when this process is running on Vercel (build or Function). */
export function isVercel(env: DeploymentEnv = process.env): boolean {
  return env[VERCEL_ENV_VAR] === "1";
}

/** `production` / `preview` / `development` on Vercel, else null. */
export function vercelEnvironment(env: DeploymentEnv = process.env): string | null {
  return isVercel(env) ? (env.VERCEL_ENV ?? null) : null;
}

/**
 * What drives the sense -> decide -> act cycle here.
 *
 * Anything other than the two literal values is ignored rather than trusted: a
 * typo in an override must not silently disable the agent.
 */
export function agentDriver(env: DeploymentEnv = process.env): AgentDriver {
  const override = env[DRIVER_ENV_VAR]?.trim().toLowerCase();
  if (override === "interval" || override === "cron") return override;
  return isVercel(env) ? "cron" : "interval";
}

/**
 * The interval the agent actually ticks at, in ms. `local` is the compiled-in
 * local interval (`TICK_INTERVAL_MS`); the cron driver reports its schedule.
 */
export function tickIntervalMs(local: number, env: DeploymentEnv = process.env): number {
  if (agentDriver(env) !== "cron") return local;
  const raw = Number(env[CRON_INTERVAL_ENV_VAR]);
  return Number.isFinite(raw) && raw > 0 ? raw : CRON_TICK_INTERVAL_MS;
}

/**
 * Whether the dashboard offers in-browser operator controls (RUN TICK NOW and
 * SQUEEZE RUNWAY).
 *
 * ALWAYS, NOW — AND WHY THAT IS STILL SAFE
 * ----------------------------------------
 * This used to be `agentDriver(env) === "interval"`, i.e. locally only, on a
 * sound argument: `/api/tick` requires a shared secret on a deployment, and a
 * button could only send that secret by carrying it, which would publish it to
 * every visitor of a public URL holding a funded wallet key.
 *
 * The premise was that the page would have to supply the secret. It does not.
 * The controls render inert and a HUMAN pastes the secret into the page to arm
 * them; it lives in that one tab's memory and is sent as a request header.
 * Nothing is compiled into the client bundle, nothing is rendered into the
 * HTML, and a visitor without the secret has a control that 401s — which is
 * exactly the protection `/api/tick` already provides on its own.
 *
 * What that buys is the thing the old arrangement cost: a judge on the deployed
 * dashboard can advance the loop instead of waiting out a 60-second cron, and
 * can trigger the squeeze that gives the agent something to decide about. An
 * agent whose autonomy cannot be observed inside a demo may as well not have
 * any. See `src/components/OperatorControls.tsx` and `src/lib/squeeze.ts`.
 *
 * `operatorAuthRequired()` (in `tickAuth.ts`) is the companion answer: whether
 * those controls must ask for a secret before they will do anything.
 */
export function manualTickEnabled(env: DeploymentEnv = process.env): boolean {
  // The parameter is kept, unread, on purpose: every other predicate in this
  // module is a function of the environment, and callers (and tests) pass one.
  // Removing it would make this the odd one out at every call site for no gain,
  // and it is the natural hook if a deployment ever needs to hide the controls.
  void env;
  return true;
}

/**
 * How often the dashboard should re-read the server, in ms. 0 means "never —
 * the SSE stream is authoritative", which is the local case.
 *
 * Under the cron driver it is NOT authoritative: the cron invocation and the
 * open stream are served by different Function instances, so the instance
 * holding the stream never sees the tick that another instance ran. Both sides
 * share the durable journal, so the fix is for the reader to poll it. See
 * `AgentStore.refresh()`.
 */
export function dashboardPollMs(env: DeploymentEnv = process.env): number {
  return agentDriver(env) === "cron" ? REMOTE_POLL_MS : 0;
}
