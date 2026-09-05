/**
 * Tick authentication tests.
 *
 * `/api/tick` is the only endpoint in this project that can move money, and on
 * a public deployment the wallet key sits in the same environment the handler
 * runs in. So the properties asserted here are not "the header parser works" —
 * they are the ones that decide whether a stranger can spend the agent's funds:
 *
 *   - local development is untouched (no secret, no header, still ticks);
 *   - a deployment ALWAYS demands the secret;
 *   - `/api/squeeze`, which is the endpoint that moves money OUT, demands it
 *     whenever the chain is LIVE — localhost included, override or not;
 *   - a deployment with no secret configured refuses rather than falls open;
 *   - a wrong, empty, truncated or absent secret is refused;
 *   - the comparison does not throw on a length mismatch, which is the classic
 *     way a "constant-time" check turns the secret's length into an oracle.
 */

import { describe, expect, it } from "vitest";

import {
  CHAIN_MODE_ENV,
  REQUIRE_TICK_AUTH_ENV,
  TICK_SECRET_ENV,
  TICK_SECRET_HEADER,
  authorizeSqueeze,
  authorizeTick,
  configuredSecret,
  isLiveChain,
  operatorAuthRequired,
  presentedSecret,
  requiresSqueezeAuth,
  requiresTickAuth,
  secretsMatch,
} from "./tickAuth";

const SECRET = "3f8a0c1d5e6b7a90112233445566778899aabbccddeeff00112233445566778";

/** A deployed environment: Vercel sets VERCEL=1 in every Function. */
function deployed(extra: Record<string, string | undefined> = {}) {
  return { VERCEL: "1", [TICK_SECRET_ENV]: SECRET, ...extra };
}

/** A developer's machine: no Vercel marker, no secret. */
function local(extra: Record<string, string | undefined> = {}) {
  return { ...extra };
}

/**
 * A developer's machine pointed at the REAL chain — `next dev` with
 * `FILRUNWAY_MODE=live`. No Vercel marker, so the tick check does not apply,
 * but the wallet behind the process is funded and `/api/squeeze` can empty it.
 */
function localLive(extra: Record<string, string | undefined> = {}) {
  return { [CHAIN_MODE_ENV]: "live", [TICK_SECRET_ENV]: SECRET, ...extra };
}

function headers(init: Record<string, string> = {}): Headers {
  return new Headers(init);
}

describe("requiresTickAuth", () => {
  it("does not require a secret locally, so npm run dev is unchanged", () => {
    expect(requiresTickAuth(local())).toBe(false);
  });

  it("requires a secret on Vercel", () => {
    expect(requiresTickAuth({ VERCEL: "1" })).toBe(true);
  });

  it("honours an explicit override in both directions", () => {
    expect(requiresTickAuth(local({ [REQUIRE_TICK_AUTH_ENV]: "1" }))).toBe(true);
    expect(requiresTickAuth(deployed({ [REQUIRE_TICK_AUTH_ENV]: "0" }))).toBe(false);
  });
});

describe("configuredSecret", () => {
  it("treats whitespace-only as absent", () => {
    expect(configuredSecret({ [TICK_SECRET_ENV]: "   " })).toBeNull();
    expect(configuredSecret({})).toBeNull();
  });

  it("trims a value pasted with a trailing newline", () => {
    expect(configuredSecret({ [TICK_SECRET_ENV]: ` ${SECRET}\n` })).toBe(SECRET);
  });
});

describe("secretsMatch", () => {
  it("matches an identical secret", () => {
    expect(secretsMatch(SECRET, SECRET)).toBe(true);
  });

  it("rejects a different secret of the same length", () => {
    const other = `${SECRET.slice(0, -1)}f`;
    expect(other).toHaveLength(SECRET.length);
    expect(secretsMatch(other, SECRET)).toBe(false);
  });

  it("rejects — rather than throwing on — a length mismatch", () => {
    // The naive implementation passes raw buffers to timingSafeEqual, which
    // THROWS when the lengths differ. That 500 is itself an oracle: it tells a
    // caller their guess was the wrong length. Digesting first removes it.
    expect(() => secretsMatch("short", SECRET)).not.toThrow();
    expect(secretsMatch("short", SECRET)).toBe(false);
    expect(secretsMatch(`${SECRET}extra`, SECRET)).toBe(false);
    expect(secretsMatch("", SECRET)).toBe(false);
  });

  it("rejects a correct prefix of the secret", () => {
    expect(secretsMatch(SECRET.slice(0, 32), SECRET)).toBe(false);
  });
});

describe("presentedSecret", () => {
  it("reads a bearer token, case-insensitively, with surrounding space", () => {
    expect(presentedSecret(headers({ authorization: `Bearer ${SECRET}` }))).toEqual({
      value: SECRET,
      via: "bearer",
    });
    expect(presentedSecret(headers({ authorization: `bearer   ${SECRET}  ` }))).toEqual({
      value: SECRET,
      via: "bearer",
    });
  });

  it("reads the fallback header", () => {
    expect(presentedSecret(headers({ [TICK_SECRET_HEADER]: SECRET }))).toEqual({
      value: SECRET,
      via: "header",
    });
  });

  it("returns null for no credential, an empty bearer or another scheme", () => {
    expect(presentedSecret(headers())).toBeNull();
    expect(presentedSecret(headers({ authorization: "Bearer " }))).toBeNull();
    expect(presentedSecret(headers({ authorization: `Basic ${SECRET}` }))).toBeNull();
  });
});

describe("authorizeTick", () => {
  it("lets a local tick through with no credential at all", () => {
    expect(authorizeTick(headers(), local())).toEqual({ ok: true, via: "open" });
  });

  it("accepts the cron job's own Authorization header on a deployment", () => {
    // This is exactly what Vercel Cron sends when CRON_SECRET is set on the
    // project, so the schedule authenticates itself with no extra wiring.
    const result = authorizeTick(headers({ authorization: `Bearer ${SECRET}` }), deployed());
    expect(result).toEqual({ ok: true, via: "bearer" });
  });

  it("accepts the fallback header on a deployment", () => {
    expect(authorizeTick(headers({ [TICK_SECRET_HEADER]: SECRET }), deployed())).toEqual({
      ok: true,
      via: "header",
    });
  });

  it("refuses an unauthenticated request on a deployment", () => {
    const result = authorizeTick(headers(), deployed());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(401);
  });

  it("refuses a wrong secret on a deployment", () => {
    const result = authorizeTick(headers({ authorization: "Bearer nope" }), deployed());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(401);
  });

  it("FAILS CLOSED when the deployment has no secret configured", () => {
    // The dangerous alternative is falling open, which would leave a public URL
    // with a funded wallet spendable by anyone who found the path. Doing
    // nothing is recoverable; that is not.
    const result = authorizeTick(headers({ authorization: `Bearer ${SECRET}` }), {
      VERCEL: "1",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(503);
    expect(result.error).toContain(TICK_SECRET_ENV);
  });

  it("says the same thing however the request was wrong", () => {
    // A different message per failure would let a caller learn whether a secret
    // exists, or how long it is, by reading the 401 body.
    const absent = authorizeTick(headers(), deployed());
    const wrong = authorizeTick(headers({ authorization: "Bearer wrong" }), deployed());
    const truncated = authorizeTick(
      headers({ authorization: `Bearer ${SECRET.slice(0, 10)}` }),
      deployed(),
    );
    if (absent.ok || wrong.ok || truncated.ok) throw new Error("unreachable");
    expect(wrong.error).toBe(absent.error);
    expect(truncated.error).toBe(absent.error);
  });
});

describe("isLiveChain", () => {
  it("is true only for the live mode marker", () => {
    expect(isLiveChain({ [CHAIN_MODE_ENV]: "live" })).toBe(true);
    expect(isLiveChain({ [CHAIN_MODE_ENV]: "mock" })).toBe(false);
    expect(isLiveChain({})).toBe(false);
  });

  it("errs toward LIVE on a sloppy value, never away from it", () => {
    // getChainMode() compares exactly, so " LIVE\n" actually selects the MOCK
    // adapter. Reading it as live here only ever demands a secret that was not
    // strictly needed; the reverse — a value the adapter reads as live and this
    // reads as mock — is the one that would leave a funded account unguarded,
    // and there is none.
    expect(isLiveChain({ [CHAIN_MODE_ENV]: " LIVE\n" })).toBe(true);
    expect(isLiveChain({ [CHAIN_MODE_ENV]: "Live" })).toBe(true);
  });
});

describe("requiresSqueezeAuth", () => {
  it("ALWAYS requires the secret in live mode, on any host and any driver", () => {
    // The hole this closes: /api/squeeze reused the tick's rule, so a dev
    // server in live mode accepted an unauthenticated withdrawal.
    expect(requiresSqueezeAuth(localLive())).toBe(true);
    expect(requiresSqueezeAuth(localLive({ FILRUNWAY_AGENT_DRIVER: "interval" }))).toBe(true);
    expect(requiresSqueezeAuth(deployed({ [CHAIN_MODE_ENV]: "live" }))).toBe(true);
  });

  it("cannot be switched off in live mode by the override", () => {
    // The override is a testing affordance. It must not be a way to publish a
    // withdrawal endpoint that moves real funds.
    expect(requiresSqueezeAuth(localLive({ [REQUIRE_TICK_AUTH_ENV]: "0" }))).toBe(true);
    expect(requiresSqueezeAuth(localLive({ [REQUIRE_TICK_AUTH_ENV]: "false" }))).toBe(true);
  });

  it("follows the tick's rule in mock mode, so the local demo stays open", () => {
    expect(requiresSqueezeAuth(local())).toBe(false);
    expect(requiresSqueezeAuth(local({ [CHAIN_MODE_ENV]: "mock" }))).toBe(false);
    expect(requiresSqueezeAuth(local({ [REQUIRE_TICK_AUTH_ENV]: "0" }))).toBe(false);
  });

  it("requires the secret on a DEPLOYED mock build", () => {
    // Mock or not, a public URL is a public button.
    expect(requiresSqueezeAuth(deployed())).toBe(true);
  });

  it("is strictly stricter than the tick's rule, never looser", () => {
    const worlds = [
      local(),
      local({ [REQUIRE_TICK_AUTH_ENV]: "0" }),
      localLive(),
      localLive({ [REQUIRE_TICK_AUTH_ENV]: "0" }),
      deployed(),
      deployed({ [REQUIRE_TICK_AUTH_ENV]: "0" }),
      deployed({ [CHAIN_MODE_ENV]: "live" }),
    ];
    for (const env of worlds) {
      if (requiresTickAuth(env)) expect(requiresSqueezeAuth(env)).toBe(true);
    }
  });
});

describe("authorizeSqueeze", () => {
  it("refuses an unauthenticated squeeze on a LIVE dev server", () => {
    const result = authorizeSqueeze(headers(), localLive());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(401);
    expect(result.error).toContain("/api/squeeze");
  });

  it("refuses a wrong secret on a LIVE dev server", () => {
    const result = authorizeSqueeze(headers({ authorization: "Bearer nope" }), localLive());
    expect(result.ok).toBe(false);
  });

  it("FAILS CLOSED when live and no secret is configured", () => {
    // Same reasoning as the tick's 503, with more at stake: a live deployment
    // that cannot authenticate anyone must be unsqueezable, not open.
    const result = authorizeSqueeze(headers({ authorization: `Bearer ${SECRET}` }), {
      [CHAIN_MODE_ENV]: "live",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.status).toBe(503);
    expect(result.error).toContain(TICK_SECRET_ENV);
  });

  it("accepts either credential form on a LIVE dev server", () => {
    expect(authorizeSqueeze(headers({ authorization: `Bearer ${SECRET}` }), localLive())).toEqual({
      ok: true,
      via: "bearer",
    });
    expect(authorizeSqueeze(headers({ [TICK_SECRET_HEADER]: SECRET }), localLive())).toEqual({
      ok: true,
      via: "header",
    });
  });

  it("stays open on a local mock run, so the demo needs no secret", () => {
    expect(authorizeSqueeze(headers(), local())).toEqual({ ok: true, via: "open" });
  });

  it("says the same thing however the request was wrong", () => {
    const absent = authorizeSqueeze(headers(), localLive());
    const wrong = authorizeSqueeze(headers({ authorization: "Bearer wrong" }), localLive());
    if (absent.ok || wrong.ok) throw new Error("unreachable");
    expect(wrong.error).toBe(absent.error);
  });

  it("leaves /api/tick's own behaviour untouched", () => {
    // The tick is deliberately NOT tightened: its worst case is running the
    // cycle a few seconds early, and local development depends on it staying
    // open. Only the endpoint that moves money OUT got the stricter rule.
    expect(authorizeTick(headers(), localLive())).toEqual({ ok: true, via: "open" });
    expect(requiresTickAuth(localLive())).toBe(false);
  });
});

describe("operatorAuthRequired", () => {
  it("tracks the tick's answer wherever the two endpoints agree", () => {
    // The dashboard now offers RUN TICK NOW and SQUEEZE RUNWAY on a deployment.
    // Both endpoints move money, so the controls have to know whether to demand
    // the secret — and the answer must be the SERVER's, resolved from the same
    // predicates the route handlers enforce. A separate predicate that could
    // drift would eventually show an armed control that always 401s, or an
    // open one on a deployment that is not open. (Where the two endpoints
    // disagree — a LIVE dev server — the controls follow the stricter one; see
    // the next case.)
    expect(operatorAuthRequired(local())).toBe(requiresTickAuth(local()));
    expect(operatorAuthRequired(deployed())).toBe(requiresTickAuth(deployed()));
    expect(operatorAuthRequired(local())).toBe(false);
    expect(operatorAuthRequired(deployed())).toBe(true);
  });

  it("follows the explicit override in both directions", () => {
    expect(operatorAuthRequired(local({ [REQUIRE_TICK_AUTH_ENV]: "1" }))).toBe(true);
    expect(operatorAuthRequired(deployed({ [REQUIRE_TICK_AUTH_ENV]: "0" }))).toBe(false);
  });

  it("asks for the secret on a LIVE dev server, because SQUEEZE demands one", () => {
    // The strip has ONE input for both buttons. On a live dev server RUN TICK
    // NOW would go through without it, but SQUEEZE RUNWAY would not — so the
    // input has to be there. A secret sent to an endpoint that is not checking
    // one costs nothing; a control that can never be armed is broken.
    expect(requiresTickAuth(localLive())).toBe(false);
    expect(requiresSqueezeAuth(localLive())).toBe(true);
    expect(operatorAuthRequired(localLive())).toBe(true);
  });

  it("stays out of the way on a local mock run", () => {
    expect(operatorAuthRequired(local())).toBe(false);
  });
});
