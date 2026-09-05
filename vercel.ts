/**
 * Vercel project configuration.
 *
 * `vercel.ts` rather than `vercel.json`: it is the current recommended form,
 * it type-checks against `@vercel/config`, and — the reason it matters here —
 * it can read the environment, so the cron schedule is a deployment setting
 * rather than a constant baked into a committed file. The Vercel CLI and the
 * platform build compile this to the JSON form automatically; there must not
 * also be a `vercel.json`.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * The agent's cycle is a `setInterval` in `src/lib/agent.ts`. That works when a
 * single process stays alive and is meaningless on a Function that lives for
 * one request. Deployed, the driver is the cron job below: it calls
 * `/api/tick`, which is the same cycle the local timer runs, and which requires
 * `CRON_SECRET` before it will do anything (see `src/lib/tickAuth.ts`).
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET` on every cron invocation
 * when that variable is set on the project, so the schedule below authenticates
 * itself with no extra wiring — and an unauthenticated caller who finds the
 * path gets a 401 instead of a deposit.
 *
 * PLAN LIMITS — READ THIS BEFORE DEPLOYING
 * ----------------------------------------
 * Cron granularity is a plan feature. Hobby projects are limited to a small
 * number of cron jobs that run at most once a day, and the run may be up to an
 * hour late; per-minute schedules need Pro. A once-a-day agent is a poor demo,
 * so on Hobby either set FILRUNWAY_CRON_SCHEDULE to something the plan accepts
 * and drive the minute-by-minute cadence from an external scheduler calling
 * `/api/tick` with the same bearer token, or deploy to a Pro project.
 *
 * FILRUNWAY_CRON_SCHEDULE is read at BUILD time (this file is compiled on the
 * build machine, where project environment variables are available), so
 * changing it requires a redeploy — unlike the runtime variables, which do not.
 */

import type { VercelConfig } from "@vercel/config/v1";

/** Once a minute. The finest granularity Vercel Cron offers. */
const DEFAULT_SCHEDULE = "* * * * *";

export const config: VercelConfig = {
  framework: "nextjs",

  crons: [
    {
      path: "/api/tick",
      schedule: process.env.FILRUNWAY_CRON_SCHEDULE?.trim() || DEFAULT_SCHEDULE,
    },
  ],

  functions: {
    /**
     * A LIVE tick is a chain read, a deposit and a wait for inclusion on
     * Calibration — measured at roughly 60–90 seconds end to end, which is well
     * past any default that used to apply. It must not be cut off holding a
     * submitted transaction it never recorded the outcome of.
     */
    "src/app/api/tick/route.ts": { maxDuration: 300 },

    /**
     * The SSE feed is deliberately long-lived. It is closed by the platform at
     * `maxDuration` and the browser's EventSource reconnects on its own
     * (`retry: 3000` is sent on connect), so this bounds one connection rather
     * than the feed.
     */
    "src/app/api/stream/route.ts": { maxDuration: 300 },
  },
};
