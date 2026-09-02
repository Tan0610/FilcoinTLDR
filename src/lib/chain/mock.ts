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
const MOCK_DATA_SETS: StoredDataSet[] = [
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
  private items: StoredItem[] = [];
  private dataSets: StoredDataSet[] = MOCK_DATA_SETS.map((set) => ({
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
    const fundsAvailable = subDecimalFloor(credited, spent);

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
      walletUsdfc: subDecimalFloor(INITIAL_WALLET_USDFC, this.walletSpent),
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
    return {
      takenAt: this.now(),
      dataSets: this.dataSets.map((set) => ({ ...set, pieceCids: [...set.pieceCids] })),
      totalSizeBytes: this.dataSets.reduce((total, set) => total + (set.sizeBytes ?? 0), 0),
      items: [...this.items],
    };
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
