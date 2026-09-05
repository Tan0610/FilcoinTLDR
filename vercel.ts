/**
 * Vercel project configuration.
 *
 * `vercel.ts` rather than `vercel.json`: it is the current recommended form and
 * it type-checks against `@vercel/config`. The Vercel CLI compiles it to the
 * JSON form automatically; there must not also be a `vercel.json`.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * The agent's cycle is a `setInterval` in `src/lib/agent.ts`. That works when a
 * single process stays alive and is meaningless on a Function that lives for
 * one request. Deployed, the cycle has to be driven from outside: something
 * calls `/api/tick`, which runs the same cycle the local timer runs, and which
 * requires `CRON_SECRET` before it will do anything (see `src/lib/tickAuth.ts`).
 *
 * WHAT ACTUALLY DRIVES THE TICK
 * -----------------------------
 * `.github/workflows/agent-tick.yml`, every 5 minutes, sending
 * `Authorization: Bearer $CRON_SECRET` to `POST /api/tick`. That is the real
 * cadence. The cron job below is a once-a-day BACKSTOP only — this project is
 * on the Hobby plan, where cron jobs run at most once a day (and may be up to
 * an hour late), so a Hobby cron cannot be the driver of an agent that is
 * supposed to look alive. Per-minute schedules need Pro.
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET` on every cron invocation
 * when that variable is set on the project, so the backstop authenticates
 * itself with no extra wiring — and an unauthenticated caller who finds the
 * path gets a 401 instead of a deposit.
 *
 * WHY THE SCHEDULE IS A LITERAL AND MUST STAY ONE
 * -----------------------------------------------
 * It used to read `process.env.FILRUNWAY_CRON_SCHEDULE?.trim() || DEFAULT`, on
 * the assumption — stated in this comment, and wrong — that the platform
 * compiles this file on the build machine where project environment variables
 * are available. It does not. On a git-source deployment the platform reads
 * this config STATICALLY, before any build runs: it cannot resolve a
 * `process.env` expression, so it drops the key entirely and schema validation
 * then fails with
 *
 *     `crons[0]` missing required property `schedule`
 *
 * — which is exactly what every git-push deploy of this project did until this
 * value became a literal. Local `vercel deploy` was not affected, because there
 * the CLI really does compile `vercel.ts` on this machine and upload finished
 * JSON, which is what hid the bug.
 *
 * So: the schedule must be a value that survives static extraction. To change
 * the backstop cadence, edit the line below and redeploy. Do not reintroduce a
 * runtime expression here. (`deploymentEnv()` from `@vercel/config` is not an
 * escape hatch either: it emits a `$NAME` placeholder for the routing layer to
 * resolve at request time, which is not a cron expression and is not what the
 * cron scheduler reads.)
 */

import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  framework: "nextjs",

  crons: [
    {
      path: "/api/tick",
      /** Daily backstop, 03:00 UTC. The Hobby plan permits no finer. */
      schedule: "0 3 * * *",
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
     * The operator's squeeze submits a withdrawal and WAITS for it to be
     * included before responding, because an unconfirmed withdrawal leaves the
     * runway unchanged and the demo it exists to enable would look broken. Same
     * Calibration inclusion times as a deposit, so the same budget.
     */
    "src/app/api/squeeze/route.ts": { maxDuration: 300 },

    /**
     * The SSE feed is deliberately long-lived. It is closed by the platform at
     * `maxDuration` and the browser's EventSource reconnects on its own
     * (`retry: 3000` is sent on connect), so this bounds one connection rather
     * than the feed.
     */
    "src/app/api/stream/route.ts": { maxDuration: 300 },
  },
};
