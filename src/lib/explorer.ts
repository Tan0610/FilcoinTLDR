/**
 * Where a transaction hash or an address goes when a reader clicks it.
 *
 * WHY NOT FILFOX
 * --------------
 * This project used to link Filfox (`calibration.filfox.info/en/message/…`).
 * Every one of those links was dead, for a reason that is worth stating rather
 * than papering over: **Filfox is a Filecoin-native explorer.** It indexes
 * message CIDs (`bafy…`) and `f4`/`t4` actor addresses. It does not index the
 * Ethereum-style `0x` transaction hash the Synapse SDK hands back, nor the
 * `0x` address the agent signs from. Pasting either into a Filfox path
 * produces a page about nothing.
 *
 * Making Filfox work would mean a conversion on every link:
 *
 *   - hash -> message CID, via `Filecoin.EthGetMessageCidByTransactionHash`;
 *   - `0x` address -> `t410f…`, via `Filecoin.EthAddressToFilecoinAddress`.
 *
 * Both are real RPC methods and both were verified to work. Neither is worth
 * using here. They are async, so a synchronous render would have to hold a
 * link back until a network round trip finished; they can fail, so every link
 * acquires a failure mode; and the hash->CID index is the same ~3-day,
 * non-archival window that `src/lib/txVerify.ts` documents at length — so the
 * conversion stops working for exactly the old records whose links most need
 * to keep resolving.
 *
 * WHY BLOCKSCOUT
 * --------------
 * Blockscout runs an EVM explorer over the same Calibration chain and indexes
 * the `0x` forms directly. `/tx/<0x hash>` and `/address/<0x address>` both
 * resolve with no conversion, which makes a link a pure string build with
 * nothing to await and nothing to fail. Verified against its API — which is
 * what the page reads — for the agent's address and for its real top-up
 * transactions.
 *
 * A CAVEAT THIS MODULE CANNOT FIX
 * -------------------------------
 * The hash a client computes when it submits a transaction is not always the
 * hash the chain ends up indexing it under. One of this agent's own top-ups is
 * recorded in the journal as `0x85a8d620…`, while the chain — and therefore
 * every explorer — knows that same message as `0x400ce862…`. Both map to the
 * one message CID `bafy2bzacecc2rvra…`; a Lotus node resolves either, an
 * explorer only the latter.
 *
 * Nothing synchronous can detect that, so this module does not try. The place
 * that can is `npm run decisions`, which already asks a node about every hash
 * before printing it: `eth_getTransactionByHash` returns the canonical hash in
 * the answer, so the reader links what the chain calls the transaction rather
 * than what the journal recorded. See `explorerTxHash()` in
 * `src/lib/txVerify.ts`.
 */

import type { AgentMode } from "./types";

/** Blockscout, Filecoin Calibration testnet. */
export const EXPLORER_BASE = "https://filecoin-testnet.blockscout.com";

/** What to call it in the UI, so a label cannot drift from the base above. */
export const EXPLORER_NAME = "blockscout";

/** A transaction, by its Ethereum-style `0x` hash. */
export function explorerTxUrl(txHash: string): string {
  return `${EXPLORER_BASE}/tx/${txHash}`;
}

/** An account, by its Ethereum-style `0x` address. */
export function explorerAddressUrl(address: string): string {
  return `${EXPLORER_BASE}/address/${address}`;
}

/**
 * The explorer link for a decision's hash — or `null` when there is nothing on
 * chain to link to.
 *
 * The mock adapter mints hashes with `0x${hex(32)}`. They are perfectly
 * well-formed and they correspond to no transaction anywhere, so an explorer
 * link built from one is guaranteed to land on a not-found page. `npm run
 * decisions` has always refused to print a link for a MOCK record for this
 * reason; the dashboard used to print one anyway, which meant the default
 * local demo shipped a decision card whose only clickable element was dead.
 *
 * Only a LIVE record gets a link. Not-yet-known mode is treated as not-LIVE:
 * the cost of withholding a link for one frame is a link, and the cost of
 * getting it wrong is a judge clicking a simulated hash into a 404.
 */
export function decisionTxUrl(
  txHash: string | undefined,
  mode: AgentMode | null,
): string | null {
  if (!txHash) return null;
  if (mode !== "LIVE") return null;
  return explorerTxUrl(txHash);
}
