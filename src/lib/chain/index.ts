/**
 * Chain boundary.
 *
 * Everything above this file (policy engine, agent loop, API routes, dashboard)
 * talks to Filecoin ONLY through `ChainAdapter`. Nothing above this file may
 * import the Synapse SDK, ethers, or a private key.
 *
 * SEAM FOR THE LIVE-CHAIN AGENT
 * -----------------------------
 * Two implementations live behind this seam: `MockChainAdapter` (simulated,
 * the default) and `SynapseChainAdapter` (real Calibration chain, selected by
 * `FILRUNWAY_MODE=live`). Do not change the interface without updating
 * `src/lib/types.ts` — the dashboard is written against these shapes.
 *
 * `./synapse` is imported statically but costs nothing in mock mode: it pulls
 * the Synapse SDK in with a dynamic `import()` on first use and holds only
 * `import type` references at module scope.
 */

import type {
  AgentMode,
  RunwaySnapshot,
  StorageListing,
  StoredItem,
  TxStatus,
} from "../types";
import { MockChainAdapter } from "./mock";
import { SynapseChainAdapter } from "./synapse";

export interface ChainAdapter {
  /** MOCK or LIVE — surfaced in the UI so a demo can never be mistaken for mainnet. */
  readonly mode: AgentMode;

  /** The agent's own address (0x / f4 form as the implementation prefers). */
  getAddress(): Promise<string>;

  /** One reading of the agent's Filecoin Pay position + wallet balances. */
  getSnapshot(): Promise<RunwaySnapshot>;

  /**
   * Move `amountUsdfc` (whole USDFC decimal string, e.g. "5") from the wallet
   * into Filecoin Pay. Resolves once the transaction is submitted and its hash
   * is known; may throw on insufficient balance, allowance or gas.
   */
  deposit(amountUsdfc: string): Promise<{ txHash: string }>;

  /** Payloads uploaded by THIS process. Empty on a freshly started server. */
  getStoredItems(): Promise<StoredItem[]>;

  /**
   * What the agent is actually paying to store, read from the chain rather than
   * remembered in process: the data sets on its account, their providers, sizes
   * and active piece CIDs. This is what the dashboard's STORED DATA panel shows,
   * so it must never invent a row — an account with nothing stored returns an
   * empty `dataSets`, and an unreadable field is `null` / `[]`, not a guess.
   */
  listStorage(): Promise<StorageListing>;

  /** Push a payload to Filecoin storage and return its record. */
  uploadFile(name: string, data: Uint8Array): Promise<StoredItem>;

  /**
   * OPTIONAL. Wait for a submitted transaction to be included, and report the
   * outcome. Must never throw: a lost receipt is a `FAILED` status, not an
   * exception.
   *
   * Adapters that settle instantly (the mock) leave this undefined, and the
   * agent treats a submitted deposit as immediately CONFIRMED. The live adapter
   * implements it, which is what turns the `tx` event's `status` field into a
   * real SUBMITTED -> CONFIRMED / FAILED progression.
   */
  waitForTransaction?(txHash: string): Promise<{ status: TxStatus; error?: string }>;

  /**
   * OPTIONAL, and DESTRUCTIVE. Terminate the Warm Storage payment rail for one
   * data set: the service winds down over the lockup period, the provider stops
   * being paid to hold the pieces, and there is no undo.
   *
   * Resolves once the transaction is submitted and its hash is known, exactly
   * like `deposit()`, so the same SUBMITTED -> CONFIRMED progression applies.
   *
   * An adapter is allowed not to implement this. The agent then records its
   * `PRUNE_DATASET` decision with an outcome saying the capability is absent —
   * it never silently converts the decision into something else. And even where
   * it IS implemented, `agent.ts` refuses to call it unless the deployment's
   * explicit opt-in is set; see `src/lib/eviction.ts`.
   */
  terminateDataSet?(dataSetId: string): Promise<{ txHash: string }>;

  /**
   * OPTIONAL. Move `amountUsdfc` OUT of Filecoin Pay and back to the agent's
   * own wallet.
   *
   * This is not something the agent ever does. It exists for the operator's
   * SQUEEZE RUNWAY control, which manufactures a genuine funding crisis so the
   * policy engine has something real to react to on a demo account whose true
   * runway is measured in years. The funds move between two accounts the
   * operator already controls; nothing is lost and nothing is simulated.
   * See `src/lib/squeeze.ts`.
   */
  withdraw?(amountUsdfc: string): Promise<{ txHash: string }>;
}

export type ChainMode = "mock" | "live";

export function getChainMode(): ChainMode {
  return process.env.FILRUNWAY_MODE === "live" ? "live" : "mock";
}

const ADAPTER_KEY = Symbol.for("filrunway.chain.adapter");
type GlobalWithAdapter = typeof globalThis & { [ADAPTER_KEY]?: ChainAdapter };

/**
 * Process-wide singleton so the simulated runway (and, later, the live SDK
 * session) survives across route handlers and Next.js hot reloads.
 */
export function getChainAdapter(): ChainAdapter {
  const g = globalThis as GlobalWithAdapter;
  if (g[ADAPTER_KEY]) return g[ADAPTER_KEY];

  const mode = getChainMode();

  // An explicitly-live misconfiguration is LOUD: the SynapseChainAdapter
  // constructor validates FILECOIN_PRIVATE_KEY synchronously and throws with an
  // actionable message. Falling back to the mock here would let a demo present
  // simulated numbers under a "LIVE - CALIBRATION" badge, which is worse than
  // an error page. (An unset FILRUNWAY_MODE still defaults to mock, silently.)
  const adapter: ChainAdapter = mode === "live" ? new SynapseChainAdapter() : new MockChainAdapter();

  g[ADAPTER_KEY] = adapter;
  return adapter;
}

/** Test/demo hook: drop the cached adapter so the next call rebuilds it. */
export function resetChainAdapter(): void {
  const g = globalThis as GlobalWithAdapter;
  delete g[ADAPTER_KEY];
}

/**
 * Test hook: install a specific adapter. This is how `agent.test.ts` drives the
 * runner against a scripted chain — a deposit that reverts, a read that throws,
 * a transaction that never confirms — with no network and no key. Nothing in
 * the application calls it.
 */
export function setChainAdapter(adapter: ChainAdapter): void {
  const g = globalThis as GlobalWithAdapter;
  g[ADAPTER_KEY] = adapter;
}

export { MockChainAdapter } from "./mock";
export type { MockChainAdapterOptions } from "./mock";
export { SynapseChainAdapter } from "./synapse";
export type { SynapseChainAdapterOptions } from "./synapse";
