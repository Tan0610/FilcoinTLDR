/**
 * The policy engine's proof-aware branch.
 *
 * `policy.test.ts` covers the runway rules. These cover the decision the agent
 * makes when its storage stops earning its cost — and, far more importantly,
 * the decisions it must NOT make when it cannot tell.
 *
 * `evaluate()` is still pure here: every input, including whether eviction is
 * armed, is passed in.
 */

import { describe, expect, it } from "vitest";

import { EPOCHS_PER_DAY } from "./constants";
import { DEFAULT_RULES, evaluate, isDepositAction, resizeTopUp } from "./policy";
import { classifyProofState, proofSnapshotFrom, unreadableReading } from "./proof";
import { accumulate, emptyTotals } from "./journal";
import { spendEntriesFrom } from "./spendGuard";
import type { DataSetProofState, ProofSnapshot, RunwaySnapshot, StoredDataSet } from "./types";

const EPOCH = 3_000_000;
const NOW = 1_756_000_000_000;

function proofState(
  dataSetId: string,
  kind: "healthy" | "delinquent" | "unreadable",
): DataSetProofState {
  if (kind === "unreadable") {
    return classifyProofState(unreadableReading(dataSetId, "RPC timed out"), EPOCH);
  }
  return classifyProofState(
    {
      dataSetId,
      isLive: true,
      lastProvenEpoch: kind === "healthy" ? EPOCH - 120 : EPOCH - 5_760,
      nextChallengeEpoch: kind === "healthy" ? EPOCH + 1_320 : null,
      provingDeadline: kind === "healthy" ? EPOCH + 2_760 : EPOCH - 2_880,
      provenThisPeriod: kind === "healthy",
      errors: [],
    },
    EPOCH,
  );
}

function storedSet(proof: DataSetProofState): StoredDataSet {
  return {
    id: proof.dataSetId,
    pdpId: proof.dataSetId,
    provider: "0xprovider",
    sizeBytes: 1_048_576,
    isLive: proof.isLive === true,
    withCDN: false,
    pieceCids: [],
    proof,
  };
}

function proofOf(...kinds: ("healthy" | "delinquent" | "unreadable")[]): ProofSnapshot {
  return proofSnapshotFrom(
    kinds.map((kind, index) => storedSet(proofState(String(30_291 + index), kind))),
    EPOCH,
  );
}

/** A reading with `days` of runway and, optionally, a proof reading. */
function snapshotWith(days: number, proof?: ProofSnapshot, wallet = "250"): RunwaySnapshot {
  return {
    takenAt: NOW,
    epoch: EPOCH,
    fundsAvailable: "1.5",
    lockupRate: "0.00041",
    lockupCurrent: "0.84870",
    epochsRemaining: Math.round(days * EPOCHS_PER_DAY),
    daysRemaining: days,
    walletUsdfc: wallet,
    walletFil: "4.9823",
    ...(proof ? { proof } : {}),
  };
}

const opts = { now: NOW, id: "d1", demoScale: 1 } as const;

/* ---------- the branch that must never fire by accident ---------- */

describe("an unreadable proof state can never cause a cut", () => {
  it("tops up as usual, and says the proof state is unknown", () => {
    // The RPC-hiccup case. Every field the delinquency judgement needs is
    // missing; the runway is short enough for a rule to have fired. If unknown
    // were ever read as "not proven", this is the tick that would destroy data.
    const decision = evaluate(snapshotWith(5, proofOf("healthy", "unreadable")), DEFAULT_RULES, {
      ...opts,
      evictionEnabled: true,
    });

    expect(decision.action).toBe("TOP_UP");
    expect(decision.target).toBeUndefined();
    expect(decision.reasoning).toContain("could not be read");
    expect(decision.reasoning).toContain("never as a missed proof");
    expect(decision.reasoning).toContain("no data set is proposed for termination");
  });

  it("tops up as usual when the storage listing itself failed", () => {
    const decision = evaluate(
      snapshotWith(5, { epoch: EPOCH, dataSets: [], unreadable: 0, delinquent: 0, listingError: "listStorage timed out" }),
      DEFAULT_RULES,
      { ...opts, evictionEnabled: true },
    );

    expect(decision.action).toBe("TOP_UP");
    expect(decision.reasoning).toContain("storage listing could not be read");
    // And it must not claim the account stores nothing, which is a different
    // and much more flattering statement than "we could not look".
    expect(decision.reasoning).not.toContain("No data sets are on this account");
  });

  it("behaves exactly as before when the snapshot carries no proof reading", () => {
    const withProof = evaluate(snapshotWith(5), DEFAULT_RULES, opts);
    expect(withProof.action).toBe("TOP_UP");
    // Nothing is asserted about storage, because nothing was read.
    expect(withProof.reasoning).not.toContain("PDP");
    expect(withProof.reasoning).not.toContain("proof");
  });

  it("does not cut a healthy account however short the runway is", () => {
    const decision = evaluate(snapshotWith(0.5, proofOf("healthy", "healthy")), DEFAULT_RULES, {
      ...opts,
      evictionEnabled: true,
    });

    expect(decision.action).toBe("EMERGENCY_TOP_UP");
    expect(decision.reasoning).toContain("2 data sets proving on schedule");
  });
});

/* ---------- the eviction decision ---------- */

describe("PRUNE_DATASET", () => {
  it("prefers cutting dead weight over buying runway for it", () => {
    const decision = evaluate(snapshotWith(5, proofOf("healthy", "delinquent")), DEFAULT_RULES, {
      ...opts,
      evictionEnabled: true,
    });

    expect(decision.action).toBe("PRUNE_DATASET");
    expect(decision.outcome).toBe("PENDING");
    expect(decision.target?.dataSetId).toBe("30292");
    expect(decision.target?.epochsOverdue).toBe(2_880);
    expect(decision.target?.liveDataSets).toBe(2);
    expect(decision.target?.executionEnabled).toBe(true);
  });

  it("cites the real numbers behind the choice", () => {
    const decision = evaluate(snapshotWith(5, proofOf("healthy", "delinquent")), DEFAULT_RULES, {
      ...opts,
      evictionEnabled: true,
    });

    // The reading it decided on.
    expect(decision.reasoning).toContain("Runway 5.0 days");
    expect(decision.reasoning).toContain("7-day top-up threshold");
    // The evidence, checkable against a block explorer.
    expect(decision.reasoning).toContain("#30292");
    expect(decision.reasoning).toContain(`last proven at epoch ${(EPOCH - 5_760).toLocaleString("en-US")}`);
    expect(decision.reasoning).toContain(`proving deadline epoch ${(EPOCH - 2_880).toLocaleString("en-US")}`);
    expect(decision.reasoning).toContain("2,880 epochs past its proving deadline");
    // The trade it made, and the deposit it is NOT making.
    expect(decision.reasoning).toContain("5 USDFC deposit this rule calls for");
    expect(decision.reasoning).toContain("NOT made on this reading");
    expect(decision.reasoning).toContain("1 of 2 live rails survive");
  });

  it("re-sizes the deferred top-up over the surviving rails, and says it is a bound", () => {
    const decision = evaluate(snapshotWith(5, proofOf("healthy", "delinquent")), DEFAULT_RULES, {
      ...opts,
      evictionEnabled: true,
    });

    // 5 USDFC across 2 rails, one of which is being cut.
    expect(decision.target?.deferredTopUpAmount).toBe("5");
    expect(decision.target?.resizedTopUpAmount).toBe("2.5");
    expect(decision.reasoning).toContain("about 2.50 USDFC rather than 5 USDFC");
    // Honesty: Filecoin Pay gives one aggregate rate, so this is arithmetic on
    // a rail COUNT and the decision has to say so rather than imply a reading.
    expect(decision.reasoning).toContain("a bound, not a measurement");
    expect(decision.reasoning).toContain("re-decides against the true");
  });

  it("prefers cutting over declaring insufficient funds", () => {
    // The wallet cannot cover the 5 USDFC the rule wants. Cutting a rail that
    // is not earning its cost costs nothing but gas — a strictly better answer
    // than recording a shortfall and doing nothing.
    const decision = evaluate(
      snapshotWith(5, proofOf("healthy", "delinquent"), "0.1"),
      DEFAULT_RULES,
      { ...opts, evictionEnabled: true },
    );

    expect(decision.action).toBe("PRUNE_DATASET");
  });

  it("picks the lowest-numbered delinquent set, deterministically", () => {
    const decision = evaluate(
      snapshotWith(5, proofOf("delinquent", "delinquent")),
      DEFAULT_RULES,
      { ...opts, evictionEnabled: true },
    );

    expect(decision.target?.dataSetId).toBe("30291");
  });
});

/* ---------- the gate, expressed in the decision itself ---------- */

describe("with eviction not armed", () => {
  it("still MAKES and records the decision, with execution withheld", () => {
    const decision = evaluate(snapshotWith(5, proofOf("healthy", "delinquent")), DEFAULT_RULES, {
      ...opts,
      evictionEnabled: false,
    });

    // The autonomy artifact is the decision, not the transaction.
    expect(decision.action).toBe("PRUNE_DATASET");
    expect(decision.outcome).toBe("NO_ACTION");
    expect(decision.target?.dataSetId).toBe("30292");
    expect(decision.target?.executionEnabled).toBe(false);
    // Nothing is claimed to have been submitted.
    expect(decision.reasoning).not.toContain("Submitting terminateService");
  });

  it("defaults to withheld when the caller says nothing about it", () => {
    const decision = evaluate(
      snapshotWith(5, proofOf("healthy", "delinquent")),
      DEFAULT_RULES,
      opts,
    );

    expect(decision.outcome).toBe("NO_ACTION");
    expect(decision.target?.executionEnabled).toBe(false);
  });

  it("funds an emergency rather than sitting on an option it may not take", () => {
    // Inside the 2-day emergency threshold with eviction disarmed, refusing to
    // top up because the agent preferred a cut it is not allowed to make would
    // let the account die on a technicality.
    const decision = evaluate(
      snapshotWith(1, proofOf("healthy", "delinquent")),
      DEFAULT_RULES,
      { ...opts, evictionEnabled: false },
    );

    expect(decision.action).toBe("EMERGENCY_TOP_UP");
    expect(decision.reasoning).toContain("would be cut in preference to this deposit");
    expect(decision.reasoning).toContain("eviction is not armed");
    expect(decision.reasoning).toContain("rather than left to die");
  });

  it("cuts during an emergency when it IS armed", () => {
    const decision = evaluate(snapshotWith(1, proofOf("healthy", "delinquent")), DEFAULT_RULES, {
      ...opts,
      evictionEnabled: true,
    });

    expect(decision.action).toBe("PRUNE_DATASET");
  });
});

/* ---------- what a HOLD says about dead weight ---------- */

describe("HOLD with a delinquent data set", () => {
  it("flags it, and declines to take an irreversible action it is not forced into", () => {
    const decision = evaluate(snapshotWith(30, proofOf("healthy", "delinquent")), DEFAULT_RULES, {
      ...opts,
      evictionEnabled: true,
    });

    expect(decision.action).toBe("HOLD");
    // An agent that noticed dead weight and left it alone has to show that it
    // noticed, or the decision is indistinguishable from not looking.
    expect(decision.reasoning).toContain("#30292");
    expect(decision.reasoning).toContain("not taking an irreversible action");
    expect(decision.reasoning).toContain("will reconsider if the runway falls");
  });
});

/* ---------- resizing, and the accounting it must not corrupt ---------- */

describe("resizeTopUp", () => {
  it("is pro-rata by rail count", () => {
    expect(resizeTopUp("5", 2)).toBe("2.5");
    expect(resizeTopUp("15", 3)).toBe("10");
    expect(resizeTopUp("5", 4)).toBe("3.75");
  });

  it("is zero when nothing survives the cut", () => {
    expect(resizeTopUp("5", 1)).toBe("0");
    expect(resizeTopUp("5", 0)).toBe("0");
    // A liveness read that produced nothing must not produce a negative divisor.
    expect(resizeTopUp("5", Number.NaN)).toBe("0");
  });
});

describe("a prune is never counted as a deposit", () => {
  it("is excluded from the deposits total and from the safety cap's ledger", () => {
    const pruned = evaluate(snapshotWith(5, proofOf("healthy", "delinquent")), DEFAULT_RULES, {
      ...opts,
      evictionEnabled: true,
    });
    const executed = { ...pruned, outcome: "EXECUTED" as const, txHash: "0xabc" };

    // It carries `ruleFired` — the 5 USDFC top-up it was taken INSTEAD of —
    // and it executed a transaction. Both of the figures below used to key on
    // exactly that pair, and would have reported 5 USDFC spent on a decision
    // whose whole point was not to spend it.
    expect(executed.ruleFired?.topUpAmount).toBe("5");
    expect(isDepositAction(executed.action)).toBe(false);

    const totals = accumulate(emptyTotals(), executed);
    expect(totals.depositedUsdfc).toBe("0");
    // It still counts as an executed action: a transaction really was made.
    expect(totals.executed).toBe(1);

    expect(spendEntriesFrom([executed])).toEqual([]);
  });

  it("still counts a real top-up in both", () => {
    const topUp = evaluate(snapshotWith(5, proofOf("healthy", "healthy")), DEFAULT_RULES, opts);
    const executed = { ...topUp, outcome: "EXECUTED" as const, txHash: "0xabc" };

    expect(isDepositAction(executed.action)).toBe(true);
    expect(accumulate(emptyTotals(), executed).depositedUsdfc).toBe("5");
    expect(spendEntriesFrom([executed])).toHaveLength(1);
  });
});
