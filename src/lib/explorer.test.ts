import { describe, expect, it } from "vitest";

import {
  EXPLORER_BASE,
  EXPLORER_NAME,
  decisionTxUrl,
  explorerAddressUrl,
  explorerTxUrl,
} from "./explorer";

/**
 * These are the links a judge clicks, so the thing under test is not really
 * string concatenation — it is the claim that the URL shape reaches a page
 * about this transaction rather than a not-found shell.
 *
 * The shapes below were established empirically against the live explorer's
 * API (which is what its page reads) for this agent's own real transactions:
 *
 *   /tx/0x400ce862…      -> 200, the top-up in block 4,042,885
 *   /tx/0x06e27a6a…      -> 200, the top-up in block 4,034,196
 *   /address/0x48c54EAb… -> 200, the agent's account with its balance
 *
 * and against a control that must NOT resolve:
 *
 *   /tx/0x000…001        -> 404
 *
 * The Filfox shape this project used to emit — `/en/message/<0x hash>` — has
 * no such page: Filfox indexes message CIDs, not Ethereum hashes.
 */

const REAL_TX = "0x400ce8628408da3d4c5b1e09ec7a2533f7e6da374a2a86f33f72a553430e0df7";
const AGENT = "0x48c54EAb7039f43DcAEd14ba44b999E16a9309bD";
/** A mock-adapter hash: well-formed, and on no chain. */
const SIMULATED = "0x1946998b9a77300cbdfa187ed9359510a81f45488332e6e1daf5f45b0118eaec";

describe("explorer base", () => {
  it("is an EVM explorer, not Filfox — the `0x` forms must resolve as given", () => {
    expect(EXPLORER_BASE).toBe("https://filecoin-testnet.blockscout.com");
    expect(EXPLORER_BASE).not.toContain("filfox");
  });

  it("carries no path prefix that a builder would have to remember", () => {
    expect(EXPLORER_BASE.endsWith("/")).toBe(false);
  });

  it("names itself, so a UI label cannot drift from the host it links to", () => {
    expect(EXPLORER_BASE).toContain(EXPLORER_NAME);
  });
});

describe("explorerTxUrl", () => {
  it("builds the verified transaction shape", () => {
    expect(explorerTxUrl(REAL_TX)).toBe(
      `https://filecoin-testnet.blockscout.com/tx/${REAL_TX}`,
    );
  });

  it("passes the hash through untouched — casing and all", () => {
    const mixed = "0xAbC0000000000000000000000000000000000000000000000000000000000001";
    expect(explorerTxUrl(mixed)).toContain(mixed);
  });

  it("does not emit the Filfox message path, which 404s for an `0x` hash", () => {
    expect(explorerTxUrl(REAL_TX)).not.toContain("/message/");
  });
});

describe("explorerAddressUrl", () => {
  it("builds the verified address shape", () => {
    expect(explorerAddressUrl(AGENT)).toBe(
      `https://filecoin-testnet.blockscout.com/address/${AGENT}`,
    );
  });

  it("keeps the checksummed `0x` address rather than needing a t410f conversion", () => {
    // The chain also knows this account as t410fjdcu5k3qhh2d3sxncs5ejomz4fvjgcn57ixomgi.
    // Deriving that at link time is exactly the round trip this explorer avoids.
    expect(explorerAddressUrl(AGENT)).toContain("0x48c54EAb");
    expect(explorerAddressUrl(AGENT)).not.toContain("t410f");
  });
});

describe("decisionTxUrl", () => {
  it("links a LIVE hash", () => {
    expect(decisionTxUrl(REAL_TX, "LIVE")).toBe(explorerTxUrl(REAL_TX));
  });

  it("refuses to link a MOCK hash — it is minted locally and on no chain", () => {
    expect(decisionTxUrl(SIMULATED, "MOCK")).toBeNull();
  });

  it("refuses when the mode is not yet known, rather than guessing LIVE", () => {
    expect(decisionTxUrl(SIMULATED, null)).toBeNull();
    expect(decisionTxUrl(REAL_TX, null)).toBeNull();
  });

  it("has nothing to link when the decision produced no transaction", () => {
    expect(decisionTxUrl(undefined, "LIVE")).toBeNull();
    expect(decisionTxUrl("", "LIVE")).toBeNull();
  });

  it("never returns a URL for anything but LIVE", () => {
    for (const mode of ["MOCK", null] as const) {
      expect(decisionTxUrl(REAL_TX, mode)).toBeNull();
    }
  });
});
