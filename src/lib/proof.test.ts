/**
 * PDP proof-state classification.
 *
 * `isDelinquent` is the flag that can cause the agent to terminate a data set,
 * and there is no undo. So the tests below are weighted almost entirely towards
 * the ways it must NOT be set: a read that timed out, a read that reverted, a
 * proving period that was never initialised, an unknown chain epoch, a data set
 * that is not live. Every one of those has to come out UNKNOWN, and unknown has
 * to come out not-delinquent.
 *
 * The single positive case is at the bottom, and it needs every decisive field
 * to have actually answered.
 */

import { describe, expect, it } from "vitest";

import {
  classifyProofState,
  delinquentSets,
  describeProof,
  liveSetCount,
  proofSnapshotFrom,
  unreadableProofSnapshot,
  unreadableReading,
  type ProofReading,
} from "./proof";
import type { DataSetProofState, StoredDataSet } from "./types";

const EPOCH = 3_000_000;

/** A data set that is live, overdue and unproven — the one delinquent shape. */
function delinquentReading(overrides: Partial<ProofReading> = {}): ProofReading {
  return {
    dataSetId: "42",
    isLive: true,
    lastProvenEpoch: EPOCH - 5_760,
    nextChallengeEpoch: null,
    provingDeadline: EPOCH - 2_880,
    provenThisPeriod: false,
    errors: [],
    ...overrides,
  };
}

describe("classifyProofState: an unread field is never a missed proof", () => {
  it("refuses to judge a data set whose liveness did not answer", () => {
    const state = classifyProofState(delinquentReading({ isLive: null }), EPOCH);

    expect(state.readable).toBe(false);
    expect(state.isDelinquent).toBe(false);
    expect(state.unknownReason).toContain("dataSetLive");
  });

  it("refuses to judge a data set whose provenThisPeriod did not answer", () => {
    const state = classifyProofState(delinquentReading({ provenThisPeriod: null }), EPOCH);

    expect(state.readable).toBe(false);
    expect(state.isDelinquent).toBe(false);
    expect(state.unknownReason).toContain("provenThisPeriod");
  });

  it("refuses to judge a data set whose provingDeadline did not answer", () => {
    const state = classifyProofState(delinquentReading({ provingDeadline: null }), EPOCH);

    expect(state.readable).toBe(false);
    expect(state.isDelinquent).toBe(false);
    expect(state.unknownReason).toContain("provingDeadline");
  });

  it("carries a reported call error through into the reason", () => {
    const state = classifyProofState(
      delinquentReading({ errors: ["PDPVerifier.dataSetLive reverted (execution reverted)"] }),
      EPOCH,
    );

    // Every decisive VALUE is present, so the arithmetic would say delinquent —
    // but a call reported an error, and that outranks the values it produced.
    expect(state.readable).toBe(false);
    expect(state.isDelinquent).toBe(false);
    expect(state.unknownReason).toContain("execution reverted");
  });

  it("refuses to judge anything when the chain epoch itself is unknown", () => {
    // This is the whole-account failure mode: `getBlockNumber` did not answer,
    // so nothing can be said to be late, however overdue its deadline looks.
    for (const epoch of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const state = classifyProofState(delinquentReading(), epoch);
      expect(state.readable).toBe(false);
      expect(state.isDelinquent).toBe(false);
      expect(state.unknownReason).toContain("chain epoch");
    }
  });

  it("produces a fully unknown state from `unreadableReading`", () => {
    const state = classifyProofState(unreadableReading("7", "RPC timed out"), EPOCH);

    expect(state.readable).toBe(false);
    expect(state.isDelinquent).toBe(false);
    expect(state.epochsOverdue).toBeNull();
    expect(state.unknownReason).toContain("RPC timed out");
  });

  it("names every missing call, deduplicated, rather than only the first", () => {
    const state = classifyProofState(
      { ...delinquentReading(), isLive: null, provenThisPeriod: null, provingDeadline: null },
      EPOCH,
    );

    expect(state.unknownReason).toContain("dataSetLive");
    expect(state.unknownReason).toContain("provenThisPeriod");
    expect(state.unknownReason).toContain("provingDeadline");
  });
});

describe("classifyProofState: read, but not delinquent", () => {
  it("does not call a terminated data set delinquent", () => {
    // Nothing to prove and nothing being paid for. `isLive: false` is a real
    // reading, so the state IS readable — it is just not a delinquency.
    const state = classifyProofState(delinquentReading({ isLive: false }), EPOCH);

    expect(state.readable).toBe(true);
    expect(state.isDelinquent).toBe(false);
  });

  it("does not call an uninitialised proving period delinquent", () => {
    // Warm Storage returns 0 before the first proving period starts. Treating
    // that as epoch zero would make every new data set infinitely overdue.
    const state = classifyProofState(delinquentReading({ provingDeadline: 0 }), EPOCH);

    expect(state.readable).toBe(true);
    expect(state.isDelinquent).toBe(false);
    expect(state.epochsOverdue).toBeNull();
  });

  it("does not call a data set delinquent before its deadline", () => {
    const state = classifyProofState(
      delinquentReading({ provingDeadline: EPOCH + 1_000, provenThisPeriod: false }),
      EPOCH,
    );

    expect(state.readable).toBe(true);
    expect(state.isDelinquent).toBe(false);
    expect(state.epochsOverdue).toBe(0);
  });

  it("does not call an overdue data set delinquent when it HAS proved", () => {
    const state = classifyProofState(delinquentReading({ provenThisPeriod: true }), EPOCH);

    expect(state.readable).toBe(true);
    expect(state.isDelinquent).toBe(false);
    expect(state.epochsOverdue).toBe(2_880);
  });

  it("treats the deadline epoch itself as not yet late", () => {
    const state = classifyProofState(delinquentReading({ provingDeadline: EPOCH }), EPOCH);

    expect(state.isDelinquent).toBe(false);
  });
});

describe("classifyProofState: the one delinquent case", () => {
  it("is live, past its deadline, unproven, and every decisive field answered", () => {
    const state = classifyProofState(delinquentReading(), EPOCH);

    expect(state.readable).toBe(true);
    expect(state.unknownReason).toBeNull();
    expect(state.isDelinquent).toBe(true);
    expect(state.epochsOverdue).toBe(2_880);
    // The evidence a reader can check against an explorer is preserved.
    expect(state.lastProvenEpoch).toBe(EPOCH - 5_760);
    expect(state.provingDeadline).toBe(EPOCH - 2_880);
  });
});

/* ---------- aggregation ---------- */

function storedSet(id: string, proof: DataSetProofState): StoredDataSet {
  return {
    id,
    pdpId: id,
    provider: "0xprovider",
    sizeBytes: 1_048_576,
    isLive: proof.isLive === true,
    withCDN: false,
    pieceCids: [],
    proof,
  };
}

describe("proofSnapshotFrom", () => {
  it("counts delinquent and unreadable separately, never merging them", () => {
    const healthy = classifyProofState(delinquentReading({ provenThisPeriod: true }), EPOCH);
    const bad = classifyProofState(delinquentReading({ dataSetId: "43" }), EPOCH);
    const unknown = classifyProofState(unreadableReading("44", "timeout"), EPOCH);

    const snapshot = proofSnapshotFrom(
      [storedSet("42", healthy), storedSet("43", bad), storedSet("44", unknown)],
      EPOCH,
    );

    expect(snapshot.delinquent).toBe(1);
    expect(snapshot.unreadable).toBe(1);
    expect(snapshot.dataSets).toHaveLength(3);
    expect(snapshot.listingError).toBeNull();
  });

  it("orders delinquent sets numerically so selection is deterministic", () => {
    const nine = classifyProofState(delinquentReading({ dataSetId: "9" }), EPOCH);
    const ten = classifyProofState(delinquentReading({ dataSetId: "10" }), EPOCH);

    // Lexically "10" sorts before "9"; the agent must pick the same victim
    // every tick, and "lowest id" has to mean the numerically lowest one.
    const snapshot = proofSnapshotFrom([storedSet("10", ten), storedSet("9", nine)], EPOCH);
    expect(delinquentSets(snapshot).map((s) => s.dataSetId)).toEqual(["9", "10"]);
  });

  it("counts only confirmed-live data sets", () => {
    const live = classifyProofState(delinquentReading({ provenThisPeriod: true }), EPOCH);
    const dead = classifyProofState(delinquentReading({ dataSetId: "43", isLive: false }), EPOCH);
    const unknown = classifyProofState(unreadableReading("44", "timeout"), EPOCH);

    const snapshot = proofSnapshotFrom(
      [storedSet("42", live), storedSet("43", dead), storedSet("44", unknown)],
      EPOCH,
    );
    // Unknown liveness is not liveness. Counting it would inflate the divisor
    // the re-sized top-up is computed from.
    expect(liveSetCount(snapshot)).toBe(1);
  });

  it("reports nothing at all for a snapshot with no proof reading", () => {
    expect(delinquentSets(undefined)).toEqual([]);
    expect(liveSetCount(undefined)).toBe(0);
    expect(describeProof(undefined)).toBe("");
  });
});

describe("describeProof", () => {
  it("says an unreadable state is unknown and not a missed proof", () => {
    const snapshot = proofSnapshotFrom(
      [storedSet("44", classifyProofState(unreadableReading("44", "RPC timed out"), EPOCH))],
      EPOCH,
    );

    const text = describeProof(snapshot);
    expect(text).toContain("could not be read");
    expect(text).toContain("RPC timed out");
    expect(text).toContain("never as a missed proof");
    expect(text).toContain("no data set is proposed for");
  });

  it("distinguishes a failed listing from an account with nothing stored", () => {
    const failed = describeProof(unreadableProofSnapshot(EPOCH, "listStorage timed out"));
    expect(failed).toContain("storage listing could not be read");
    expect(failed).toContain("listStorage timed out");
    expect(failed).not.toContain("No data sets are on this account");

    const empty = describeProof(proofSnapshotFrom([], EPOCH));
    expect(empty).toContain("No data sets are on this account");
  });

  it("names the overdue data set and by how much", () => {
    const snapshot = proofSnapshotFrom(
      [storedSet("43", classifyProofState(delinquentReading({ dataSetId: "43" }), EPOCH))],
      EPOCH,
    );

    const text = describeProof(snapshot);
    expect(text).toContain("#43");
    expect(text).toContain("2,880 epochs overdue");
  });

  it("says so plainly when everything is proving", () => {
    const snapshot = proofSnapshotFrom(
      [
        storedSet(
          "42",
          classifyProofState(delinquentReading({ provenThisPeriod: true }), EPOCH),
        ),
      ],
      EPOCH,
    );

    expect(describeProof(snapshot)).toContain("proving on schedule");
  });
});
