/**
 * Re-checking the journal's own evidence against the chain.
 *
 * WHY
 * ---
 * `npm run decisions` prints a section headed "transactions the agent
 * authored (LIVE, onchain)". Everything upstream of that heading is this
 * project's own bookkeeping: the record says LIVE, the record carries a hash,
 * therefore the hash is presented as onchain. That is an assertion about the
 * chain made entirely from a file we wrote ourselves.
 *
 * It has been close to wrong. `data/decisions.jsonl` — the LIVE journal path —
 * carries eleven MOCK-stamped records at its head (seq 1..11), written into
 * that path before the two modes had separate files, five of them holding
 * hashes the mock adapter minted with `0x${hex(32)}`. The mode scoping keeps
 * them out of the evidence section, but "a filter we wrote keeps them out" is a
 * weaker guarantee than "we asked the chain". So the reader asks.
 *
 * THE TRAP: A NULL ANSWER IS NOT A DENIAL
 * ---------------------------------------
 * `eth_getTransactionByHash` on Filecoin is NOT a permanent index. A Lotus node
 * keeps the Ethereum-hash -> Filecoin-message mapping for a short window (three
 * days by default) and the public Calibration endpoint is not archival. Once a
 * transaction ages past that window the hash stops resolving even though the
 * message is on chain forever and any explorer still shows it.
 *
 * This was measured, not assumed. `0x06e27a6a…` — the agent's own real top-up,
 * block 4,034,196 — resolved from `api.calibration.node.glif.io` with a block
 * number, and returned `null` from the same endpoint fifteen minutes later, at
 * which point it was 3.2 days old. The same node then refused
 * `eth_getBlockByNumber` for that block: "failed to retrieve messages and
 * receipts". It cannot confirm, and it cannot deny.
 *
 * Worse, the endpoint is a POOL and its members disagree. Asked for that same
 * hash twelve times in a row it confirmed twice and returned `null` ten times —
 * one URL, one second, two different answers. A single null is not even one
 * node's considered answer; see `DEFAULT_ATTEMPTS`.
 *
 * A verifier that read `null` as "fabricated" would therefore libel this
 * project's own genuine evidence three days after it was produced — the exact
 * failure it was written to prevent, pointed the other way. So `null` is its
 * own verdict, `UNRESOLVED`, and it is reported as inconclusive.
 *
 * WHERE `UNRESOLVED` STILL BITES
 * ------------------------------
 * Inside the index window a null answer IS a denial: the node would have the
 * mapping if the transaction existed. `verdictLabel()` takes the record's
 * timestamp for exactly this reason and says which of the two situations it is
 * in. A fresh LIVE record whose hash does not resolve is a real problem; an old
 * one is a limitation of the endpoint, and the reader must not confuse them.
 *
 * THREE ANSWERS, NEVER TWO
 * ------------------------
 * A lookup that fails is not a lookup that returned null. An unreachable node,
 * a timeout, a JSON-RPC error — none of them are evidence either way, and they
 * get their own verdict. The one thing this module may never do is report an
 * unconfirmed hash as confirmed.
 *
 * Needs no key and no running server; `eth_getTransactionByHash` is a public
 * read. Injectable `fetch`, so the test suite makes no network call.
 */

/** What the chain said about one hash. */
export type TxVerdict =
  /** The node returned a transaction. The hash is real, and this is proof. */
  | "CONFIRMED"
  /**
   * The node answered, and answered null. Either the transaction does not
   * exist, or it has aged out of this node's short-lived hash index. Only the
   * record's age can tell those apart — see `verdictLabel()`.
   */
  | "UNRESOLVED"
  /** Nobody answered. Says nothing either way, and must never read as either. */
  | "UNVERIFIED";

export interface TxCheck {
  readonly hash: string;
  readonly verdict: TxVerdict;
  /** Block number as reported, when CONFIRMED. Null otherwise. */
  readonly blockNumber: number | null;
  /**
   * The hash the CHAIN files this transaction under, when CONFIRMED and the
   * node reported one. Null otherwise.
   *
   * Usually identical to `hash`, and then it is redundant. It is here for
   * when it is not. The hash a client computes at submit time and the hash the
   * chain indexes are derived from different bytes, and they can disagree:
   * this agent's top-up in block 4,042,885 is journalled as `0x85a8d620…` and
   * indexed by the chain as `0x400ce862…`. A Lotus node resolves either,
   * because it keeps a short-lived alias from the submitted hash to the
   * message CID; an explorer, which only ever saw the message that landed,
   * resolves only the canonical one. So the submitted hash is what ties a
   * record to the journal, and the canonical hash is what a link must use.
   */
  readonly onchainHash: string | null;
  /** Why the lookup could not be made, when UNVERIFIED. Null otherwise. */
  readonly error: string | null;
}

/**
 * How long a Lotus node keeps the Ethereum tx-hash -> message mapping.
 *
 * Lotus's own default (`EthTxHashMappingLifetimeDays`). It is node
 * configuration rather than consensus, so this is a floor for how much doubt to
 * extend a null answer, never a guarantee about any particular endpoint. Used
 * only to decide whether a null is worth alarming about.
 */
export const ETH_TX_INDEX_LIFETIME_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The public Calibration node. Overridden by `FILECOIN_RPC_URL`, which the live
 * adapter already reads, so a deployment pointing at its own (possibly
 * archival) node gets verified against that node.
 */
export const DEFAULT_VERIFY_RPC = "https://api.calibration.node.glif.io/rpc/v1";

export type VerifyEnv = Record<string, string | undefined>;

export function verifyRpcUrl(env: VerifyEnv = process.env): string {
  const raw = env.FILECOIN_RPC_URL?.trim();
  return raw && raw !== "" ? raw : DEFAULT_VERIFY_RPC;
}

export interface VerifyOptions {
  rpcUrl?: string;
  /** Injected for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request budget. A slow node is UNVERIFIED, not UNRESOLVED. */
  timeoutMs?: number;
  /** How many times to ask before accepting a non-confirming answer. */
  attempts?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * How many times to ask before believing a non-confirming answer.
 *
 * `api.calibration.node.glif.io` is a POOL, and its members do not agree. Asked
 * for `0x06e27a6a…` twelve times in a row, it confirmed twice and returned null
 * ten times — the same real transaction, the same second, the same URL. A
 * single null is therefore not even one node's considered answer, it is a
 * routing outcome. Asking again is the cheapest possible correction and it is
 * the difference between "unconfirmed" and a false accusation.
 */
const DEFAULT_ATTEMPTS = 3;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A well-formed 32-byte hash. Anything else is not worth a round trip. */
export function isTxHash(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

/**
 * One lookup. Never throws: every failure becomes an UNVERIFIED verdict
 * carrying its reason, because a reader that crashes on a flaky node is a
 * reader nobody runs.
 */
export async function verifyTxHash(hash: string, options: VerifyOptions = {}): Promise<TxCheck> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  let best: TxCheck | null = null;

  for (let i = 0; i < attempts; i += 1) {
    const check = await askOnce(hash, options);
    // Any confirmation settles it: a pool member that HAS the transaction is
    // authoritative, and one that does not is merely uninformed.
    if (check.verdict === "CONFIRMED") return check;
    // A real null from a node outranks a transport failure as an answer, but
    // neither is proof of anything and both leave the loop running.
    if (best === null || (best.verdict === "UNVERIFIED" && check.verdict === "UNRESOLVED")) {
      best = check;
    }
    if (check.verdict === "UNVERIFIED" && check.error === "not a 32-byte tx hash") break;
    if (check.verdict === "UNVERIFIED" && check.error === "no fetch available") break;
  }

  return best!;
}

async function askOnce(hash: string, options: VerifyOptions): Promise<TxCheck> {
  if (!isTxHash(hash)) {
    return {
      hash,
      verdict: "UNVERIFIED",
      blockNumber: null,
      onchainHash: null,
      error: "not a 32-byte tx hash",
    };
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return {
      hash,
      verdict: "UNVERIFIED",
      blockNumber: null,
      onchainHash: null,
      error: "no fetch available",
    };
  }

  const url = options.rpcUrl ?? verifyRpcUrl();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getTransactionByHash",
        params: [hash],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        hash,
        verdict: "UNVERIFIED",
        blockNumber: null,
        onchainHash: null,
        error: `RPC HTTP ${response.status}`,
      };
    }

    const body = (await response.json()) as {
      result?: { blockNumber?: string | null; hash?: string | null } | null;
      error?: { message?: string };
    };

    if (body.error) {
      return {
        hash,
        verdict: "UNVERIFIED",
        blockNumber: null,
        onchainHash: null,
        error: `RPC error: ${body.error.message ?? "unknown"}`,
      };
    }

    if (body.result === null || body.result === undefined) {
      return { hash, verdict: "UNRESOLVED", blockNumber: null, onchainHash: null, error: null };
    }

    const raw = body.result.blockNumber;
    const block = typeof raw === "string" ? Number.parseInt(raw, 16) : Number.NaN;
    // Only a well-formed hash is carried forward. A node that answers with
    // anything else has told us nothing usable, and a malformed value in an
    // explorer link is worse than no value at all.
    const reported = body.result.hash;
    return {
      hash,
      verdict: "CONFIRMED",
      blockNumber: Number.isFinite(block) ? block : null,
      onchainHash: typeof reported === "string" && isTxHash(reported) ? reported : null,
      error: null,
    };
  } catch (error) {
    return { hash, verdict: "UNVERIFIED", blockNumber: null, onchainHash: null, error: message(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Look up many hashes, de-duplicated, sequentially.
 *
 * Sequential on purpose: the evidence list is capped at ten rows and a public
 * node is a shared resource. Correctness here is worth more than latency.
 */
export async function verifyTxHashes(
  hashes: readonly string[],
  options: VerifyOptions = {},
): Promise<Map<string, TxCheck>> {
  const out = new Map<string, TxCheck>();
  for (const hash of hashes) {
    if (out.has(hash)) continue;
    out.set(hash, await verifyTxHash(hash, options));
  }
  return out;
}

/**
 * Whether an UNRESOLVED answer is a denial or an expiry.
 *
 * Inside the node's index window the node would hold the mapping if the
 * transaction existed, so a null is the node saying no. Outside it, a null says
 * nothing at all. Unknown timestamp is treated as outside: the cautious answer
 * is the one that does not accuse.
 */
export function insideIndexWindow(recordedAt: number | null, now = Date.now()): boolean {
  if (recordedAt === null || !Number.isFinite(recordedAt)) return false;
  const age = now - recordedAt;
  return age >= 0 && age < ETH_TX_INDEX_LIFETIME_DAYS * DAY_MS;
}

/**
 * How a verdict reads to a human.
 *
 * `recordedAt` is the moment the decision was taken. Supplied, it upgrades an
 * UNRESOLVED answer from "inconclusive" to "the node denies this" when the
 * record is young enough for the denial to mean something.
 */
export function verdictLabel(check: TxCheck, recordedAt: number | null = null): string {
  switch (check.verdict) {
    case "CONFIRMED":
      return check.blockNumber === null
        ? "confirmed onchain"
        : `confirmed onchain · block ${check.blockNumber.toLocaleString("en-US")}`;
    case "UNRESOLVED":
      return insideIndexWindow(recordedAt)
        ? "NOT ON CHAIN — the node holds no such transaction, and this record is " +
            `newer than the ~${ETH_TX_INDEX_LIFETIME_DAYS}-day hash index, so that is a denial. ` +
            "Not evidence of anything."
        : "UNCONFIRMED — this node cannot resolve the hash. Filecoin's tx-hash index is " +
            `~${ETH_TX_INDEX_LIFETIME_DAYS} days and this endpoint is not archival, so an older ` +
            "transaction stops resolving while still being on chain. Neither confirmed nor " +
            "denied here; check the explorer link.";
    case "UNVERIFIED":
      return `UNVERIFIED — could not reach the chain to check${check.error ? ` (${check.error})` : ""}`;
  }
}

/** True when a verdict may be presented as proof. Only one of them may. */
export function isProven(check: TxCheck | undefined): boolean {
  return check?.verdict === "CONFIRMED";
}

/**
 * True when a verdict is an actual accusation: the node denied a hash it would
 * have held. This, and only this, is worth a non-zero exit status.
 */
export function isDenied(check: TxCheck | undefined, recordedAt: number | null): boolean {
  return check?.verdict === "UNRESOLVED" && insideIndexWindow(recordedAt);
}

/**
 * Whether the chain files this transaction under a different hash than the one
 * the journal recorded.
 *
 * Only ever true for a CONFIRMED check that reported a hash. Comparison is
 * case-insensitive: hex casing carries no meaning, and a node that answers in
 * a different case than the SDK recorded has not renamed anything.
 */
export function hashRewritten(recordedHash: string, check?: TxCheck): boolean {
  const onchain = check?.onchainHash;
  if (!onchain) return false;
  return onchain.toLowerCase() !== recordedHash.toLowerCase();
}

/**
 * The hash to build an explorer link from.
 *
 * The canonical one when the node supplied it, the recorded one otherwise —
 * because an unverified or unreachable record still deserves a link, and the
 * recorded hash is right for all but the rare rewritten case. This never
 * replaces the hash a record is *presented* under; the journal's hash is the
 * thing being attested to and it stays on screen. It only decides where the
 * click goes.
 */
export function explorerTxHash(recordedHash: string, check?: TxCheck): string {
  return check?.onchainHash ?? recordedHash;
}
