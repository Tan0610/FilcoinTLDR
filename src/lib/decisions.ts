/**
 * Client-side decision-list merging.
 *
 * THE RACE
 * --------
 * The dashboard fills its decision log from two sources that race each other:
 * the initial `GET /api/decisions` hydrate and the SSE stream. The hydrate is
 * also what STARTS the agent loop (`ensureAgentLoop()`), so its response is
 * usually `[]` — the first tick is still in flight behind it. Worse, the
 * hydrate is gated on `Promise.all` with `GET /api/snapshot`, which in LIVE
 * mode waits on an RPC read, so the empty decision list is applied seconds
 * later — after the stream has already delivered the first decision.
 *
 * Replacing state with that response wipes the decision on screen. It
 * self-heals on the next decision event, but a live tick is ~74s, so the wrong
 * state sits in the opening frame for over a minute. (In mock mode ticks settle
 * in milliseconds, which is why this is nearly invisible there.)
 *
 * The fix is to MERGE rather than replace: union by `Decision.id`, keep the
 * more advanced record on a collision, and re-sort into the feed's
 * reverse-chronological order.
 */

import type { AgentNotice, Decision, DecisionTotals } from "./types";

/** Feed cap. Matches the number of cards the dashboard is willing to hold. */
export const MAX_FEED_DECISIONS = 120;

/**
 * Which of two records for the same decision to keep.
 *
 * A decision only ever gains information: the agent stores it PENDING, then
 * upserts it to EXECUTED / FAILED once the transaction settles. So a record
 * that has left PENDING is never the older one. Anything else keeps `current`,
 * because the stream is live and the fetch is a snapshot taken before it.
 */
function moreAdvanced(current: Decision, incoming: Decision): Decision {
  if (current.outcome === "PENDING" && incoming.outcome !== "PENDING") return incoming;
  return current;
}

/**
 * Union `incoming` into `current`, de-duplicated by id and ordered
 * reverse-chronologically by `at` — the same order the SSE path produces by
 * prepending each new decision. Ties break on id so the order is stable and
 * React never sees two cards with the same key.
 */
export function mergeDecisions(
  current: Decision[],
  incoming: Decision[],
  limit = MAX_FEED_DECISIONS,
): Decision[] {
  const byId = new Map<string, Decision>();
  for (const decision of current) byId.set(decision.id, decision);
  for (const decision of incoming) {
    const existing = byId.get(decision.id);
    byId.set(decision.id, existing ? moreAdvanced(existing, decision) : decision);
  }

  return [...byId.values()]
    .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
    .slice(0, limit);
}

/**
 * The newer of two `lastTickAt` readings. The hydrate must never drag the
 * status strip back to "—" (or to an older tick) after the stream has already
 * reported one.
 */
export function mergeLastTickAt(current: number | null, incoming: number | null): number | null {
  if (incoming === null) return current;
  if (current === null) return incoming;
  return Math.max(current, incoming);
}

/**
 * The more complete of two `DecisionTotals` readings.
 *
 * Same race as `mergeLastTickAt`: the hydrate's figures are a snapshot taken
 * before the stream, so applying them unconditionally can drag the AUTONOMOUS
 * DEPOSITS tile backwards after a `totals` event has already reported a newer
 * count. `decisions` only ever grows, so it is the tiebreak.
 */
export function newerTotals(
  current: DecisionTotals | null,
  incoming: DecisionTotals | null,
): DecisionTotals | null {
  if (!incoming) return current;
  if (!current) return incoming;
  return incoming.decisions >= current.decisions ? incoming : current;
}

/**
 * The more complete of two disclosure sets. Same race again: the hydrate's
 * `AgentStatus.notices` and the stream's `notices` frame both carry the whole
 * set, and either can land second.
 *
 * Notices are append-only and deduplicated by key server-side, so the longer
 * list is always the newer one. Replacing rather than merging is what keeps a
 * reconnect from appending a second copy of the same disclosure — and returning
 * `current` unchanged when nothing is newer keeps React from re-rendering the
 * pinned rows on every reconnect.
 */
export function newerNotices(
  current: AgentNotice[],
  incoming: AgentNotice[] | undefined,
): AgentNotice[] {
  if (!incoming) return current;
  return incoming.length > current.length ? incoming : current;
}
