/**
 * The hydrate/stream race. `GET /api/decisions` is what starts the agent loop,
 * so it answers `[]` while the first tick is still running; replacing state
 * with that answer wipes whatever the SSE stream already delivered. These tests
 * pin the merge that makes the opening frame of a live demo correct.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_FEED_DECISIONS,
  mergeDecisions,
  mergeLastTickAt,
  newerNotices,
  newerTotals,
} from "./decisions";
import type { Decision, DecisionOutcome, DecisionTotals, RunwaySnapshot } from "./types";

const SNAPSHOT: RunwaySnapshot = {
  takenAt: 1_700_000_000_000,
  epoch: 2_960_000,
  fundsAvailable: "11.33568",
  lockupRate: "0.000002777832968892",
  lockupCurrent: "0.84870",
  epochsRemaining: 4_080_772,
  daysRemaining: 1_417.0,
  walletUsdfc: "250",
  walletFil: "5",
};

function decision(
  id: string,
  at: number,
  outcome: DecisionOutcome = "PENDING",
): Decision {
  return {
    id,
    at,
    snapshot: SNAPSHOT,
    ruleFired: null,
    action: "TOP_UP",
    reasoning: "test",
    outcome,
  };
}

describe("mergeDecisions", () => {
  it("keeps a streamed decision when the hydrate answers empty", () => {
    const streamed = decision("a", 1_000);
    expect(mergeDecisions([streamed], [])).toEqual([streamed]);
  });

  it("adds fetched history without dropping streamed decisions", () => {
    const streamed = decision("new", 3_000);
    const fetched = [decision("old", 1_000), decision("older", 500)];
    expect(mergeDecisions([streamed], fetched).map((d) => d.id)).toEqual([
      "new",
      "old",
      "older",
    ]);
  });

  it("de-duplicates by id so React never sees two cards with one key", () => {
    const merged = mergeDecisions([decision("a", 1_000)], [decision("a", 1_000)]);
    expect(merged).toHaveLength(1);
    expect(new Set(merged.map((d) => d.id)).size).toBe(merged.length);
  });

  it("keeps the settled record whichever side it arrived on", () => {
    const pending = decision("a", 1_000, "PENDING");
    const executed = decision("a", 1_000, "EXECUTED");

    expect(mergeDecisions([pending], [executed])[0].outcome).toBe("EXECUTED");
    // The stream is live; a fetch taken before it must not undo its update.
    expect(mergeDecisions([executed], [pending])[0].outcome).toBe("EXECUTED");
  });

  it("orders reverse-chronologically, like the streamed feed", () => {
    const merged = mergeDecisions(
      [decision("mid", 2_000)],
      [decision("newest", 3_000), decision("oldest", 1_000)],
    );
    expect(merged.map((d) => d.id)).toEqual(["newest", "mid", "oldest"]);
  });

  it("is stable for decisions stamped in the same millisecond", () => {
    const a = decision("a", 1_000);
    const b = decision("b", 1_000);
    expect(mergeDecisions([a], [b])).toEqual(mergeDecisions([b], [a]));
  });

  it("caps the feed", () => {
    const many = Array.from({ length: 200 }, (_, i) => decision(`d${i}`, i));
    expect(mergeDecisions([], many)).toHaveLength(MAX_FEED_DECISIONS);
    expect(mergeDecisions([], many, 3).map((d) => d.id)).toEqual([
      "d199",
      "d198",
      "d197",
    ]);
  });

  it("never mutates either input", () => {
    const current = [decision("a", 1_000)];
    const incoming = [decision("b", 2_000)];
    mergeDecisions(current, incoming);
    expect(current.map((d) => d.id)).toEqual(["a"]);
    expect(incoming.map((d) => d.id)).toEqual(["b"]);
  });
});

describe("mergeLastTickAt", () => {
  it("never regresses to an older tick or back to unknown", () => {
    expect(mergeLastTickAt(5_000, null)).toBe(5_000);
    expect(mergeLastTickAt(5_000, 4_000)).toBe(5_000);
    expect(mergeLastTickAt(5_000, 6_000)).toBe(6_000);
  });

  it("accepts the first reading from either source", () => {
    expect(mergeLastTickAt(null, 4_000)).toBe(4_000);
    expect(mergeLastTickAt(null, null)).toBeNull();
  });
});

describe("newerTotals", () => {
  const totals = (decisions: number, executed = 0): DecisionTotals => ({
    decisions,
    executed,
    depositedUsdfc: (executed * 5).toString(),
    firstAt: 1,
    lastAt: decisions,
  });

  it("keeps the more complete reading", () => {
    expect(newerTotals(totals(3), totals(7))!.decisions).toBe(7);
    expect(newerTotals(totals(7), totals(3))!.decisions).toBe(7);
  });

  it("does not let the slow hydrate drag the deposits tile backwards", () => {
    // The stream has already reported 12 decisions including an executed
    // deposit; the hydrate's older snapshot of 4 must not replace it.
    const live = totals(12, 1);
    expect(newerTotals(live, totals(4, 0))).toBe(live);
  });

  it("accepts the first reading from either source", () => {
    const first = totals(2);
    expect(newerTotals(null, first)).toBe(first);
    expect(newerTotals(first, null)).toBe(first);
    expect(newerTotals(null, null)).toBeNull();
  });

  it("prefers the incoming reading on a tie, so a later outcome flip wins", () => {
    // Same decision count, but one of them has since settled to EXECUTED.
    const settled = totals(9, 1);
    expect(newerTotals(totals(9, 0), settled)).toBe(settled);
  });
});

/* ---------- standing disclosures ---------- */

/**
 * Same race as the totals above: the hydrate's `AgentStatus.notices` and the
 * stream's `notices` frame both carry the whole set and either can land second.
 * The stakes are different, though — a disclosure that arrives twice must not
 * turn into two rows, and one that arrives late must not be dropped.
 */
describe("newerNotices", () => {
  const withheld = { key: "journal-withheld", level: "info" as const, message: "5 MOCK…" };
  const skipped = { key: "journal-skipped", level: "warn" as const, message: "2 lines…" };

  it("takes the longer set, whichever source it arrives from", () => {
    expect(newerNotices([], [withheld])).toEqual([withheld]);
    expect(newerNotices([withheld], [withheld, skipped])).toEqual([withheld, skipped]);
  });

  it("does not let a stale hydrate drop a disclosure already on screen", () => {
    const shown = [withheld, skipped];
    expect(newerNotices(shown, [withheld])).toBe(shown);
    expect(newerNotices(shown, [])).toBe(shown);
    expect(newerNotices(shown, undefined)).toBe(shown);
  });

  it("keeps the identical set identical, so a reconnect re-renders nothing", () => {
    const shown = [withheld];
    // Same length is not newer: returning `shown` itself is what stops the
    // pinned rows from remounting every time the stream drops and reconnects.
    expect(newerNotices(shown, [{ ...withheld }])).toBe(shown);
  });

  it("stays empty when there is nothing to disclose", () => {
    expect(newerNotices([], [])).toEqual([]);
  });
});
