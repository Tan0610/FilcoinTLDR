/**
 * The reader's onchain re-check.
 *
 * The property under test is narrow and load-bearing: a hash that the chain
 * does not confirm must never come back as though it had been. There are three
 * answers, and only one of them is proof.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_VERIFY_RPC,
  ETH_TX_INDEX_LIFETIME_DAYS,
  explorerTxHash,
  hashRewritten,
  insideIndexWindow,
  isDenied,
  isProven,
  isTxHash,
  verdictLabel,
  verifyRpcUrl,
  verifyTxHash,
  verifyTxHashes,
} from "./txVerify";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_788_600_000_000;
const FRESH = NOW - 2 * 60 * 60 * 1000;
const AGED = NOW - (ETH_TX_INDEX_LIFETIME_DAYS + 1) * DAY_MS;

const REAL = "0x06e27a6a7fd532722727953b8d266f14d8109aaaa2c9edc8645bf17a1a2fcf6b";
/** Invented by the mock adapter, and sitting in the LIVE journal file. */
const SIMULATED = "0x4e32fb1b669d258647ec924a682feae7d9e4419d830f6980866eac527022a2c9";

/** A fetch that answers with one JSON-RPC body, and records what it was asked. */
function rpc(body: unknown, calls: unknown[] = []): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("isTxHash", () => {
  it("accepts a 32-byte hash and rejects anything else", () => {
    expect(isTxHash(REAL)).toBe(true);
    expect(isTxHash("0xdeadbeef")).toBe(false);
    expect(isTxHash("0xsimulated1")).toBe(false);
    expect(isTxHash(`${REAL}00`)).toBe(false);
  });
});

describe("verifyRpcUrl", () => {
  it("defaults to the public Calibration node", () => {
    expect(verifyRpcUrl({})).toBe(DEFAULT_VERIFY_RPC);
  });

  it("honours FILECOIN_RPC_URL", () => {
    expect(verifyRpcUrl({ FILECOIN_RPC_URL: "https://node.example/rpc" })).toBe(
      "https://node.example/rpc",
    );
  });

  it("ignores a blank override rather than calling the empty string", () => {
    expect(verifyRpcUrl({ FILECOIN_RPC_URL: "   " })).toBe(DEFAULT_VERIFY_RPC);
  });
});

describe("verifyTxHash", () => {
  it("confirms a hash the node returns, with its block number", async () => {
    const check = await verifyTxHash(REAL, {
      fetchImpl: rpc({ jsonrpc: "2.0", id: 1, result: { blockNumber: "0x3d8e94" } }),
    });
    expect(check.verdict).toBe("CONFIRMED");
    expect(check.blockNumber).toBe(4_034_196);
    expect(check.error).toBeNull();
    expect(isProven(check)).toBe(true);
  });

  it("asks eth_getTransactionByHash for exactly that hash", async () => {
    const calls: unknown[] = [];
    await verifyTxHash(REAL, { fetchImpl: rpc({ result: null }, calls), attempts: 1 });
    expect(calls).toEqual([
      { jsonrpc: "2.0", id: 1, method: "eth_getTransactionByHash", params: [REAL] },
    ]);
  });

  /* ---- the pool disagrees with itself; ask again ---- */

  it("takes a confirmation from any attempt, and stops asking once it has one", async () => {
    // Measured against the real endpoint: twelve identical queries for one real
    // transaction returned two confirmations and ten nulls.
    const answers = [{ result: null }, { result: { blockNumber: "0x3d8e94" } }, { result: null }];
    let index = 0;
    const check = await verifyTxHash(REAL, {
      fetchImpl: (async () =>
        new Response(JSON.stringify(answers[index++]))) as unknown as typeof fetch,
    });
    expect(check.verdict).toBe("CONFIRMED");
    expect(index).toBe(2);
  });

  it("accepts unresolved only after every attempt has said so", async () => {
    const calls: unknown[] = [];
    const check = await verifyTxHash(SIMULATED, { fetchImpl: rpc({ result: null }, calls) });
    expect(check.verdict).toBe("UNRESOLVED");
    expect(calls).toHaveLength(3);
  });

  it("prefers a node's null over a transport failure when reporting", async () => {
    const answers: (Response | Error)[] = [
      new Error("socket hang up"),
      new Response(JSON.stringify({ result: null })),
      new Error("socket hang up"),
    ];
    let index = 0;
    const check = await verifyTxHash(SIMULATED, {
      fetchImpl: (async () => {
        const next = answers[index++];
        if (next instanceof Error) throw next;
        return next;
      }) as unknown as typeof fetch,
    });
    expect(check.verdict).toBe("UNRESOLVED");
  });

  it("does not retry an input that can never be a hash", async () => {
    let calls = 0;
    await verifyTxHash("0xsimulated1", {
      fetchImpl: (async () => {
        calls += 1;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    expect(calls).toBe(0);
  });

  it("reports a null result as UNRESOLVED, and never as proof", async () => {
    const check = await verifyTxHash(SIMULATED, { fetchImpl: rpc({ jsonrpc: "2.0", result: null }) });
    expect(check.verdict).toBe("UNRESOLVED");
    expect(isProven(check)).toBe(false);
  });

  it("treats a missing result field as UNRESOLVED, not as confirmed", async () => {
    const check = await verifyTxHash(SIMULATED, { fetchImpl: rpc({ jsonrpc: "2.0", id: 1 }) });
    expect(check.verdict).toBe("UNRESOLVED");
  });

  /* ---- the three-answer rule: a failure is not an absence ---- */

  it("reports a thrown fetch as UNVERIFIED, never UNRESOLVED", async () => {
    const check = await verifyTxHash(REAL, {
      fetchImpl: (async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      }) as unknown as typeof fetch,
    });
    expect(check.verdict).toBe("UNVERIFIED");
    expect(check.error).toContain("ENOTFOUND");
    expect(isProven(check)).toBe(false);
  });

  it("reports a non-200 as UNVERIFIED", async () => {
    const check = await verifyTxHash(REAL, {
      fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
    });
    expect(check.verdict).toBe("UNVERIFIED");
    expect(check.error).toBe("RPC HTTP 503");
  });

  it("reports a JSON-RPC error as UNVERIFIED", async () => {
    const check = await verifyTxHash(REAL, {
      fetchImpl: rpc({ jsonrpc: "2.0", error: { message: "method not supported" } }),
    });
    expect(check.verdict).toBe("UNVERIFIED");
    expect(check.error).toContain("method not supported");
  });

  it("reports unparseable JSON as UNVERIFIED", async () => {
    const check = await verifyTxHash(REAL, {
      fetchImpl: (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch,
    });
    expect(check.verdict).toBe("UNVERIFIED");
  });

  it("does not spend a round trip on something that is not a hash", async () => {
    let called = false;
    const check = await verifyTxHash("0xsimulated1", {
      fetchImpl: (async () => {
        called = true;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    expect(called).toBe(false);
    expect(check.verdict).toBe("UNVERIFIED");
  });

  it("never throws, whatever the transport does", async () => {
    await expect(
      verifyTxHash(REAL, {
        fetchImpl: (() => {
          throw new Error("synchronous explosion");
        }) as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({ verdict: "UNVERIFIED" });
  });
});

describe("verifyTxHashes", () => {
  it("looks each distinct hash up once", async () => {
    const calls: unknown[] = [];
    const checks = await verifyTxHashes([REAL, SIMULATED, REAL], {
      fetchImpl: rpc({ result: { blockNumber: "0x1" } }, calls),
    });
    expect(calls).toHaveLength(2);
    expect(checks.size).toBe(2);
    expect(checks.get(REAL)?.verdict).toBe("CONFIRMED");
  });

  it("returns an empty map for an empty list without touching the network", async () => {
    let called = false;
    const checks = await verifyTxHashes([], {
      fetchImpl: (async () => {
        called = true;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    expect(called).toBe(false);
    expect(checks.size).toBe(0);
  });
});

/* ---- the trap: a null answer from a non-archival node is not a denial ---- */

describe("insideIndexWindow", () => {
  it("counts a record younger than the index lifetime as inside it", () => {
    expect(insideIndexWindow(FRESH, NOW)).toBe(true);
  });

  it("counts an older record as outside it", () => {
    expect(insideIndexWindow(AGED, NOW)).toBe(false);
  });

  it("treats an unknown timestamp as outside — the answer that does not accuse", () => {
    expect(insideIndexWindow(null, NOW)).toBe(false);
    expect(insideIndexWindow(Number.NaN, NOW)).toBe(false);
  });

  it("treats a future timestamp as outside rather than trusting a bad clock", () => {
    expect(insideIndexWindow(NOW + DAY_MS, NOW)).toBe(false);
  });
});

describe("isDenied", () => {
  const unresolved = { hash: SIMULATED, verdict: "UNRESOLVED", blockNumber: null, onchainHash: null, error: null } as const;

  it("never accuses on an unknown timestamp", () => {
    expect(isDenied(unresolved, null)).toBe(false);
  });

  it("never accuses a confirmed hash", () => {
    expect(
      isDenied({ hash: REAL, verdict: "CONFIRMED", blockNumber: 1, onchainHash: null, error: null }, Date.now()),
    ).toBe(false);
  });

  it("never accuses on a transport failure", () => {
    expect(
      isDenied({ hash: REAL, verdict: "UNVERIFIED", blockNumber: null, onchainHash: null, error: "timeout" }, Date.now()),
    ).toBe(false);
  });

  it("never accuses an aged record — the endpoint's index expired, not the chain", () => {
    expect(isDenied(unresolved, AGED)).toBe(false);
  });

  it("does accuse a record fresh enough for the node to still hold the mapping", () => {
    expect(isDenied(unresolved, Date.now() - 60_000)).toBe(true);
  });
});

describe("verdictLabel", () => {
  it("says NOT ON CHAIN for an unresolved hash the node would still hold", () => {
    const label = verdictLabel(
      { hash: SIMULATED, verdict: "UNRESOLVED", blockNumber: null, onchainHash: null, error: null },
      Date.now() - 60_000,
    );
    expect(label).toContain("NOT ON CHAIN");
    expect(label).toContain("Not evidence");
  });

  it("does NOT call an aged unresolved hash fake — this is the libel guard", () => {
    // The project's own real top-up stops resolving on the public node after
    // roughly three days. Reporting that as fabricated would discredit genuine
    // evidence, which is the exact failure this reader exists to prevent.
    const label = verdictLabel(
      { hash: REAL, verdict: "UNRESOLVED", blockNumber: null, onchainHash: null, error: null },
      AGED,
    );
    expect(label).toContain("UNCONFIRMED");
    expect(label).not.toContain("NOT ON CHAIN");
    expect(label).toContain("not archival");
  });

  it("is cautious when it has no timestamp at all", () => {
    const label = verdictLabel({
      hash: SIMULATED,
      verdict: "UNRESOLVED",
      blockNumber: null,
      onchainHash: null,
      error: null,
    });
    expect(label).toContain("UNCONFIRMED");
    expect(label).not.toContain("NOT ON CHAIN");
  });

  it("never calls an unresolved hash confirmed, at any age", () => {
    for (const at of [FRESH, AGED, null]) {
      expect(
        verdictLabel({ hash: REAL, verdict: "UNRESOLVED", blockNumber: null, onchainHash: null, error: null }, at),
      ).not.toContain("confirmed onchain");
    }
  });

  it("never calls an unverified hash confirmed", () => {
    const label = verdictLabel({
      hash: REAL,
      verdict: "UNVERIFIED",
      blockNumber: null,
      onchainHash: null,
      error: "timeout",
    });
    expect(label).toContain("UNVERIFIED");
    expect(label).not.toContain("confirmed onchain");
  });

  it("carries the block number when there is one", () => {
    expect(
      verdictLabel({
        hash: REAL,
        verdict: "CONFIRMED",
        blockNumber: 4_034_196,
        onchainHash: null,
        error: null,
      }),
    ).toContain("4,034,196");
  });

  it("still confirms when the node gave no block number", () => {
    expect(
      verdictLabel({ hash: REAL, verdict: "CONFIRMED", blockNumber: null, onchainHash: null, error: null }),
    ).toBe("confirmed onchain");
  });
});

/**
 * The submitted hash and the indexed hash need not be the same string.
 *
 * Measured on this project's own evidence. The agent's top-up in block
 * 4,042,885 is journalled as `0x85a8d620…`, and that is genuinely the hash the
 * client computed when it submitted. The chain indexes the message it produced
 * under `0x400ce862…`, and that is the only one an explorer can find:
 *
 *   - glif and drpc both answer `eth_getTransactionByHash("0x85a8d620…")`
 *     with a transaction whose own `hash` field reads `0x400ce862…`;
 *   - `EthGetMessageCidByTransactionHash` maps BOTH to the one message CID
 *     `bafy2bzacecc2rvra…`, and `EthGetTransactionHashByCid` maps that CID
 *     back to `0x400ce862…`;
 *   - Blockscout's API: 404 for `0x85a8d620…`, 200 for `0x400ce862…`.
 *
 * A node keeps a short-lived alias from the submitted hash, so it resolves
 * either; an explorer only ever saw the message that landed, so it resolves
 * one. The record must keep showing the hash it recorded — that is the string
 * being attested to — while the LINK follows the chain.
 */
const SUBMITTED = "0x85a8d6207fabe916b76b72d33b04662d2ca3037d9d5107e99dc6d6b1cd0a5e9d";
const CANONICAL = "0x400ce8628408da3d4c5b1e09ec7a2533f7e6da374a2a86f33f72a553430e0df7";

function confirmed(hash: string, onchainHash: string | null) {
  return { hash, verdict: "CONFIRMED", blockNumber: 4_042_885, onchainHash, error: null } as const;
}

describe("onchainHash", () => {
  it("captures the hash the node reports, not the one that was asked for", async () => {
    const check = await verifyTxHash(SUBMITTED, {
      attempts: 1,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ result: { blockNumber: "0x3db085", hash: CANONICAL } }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });
    expect(check.verdict).toBe("CONFIRMED");
    expect(check.hash).toBe(SUBMITTED);
    expect(check.onchainHash).toBe(CANONICAL);
  });

  it("is null when the node omits the hash — a link falls back, it does not break", async () => {
    const check = await verifyTxHash(REAL, {
      attempts: 1,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ result: { blockNumber: "0x3d8f14" } }), { status: 200 })) as
        unknown as typeof fetch,
    });
    expect(check.verdict).toBe("CONFIRMED");
    expect(check.onchainHash).toBeNull();
  });

  it("rejects a malformed hash from the node rather than putting it in a URL", async () => {
    const check = await verifyTxHash(REAL, {
      attempts: 1,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ result: { blockNumber: "0x1", hash: "not-a-hash" } }), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    expect(check.onchainHash).toBeNull();
  });

  it("is null on every non-confirming verdict", async () => {
    const unresolved = await verifyTxHash(REAL, {
      attempts: 1,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ result: null }), { status: 200 })) as unknown as typeof fetch,
    });
    expect(unresolved.verdict).toBe("UNRESOLVED");
    expect(unresolved.onchainHash).toBeNull();

    const unverified = await verifyTxHash(REAL, {
      attempts: 1,
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    expect(unverified.verdict).toBe("UNVERIFIED");
    expect(unverified.onchainHash).toBeNull();
  });
});

describe("hashRewritten", () => {
  it("is true only when the chain filed the message under a different hash", () => {
    expect(hashRewritten(SUBMITTED, confirmed(SUBMITTED, CANONICAL))).toBe(true);
  });

  it("is false in the ordinary case where the two agree", () => {
    expect(hashRewritten(REAL, confirmed(REAL, REAL))).toBe(false);
  });

  it("does not treat hex casing as a rewrite", () => {
    expect(hashRewritten(REAL.toUpperCase().replace("0X", "0x"), confirmed(REAL, REAL))).toBe(false);
  });

  it("is false when there is no check, or the node reported no hash", () => {
    expect(hashRewritten(SUBMITTED, undefined)).toBe(false);
    expect(hashRewritten(SUBMITTED, confirmed(SUBMITTED, null))).toBe(false);
  });
});

describe("explorerTxHash", () => {
  it("links what the chain calls the transaction when the two differ", () => {
    expect(explorerTxHash(SUBMITTED, confirmed(SUBMITTED, CANONICAL))).toBe(CANONICAL);
  });

  it("links the recorded hash when nothing contradicts it", () => {
    expect(explorerTxHash(REAL, confirmed(REAL, REAL))).toBe(REAL);
  });

  it("still yields a link when the record was never checked", () => {
    // --no-verify, or an unreachable node. An unverified record keeps its
    // link; withholding one would punish the reader for the node being down.
    expect(explorerTxHash(REAL, undefined)).toBe(REAL);
    expect(explorerTxHash(REAL, confirmed(REAL, null))).toBe(REAL);
  });

  it("never invents a hash it was not given", () => {
    expect([SUBMITTED, CANONICAL]).toContain(explorerTxHash(SUBMITTED, confirmed(SUBMITTED, CANONICAL)));
  });
});
