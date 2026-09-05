/**
 * Driver-detection tests.
 *
 * This is a small module with one large consequence: it decides whether the
 * agent's cycle is a timer in this process or a scheduled call from outside.
 * Get it wrong in one direction and the deployed agent never ticks; get it
 * wrong in the other and merely LOADING the local dashboard stops starting the
 * loop. Both are silent failures, so the detection is asserted rather than
 * assumed.
 */

import { describe, expect, it } from "vitest";

import {
  CRON_INTERVAL_ENV_VAR,
  CRON_TICK_INTERVAL_MS,
  DRIVER_ENV_VAR,
  REMOTE_POLL_MS,
  agentDriver,
  dashboardPollMs,
  isVercel,
  manualTickEnabled,
  tickIntervalMs,
  vercelEnvironment,
} from "./deployment";

const LOCAL_INTERVAL = 15_000;

describe("isVercel", () => {
  it("keys off Vercel's own marker, not a guess", () => {
    expect(isVercel({ VERCEL: "1" })).toBe(true);
    expect(isVercel({})).toBe(false);
    expect(isVercel({ NODE_ENV: "production" })).toBe(false);
    expect(isVercel({ VERCEL: "0" })).toBe(false);
  });

  it("reports which Vercel environment it is in, when it is in one", () => {
    expect(vercelEnvironment({ VERCEL: "1", VERCEL_ENV: "production" })).toBe("production");
    expect(vercelEnvironment({ VERCEL_ENV: "production" })).toBeNull();
  });
});

describe("agentDriver", () => {
  it("keeps the local setInterval driver off Vercel", () => {
    expect(agentDriver({})).toBe("interval");
  });

  it("uses the cron driver on Vercel, where no process holds a timer", () => {
    expect(agentDriver({ VERCEL: "1" })).toBe("cron");
  });

  it("honours an explicit override, for a self-hosted long-running server", () => {
    expect(agentDriver({ VERCEL: "1", [DRIVER_ENV_VAR]: "interval" })).toBe("interval");
    expect(agentDriver({ [DRIVER_ENV_VAR]: "cron" })).toBe("cron");
  });

  it("ignores a typo rather than trusting it", () => {
    // A misspelled override must not silently leave the agent with no driver.
    expect(agentDriver({ VERCEL: "1", [DRIVER_ENV_VAR]: "intervall" })).toBe("cron");
    expect(agentDriver({ [DRIVER_ENV_VAR]: "" })).toBe("interval");
  });
});

describe("tickIntervalMs", () => {
  it("reports the local interval locally", () => {
    expect(tickIntervalMs(LOCAL_INTERVAL, {})).toBe(LOCAL_INTERVAL);
  });

  it("reports the cron schedule when that is what actually drives it", () => {
    // The dashboard's NEXT TICK countdown is a reading like any other; running
    // it to a deadline nothing observes would be a false one.
    expect(tickIntervalMs(LOCAL_INTERVAL, { VERCEL: "1" })).toBe(CRON_TICK_INTERVAL_MS);
    expect(
      tickIntervalMs(LOCAL_INTERVAL, { VERCEL: "1", [CRON_INTERVAL_ENV_VAR]: "300000" }),
    ).toBe(300_000);
  });

  it("ignores a nonsense override", () => {
    expect(
      tickIntervalMs(LOCAL_INTERVAL, { VERCEL: "1", [CRON_INTERVAL_ENV_VAR]: "soon" }),
    ).toBe(CRON_TICK_INTERVAL_MS);
  });
});

describe("manualTickEnabled", () => {
  it("offers the operator controls on a deployment as well as locally", () => {
    // This used to be false on Vercel, because a button could only send the
    // tick secret by carrying it — which would publish it to every visitor of
    // a public URL holding a funded wallet key.
    //
    // The page does not carry it. A human pastes the secret in and it is sent
    // as a request header; nothing is inlined into the bundle or rendered into
    // the HTML, and a visitor without it gets the 401 `/api/tick` already
    // returns. What the old arrangement cost was the ability to demonstrate the
    // agent at all on the deployment — a judge could only wait out the cron.
    expect(manualTickEnabled({})).toBe(true);
    expect(manualTickEnabled({ VERCEL: "1" })).toBe(true);
  });
});

describe("dashboardPollMs", () => {
  it("does not poll locally, where the SSE stream is authoritative", () => {
    expect(dashboardPollMs({})).toBe(0);
  });

  it("polls under the cron driver, where the stream is served by another process", () => {
    expect(dashboardPollMs({ VERCEL: "1" })).toBe(REMOTE_POLL_MS);
  });
});
