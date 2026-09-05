/**
 * Agent runner: sense -> decide -> act.
 *
 * This is the only place that combines the pure policy engine with the
 * side-effecting ChainAdapter. It stays deliberately thin so the interesting
 * logic remains unit-testable in `policy.ts`.
 *
 * Two live-chain concerns land here rather than in the adapter:
 *
 *   1. A failed chain read becomes a FAILED Decision carrying the error text,
 *      so an RPC outage is visible in the audit trail instead of vanishing into
 *      a 500. Nothing here is allowed to take down the SSE stream.
 *   2. Transaction confirmation. `deposit()` resolves at submission; adapters
 *      that can track inclusion expose `waitForTransaction()`, and the tx event
 *      then walks SUBMITTED -> CONFIRMED / FAILED for real.
 *   3. Tick coalescing. Only one cycle may run at a time — a second deposit
 *      submitted against the same reading would double-spend the policy. A
 *      caller that arrives mid-cycle is told so (`TickResult.coalesced`) rather
 *      than handed an older decision dressed up as the answer to its request.
 */

import { getChainAdapter } from "./chain";
import { SENSE_INTERVAL_MS, TICK_INTERVAL_MS, explorerMessageUrl } from "./constants";
import { DEMO_LABEL, DEMO_SCALED, DEMO_SCALE_AGREEMENT, scaleRules } from "./demo";
import { agentDriver, tickIntervalMs } from "./deployment";
import { DEFAULT_RULES, evaluate, newDecisionId } from "./policy";
import {
  checkSpend,
  describeLimits,
  spendCapEnabled,
  spendLimits,
  type SpendLimits,
} from "./spendGuard";
import { getStore } from "./store";
import type {
  AgentStatus,
  Decision,
  LogLevel,
  RunwaySnapshot,
  StorageListing,
} from "./types";
import { toFixedString } from "./units";

/**
 * The rule set the agent actually runs. Identical to DEFAULT_RULES unless
 * FILRUNWAY_DEMO_SCALE is set — see `src/lib/demo.ts` for exactly what that
 * does and, more importantly, what it does not do (it never touches a reading).
 */
const ACTIVE_RULES = scaleRules(DEFAULT_RULES);

function log(level: LogLevel, message: string): void {
  const store = getStore();
  store.publish({ id: store.nextEventId(), at: Date.now(), type: "log", level, message });
}

/**
 * A startup fact that must still be visible to a viewer who connects hours
 * later. Logged into the trace exactly as an ordinary line AND pinned as a
 * standing disclosure, because the trace is a rolling window that a few
 * minutes of ticks empties completely. Idempotent by `key`.
 */
function notice(key: string, level: LogLevel, message: string): void {
  log(level, message);
  getStore().addNotice({ key, level, message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The agent's own spending cap, applied to a decision that wants to deposit.
 *
 * Runs BEFORE the decision is recorded, so a capped tick is journalled once, as
 * what it is, rather than as a TOP_UP that quietly turned into something else.
 * The rule that fired is kept on the decision and its reasoning is kept in
 * front of the refusal: the record has to show what the agent wanted to do as
 * well as why it did not.
 *
 * This is the only place the cap is enforced, and it is deliberately outside
 * `policy.ts` — `evaluate()` is pure, and answering "how much have I spent in
 * the last 24 hours?" needs the durable history that only the store has.
 *
 * Limits are read per call rather than captured at module load, so changing
 * them is an environment change and not a redeploy of a frozen constant.
 */
function applySpendCap(decision: Decision): Decision {
  if (decision.action !== "TOP_UP" && decision.action !== "EMERGENCY_TOP_UP") return decision;
  if (!spendCapEnabled(getChainAdapter().mode)) return decision;

  const limits: SpendLimits = spendLimits();
  const amount = decision.ruleFired?.topUpAmount ?? "0";
  const verdict = checkSpend(getStore().spendEntries(), amount, decision.at, limits);
  if (verdict.allowed) return decision;

  return {
    ...decision,
    action: "SAFETY_CAP",
    outcome: "NO_ACTION",
    reasoning: `${decision.reasoning} ${verdict.reason}`,
  };
}

/** Stand-in reading for a FAILED decision taken before any successful read. */
function unknownSnapshot(): RunwaySnapshot {
  return {
    takenAt: Date.now(),
    epoch: 0,
    fundsAvailable: "0",
    lockupRate: "0",
    lockupCurrent: "0",
    epochsRemaining: 0,
    daysRemaining: 0,
    walletUsdfc: "0",
    walletFil: "0",
  };
}

/**
 * Cache for `getStorage()`.
 *
 * The storage listing is several chain reads deep and changes only when the
 * agent uploads, whereas the dashboard panel polls and every open tab polls
 * independently. A few seconds of reuse keeps a live demo off the RPC's back
 * without ever showing a figure older than the panel's own refresh interval.
 */
const STORAGE_TTL_MS = 10_000;
let storageCache: { at: number; listing: StorageListing } | null = null;

/** What the agent is paying to store. Chain-read; see `ChainAdapter.listStorage`. */
export async function getStorage(): Promise<StorageListing> {
  const now = Date.now();
  if (storageCache && now - storageCache.at < STORAGE_TTL_MS) {
    return storageCache.listing;
  }
  const listing = await getChainAdapter().listStorage();
  storageCache = { at: now, listing };
  return listing;
}

export async function getStatus(): Promise<AgentStatus> {
  const store = getStore();
  const adapter = getChainAdapter();
  // The interval ACTUALLY in force. Under the cron driver the local 15s
  // constant is not what schedules anything, and a NEXT TICK countdown running
  // to a deadline nothing observes would be a false reading on a dashboard
  // whose whole claim is that its readings are true.
  const interval = tickIntervalMs(TICK_INTERVAL_MS);
  return {
    mode: adapter.mode,
    address: await adapter.getAddress(),
    tickIntervalMs: interval,
    lastTickAt: store.lastTickAt,
    nextTickAt: store.lastTickAt === null ? null : store.lastTickAt + interval,
    // Whole-history figures, from the durable journal rather than from whatever
    // decisions a particular browser tab happens to be holding.
    totals: store.totals,
    journalPath: store.journal.enabled ? store.journal.path : null,
    // Standing disclosures, so a hydrate carries them even before the stream
    // connects — and so they cannot expire out of the trace. See `AgentNotice`.
    notices: store.notices,
  };
}

/** Read the chain and publish the reading. Cheap; drives the live gauge. */
export async function sense(): Promise<RunwaySnapshot> {
  const store = getStore();
  const snapshot = await getChainAdapter().getSnapshot();
  store.setSnapshot(snapshot);
  store.publish({
    id: store.nextEventId(),
    at: Date.now(),
    type: "snapshot",
    snapshot,
  });
  return snapshot;
}

/**
 * How stale a reading may be before `getSnapshot()` takes a new one, under the
 * cron driver only.
 *
 * Locally a `setInterval` re-reads the chain every 2 seconds, which is what
 * gives the gauge enough anchor points to count down smoothly. A serverless
 * instance has no such timer, so without this the dashboard would show one
 * reading per minute and the needle would sit still between ticks — a true
 * number, but a static one, on a page whose entire point is watching a live
 * position move.
 *
 * Deliberately far LONGER than the local 2s: this read is reachable from a
 * public GET, so it is a shared, TTL-gated cache per instance rather than a
 * read per request. It is a READ, never a decision — nothing here can spend.
 */
const REMOTE_SENSE_TTL_MS = 10_000;

/** Coalesces concurrent refreshes so several polling tabs cost one chain read. */
let senseInFlight: Promise<RunwaySnapshot> | null = null;

export async function getSnapshot(): Promise<RunwaySnapshot> {
  const store = getStore();
  const snapshot = store.snapshot;
  if (!snapshot) return sense();

  if (agentDriver() !== "cron" || Date.now() - snapshot.takenAt <= REMOTE_SENSE_TTL_MS) {
    return snapshot;
  }

  senseInFlight ??= sense()
    // A failed read falls back to the last true reading rather than to a
    // fabricated one or a 500. The dashboard already marks the stream stale.
    .catch(() => snapshot)
    .finally(() => {
      senseInFlight = null;
    });
  return senseInFlight;
}

/** What a tick call returns. See `runTick()` for why `coalesced` exists. */
export interface TickResult {
  /** The decision. Fresh unless `coalesced` says otherwise. */
  decision: Decision;
  /**
   * True when a cycle was already running and no new one was started for this
   * call. The decision is then either the last completed one or the result of
   * the cycle that was already in flight — in both cases NOT a decision taken
   * in response to this request.
   */
  coalesced: boolean;
}

/**
 * One full cycle: sense -> decide -> act. Never runs two at once.
 *
 * THE GUARD
 * ---------
 * A tick that arrives while another is in flight used to be served
 * `store.decisions[0]` — the PREVIOUS decision — in a response shaped exactly
 * like a fresh one. Pressing RUN TICK during a slow live cycle therefore
 * produced a card that looked like a brand-new decision and was minutes old,
 * with nothing anywhere to say so. That is misleading rather than merely
 * imprecise, so the coalesced case is now labelled: same fast answer, plus
 * `coalesced: true` so the caller can tell.
 *
 * The old guard also had a hole. `store.tickInFlight && store.decisions[0]`
 * fell through when no decision had completed yet, so the very first concurrent
 * tick — exactly the case the dashboard hits, because hydrate starts the loop
 * and the RUN TICK button is live immediately — ran a SECOND cycle against the
 * same reading. There is nothing to serve fast in that state, so the call now
 * joins the cycle already running instead of starting its own.
 */
export async function runTick(): Promise<TickResult> {
  const store = getStore();

  if (store.tickInFlight) {
    const previous = store.decisions[0];
    if (previous) return { decision: previous, coalesced: true };
    // Nothing has completed yet: the only honest answer is the outcome of the
    // cycle that is already running.
    if (store.inFlightTick) {
      return { decision: await store.inFlightTick, coalesced: true };
    }
  }

  store.tickInFlight = true;
  const running = executeTick().finally(() => {
    store.tickInFlight = false;
    store.inFlightTick = null;
  });
  store.inFlightTick = running;

  const decision = await running;
  // Do not return until the record is actually durable. On a serverless host
  // the instance can be frozen the instant the handler responds, and a journal
  // write still queued at that moment is a transaction with no evidence behind
  // it — the exact failure this project's autonomy claim cannot survive.
  await store.flushJournal();
  return { decision, coalesced: false };
}

/** The cycle itself. Only ever called through `runTick`'s guard. */
async function executeTick(): Promise<Decision> {
  const store = getStore();

  let snapshot: RunwaySnapshot;
  try {
    snapshot = await sense();
  } catch (error) {
    // A chain read failure is a first-class, recorded outcome — not a crash.
    const message = errorMessage(error);
    const failed: Decision = {
      id: newDecisionId(),
      at: Date.now(),
      snapshot: store.snapshot ?? unknownSnapshot(),
      ruleFired: null,
      action: "HOLD",
      reasoning:
        "Chain read failed, so the policy could not be evaluated against a current " +
        `reading. Holding rather than acting on stale data. ${message}`,
      outcome: "FAILED",
      error: message,
    };
    store.upsertDecision(failed);
    store.markTick(failed.at);
    store.publish({
      id: store.nextEventId(),
      at: Date.now(),
      type: "decision",
      decision: failed,
    });
    log("error", `Chain read failed: ${message}`);
    return failed;
  }

  let decision = evaluate(snapshot, ACTIVE_RULES);
  decision = applySpendCap(decision);

  store.upsertDecision(decision);
  store.markTick(decision.at);
  store.publish({
    id: store.nextEventId(),
    at: Date.now(),
    type: "decision",
    decision,
  });

  if (decision.action === "SAFETY_CAP") {
    // Declined by the agent itself. Nothing was submitted and nothing may be:
    // this is the decision, not a step on the way to one.
    log("warn", decision.reasoning);
    return decision;
  }

  if (decision.action === "INSUFFICIENT_FUNDS") {
    // The policy engine already established the wallet cannot cover this
    // deposit. Attempting it anyway would only manufacture a FAILED tx.
    log(
      "warn",
      `Deposit of ${decision.ruleFired?.topUpAmount ?? "0"} USDFC not attempted: wallet ` +
        `holds ${toFixedString(decision.snapshot.walletUsdfc, 2)} USDFC. Fund the agent ` +
        "wallet to let the policy act.",
    );
    return decision;
  }

  if (decision.action === "HOLD" || !decision.ruleFired) {
    return decision;
  }

  const amount = decision.ruleFired.topUpAmount;
  log("info", `Submitting deposit of ${amount} USDFC to Filecoin Pay...`);

  try {
    const adapter = getChainAdapter();
    const { txHash } = await adapter.deposit(amount);
    const explorerUrl = explorerMessageUrl(txHash);
    const tracksConfirmation = typeof adapter.waitForTransaction === "function";

    store.publish({
      id: store.nextEventId(),
      at: Date.now(),
      type: "tx",
      decisionId: decision.id,
      txHash,
      amountUsdfc: amount,
      status: tracksConfirmation ? "SUBMITTED" : "CONFIRMED",
      explorerUrl,
    });

    decision = { ...decision, outcome: "EXECUTED", txHash };
    // Count it against the cap the moment it reaches the chain, not when the
    // journal is next read: a burst of ticks inside one process must not be
    // able to outrun the cap simply by being faster than persistence.
    store.recordSpend({ id: decision.id, at: decision.at, amountUsdfc: amount });
    log(
      "info",
      tracksConfirmation
        ? `Deposit submitted: ${amount} USDFC (${txHash.slice(0, 12)}...)`
        : `Deposit confirmed: ${amount} USDFC (${txHash.slice(0, 12)}...)`,
    );

    if (tracksConfirmation) {
      // `waitForTransaction` is contractually non-throwing; the guard is belt
      // and braces so a misbehaving adapter cannot abort the tick.
      const result = await adapter
        .waitForTransaction!(txHash)
        .catch((error: unknown) => ({
          status: "FAILED" as const,
          error: errorMessage(error),
        }));

      store.publish({
        id: store.nextEventId(),
        at: Date.now(),
        type: "tx",
        decisionId: decision.id,
        txHash,
        amountUsdfc: amount,
        status: result.status,
        explorerUrl,
      });

      if (result.status === "FAILED") {
        const message = result.error ?? "Transaction failed to confirm";
        decision = { ...decision, outcome: "FAILED", error: message };
        // It did not stand, so it does not count. Keeps the cap's arithmetic
        // identical to the journal's, which counts EXECUTED decisions only.
        store.releaseSpend(decision.id);
        log("error", `Deposit of ${amount} USDFC did not confirm: ${message}`);
      } else {
        log("info", `Deposit confirmed onchain: ${amount} USDFC.`);
      }
    }
  } catch (error) {
    const message = errorMessage(error);
    decision = { ...decision, outcome: "FAILED", error: message };
    log("error", `Deposit of ${amount} USDFC failed: ${message}`);
  }

  store.upsertDecision(decision);
  store.publish({
    id: store.nextEventId(),
    at: Date.now(),
    type: "decision",
    decision,
  });

  // Re-read so the gauge immediately reflects the new balance.
  await sense().catch(() => log("warn", "Post-deposit snapshot read failed."));
  return decision;
}

/**
 * Prepare this process to answer a request about the agent.
 *
 * Two things, in order, and every route calls it in place of
 * `ensureAgentLoop()`:
 *
 *   1. Start the loop (or, under the cron driver, announce that there is not
 *      one) — unchanged behaviour, still idempotent.
 *   2. Make sure the durable record has actually been read, and re-read it if
 *      another process has written since.
 *
 * Locally both steps are free: the filesystem journal was read inside the
 * store's constructor, `ready` is already resolved and `refresh()` returns
 * immediately. Deployed, this is what turns five independent Function
 * instances into one agent with one history.
 */
export async function ensureAgentReady(): Promise<void> {
  ensureAgentLoop();
  const store = getStore();
  await store.ready;
  await store.refresh();
}

/**
 * Start the autonomous loop. Called lazily from the API routes so nothing
 * schedules timers during `next build`. Idempotent, and safe across hot reloads
 * because the guard lives on the globalThis-pinned store.
 *
 * THE DRIVER
 * ----------
 * Under the `interval` driver this is exactly what it always was: two timers
 * and an immediate first tick, owned by a process that stays alive.
 *
 * Under the `cron` driver it starts NOTHING. A Vercel Function exists for the
 * length of a request, so a timer set here would either never fire or fire
 * unobserved — and, worse, the immediate `runTick()` would mean that merely
 * READING the dashboard could cause the agent to spend. The cycle is driven
 * from outside instead, by a scheduled, authenticated call to `/api/tick`.
 * See `src/lib/deployment.ts` and `vercel.ts`.
 */
export function ensureAgentLoop(): void {
  const store = getStore();
  if (store.loopStarted) return;
  store.loopStarted = true;

  const driver = agentDriver();
  const interval = tickIntervalMs(TICK_INTERVAL_MS);

  log("info", `FilRunway agent online (${getChainAdapter().mode} mode).`);
  if (spendCapEnabled(getChainAdapter().mode)) {
    // Pinned, because it qualifies every deposit figure on the dashboard for as
    // long as the process runs, and because a viewer who arrives after a
    // SAFETY_CAP card needs to be able to see what limit it was that fired.
    // Raised only when the cap is actually in force — a MOCK run states nothing,
    // since claiming a limit that is not enforced would be worse than silence.
    notice("spend-cap", "info", describeLimits(spendLimits()));
  }
  if (store.journal.enabled) {
    // Where the record lives is already permanent on screen: `journalPath` on
    // AgentStatus backs the deposits tile's own "durable record" wording.
    log("info", `Decisions are journalled to ${store.journal.path}.`);
  } else {
    // Its ABSENCE is not surfaced anywhere else, and it qualifies every figure
    // on the dashboard, so it has to outlive the trace.
    notice(
      "journal-off",
      "warn",
      "Decision persistence is off; this session's decisions will not survive a restart.",
    );
  }
  if (DEMO_SCALED) {
    // Not pinned: the demo timescale is already disclosed permanently in three
    // places that cannot expire — the gauge header, every scaled rule label,
    // and every decision's own reasoning. See `src/lib/demo.ts`.
    log(
      "warn",
      `${DEMO_LABEL}: policy thresholds and gauge graduations are scaled. ` +
        "All displayed balances, burn rates and runway figures are real onchain readings.",
    );
  }
  if (!DEMO_SCALE_AGREEMENT.agree) {
    // The gauge is a client component and only sees NEXT_PUBLIC_*, so a
    // server-only scale makes the agent act on scaled thresholds while the gauge
    // still draws an unscaled axis. Say so rather than let the two drift — and
    // keep saying it, because a mismatch persists for the life of the process
    // and the gauge it contradicts is on screen the whole time.
    notice(
      "demo-scale-mismatch",
      "error",
      `Demo timescale mismatch: the agent runs at ×${DEMO_SCALE_AGREEMENT.server} but the ` +
        `browser gauge will draw ×${DEMO_SCALE_AGREEMENT.client}. Set ` +
        "NEXT_PUBLIC_FILRUNWAY_DEMO_SCALE (not just FILRUNWAY_DEMO_SCALE) so both agree.",
    );
  }

  if (driver === "cron") {
    // Pinned, not logged: a viewer arriving an hour in must still be able to
    // tell what is driving this agent. It is also the answer to "why is there
    // no RUN TICK button?", which is otherwise a silent difference from the
    // local build.
    notice(
      "driver-cron",
      "info",
      `Serverless deployment: the agent is driven by a scheduled call to /api/tick every ` +
        `${Math.round(interval / 1000)}s, not by a timer in this process. /api/tick requires ` +
        "the deployment's shared secret, so no visitor can make this agent spend.",
    );
    return;
  }

  setInterval(() => {
    void sense().catch(() => log("warn", "Snapshot read failed."));
  }, SENSE_INTERVAL_MS);

  setInterval(() => {
    void runTick().catch((error: unknown) => {
      log("error", `Tick failed: ${errorMessage(error)}`);
    });
  }, TICK_INTERVAL_MS);

  void runTick().catch(() => log("warn", "Initial tick failed."));
}
