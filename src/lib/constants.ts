/**
 * Chain + agent constants.
 *
 * Filecoin epochs are 30 seconds, so a day is 2880 epochs. Every runway
 * calculation in the app funnels through EPOCHS_PER_DAY so the live-chain
 * agent and the mock adapter cannot drift apart.
 */

export const EPOCH_SECONDS = 30;
export const EPOCHS_PER_DAY = (24 * 60 * 60) / EPOCH_SECONDS; // 2880

/**
 * Block-explorer links live in `src/lib/explorer.ts`.
 *
 * They used to be three lines here, pointing at Filfox — and every link they
 * built was dead, because Filfox indexes Filecoin-native message CIDs and
 * `t4` addresses rather than the `0x` forms this agent produces. Getting that
 * right needs a paragraph of reasoning about which explorer indexes what, and
 * a rule about when a hash must NOT be linked at all, which is more than a
 * constants file should be carrying.
 */

/** How often the agent runs a full sense -> decide -> act cycle. */
export const TICK_INTERVAL_MS = 15_000;
/** How often the agent re-reads its balance (cheap; drives the live gauge). */
export const SENSE_INTERVAL_MS = 2_000;
/** SSE heartbeat so proxies do not close an idle stream. */
export const SSE_HEARTBEAT_MS = 15_000;

/** Runway bands used for gauge colour + copy. Days. */
export const BAND_CRITICAL_DAYS = 2;
export const BAND_WARNING_DAYS = 7;
/** Full-scale of the runway gauge, in days. */
export const GAUGE_MAX_DAYS = 14;

/* ---------- Unbounded-runway sentinel ---------- */

/**
 * Filecoin Pay reports `runwayInEpochs === maxUint256` when the lockup rate is
 * zero: nothing is being spent, so the runway is unbounded. It reports `0`
 * when the account is already in deficit (`debt > 0`).
 *
 * We cannot carry `Infinity` in a `RunwaySnapshot`. Snapshots are pushed to the
 * browser as JSON over SSE and `JSON.stringify(Infinity)` is `null`, which
 * would arrive as a missing number and render as a CRITICAL zero — the exact
 * opposite of the truth. So the chain layer maps "unbounded" onto a large
 * FINITE sentinel that survives the wire, and every display or policy path
 * funnels through the predicates below instead of `Number.isFinite`.
 *
 * The sentinel is deliberately far above any physically reachable runway
 * (~3.1e12 days ≈ 8.6 billion years) so a real reading can never collide.
 */
export const UNBOUNDED_EPOCHS = Number.MAX_SAFE_INTEGER;
export const UNBOUNDED_DAYS = UNBOUNDED_EPOCHS / EPOCHS_PER_DAY;

/** True for both the finite sentinel and a legacy `Infinity`. */
export function isUnboundedEpochs(epochs: number): boolean {
  return !Number.isFinite(epochs) || epochs >= UNBOUNDED_EPOCHS;
}

/** True for both the finite sentinel and a legacy `Infinity`. */
export function isUnboundedDays(days: number): boolean {
  return !Number.isFinite(days) || days >= UNBOUNDED_DAYS;
}
