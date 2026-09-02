/**
 * SynapseChainAdapter — the LIVE Filecoin chain adapter.
 *
 * Built against `@filoz/synapse-sdk@1.2.1`, which is **viem-based**. There is
 * no ethers dependency anywhere in this file, and none of the pre-1.0 helpers
 * (`Synapse.create({privateKey, rpcURL})`, `preflightUpload`, `getServicePrice`,
 * `operatorApproval`, `RPC_URLS`, `terminateDataSet`) exist any more.
 *
 * SECRET HANDLING
 * ---------------
 * `FILECOIN_PRIVATE_KEY` is read here and in `scripts/bootstrap.ts` and nowhere
 * else. It never leaves this module: it is not re-exported, not attached to any
 * value that crosses the `ChainAdapter` boundary, and every error message that
 * escapes this file is passed through `scrub()` first. Only the derived address
 * is ever logged.
 *
 * LAZY SDK LOADING
 * ----------------
 * `getChainAdapter()` is synchronous, and the mock demo must not pay for the
 * SDK. So this module imports the SDK with `import type` only, and pulls the
 * real thing in with a dynamic `import()` on the first call that needs a chain
 * connection. Constructing the adapter therefore costs nothing but a private
 * key validation — which is exactly the check we want to run eagerly and
 * loudly.
 *
 * FAILURE POLICY
 * --------------
 * Every chain call is wrapped in a timeout and re-thrown as a plain `Error`
 * with a scrubbed message. `agent.ts` turns those into `FAILED` decisions, so a
 * flaky RPC degrades the dashboard rather than taking down the SSE stream.
 */

import type { Synapse } from "@filoz/synapse-sdk";

import {
  EPOCHS_PER_DAY,
  UNBOUNDED_DAYS,
  UNBOUNDED_EPOCHS,
} from "../constants";
import type {
  RunwaySnapshot,
  StorageListing,
  StoredDataSet,
  StoredItem,
  TxStatus,
} from "../types";
import { formatUnits, parseUnits } from "../units";
import type { ChainAdapter } from "./index";

/* ------------------------------------------------------------------ *
 * Pure helpers — no network, no SDK, no secrets. Unit-tested directly. *
 * ------------------------------------------------------------------ */

/**
 * `viem`'s `maxUint256`, inlined so this module stays importable (and testable)
 * without loading the SDK. Filecoin Pay returns exactly this value from
 * `runwayInEpochs` / `grossCoverageInEpochs` when `lockupRatePerEpoch === 0n`.
 */
export const MAX_UINT256 = 2n ** 256n - 1n;

/** USDFC and FIL both use 18 decimals. */
export const TOKEN_DECIMALS = 18;

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Validate and normalise the agent's private key.
 *
 * Throws a message an operator can act on. The key itself is NEVER included in
 * the error — only its length, which is the part that is usually wrong.
 */
export function assertPrivateKey(value: string | undefined | null): `0x${string}` {
  const raw = value?.trim() ?? "";
  if (raw === "") {
    throw new Error(
      "FILRUNWAY_MODE=live requires FILECOIN_PRIVATE_KEY. Set it in .env.local to the " +
        "32-byte hex private key of a Calibration wallet funded with tFIL (gas) and USDFC " +
        "(storage). Refusing to fall back to the mock adapter, because a demo silently " +
        "showing simulated data while claiming to be live is worse than a hard failure.",
    );
  }
  const prefixed = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!PRIVATE_KEY_RE.test(prefixed)) {
    throw new Error(
      `FILECOIN_PRIVATE_KEY is malformed: expected 64 hex characters (optionally 0x-prefixed), ` +
        `got ${raw.length} characters. The value itself is not logged.`,
    );
  }
  return prefixed as `0x${string}`;
}

/**
 * Map `accountSummary().runwayInEpochs` onto a JSON-safe number.
 *
 * - `maxUint256` (zero burn rate) -> `UNBOUNDED_EPOCHS`, the finite sentinel.
 * - `0n` (account in deficit, `debt > 0n`) -> `0`.
 * - anything absurdly large (dust burn rate) -> clamped to the same sentinel,
 *   so the UI can never be handed a garbage 10^30.
 */
export function runwayEpochsToNumber(runwayInEpochs: bigint): number {
  if (runwayInEpochs >= MAX_UINT256) return UNBOUNDED_EPOCHS;
  if (runwayInEpochs <= 0n) return 0;
  const asNumber = Number(runwayInEpochs);
  if (!Number.isFinite(asNumber) || asNumber >= UNBOUNDED_EPOCHS) return UNBOUNDED_EPOCHS;
  return Math.floor(asNumber);
}

/** The fields of `payments.accountSummary()` that a `RunwaySnapshot` needs. */
export interface AccountSummaryLike {
  epoch: bigint;
  availableFunds: bigint;
  debt: bigint;
  lockupRatePerEpoch: bigint;
  totalLockup: bigint;
  runwayInEpochs: bigint;
}

export interface SnapshotInput {
  summary: AccountSummaryLike;
  walletUsdfc: bigint;
  walletFil: bigint;
  takenAt: number;
}

/**
 * bigint base units -> the whole-USDFC decimal strings `RunwaySnapshot` is
 * defined in. Pure; this is the function the unit tests pin down.
 */
export function toRunwaySnapshot(input: SnapshotInput): RunwaySnapshot {
  const { summary } = input;
  const epochsRemaining = runwayEpochsToNumber(summary.runwayInEpochs);
  const daysRemaining =
    epochsRemaining >= UNBOUNDED_EPOCHS ? UNBOUNDED_DAYS : epochsRemaining / EPOCHS_PER_DAY;

  return {
    takenAt: input.takenAt,
    epoch: Number(summary.epoch),
    fundsAvailable: formatUnits(summary.availableFunds, TOKEN_DECIMALS),
    lockupRate: formatUnits(summary.lockupRatePerEpoch, TOKEN_DECIMALS),
    lockupCurrent: formatUnits(summary.totalLockup, TOKEN_DECIMALS),
    epochsRemaining,
    daysRemaining,
    walletUsdfc: formatUnits(input.walletUsdfc, TOKEN_DECIMALS),
    walletFil: formatUnits(input.walletFil, TOKEN_DECIMALS),
  };
}

/** Redact a secret from any string before it can reach a log or an SSE frame. */
export function scrub(message: string, ...secrets: string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    out = out.split(secret).join("[redacted]");
    const bare = secret.startsWith("0x") ? secret.slice(2) : secret;
    out = out.split(bare).join("[redacted]");
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Adapter                                                              *
 * ------------------------------------------------------------------ */

/** Read timeouts. Filecoin blocks are 30s, so receipts get a much longer leash. */
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_RECEIPT_TIMEOUT_MS = 180_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 600_000;

/** How many piece CIDs the storage panel lists per data set. */
const PIECE_PAGE_SIZE = 8n;

/** SDK limits, mirrored from `SIZE_CONSTANTS` so we can fail before a round trip. */
export const MIN_UPLOAD_BYTES = 127;
export const MAX_UPLOAD_BYTES = 1_065_353_216;

export interface SynapseChainAdapterOptions {
  /** Defaults to `process.env.FILECOIN_PRIVATE_KEY`. */
  privateKey?: string;
  /** Optional RPC override. Unset uses the SDK's built-in Calibration fallback set. */
  rpcUrl?: string;
  /** App identifier used to namespace data sets. */
  source?: string;
  callTimeoutMs?: number;
  receiptTimeoutMs?: number;
  uploadTimeoutMs?: number;
}

interface Session {
  synapse: Synapse;
  address: `0x${string}`;
  tokens: { readonly USDFC: string; readonly FIL: string };
}

export interface ServiceApprovalReport {
  isApproved: boolean;
  rateAllowance: bigint;
  rateUsage: bigint;
  lockupAllowance: bigint;
  lockupUsage: bigint;
  maxLockupPeriod: bigint;
}

export interface OpsReport {
  address: string;
  chainId: number;
  chainName: string;
  contracts: { filecoinPay: string; warmStorage: string; usdfc: string };
  walletFil: bigint;
  walletUsdfc: bigint;
  contractBalance: bigint;
  summary: AccountSummaryLike & {
    lockupRatePerMonth: bigint;
    totalFixedLockup: bigint;
    totalRateBasedLockup: bigint;
    grossCoverageInEpochs: bigint;
    funds: bigint;
  };
  approval: ServiceApprovalReport;
  snapshot: RunwaySnapshot;
}

export interface DataSetReport {
  dataSetId: bigint;
  pdpVerifierDataSetId: bigint;
  serviceProvider: string;
  isLive: boolean;
  isManaged: boolean;
  withCDN: boolean;
  hasActivePieces: boolean;
}

export class SynapseChainAdapter implements ChainAdapter {
  readonly mode = "LIVE" as const;

  private readonly privateKey: `0x${string}`;
  private readonly rpcUrl: string | undefined;
  private readonly source: string;
  private readonly callTimeoutMs: number;
  private readonly receiptTimeoutMs: number;
  private readonly uploadTimeoutMs: number;

  private sessionPromise: Promise<Session> | undefined;
  private cachedAddress: `0x${string}` | undefined;
  /** Uploads performed by THIS process. See `getStoredItems()`. */
  private items: StoredItem[] = [];

  constructor(options: SynapseChainAdapterOptions = {}) {
    // Eager, synchronous, and loud: a live-mode misconfiguration must fail at
    // construction rather than surface as a mysterious RPC error ten seconds in.
    this.privateKey = assertPrivateKey(options.privateKey ?? process.env.FILECOIN_PRIVATE_KEY);
    this.rpcUrl = options.rpcUrl ?? process.env.FILECOIN_RPC_URL ?? undefined;
    this.source = options.source ?? "filrunway";
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.receiptTimeoutMs = options.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  }

  /* ---------- plumbing ---------- */

  /** Wrap a chain call in a timeout and a scrubbed, labelled error. */
  private call<T>(label: string, task: () => Promise<T>, timeoutMs?: number): Promise<T> {
    const ms = timeoutMs ?? this.callTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new Error(`${label} timed out after ${ms}ms (Filecoin RPC unreachable or slow)`));
      }, ms);
      (timer as unknown as { unref?: () => void }).unref?.();

      task().then(
        (value) => {
          if (settled) return;
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          clearTimeout(timer);
          reject(this.wrap(label, error));
        },
      );
    });
  }

  private wrap(label: string, error: unknown): Error {
    const raw = error instanceof Error ? error.message : String(error);
    return new Error(`${label} failed: ${scrub(raw, this.privateKey)}`);
  }

  /**
   * Load the SDK and build the Synapse client. Cached; a failed attempt clears
   * the cache so the next tick retries rather than latching a dead session.
   */
  private session(): Promise<Session> {
    if (!this.sessionPromise) {
      this.sessionPromise = this.createSession().catch((error: unknown) => {
        this.sessionPromise = undefined;
        throw error instanceof Error ? error : new Error(String(error));
      });
    }
    return this.sessionPromise;
  }

  private async createSession(): Promise<Session> {
    try {
      const [{ Synapse: SynapseClass, TOKENS }, { privateKeyToAccount }, { http }] =
        await Promise.all([
          import("@filoz/synapse-sdk"),
          import("viem/accounts"),
          import("viem"),
        ]);

      const account = privateKeyToAccount(this.privateKey);
      this.cachedAddress = account.address;

      // `chain` defaults to Calibration and `transport` to the SDK's built-in
      // Calibration fallback set, so both are only passed when overridden.
      const synapse = SynapseClass.create({
        account,
        source: this.source,
        ...(this.rpcUrl
          ? { transport: http(this.rpcUrl, { timeout: this.callTimeoutMs }) }
          : {}),
      });

      return { synapse, address: account.address, tokens: TOKENS };
    } catch (error) {
      throw this.wrap("Synapse client initialisation", error);
    }
  }

  /* ---------- ChainAdapter ---------- */

  /**
   * Derived locally from the private key: no RPC, so the status strip keeps
   * working even when the node is down.
   */
  async getAddress(): Promise<string> {
    if (!this.cachedAddress) {
      const { privateKeyToAccount } = await import("viem/accounts");
      this.cachedAddress = privateKeyToAccount(this.privateKey).address;
    }
    return this.cachedAddress;
  }

  async getSnapshot(): Promise<RunwaySnapshot> {
    const { synapse, tokens } = await this.session();

    const [summary, walletFil, walletUsdfc] = await Promise.all([
      this.call("payments.accountSummary", () => synapse.payments.accountSummary()),
      // walletBalance defaults to FIL, so BOTH tokens are named explicitly.
      this.call("payments.walletBalance(FIL)", () =>
        synapse.payments.walletBalance({ token: tokens.FIL }),
      ),
      this.call("payments.walletBalance(USDFC)", () =>
        synapse.payments.walletBalance({ token: tokens.USDFC }),
      ),
    ]);

    return toRunwaySnapshot({ summary, walletFil, walletUsdfc, takenAt: Date.now() });
  }

  /**
   * Deposit `amountUsdfc` into Filecoin Pay.
   *
   * Uses `payments.fund()`, which auto-routes in one transaction:
   *   - Warm Storage not yet approved as operator -> depositWithPermitAndApproveOperator
   *   - already approved                          -> depositWithPermit
   * So first-run bootstrap and steady-state top-ups share one code path.
   *
   * Resolves as soon as the hash is known; confirmation is tracked separately
   * by `waitForTransaction()` so the UI can show SUBMITTED before CONFIRMED.
   */
  async deposit(amountUsdfc: string): Promise<{ txHash: string }> {
    const amount = parseUnits(amountUsdfc, TOKEN_DECIMALS);
    if (amount <= 0n) {
      throw new Error(`deposit: amount must be positive, got ${amountUsdfc} USDFC`);
    }

    const { synapse } = await this.session();
    const txHash = await this.call("payments.fund", () => synapse.payments.fund({ amount }));
    return { txHash };
  }

  /** Real confirmation tracking: never throws, always reports an outcome. */
  async waitForTransaction(txHash: string): Promise<{ status: TxStatus; error?: string }> {
    try {
      const { synapse } = await this.session();
      const receipt = await this.call(
        "waitForTransactionReceipt",
        () =>
          synapse.client.waitForTransactionReceipt({
            hash: txHash as `0x${string}`,
            timeout: this.receiptTimeoutMs,
          }),
        this.receiptTimeoutMs + 5_000,
      );
      return receipt.status === "success"
        ? { status: "CONFIRMED" }
        : { status: "FAILED", error: "Transaction reverted onchain" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: "FAILED", error: scrub(message, this.privateKey) };
    }
  }

  /**
   * Uploads performed by this process.
   *
   * Deliberately NOT a chain enumeration: `StoredItem.name` is a local label
   * that has no onchain counterpart, and walking every data set's pieces costs
   * a provider round trip per set. `scripts/bootstrap.ts datasets` does the
   * authoritative onchain listing.
   */
  async getStoredItems(): Promise<StoredItem[]> {
    return [...this.items];
  }

  /**
   * The authoritative answer to "what is the burn rate buying?", read from the
   * chain rather than from process memory.
   *
   * `listDataSets()` supplies ids, providers and liveness. Per-data-set sizes
   * and active piece CIDs come from PDPVerifier, which `@filoz/synapse-sdk`
   * does not re-export — so they are read through `@filoz/synapse-core`, the
   * SDK's own dependency (and already declared in `serverExternalPackages`).
   * Both are pure contract reads: no service-provider HTTP, no context
   * creation, nothing that can hang on an SP being down.
   *
   * Each enrichment is independently guarded. If PDPVerifier is unreachable the
   * panel still lists the data sets and their providers, with `sizeBytes: null`
   * and no piece CIDs — an honest gap, never a fabricated value.
   */
  async listStorage(): Promise<StorageListing> {
    const takenAt = Date.now();
    const { dataSets, totalSizeBytes } = await this.listDataSets();
    const pdpIds = dataSets.map((set) => set.pdpVerifierDataSetId);

    const [sizes, pieces] = await Promise.all([
      this.dataSetSizes(pdpIds),
      Promise.all(pdpIds.map((id) => this.activePieceCids(id))),
    ]);

    const listed: StoredDataSet[] = dataSets.map((set, index) => ({
      id: set.dataSetId.toString(),
      pdpId: set.pdpVerifierDataSetId.toString(),
      provider: set.serviceProvider,
      sizeBytes: sizes[index] ?? null,
      isLive: set.isLive,
      withCDN: set.withCDN,
      pieceCids: pieces[index] ?? [],
    }));

    return {
      takenAt,
      dataSets: listed,
      totalSizeBytes: Number(totalSizeBytes),
      items: [...this.items],
    };
  }

  /** Bytes per data set, positionally. `null` for any read that failed. */
  private async dataSetSizes(pdpIds: bigint[]): Promise<(number | null)[]> {
    if (pdpIds.length === 0) return [];
    try {
      const { synapse } = await this.session();
      const { getDataSetSizes } = await import("@filoz/synapse-core/pdp-verifier");
      const sizes = await this.call("pdpVerifier.getDataSetSizes", () =>
        getDataSetSizes(synapse.readClient, { dataSetIds: pdpIds }),
      );
      return pdpIds.map((_, index) => {
        const size = sizes[index];
        return size === undefined ? null : Number(size);
      });
    } catch {
      // A missing size is displayed as an em dash. Never guess one.
      return pdpIds.map(() => null);
    }
  }

  /** The first page of active piece CIDs in one data set. `[]` on any failure. */
  private async activePieceCids(pdpId: bigint): Promise<string[]> {
    try {
      const { synapse } = await this.session();
      const { getActivePiecesByCursor } = await import("@filoz/synapse-core/pdp-verifier");
      const page = await this.call("pdpVerifier.getActivePiecesByCursor", () =>
        getActivePiecesByCursor(synapse.readClient, {
          dataSetId: pdpId,
          limit: PIECE_PAGE_SIZE,
        }),
      );
      return page.items.map((piece) => piece.cid.toString());
    } catch {
      return [];
    }
  }

  async uploadFile(name: string, data: Uint8Array): Promise<StoredItem> {
    if (data.byteLength < MIN_UPLOAD_BYTES) {
      throw new Error(
        `uploadFile: ${data.byteLength} bytes is below the ${MIN_UPLOAD_BYTES}-byte minimum piece size`,
      );
    }
    if (data.byteLength > MAX_UPLOAD_BYTES) {
      throw new Error(
        `uploadFile: ${data.byteLength} bytes exceeds the ${MAX_UPLOAD_BYTES}-byte (~1 GiB) maximum`,
      );
    }

    const { synapse } = await this.session();

    // prepare() returns the deposit/approval transaction needed to cover the
    // new cost stream, or null when the account already has enough headroom.
    const { transaction } = await this.call("storage.prepare", () =>
      synapse.storage.prepare({ dataSize: BigInt(data.byteLength) }),
    );
    if (transaction) {
      await this.call(
        "storage.prepare.execute",
        () => transaction.execute(),
        this.receiptTimeoutMs,
      );
    }

    const result = await this.call(
      "storage.upload",
      () => synapse.storage.upload(data),
      this.uploadTimeoutMs,
    );

    const primary = result.copies.find((copy) => copy.role === "primary") ?? result.copies[0];
    const item: StoredItem = {
      id: result.pieceCid.toString(),
      name,
      sizeBytes: result.size,
      pieceCid: result.pieceCid.toString(),
      dataSetId: primary ? primary.dataSetId.toString() : undefined,
      uploadedAt: Date.now(),
    };
    this.items = [item, ...this.items];

    if (!result.complete) {
      // Not fatal: the primary copy is stored, secondaries can be retried.
      const reasons = result.failedAttempts.map((a) => a.error).join("; ");
      console.warn(
        `[filrunway] upload stored ${result.copies.length}/${result.requestedCopies} copies: ${reasons}`,
      );
    }

    return item;
  }

  /* ---------- ops surface, used by scripts/bootstrap.ts ---------- */

  /**
   * Approve Warm Storage as a payments operator.
   *
   * `fund({ amount: 0n })` is the SDK's canonical approval path: it resolves
   * `maxLockupPeriod` from the live price list and grants maxUint256 rate and
   * lockup allowances. It throws "Nothing to fund" when approval is already
   * maximal, which we translate into a no-op result.
   */
  async ensureApproved(): Promise<{ alreadyApproved: boolean; txHash?: string }> {
    const { synapse } = await this.session();
    try {
      const txHash = await this.call("payments.fund(approve-only)", () =>
        synapse.payments.fund({ amount: 0n }),
      );
      return { alreadyApproved: false, txHash };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/nothing to fund/i.test(message)) return { alreadyApproved: true };
      throw error;
    }
  }

  async getServiceApproval(): Promise<ServiceApprovalReport> {
    const { synapse } = await this.session();
    return this.call("payments.serviceApproval", () => synapse.payments.serviceApproval());
  }

  /** One-shot operator smoke test. Everything `bootstrap status` prints. */
  async describe(): Promise<OpsReport> {
    const { synapse, tokens } = await this.session();
    const address = await this.getAddress();

    const [summary, walletFil, walletUsdfc, contractBalance, approval] = await Promise.all([
      this.call("payments.accountSummary", () => synapse.payments.accountSummary()),
      this.call("payments.walletBalance(FIL)", () =>
        synapse.payments.walletBalance({ token: tokens.FIL }),
      ),
      this.call("payments.walletBalance(USDFC)", () =>
        synapse.payments.walletBalance({ token: tokens.USDFC }),
      ),
      this.call("payments.balance", () => synapse.payments.balance()),
      this.call("payments.serviceApproval", () => synapse.payments.serviceApproval()),
    ]);

    // Contract addresses are read from the chain definition at runtime, never
    // hardcoded, so switching networks cannot silently point at the wrong pay
    // contract.
    const contracts = synapse.chain.contracts;

    return {
      address,
      chainId: synapse.chain.id,
      chainName: synapse.chain.name,
      contracts: {
        filecoinPay: contracts.filecoinPay.address,
        warmStorage: contracts.fwss.address,
        usdfc: contracts.usdfc.address,
      },
      walletFil,
      walletUsdfc,
      contractBalance,
      summary,
      approval,
      snapshot: toRunwaySnapshot({ summary, walletFil, walletUsdfc, takenAt: Date.now() }),
    };
  }

  async listDataSets(): Promise<{
    dataSets: DataSetReport[];
    totalSizeBytes: bigint;
    dataSetCount: number;
  }> {
    const { synapse } = await this.session();
    const address = (await this.getAddress()) as `0x${string}`;

    const { WarmStorageService } = await import("@filoz/synapse-sdk/warm-storage");
    const warmStorage = new WarmStorageService({
      client: synapse.client,
      readClient: synapse.readClient,
    });

    const [found, totals] = await Promise.all([
      this.call("storage.findDataSets", () => synapse.storage.findDataSets({ address })),
      this.call("warmStorage.getAccountTotalStorageSize", () =>
        warmStorage.getAccountTotalStorageSize({ address }),
      ),
    ]);

    return {
      dataSets: found.map((info) => ({
        dataSetId: info.dataSetId,
        pdpVerifierDataSetId: info.pdpVerifierDataSetId,
        serviceProvider: info.serviceProvider,
        isLive: info.isLive,
        isManaged: info.isManaged,
        withCDN: info.withCDN,
        hasActivePieces: info.hasActivePieces,
      })),
      totalSizeBytes: totals.totalSizeBytes,
      dataSetCount: totals.datasetCount,
    };
  }

  /** Providers + live pricing + allowances in one call. */
  async getStorageInfo() {
    const { synapse } = await this.session();
    return this.call("storage.getStorageInfo", () => synapse.storage.getStorageInfo());
  }
}
