/**
 * Pure-function tests for the live adapter.
 *
 * Everything here runs with NO network and NO SDK: the functions under test are
 * the bigint -> decimal-string conversion and the two Filecoin Pay edge cases
 * that would otherwise only show up against a real chain — `maxUint256` runway
 * (zero burn rate) and a zeroed runway while the account is in deficit.
 *
 * The private key used below is the well-known Hardhat account #0 test key. It
 * is public, worthless, and used only to prove the format validator accepts a
 * well-formed value.
 */

import { describe, expect, it } from "vitest";

import {
  EPOCHS_PER_DAY,
  UNBOUNDED_DAYS,
  UNBOUNDED_EPOCHS,
  isUnboundedDays,
  isUnboundedEpochs,
} from "../constants";
import { evaluate } from "../policy";
import {
  MAX_UINT256,
  type AccountSummaryLike,
  assertPrivateKey,
  runwayEpochsToNumber,
  scrub,
  toRunwaySnapshot,
} from "./synapse";

const WELL_KNOWN_TEST_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** A healthy account: 11.33568 USDFC available, 0.00041 USDFC/epoch burn. */
function summary(overrides: Partial<AccountSummaryLike> = {}): AccountSummaryLike {
  return {
    epoch: 2_960_000n,
    availableFunds: 11_335_680_000_000_000_000n,
    debt: 0n,
    lockupRatePerEpoch: 410_000_000_000_000n,
    totalLockup: 848_700_000_000_000_000n,
    runwayInEpochs: 27_648n,
    ...overrides,
  };
}

describe("runwayEpochsToNumber", () => {
  it("passes an ordinary reading through unchanged", () => {
    expect(runwayEpochsToNumber(27_648n)).toBe(27_648);
  });

  it("maps maxUint256 (zero burn rate) to the unbounded sentinel", () => {
    expect(runwayEpochsToNumber(MAX_UINT256)).toBe(UNBOUNDED_EPOCHS);
    expect(isUnboundedEpochs(runwayEpochsToNumber(MAX_UINT256))).toBe(true);
  });

  it("clamps any value at or beyond the sentinel rather than emitting garbage", () => {
    // A dust burn rate can produce a runway that is finite but astronomical.
    expect(runwayEpochsToNumber(10n ** 40n)).toBe(UNBOUNDED_EPOCHS);
    expect(runwayEpochsToNumber(BigInt(Number.MAX_SAFE_INTEGER))).toBe(UNBOUNDED_EPOCHS);
  });

  it("maps a deficit (runwayInEpochs === 0n) to zero, not to unbounded", () => {
    expect(runwayEpochsToNumber(0n)).toBe(0);
    expect(isUnboundedEpochs(runwayEpochsToNumber(0n))).toBe(false);
  });

  it("never returns a fractional epoch count", () => {
    expect(Number.isInteger(runwayEpochsToNumber(1n))).toBe(true);
    expect(runwayEpochsToNumber(1n)).toBe(1);
  });

  it("stays finite so it survives JSON.stringify over SSE", () => {
    const value = runwayEpochsToNumber(MAX_UINT256);
    expect(Number.isFinite(value)).toBe(true);
    expect(JSON.parse(JSON.stringify({ value })).value).toBe(UNBOUNDED_EPOCHS);
    // The naive alternative would not survive the wire:
    expect(JSON.parse(JSON.stringify({ value: Number.POSITIVE_INFINITY })).value).toBeNull();
  });
});

describe("toRunwaySnapshot — bigint to decimal string", () => {
  const snapshot = toRunwaySnapshot({
    summary: summary(),
    walletUsdfc: 250_000_000_000_000_000_000n,
    walletFil: 4_982_300_000_000_000_000n,
    takenAt: 1_700_000_000_000,
  });

  it("converts 18-decimal base units to whole-token decimal strings", () => {
    expect(snapshot.fundsAvailable).toBe("11.33568");
    expect(snapshot.lockupRate).toBe("0.00041");
    expect(snapshot.lockupCurrent).toBe("0.8487");
    expect(snapshot.walletUsdfc).toBe("250");
    expect(snapshot.walletFil).toBe("4.9823");
  });

  it("keeps a sub-wei-precision burn rate exact rather than rounding through a float", () => {
    const tiny = toRunwaySnapshot({
      summary: summary({ lockupRatePerEpoch: 1_157_407_407n }),
      walletUsdfc: 0n,
      walletFil: 0n,
      takenAt: 0,
    });
    expect(tiny.lockupRate).toBe("0.000000001157407407");
  });

  it("carries the epoch and timestamp through as numbers", () => {
    expect(snapshot.epoch).toBe(2_960_000);
    expect(snapshot.takenAt).toBe(1_700_000_000_000);
  });

  it("derives daysRemaining from epochsRemaining and EPOCHS_PER_DAY", () => {
    expect(snapshot.epochsRemaining).toBe(27_648);
    expect(snapshot.daysRemaining).toBeCloseTo(27_648 / EPOCHS_PER_DAY, 12);
    expect(snapshot.daysRemaining).toBeCloseTo(9.6, 12);
  });

  it("emits only fields RunwaySnapshot declares, all money as strings", () => {
    for (const key of [
      "fundsAvailable",
      "lockupRate",
      "lockupCurrent",
      "walletUsdfc",
      "walletFil",
    ] as const) {
      expect(typeof snapshot[key]).toBe("string");
    }
  });
});

describe("toRunwaySnapshot — unbounded runway (zero burn rate)", () => {
  const snapshot = toRunwaySnapshot({
    summary: summary({
      lockupRatePerEpoch: 0n,
      totalLockup: 0n,
      runwayInEpochs: MAX_UINT256,
      availableFunds: 10_000_000_000_000_000_000n,
    }),
    walletUsdfc: 0n,
    walletFil: 0n,
    takenAt: 1_700_000_000_000,
  });

  it("uses the finite sentinel for both epochs and days", () => {
    expect(snapshot.epochsRemaining).toBe(UNBOUNDED_EPOCHS);
    expect(snapshot.daysRemaining).toBe(UNBOUNDED_DAYS);
    expect(isUnboundedDays(snapshot.daysRemaining)).toBe(true);
  });

  it("round-trips through JSON without becoming null", () => {
    const wire = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    expect(wire.daysRemaining).toBe(UNBOUNDED_DAYS);
    expect(isUnboundedDays(wire.daysRemaining)).toBe(true);
  });

  it("reports a zero burn rate as the string \"0\"", () => {
    expect(snapshot.lockupRate).toBe("0");
  });

  it("makes the policy engine HOLD and call the runway unbounded", () => {
    const decision = evaluate(snapshot);
    expect(decision.action).toBe("HOLD");
    expect(decision.outcome).toBe("NO_ACTION");
    expect(decision.reasoning).toContain("unbounded");
    // The sentinel must never leak into the UI copy as a raw number.
    expect(decision.reasoning).not.toContain(String(UNBOUNDED_EPOCHS));
  });
});

describe("toRunwaySnapshot — account in deficit", () => {
  const snapshot = toRunwaySnapshot({
    summary: summary({
      availableFunds: 0n,
      debt: 2_500_000_000_000_000_000n,
      runwayInEpochs: 0n,
    }),
    walletUsdfc: 3_500_000_000_000_000_000n,
    walletFil: 1_000_000_000_000_000_000n,
    takenAt: 1_700_000_000_000,
  });

  it("reads as zero runway, not unbounded", () => {
    expect(snapshot.epochsRemaining).toBe(0);
    expect(snapshot.daysRemaining).toBe(0);
    expect(isUnboundedDays(snapshot.daysRemaining)).toBe(false);
    expect(snapshot.fundsAvailable).toBe("0");
  });

  it("fires the emergency rule, but declines to act on a 3.5 USDFC wallet", () => {
    const decision = evaluate(snapshot);
    expect(decision.ruleFired?.action).toBe("EMERGENCY_TOP_UP");
    expect(decision.action).toBe("INSUFFICIENT_FUNDS");
    expect(decision.outcome).toBe("NO_ACTION");
  });

  it("states the shortfall rather than attempting a doomed deposit", () => {
    const reasoning = evaluate(snapshot).reasoning;
    expect(reasoning).toContain("The rule calls for a 15 USDFC deposit");
    expect(reasoning).toContain("the wallet holds 3.50 USDFC");
    expect(reasoning).toContain("a shortfall of 11.50 USDFC");
  });
});

describe("assertPrivateKey", () => {
  it("accepts a 0x-prefixed 32-byte key", () => {
    expect(assertPrivateKey(WELL_KNOWN_TEST_KEY)).toBe(WELL_KNOWN_TEST_KEY);
  });

  it("adds a missing 0x prefix and trims whitespace", () => {
    const bare = WELL_KNOWN_TEST_KEY.slice(2);
    expect(assertPrivateKey(`  ${bare}\n`)).toBe(WELL_KNOWN_TEST_KEY);
  });

  it("fails loudly and actionably when unset", () => {
    for (const missing of [undefined, null, "", "   "]) {
      expect(() => assertPrivateKey(missing)).toThrow(/FILECOIN_PRIVATE_KEY/);
    }
    expect(() => assertPrivateKey(undefined)).toThrow(/Refusing to fall back to the mock/);
  });

  it("rejects a malformed key without echoing it", () => {
    const bad = "0xdeadbeef";
    expect(() => assertPrivateKey(bad)).toThrow(/malformed/);
    try {
      assertPrivateKey(bad);
    } catch (error) {
      expect((error as Error).message).not.toContain("deadbeef");
    }
  });

  it("rejects non-hex characters of the right length", () => {
    expect(() => assertPrivateKey(`0x${"z".repeat(64)}`)).toThrow(/malformed/);
  });
});

describe("scrub", () => {
  it("removes a secret in both prefixed and bare form", () => {
    const message = `boom ${WELL_KNOWN_TEST_KEY} and ${WELL_KNOWN_TEST_KEY.slice(2)}`;
    const cleaned = scrub(message, WELL_KNOWN_TEST_KEY);
    expect(cleaned).not.toContain(WELL_KNOWN_TEST_KEY.slice(2));
    expect(cleaned).toBe("boom [redacted] and [redacted]");
  });

  it("leaves unrelated text alone", () => {
    expect(scrub("connection refused", WELL_KNOWN_TEST_KEY)).toBe("connection refused");
  });
});
