/**
 * The mock adapter's new surfaces.
 *
 * These exist so the two paths that cannot be rehearsed against a healthy live
 * account — a delinquent data set, and a withdrawal that collapses the runway —
 * can be demonstrated and tested with nothing at stake. The mock is also the
 * only place the "unreadable proof state" branch can be exercised on demand,
 * which is the branch whose failure mode is destroyed data.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MOCK_PROOF_ENV, MockChainAdapter, mockProofMode } from "./mock";
import { toNumber } from "../units";

const savedMode = process.env[MOCK_PROOF_ENV];

beforeEach(() => {
  delete process.env[MOCK_PROOF_ENV];
});

afterEach(() => {
  if (savedMode === undefined) delete process.env[MOCK_PROOF_ENV];
  else process.env[MOCK_PROOF_ENV] = savedMode;
});

describe("mockProofMode", () => {
  it("defaults to healthy, and ignores anything it does not recognise", () => {
    expect(mockProofMode({})).toBe("healthy");
    expect(mockProofMode({ [MOCK_PROOF_ENV]: "banana" })).toBe("healthy");
    expect(mockProofMode({ [MOCK_PROOF_ENV]: "DELINQUENT" })).toBe("delinquent");
    expect(mockProofMode({ [MOCK_PROOF_ENV]: " unreadable " })).toBe("unreadable");
  });
});

describe("listStorage proof states", () => {
  it("reports everything proving by default", async () => {
    const listing = await new MockChainAdapter().listStorage();

    expect(listing.dataSets).toHaveLength(2);
    for (const set of listing.dataSets) {
      expect(set.proof.readable).toBe(true);
      expect(set.proof.isDelinquent).toBe(false);
    }
  });

  it("makes only the SECOND data set delinquent, so the account is mixed", async () => {
    // A uniformly broken account would let a wrong implementation pass by
    // accident; the policy engine has to CHOOSE which rail to cut.
    process.env[MOCK_PROOF_ENV] = "delinquent";
    const listing = await new MockChainAdapter().listStorage();

    expect(listing.dataSets[0].proof.isDelinquent).toBe(false);
    expect(listing.dataSets[1].proof.isDelinquent).toBe(true);
    expect(listing.dataSets[1].proof.epochsOverdue).toBe(2_880);
  });

  it("makes only the SECOND data set unreadable, and never delinquent", async () => {
    process.env[MOCK_PROOF_ENV] = "unreadable";
    const listing = await new MockChainAdapter().listStorage();

    expect(listing.dataSets[0].proof.readable).toBe(true);
    expect(listing.dataSets[1].proof.readable).toBe(false);
    expect(listing.dataSets[1].proof.isDelinquent).toBe(false);
    expect(listing.dataSets[1].proof.unknownReason).toContain(MOCK_PROOF_ENV);
  });
});

describe("terminateDataSet", () => {
  it("marks the set not live, and it stops being delinquent", async () => {
    process.env[MOCK_PROOF_ENV] = "delinquent";
    const adapter = new MockChainAdapter();

    const { txHash } = await adapter.terminateDataSet("30292");
    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);

    const listing = await adapter.listStorage();
    const cut = listing.dataSets.find((set) => set.id === "30292")!;
    expect(cut.isLive).toBe(false);
    // Nothing to prove any more, so nothing is late. Left as "delinquent" the
    // next tick would decide to cut a rail it has already cut.
    expect(cut.proof.isDelinquent).toBe(false);
    expect(cut.proof.readable).toBe(true);
  });

  it("refuses an unknown or already-terminated data set", async () => {
    const adapter = new MockChainAdapter();

    await expect(adapter.terminateDataSet("99999")).rejects.toThrow(/no data set/);
    await adapter.terminateDataSet("30291");
    await expect(adapter.terminateDataSet("30291")).rejects.toThrow(/already terminated/);
  });
});

describe("withdraw", () => {
  it("really lowers the runway and really raises the wallet balance", async () => {
    // The simulated squeeze has to be as real as the live one: the runway that
    // follows must be derived from the reduced balance, not faked.
    const adapter = new MockChainAdapter({ now: () => 1_000_000 });
    const before = await adapter.getSnapshot();

    await adapter.withdraw("5");
    const after = await adapter.getSnapshot();

    expect(toNumber(after.fundsAvailable)).toBeCloseTo(toNumber(before.fundsAvailable) - 5, 6);
    expect(after.daysRemaining).toBeLessThan(before.daysRemaining);
    // The funds moved; they were not destroyed.
    expect(toNumber(after.walletUsdfc)).toBeCloseTo(toNumber(before.walletUsdfc) + 5, 6);
  });

  it("refuses a non-positive amount", async () => {
    const adapter = new MockChainAdapter();
    await expect(adapter.withdraw("0")).rejects.toThrow(/must be positive/);
  });
});
