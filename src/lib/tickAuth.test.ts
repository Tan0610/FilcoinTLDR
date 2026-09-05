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
 *   - a deployment with no secret configured refuses rather than falls open;
 *   - a wrong, empty, truncated or absent secret is refused;
 *   - the comparison does not throw on a length mismatch, which is the classic
 *     way a "constant-time" check turns the secret's length into an oracle.
 */

import { describe, expect, it } from "vitest";

import {
  REQUIRE_TICK_AUTH_ENV,
  TICK_SECRET_ENV,
  TICK_SECRET_HEADER,
  authorizeTick,
  configuredSecret,
  presentedSecret,
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
