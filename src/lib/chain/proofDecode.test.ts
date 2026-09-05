/**
 * Decoding the five PDP contract results into a `ProofReading`.
 *
 * The reads are issued as one `multicall({ allowFailure: true })` per data set,
 * so partial failure is the NORMAL case, not an edge: `getDataSetLastProvenEpoch`
 * reverts on a data set that has never proved, `provingDeadline` reverts with
 * `ProvingPeriodNotInitialized` before the first proving period starts, and any
 * one of them can simply time out.
 *
 * Every one of those has to arrive at `classifyProofState` as an absence, never
 * as a zero — because a zero deadline compared against a real chain height is
 * three million epochs overdue, and that is a terminated data set.
 */

import { describe, expect, it } from "vitest";

import { decodeProofOutcomes, type CallOutcome } from "./synapse";
import { classifyProofState } from "../proof";

const EPOCH = 3_000_000;

const ok = (result: unknown): CallOutcome => ({ status: "success", result });
const fail = (message: string): CallOutcome => ({
  status: "failure",
  error: new Error(message),
});

/** live, lastProven, nextChallenge, provenThisPeriod, provingDeadline */
function outcomes(over: Partial<Record<0 | 1 | 2 | 3 | 4, CallOutcome>> = {}): CallOutcome[] {
  const base: CallOutcome[] = [
    ok(true),
    ok(BigInt(EPOCH - 5_760)),
    ok(BigInt(EPOCH + 1_320)),
    ok(false),
    ok(BigInt(EPOCH - 2_880)),
  ];
  for (const [index, value] of Object.entries(over)) base[Number(index)] = value;
  return base;
}

describe("decodeProofOutcomes", () => {
  it("decodes a full set of successful reads", () => {
    const reading = decodeProofOutcomes("42", outcomes());

    expect(reading).toEqual({
      dataSetId: "42",
      isLive: true,
      lastProvenEpoch: EPOCH - 5_760,
      nextChallengeEpoch: EPOCH + 1_320,
      provingDeadline: EPOCH - 2_880,
      provenThisPeriod: false,
      errors: [],
    });
    expect(classifyProofState(reading, EPOCH).isDelinquent).toBe(true);
  });

  it("preserves a zero proving deadline as a real reading of 'no deadline'", () => {
    // Warm Storage returns 0 before the first proving period is initialised.
    // It is READ, so the state is readable — and `classifyProofState` then
    // declines to call it late, which is the correct answer.
    const reading = decodeProofOutcomes("42", outcomes({ 4: ok(0n) }));

    expect(reading.provingDeadline).toBe(0);
    expect(reading.errors).toEqual([]);

    const state = classifyProofState(reading, EPOCH);
    expect(state.readable).toBe(true);
    expect(state.isDelinquent).toBe(false);
  });

  it("maps a reverted decisive call to null AND to a named error", () => {
    const reading = decodeProofOutcomes(
      "42",
      outcomes({ 4: fail("execution reverted: ProvingPeriodNotInitialized") }),
    );

    expect(reading.provingDeadline).toBeNull();
    expect(reading.errors.join(" ")).toContain("WarmStorage.provingDeadline");
    expect(reading.errors.join(" ")).toContain("ProvingPeriodNotInitialized");
    expect(classifyProofState(reading, EPOCH).isDelinquent).toBe(false);
  });

  it("reports every decisive call that failed, not just the first", () => {
    const reading = decodeProofOutcomes(
      "42",
      outcomes({ 0: fail("timeout"), 3: fail("timeout"), 4: fail("timeout") }),
    );

    expect(reading.errors).toHaveLength(3);
    expect(reading.errors.join(" ")).toContain("dataSetLive");
    expect(reading.errors.join(" ")).toContain("provenThisPeriod");
    expect(reading.errors.join(" ")).toContain("provingDeadline");
  });

  it("ignores a failure in a NON-decisive call", () => {
    // `getDataSetLastProvenEpoch` and `getNextChallengeEpoch` are evidence for
    // a human reading the decision, not inputs to the judgement. Losing them
    // must not make a readable state unreadable.
    const reading = decodeProofOutcomes(
      "42",
      outcomes({ 1: fail("reverted"), 2: fail("reverted") }),
    );

    expect(reading.errors).toEqual([]);
    expect(reading.lastProvenEpoch).toBeNull();
    expect(reading.nextChallengeEpoch).toBeNull();
    expect(classifyProofState(reading, EPOCH).readable).toBe(true);
  });

  it("treats a zero last-proven or next-challenge epoch as absent", () => {
    // PDPVerifier returns 0 for "never proven" / "no challenge scheduled".
    const reading = decodeProofOutcomes("42", outcomes({ 1: ok(0n), 2: ok(0n) }));

    expect(reading.lastProvenEpoch).toBeNull();
    expect(reading.nextChallengeEpoch).toBeNull();
  });

  it("refuses a value of the wrong type rather than coercing it", () => {
    // A malformed or mis-decoded return is an unknown, never a guess.
    const reading = decodeProofOutcomes(
      "42",
      outcomes({ 0: ok("yes"), 3: ok(1n), 4: ok(true) }),
    );

    expect(reading.isLive).toBeNull();
    expect(reading.provenThisPeriod).toBeNull();
    expect(reading.provingDeadline).toBeNull();
    expect(classifyProofState(reading, EPOCH).isDelinquent).toBe(false);
  });

  it("survives a short result array", () => {
    const reading = decodeProofOutcomes("42", []);

    expect(reading.isLive).toBeNull();
    expect(reading.errors.join(" ")).toContain("not returned by the node");
    expect(classifyProofState(reading, EPOCH).isDelinquent).toBe(false);
  });
});
