/**
 * MockChainAdapter — a believable, self-contained Filecoin Pay simulation.
 *
 * The point of this file is that the whole product (dashboard, policy engine,
 * agent loop) can be built, demoed and screen-recorded with no keys, no RPC and
 * no testnet faucet. Runway DECREASES against real wall-clock time, so the
 * gauge visibly counts down and the agent visibly crosses its own thresholds.
 *
 * Time is accelerated: FILRUNWAY_MOCK_EPOCHS_PER_SECOND chain epochs elapse per
 * real second (default 120, i.e. 1 real second = 1 hour of chain time), so a
 * ~9.6 day runway drains in ~4 minutes and a judge sees HOLD -> TOP_UP ->
 * EMERGENCY_TOP_UP inside one demo.
 */

import { EPOCHS_PER_DAY } from "../constants";
import { classifyProofState, unreadableReading, type ProofReading } from "../proof";
import type { RunwaySnapshot, StorageListing, StoredDataSet, StoredItem } from "../types";
import { addDecimal, epochsFor, formatUnits, parseUnits, subDecimalFloor } from "../units";
import type { ChainAdapter } from "./index";

const DEFAULT_EPOCHS_PER_SECOND = 120;
const DEFAULT_BASE_EPOCH = 2_960_000; // plausible Calibration height
const MOCK_ADDRESS = "0x9C4dA1E6f0b7B1cB4A2F3d80f2A73B7c1E6aD5F2";

/** USDFC burned per epoch. ~1.18 USDFC/day, i.e. a small always-on data set. */
const LOCKUP_RATE = "0.00041";
/** Opening balance: exactly 9.6 days of runway at the rate above. */
const INITIAL_FUNDS = "11.33568";
const INITIAL_LOCKUP_CURRENT = "0.84870";
const INITIAL_WALLET_USDFC = "250";
const INITIAL_WALLET_FIL = "4.9823";

function hex(bytes: number): string {
  let out = "";
  for (let i = 0; i < bytes * 2; i += 1) {
    out += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  }
  return out;
}

function fakePieceCid(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let tail = "";
  for (let i = 0; i < 44; i += 1) {
    tail += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `baga6ea4sea${tail}`;
}

/**
 * The data sets the simulated account "holds".
 *
 * Deliberately TWO sets holding the SAME piece: `synapse.storage.upload()`
 * defaults to 2 copies and each copy opens its own data set, which is the
 * shape a real Calibration account ends up in (see `src/lib/demo.ts`). Fixed
 * values, not random ones, so successive polls do not reshuffle the panel.
 *
 * Everything here is simulated, and the dashboard says so: the mock adapter is
 * the one that flies the hazard stripe and the MOCK DATA badge.
 */
const MOCK_PIECE_CID = "baga6ea4seaqhx7k2mvtjq3vnwtcyzldhjrn4z6i5dq3sy2wvbmkjxu4lqk7mgvy";

/** A data set before its (epoch-dependent) proof state is attached. */
type MockDataSet = Omit<StoredDataSet, "proof">;

const MOCK_DATA_SETS: MockDataSet[] = [
  {
    id: "30291",
    pdpId: "1607",
    provider: "0x6170dE2b09b404776197485F3dc6c968Ef948505",
    sizeBytes: 1_048_576,
    isLive: true,
    withCDN: false,
    pieceCids: [MOCK_PIECE_CID],
  },
  {
    id: "30292",
    pdpId: "1608",
    provider: "0xE9bc394383B67aF9C6E1b9AaE95a5e9c9E5A6a15",
    sizeBytes: 1_048_576,
    isLive: true,
    withCDN: false,
    pieceCids: [MOCK_PIECE_CID],
  },
];

/**
 * Which PDP proof story the mock tells.
 *
 * The eviction path is the one branch of the policy engine that cannot be
 * rehearsed against a healthy live account — you would have to let real storage
 * go unproven to see it — and it is also the one branch that destroys data. So
 * it is made fully demoable HERE, where nothing can be lost:
 *
 *   healthy      (default) every data set proving on schedule. The agent tops
 *                up and never proposes a cut. This is the local demo, unchanged.
 *   delinquent   the SECOND data set is live, past its deadline and unproven.
 *                A short runway then produces a real PRUNE_DATASET decision.
 *   unreadable   the second data set's proof calls do not answer. This is the
 *                RPC-hiccup rehearsal: the agent must treat it as UNKNOWN and
 *                must NOT propose a cut. Getting this wrong is the failure the
 *                whole design is built around, so it has a switch of its own.
 *
 * Read per call, not captured at module load, so a running dev server picks up
 * a change to `.env.local` on its next restart without a code edit.
 */
export const MOCK_PROOF_ENV = "FILRUNWAY_MOCK_PROOF";
export type MockProofMode = "healthy" | "delinquent" | "unreadable";

export function mockProofMode(
  env: Record<string, string | undefined> = process.env,
): MockProofMode {
  const raw = env[MOCK_PROOF_ENV]?.trim().toLowerCase();
  if (raw === "delinquent" || raw === "unreadable") return raw;
  return "healthy";
}

/** Plausible, self-consistent proof readings for one simulated data set. */
export function mockProofReading(
  dataSetId: string,
  epoch: number,
  mode: MockProofMode,
  isLive: boolean,
): ProofReading {
  if (!isLive) {
    // A terminated set: PDPVerifier says it is not live and there is no live
    // proving period behind it. Read successfully, and not delinquent.
    return {
      dataSetId,
      isLive: false,
      lastProvenEpoch: null,
      nextChallengeEpoch: null,
      provingDeadline: 0,
      provenThisPeriod: false,
      errors: [],
    };
  }

  if (mode === "unreadable") {
    return unreadableReading(
      dataSetId,
      "simulated RPC failure (FILRUNWAY_MOCK_PROOF=unreadable)",
    );
  }

  if (mode === "delinquent") {
    return {
      dataSetId,
      isLive: true,
      lastProvenEpoch: epoch - 5_760,
      nextChallengeEpoch: null,
      provingDeadline: epoch - 2_880,
      provenThisPeriod: false,
      errors: [],
    };
  }

  return {
    dataSetId,
    isLive: true,
    lastProvenEpoch: epoch - 120,
    nextChallengeEpoch: epoch + 1_320,
    provingDeadline: epoch + 2_760,
    provenThisPeriod: true,
    errors: [],
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface MockChainAdapterOptions {
  /** Simulated epochs elapsed per real second. Higher = faster demo. */
  epochsPerSecond?: number;
  /** Wall-clock origin of the simulation. */
  startedAt?: number;
  /** Injectable clock so the mock itself stays testable. */
  now?: () => number;
}

export class MockChainAdapter implements ChainAdapter {
  readonly mode = "MOCK" as const;

  private readonly epochsPerSecond: number;
  private readonly startedAt: number;
  private readonly now: () => number;

  /** Cumulative USDFC deposited into Filecoin Pay by the agent. */
  private deposited = "0";
  /** Cumulative USDFC pulled out of the wallet. */
  private walletSpent = "0";
  /** Cumulative USDFC the OPERATOR has withdrawn from Filecoin Pay. */
  private withdrawn = "0";
  private items: StoredItem[] = [];
  private dataSets: MockDataSet[] = MOCK_DATA_SETS.map((set) => ({
    ...set,
    pieceCids: [...set.pieceCids],
  }));

  constructor(options: MockChainAdapterOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.epochsPerSecond = options.epochsPerSecond ?? DEFAULT_EPOCHS_PER_SECOND;
    this.startedAt = options.startedAt ?? this.now();
  }

  private elapsedEpochs(at: number): number {
    return Math.max(0, Math.floor(((at - this.startedAt) / 1000) * this.epochsPerSecond));
  }

  async getAddress(): Promise<string> {
    return MOCK_ADDRESS;
  }

  async getSnapshot(): Promise<RunwaySnapshot> {
    const takenAt = this.now();
    const elapsed = this.elapsedEpochs(takenAt);

    // spent = rate * epochs elapsed, exactly, in base units.
    const spentUnits = parseUnits(LOCKUP_RATE) * BigInt(elapsed);
    const spent = formatUnits(spentUnits);

    const credited = addDecimal(INITIAL_FUNDS, this.deposited);
    // An operator withdrawal really removes funds here, exactly as
    // `payments.withdraw` really removes them on chain: the simulated runway
    // that follows is derived from the reduced balance, never faked.
    const fundsAvailable = subDecimalFloor(credited, addDecimal(spent, this.withdrawn));

    const epochsRemaining = epochsFor(fundsAvailable, LOCKUP_RATE);
    const daysRemaining = epochsRemaining / EPOCHS_PER_DAY;

    return {
      takenAt,
      epoch: DEFAULT_BASE_EPOCH + elapsed,
      fundsAvailable,
      lockupRate: LOCKUP_RATE,
      lockupCurrent: INITIAL_LOCKUP_CURRENT,
      epochsRemaining: Number.isFinite(epochsRemaining) ? epochsRemaining : 0,
      daysRemaining: Number.isFinite(daysRemaining) ? daysRemaining : 0,
      // A withdrawal moves USDFC from Filecoin Pay back to the wallet; it does
      // not destroy it, and the wallet figure has to show that.
      walletUsdfc: addDecimal(
        subDecimalFloor(INITIAL_WALLET_USDFC, this.walletSpent),
        this.withdrawn,
      ),
      walletFil: INITIAL_WALLET_FIL,
    };
  }

  async deposit(amountUsdfc: string): Promise<{ txHash: string }> {
    // Simulate submit + confirmation latency so the UI shows a real pending state.
    await sleep(900 + Math.random() * 700);
    this.deposited = addDecimal(this.deposited, amountUsdfc);
    this.walletSpent = addDecimal(this.walletSpent, amountUsdfc);
    return { txHash: `0x${hex(32)}` };
  }

  async getStoredItems(): Promise<StoredItem[]> {
    return [...this.items];
  }

  async listStorage(): Promise<StorageListing> {
    const takenAt = this.now();
    const epoch = DEFAULT_BASE_EPOCH + this.elapsedEpochs(takenAt);
    const mode = mockProofMode();

    return {
      takenAt,
      dataSets: this.dataSets.map((set, index) => ({
        ...set,
        pieceCids: [...set.pieceCids],
        // Only the SECOND data set takes the configured story, so the
        // interesting modes always produce a mixed account — one healthy set
        // beside one bad one, which is the shape the policy engine has to
        // choose within. A single uniformly-broken account would let a wrong
        // implementation pass by accident.
        proof: classifyProofState(
          mockProofReading(set.id, epoch, index === 0 ? "healthy" : mode, set.isLive),
          epoch,
        ),
      })),
      totalSizeBytes: this.dataSets.reduce((total, set) => total + (set.sizeBytes ?? 0), 0),
      items: [...this.items],
    };
  }

  /**
   * Simulated termination. Marks the data set not live and stops counting its
   * bytes, which is what the chain read would show once the rail winds down.
   * Nothing is deleted from the simulation's history: the row stays visible,
   * greyed, so a demo can see what was cut.
   */
  async terminateDataSet(dataSetId: string): Promise<{ txHash: string }> {
    const target = this.dataSets.find((set) => set.id === dataSetId);
    if (!target) {
      throw new Error(`terminateDataSet: no data set ${dataSetId} on this account`);
    }
    if (!target.isLive) {
      throw new Error(`terminateDataSet: data set ${dataSetId} is already terminated`);
    }
    await sleep(700 + Math.random() * 500);
    this.dataSets = this.dataSets.map((set) =>
      set.id === dataSetId ? { ...set, isLive: false } : set,
    );
    return { txHash: `0x${hex(32)}` };
  }

  /** Simulated operator withdrawal. Really lowers the simulated runway. */
  async withdraw(amountUsdfc: string): Promise<{ txHash: string }> {
    if (parseUnits(amountUsdfc) <= 0n) {
      throw new Error(`withdraw: amount must be positive, got ${amountUsdfc} USDFC`);
    }
    await sleep(600 + Math.random() * 400);
    this.withdrawn = addDecimal(this.withdrawn, amountUsdfc);
    return { txHash: `0x${hex(32)}` };
  }

  async uploadFile(name: string, data: Uint8Array): Promise<StoredItem> {
    await sleep(600);
    const item: StoredItem = {
      id: `item_${hex(8)}`,
      name,
      sizeBytes: data.byteLength,
      pieceCid: fakePieceCid(),
      dataSetId: this.dataSets[0]?.id ?? "30291",
      uploadedAt: this.now(),
    };
    this.items = [item, ...this.items];
    // Both copies land in both data sets, exactly as a 2-copy upload does.
    this.dataSets = this.dataSets.map((set) => ({
      ...set,
      sizeBytes: (set.sizeBytes ?? 0) + item.sizeBytes,
      pieceCids: [item.pieceCid, ...set.pieceCids],
    }));
    return item;
  }
}
