/**
 * PDP proof state, and the one judgement the agent is allowed to make from it.
 *
 * WHY THIS FILE IS SEPARATE, PURE, AND PARANOID
 * --------------------------------------------
 * `isDelinquent` is the flag that can cause the agent to TERMINATE a data set —
 * an irreversible action that stops paying a storage provider and lets the data
 * go. Everything that decides it therefore lives here, with no chain access and
 * no clock, so every branch is unit-testable and none of them can be reached by
 * accident from a `catch`.
 *
 * THE INVARIANT
 * -------------
 * An unread field is NEVER evidence of a missed proof.
 *
 * The five reads behind this judgement are ordinary contract calls on a public
 * RPC. They time out, they revert for a data set that is not live, and
 * `provingDeadline` reverts outright with `ProvingPeriodNotInitialized` on a
 * data set whose first proving period has not started. If any of those were
 * folded into "not proven", a thirty-second RPC wobble would read as a
 * delinquency and the agent would cut live, healthy, paid-for storage. So the
 * reading carries `null` for anything that did not answer, `readable` is false
 * unless all three DECISIVE fields returned, and `isDelinquent` is false
 * whenever `readable` is false — unconditionally, with no override anywhere.
 *
 * The decisive fields are:
 *
 *   - `isLive`           — a terminated data set is not delinquent, it is gone.
 *   - `provingDeadline`  — with no deadline there is nothing to be late for.
 *   - `provenThisPeriod` — the actual answer to "did it prove?".
 *
 * `lastProvenEpoch` and `nextChallengeEpoch` are read too, because they are
 * what makes a decision's reasoning checkable against a block explorer, but
 * neither is allowed to influence the flag.
 *
 * WHAT WE READ, IN @filoz/synapse-sdk 1.2.1
 * -----------------------------------------
 * The SDK does not expose a proof-state helper, so these are direct contract
 * reads through the chain definitions the SDK itself carries
 * (`synapse.chain.contracts.pdp` and `.fwssView`):
 *
 *   PDPVerifier          dataSetLive(id), getDataSetLastProvenEpoch(id),
 *                        getNextChallengeEpoch(id)
 *   WarmStorageStateView provenThisPeriod(id), provingDeadline(id)
 *
 * `@filoz/synapse-core/pdp-verifier` does export `dataSetLive` and
 * `getNextChallengeEpoch` as functions, but not the other three, and mixing two
 * call styles across one multicall would cost more than it saved. See
 * `readProofStates()` in `src/lib/chain/synapse.ts`.
 */

import type { DataSetProofState, ProofSnapshot, StoredDataSet } from "./types";

/**
 * One data set's raw readings. Every field is `null` when its call did not
 * return a usable answer, and `errors` names the calls that did not.
 *
 * This is the ONLY input to `classifyProofState`, which is what keeps the
 * chain layer from being able to assert a delinquency directly.
 */
export interface ProofReading {
  dataSetId: string;
  isLive: boolean | null;
  lastProvenEpoch: number | null;
  nextChallengeEpoch: number | null;
  provingDeadline: number | null;
  provenThisPeriod: boolean | null;
  /** Human-readable reasons, one per call that did not answer. */
  errors: string[];
}

/** A reading in which nothing at all could be read. */
export function unreadableReading(dataSetId: string, error: string): ProofReading {
  return {
    dataSetId,
    isLive: null,
    lastProvenEpoch: null,
    nextChallengeEpoch: null,
    provingDeadline: null,
    provenThisPeriod: null,
    errors: [error],
  };
}

/**
 * Turn raw readings into the agent's judgement.
 *
 * `currentEpoch` is the epoch of the same reading the deadlines are compared
 * against — `RunwaySnapshot.epoch`, i.e. a true chain height, never a local
 * clock. A non-finite or non-positive epoch is itself an unknown and makes
 * every state unreadable rather than making everything look on time.
 */
export function classifyProofState(
  reading: ProofReading,
  currentEpoch: number,
): DataSetProofState {
  const base = {
    dataSetId: reading.dataSetId,
    isLive: reading.isLive,
    lastProvenEpoch: reading.lastProvenEpoch,
    nextChallengeEpoch: reading.nextChallengeEpoch,
    provingDeadline: reading.provingDeadline,
    provenThisPeriod: reading.provenThisPeriod,
  };

  const missing: string[] = [...reading.errors];
  if (reading.isLive === null) missing.push("PDPVerifier.dataSetLive did not return");
  if (reading.provenThisPeriod === null) {
    missing.push("WarmStorage.provenThisPeriod did not return");
  }
  if (reading.provingDeadline === null) {
    missing.push("WarmStorage.provingDeadline did not return");
  }
  if (!Number.isFinite(currentEpoch) || currentEpoch <= 0) {
    missing.push("the chain epoch for this reading is unknown");
  }

  if (missing.length > 0) {
    // Unknown, and therefore NOT delinquent. This is the branch an RPC failure
    // lands in, and it is the whole reason the flag is computed here.
    return {
      ...base,
      readable: false,
      unknownReason: dedupe(missing).join("; "),
      epochsOverdue: null,
      isDelinquent: false,
    };
  }

  // Every decisive field answered. From here the judgement is arithmetic.
  const live = reading.isLive === true;
  const deadline = reading.provingDeadline as number;
  const proven = reading.provenThisPeriod === true;

  if (!live) {
    return {
      ...base,
      readable: true,
      unknownReason: null,
      epochsOverdue: null,
      isDelinquent: false,
    };
  }

  if (deadline <= 0) {
    // `provingDeadline` of 0 is Warm Storage saying the first proving period
    // has not been initialised. Nothing is late; there is no deadline yet.
    return {
      ...base,
      readable: true,
      unknownReason: null,
      epochsOverdue: null,
      isDelinquent: false,
    };
  }

  const overdue = currentEpoch - deadline;
  return {
    ...base,
    readable: true,
    unknownReason: null,
    epochsOverdue: overdue > 0 ? overdue : 0,
    isDelinquent: overdue > 0 && !proven,
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Fold the storage listing's per-data-set proof states into the summary the
 * policy engine reads off the snapshot.
 *
 * Deliberately derived from the SAME objects the STORED DATA panel renders, so
 * the panel and the decision can never disagree about whether a data set is
 * proving.
 */
export function proofSnapshotFrom(
  dataSets: readonly StoredDataSet[],
  epoch: number,
): ProofSnapshot {
  const states = dataSets.map((set) => set.proof);
  return {
    epoch,
    dataSets: states,
    unreadable: states.filter((state) => !state.readable).length,
    delinquent: states.filter((state) => state.isDelinquent).length,
    listingError: null,
  };
}

/**
 * The proof snapshot for a reading in which the storage listing itself failed.
 *
 * Carries no data sets and no delinquencies — because none were established —
 * plus the reason, which every decision then states. This is what stops a
 * failed listing from being mistaken for an account with nothing stored.
 */
export function unreadableProofSnapshot(epoch: number, error: string): ProofSnapshot {
  return { epoch, dataSets: [], unreadable: 0, delinquent: 0, listingError: error };
}

/** Confirmed-delinquent data sets, lowest id first so selection is stable. */
export function delinquentSets(proof: ProofSnapshot | undefined): DataSetProofState[] {
  if (!proof) return [];
  return proof.dataSets
    .filter((state) => state.isDelinquent)
    .sort((a, b) => compareIds(a.dataSetId, b.dataSetId));
}

/** Data sets confirmed LIVE at this reading. Unknown liveness does not count. */
export function liveSetCount(proof: ProofSnapshot | undefined): number {
  if (!proof) return 0;
  return proof.dataSets.filter((state) => state.isLive === true).length;
}

/** Numeric where both ids are numeric, lexical otherwise. Stable either way. */
function compareIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a.localeCompare(b);
}

/**
 * One sentence about the proof reading, appended to every decision's reasoning.
 *
 * Written so that a decision card screenshotted on its own still says what the
 * agent knew about its storage — including, crucially, what it did NOT know.
 * Returns "" only when the snapshot carried no proof reading at all, which is
 * the one case where saying anything would be a claim we cannot back.
 */
export function describeProof(proof: ProofSnapshot | undefined): string {
  if (!proof) return "";

  if (proof.listingError) {
    return (
      ` The storage listing could not be read (${proof.listingError}), so no data set's ` +
      "proof state is known on this reading. Unknown proof state is treated as UNKNOWN and " +
      "never as a missed proof: no data set is proposed for termination, and the runway " +
      "policy is applied on its own."
    );
  }

  const total = proof.dataSets.length;
  if (total === 0) {
    return " No data sets are on this account, so there is no proof obligation to check.";
  }

  const parts: string[] = [];
  const proven = proof.dataSets.filter(
    (state) => state.readable && state.isLive === true && !state.isDelinquent,
  ).length;

  if (proof.delinquent > 0) {
    const names = proof.dataSets
      .filter((state) => state.isDelinquent)
      .map((state) => `#${state.dataSetId} (${format(state.epochsOverdue)} epochs overdue)`)
      .join(", ");
    parts.push(
      `PDP: ${proof.delinquent} of ${total} data set${total === 1 ? "" : "s"} past its ` +
        `proving deadline at epoch ${format(proof.epoch)} — ${names}.`,
    );
  } else if (proof.unreadable < total) {
    parts.push(
      `PDP: ${proven} of ${total} data set${total === 1 ? "" : "s"} proving on schedule at ` +
        `epoch ${format(proof.epoch)}.`,
    );
  }

  if (proof.unreadable > 0) {
    const reason =
      proof.dataSets.find((state) => !state.readable)?.unknownReason ?? "read failed";
    parts.push(
      `Proof state for ${proof.unreadable} of ${total} data set` +
        `${total === 1 ? "" : "s"} could not be read (${reason}); an unread proof state is ` +
        "treated as UNKNOWN and never as a missed proof, so no data set is proposed for " +
        "termination on the strength of it.",
    );
  }

  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

function format(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "unknown";
  return Math.floor(value).toLocaleString("en-US");
}
