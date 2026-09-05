/**
 * FilRunway domain contract.
 *
 * These types are the ONLY thing shared between the chain layer
 * (`src/lib/chain`, mock today / Synapse SDK tomorrow) and everything above it
 * (policy engine, API routes, dashboard). Changing a field here is a breaking
 * change for both sides — treat this file as the interface boundary.
 *
 * Money is always a decimal STRING in whole USDFC (e.g. "11.335680"), never a
 * float and never wei. Convert with `src/lib/units.ts`. Timestamps are
 * `Date.now()` milliseconds. Epochs are Filecoin chain epochs (30s each).
 */

/** A single reading of the agent's own Filecoin Pay position. */
export interface RunwaySnapshot {
  /** Wall-clock ms when this reading was taken. */
  takenAt: number;
  /** Filecoin chain epoch the reading refers to. */
  epoch: number;
  /** Unlocked USDFC in Filecoin Pay, available to cover future lockup. */
  fundsAvailable: string;
  /** USDFC burned per epoch by active storage commitments (the burn rate). */
  lockupRate: string;
  /** USDFC currently locked against existing commitments. */
  lockupCurrent: string;
  /**
   * Epochs of runway left. In LIVE mode this is a first-class on-chain read —
   * `summary.runwayInEpochs` straight off Filecoin Pay via
   * `payments.accountSummary()` — not arithmetic we perform. Only
   * `MockChainAdapter` derives it as `floor(fundsAvailable / lockupRate)`.
   * Two sentinel readings: `maxUint256` (zero burn rate, unbounded runway) is
   * mapped to `UNBOUNDED_EPOCHS`, and `0n` (account in deficit) stays `0`.
   */
  epochsRemaining: number;
  /** epochsRemaining / 2880. The headline number. */
  daysRemaining: number;
  /** USDFC sitting in the agent's wallet, i.e. what it can still deposit. */
  walletUsdfc: string;
  /** FIL sitting in the agent's wallet, i.e. whether it can still pay gas. */
  walletFil: string;
  /**
   * PDP proof state for every data set the burn rate is paying for, as read at
   * this epoch. See `ProofSnapshot`.
   *
   * OPTIONAL, and the three states are all different:
   *   - `undefined` — no proof reading was attached to this snapshot (a bare
   *     gauge read, an older journalled decision, a test fixture). The policy
   *     engine says nothing about proofs.
   *   - `{ dataSets: [] }` — read successfully; the account pays for nothing.
   *   - populated — read successfully; judge each entry on its own `readable`.
   *
   * Never a summary of "how healthy storage is": it is the raw per-data-set
   * reading, and `unreadable` is carried beside `delinquent` precisely so a
   * failed read can never be collapsed into a delinquency.
   */
  proof?: ProofSnapshot;
}

/**
 * One data set's PDP proof obligation, as read from PDPVerifier + the Warm
 * Storage state view.
 *
 * THE ONE RULE THIS TYPE EXISTS TO ENFORCE
 * ----------------------------------------
 * `isDelinquent` is true ONLY when every field the judgement rests on was
 * actually returned by a contract call. An RPC timeout, a reverted read, a
 * proving period that was never initialised — all of those set `readable:
 * false` and `isDelinquent: false`, with `unknownReason` saying which call did
 * not answer. The agent may terminate a data set on this flag, so treating an
 * unread field as a missed proof would mean destroying data on a network
 * hiccup. See `classifyProofState()` in `src/lib/proof.ts`.
 */
export interface DataSetProofState {
  /** PDPVerifier / Warm Storage data set id. The same id in SDK 1.2.1. */
  dataSetId: string;
  /** `PDPVerifier.dataSetLive`. */
  isLive: boolean | null;
  /** `PDPVerifier.getDataSetLastProvenEpoch`. */
  lastProvenEpoch: number | null;
  /** `PDPVerifier.getNextChallengeEpoch`. Informational only. */
  nextChallengeEpoch: number | null;
  /** `FilecoinWarmStorageServiceStateView.provingDeadline`. */
  provingDeadline: number | null;
  /** `FilecoinWarmStorageServiceStateView.provenThisPeriod`. */
  provenThisPeriod: boolean | null;
  /** True when every field the delinquency judgement needs was read. */
  readable: boolean;
  /** Why the state is not decisive. Null if and only if `readable`. */
  unknownReason: string | null;
  /** Epochs past `provingDeadline` at the reading epoch, or null when unknown. */
  epochsOverdue: number | null;
  /** Live, past its proving deadline, unproven this period — and READ. */
  isDelinquent: boolean;
}

/** Every data set's proof state at one chain epoch. */
export interface ProofSnapshot {
  /** The chain epoch the deadlines were compared against. */
  epoch: number;
  dataSets: DataSetProofState[];
  /** Data sets whose decisive proof fields could not be read. */
  unreadable: number;
  /** Data sets confirmed delinquent. Never includes an unreadable one. */
  delinquent: number;
  /**
   * Why NO per-data-set state exists at all — the storage listing itself
   * failed. Null on a successful reading.
   *
   * Distinct from `dataSets: []`, which is the very different claim that the
   * account pays for nothing. A decision must never say "no data sets" when
   * what actually happened is "we could not look".
   */
  listingError?: string | null;
}

/** What a policy rule is allowed to ask for. */
export type PolicyAction = "TOP_UP" | "EMERGENCY_TOP_UP" | "HOLD";

/**
 * What the agent actually decided — a superset of `PolicyAction`.
 *
 * A rule can only ask for TOP_UP / EMERGENCY_TOP_UP / HOLD. Two further
 * conclusions are the agent's own, and both DECLINE to transact with a stated
 * reason rather than failing:
 *
 *   - INSUFFICIENT_FUNDS — the rule fired and the wallet cannot cover the
 *     deposit it calls for, so nothing is attempted.
 *   - SAFETY_CAP — the rule fired and the wallet could cover it, but the agent
 *     has already made as many (or as large) deposits as its own rolling
 *     24-hour limit allows. See `src/lib/spendGuard.ts`.
 *
 * Both carry outcome NO_ACTION. Neither is a failed transaction: recognising a
 * constraint and saying so is a decision, and it is recorded as one.
 */
export type DecisionAction =
  | PolicyAction
  | "INSUFFICIENT_FUNDS"
  | "SAFETY_CAP"
  | "PRUNE_DATASET";

/**
 * What a `PRUNE_DATASET` decision is about — the data set the agent judged not
 * worth paying for, and the arithmetic behind cutting it instead of funding it.
 *
 * Carried on the Decision (and therefore journalled with it) so the record of
 * an irreversible action names its subject and its justification, rather than
 * leaving both buried in prose.
 */
export interface PruneTarget {
  /** The data set the agent decided to stop paying for. */
  dataSetId: string;
  /** Epochs past its proving deadline at the deciding reading. */
  epochsOverdue: number;
  /** Live data sets at the deciding reading, this one included. */
  liveDataSets: number;
  /** The top-up the rule called for and which was NOT made on this reading. */
  deferredTopUpAmount: string;
  /**
   * That top-up re-sized over the rails that survive the cut, pro-rata by rail
   * COUNT. A bound, not a measurement: Filecoin Pay reports one aggregate
   * `lockupRatePerEpoch` for the account and no per-rail split, so the exact
   * post-termination rate is only knowable from the next reading. The decision
   * text says so wherever this number appears.
   */
  resizedTopUpAmount: string;
  /**
   * False when this deployment's opt-in is off. The decision is still made and
   * still recorded; only its execution is withheld. See `src/lib/eviction.ts`.
   */
  executionEnabled: boolean;
}

/**
 * One line of the agent's policy. Rules are evaluated lowest-threshold-first;
 * the first rule whose `thresholdDays` the runway has fallen below wins.
 */
export interface PolicyRule {
  id: string;
  label: string;
  /** Fires when `snapshot.daysRemaining < thresholdDays`. */
  thresholdDays: number;
  action: PolicyAction;
  /** USDFC to deposit when this rule fires. "0" for HOLD. */
  topUpAmount: string;
}

export type DecisionOutcome = "PENDING" | "EXECUTED" | "FAILED" | "NO_ACTION";

/** The audit record for one sense -> decide (-> act) cycle. */
export interface Decision {
  id: string;
  at: number;
  snapshot: RunwaySnapshot;
  ruleFired: PolicyRule | null;
  action: DecisionAction;
  /** Human-readable justification, citing the actual numbers. */
  reasoning: string;
  outcome: DecisionOutcome;
  txHash?: string;
  error?: string;
  /** Present only on `PRUNE_DATASET`. See `PruneTarget`. */
  target?: PruneTarget;
}

/**
 * Aggregates over the agent's WHOLE recorded history, computed server-side from
 * the durable decision journal (`src/lib/journal.ts`) plus anything decided
 * since this process started.
 *
 * The dashboard used to derive these from the decisions held in one browser
 * tab, which made the AUTONOMOUS DEPOSITS tile session-scoped: it read zero on
 * a page opened after the deposit, and two tabs opened at different times
 * disagreed with each other. These figures are identical for every client
 * because they are the server's, and they survive a restart because the
 * journal does.
 */
export interface DecisionTotals {
  /** Decisions ever recorded. */
  decisions: number;
  /** Decisions whose deposit was executed on chain. */
  executed: number;
  /** Sum of `ruleFired.topUpAmount` over EXECUTED decisions, decimal USDFC. */
  depositedUsdfc: string;
  /** `at` of the oldest recorded decision, or null when there are none. */
  firstAt: number | null;
  /** `at` of the newest recorded decision, or null when there are none. */
  lastAt: number | null;
}

export type TxStatus = "SUBMITTED" | "CONFIRMED" | "FAILED";
export type LogLevel = "info" | "warn" | "error";

/**
 * A standing fact about this process that a viewer must be able to see
 * WHENEVER they arrive — not only if they happened to be watching when it was
 * first said.
 *
 * The AGENT TRACE is a rolling window: the server replays a bounded backlog on
 * connect and the dashboard holds a handful of lines. Ticks push events through
 * it continuously, so anything logged at startup is gone within minutes. That
 * is fine for "tick failed" and fatal for the startup lines that DISCLOSE
 * something — chiefly that the journal holds records of the other mode which
 * were deliberately withheld from this view. An omission a viewer cannot see is
 * indistinguishable from a file that never held those records, which is exactly
 * the property this project's honesty framing rests on.
 *
 * So a notice is STATE, not an event. It is carried on `AgentStatus` (seen by
 * every hydrate) and republished as a `notices` event (seen by every stream
 * connection, at any age). Notices are append-only and identified by `key`, so
 * recording one twice is a no-op and a reconnect replaces the set rather than
 * appending a line — a disclosure can never decay into repeated noise.
 *
 * A notice is only ever raised for something that IS true. Nothing withheld
 * means no notice at all; the absence of a claim is never itself a claim.
 */
export interface AgentNotice {
  /** Stable identity, e.g. "journal-withheld". Recording a key twice is a no-op. */
  key: string;
  level: LogLevel;
  message: string;
}

interface AgentEventBase {
  id: string;
  at: number;
}

/** Everything pushed over `/api/stream` as Server-Sent Events. */
export type AgentEvent =
  | (AgentEventBase & { type: "snapshot"; snapshot: RunwaySnapshot })
  | (AgentEventBase & { type: "decision"; decision: Decision })
  | (AgentEventBase & {
      type: "tx";
      decisionId: string;
      txHash: string;
      amountUsdfc: string;
      status: TxStatus;
      explorerUrl: string;
    })
  | (AgentEventBase & { type: "log"; level: LogLevel; message: string })
  /**
   * Whole-history aggregates, republished whenever they change so an open tab
   * never has to re-derive them from the decisions it happens to be holding.
   */
  | (AgentEventBase & { type: "totals"; totals: DecisionTotals })
  /**
   * The WHOLE current set of standing disclosures, not one addition. Sent at
   * the end of every stream connect and republished whenever the set grows, so
   * a client always REPLACES its copy. That is what keeps a reconnect from
   * appending the same line again. See `AgentNotice`.
   */
  | (AgentEventBase & { type: "notices"; notices: AgentNotice[] });

export type AgentEventType = AgentEvent["type"];

/** A payload the agent has parked on Filecoin via Synapse / PDP. */
export interface StoredItem {
  id: string;
  name: string;
  sizeBytes: number;
  pieceCid: string;
  dataSetId?: string;
  uploadedAt: number;
}

/**
 * One Warm Storage data set the agent is paying PDP + storage fees on.
 *
 * This is the authoritative, chain-read answer to "what is the burn rate
 * actually buying?" — `StoredItem` only records uploads performed by the
 * running process, which is empty on any freshly started server.
 */
export interface StoredDataSet {
  /** Warm Storage data set id — the id the payment rails are keyed on. */
  id: string;
  /** PDPVerifier data set id — what the proofs of possession are filed against. */
  pdpId: string;
  /** Service provider address holding this copy. */
  provider: string;
  /** Bytes stored in this data set, or null when the size read was unavailable. */
  sizeBytes: number | null;
  isLive: boolean;
  withCDN: boolean;
  /**
   * Piece CIDs currently active in this data set (possibly truncated to a page).
   * Empty means none were readable, NEVER that a placeholder should be shown.
   */
  pieceCids: string[];
  /**
   * PDP proof obligation for this data set.
   *
   * Lives here rather than on a separate read so the STORED DATA panel and the
   * policy engine can never disagree about whether a data set is proving: the
   * agent builds `RunwaySnapshot.proof` out of exactly these values. See
   * `proofSnapshotFrom()` in `src/lib/proof.ts`.
   */
  proof: DataSetProofState;
}

/** Everything the agent is currently paying to store. */
export interface StorageListing {
  /** Wall-clock ms when this listing was read. */
  takenAt: number;
  dataSets: StoredDataSet[];
  /** Total bytes across the agent's data sets, or null when unreadable. */
  totalSizeBytes: number | null;
  /** Uploads performed by THIS process, if any. Enriches names and sizes. */
  items: StoredItem[];
}

export type AgentMode = "MOCK" | "LIVE";

/** Operational context the dashboard needs but that is not part of a reading. */
export interface AgentStatus {
  mode: AgentMode;
  address: string;
  tickIntervalMs: number;
  lastTickAt: number | null;
  nextTickAt: number | null;
  /** Whole-history aggregates. See `DecisionTotals`. */
  totals: DecisionTotals;
  /**
   * Absolute path of the durable decision journal, or null when persistence is
   * off or has disabled itself after a write failure. Surfaced so an operator
   * can tell at a glance whether the record on screen is backed by a file.
   */
  journalPath: string | null;
  /**
   * Standing disclosures for this process, oldest first. Empty when there is
   * nothing to disclose. See `AgentNotice` for why these are status rather
   * than trace lines.
   */
  notices: AgentNotice[];
}

/* ---------- API response envelopes ---------- */

export interface SnapshotResponse {
  snapshot: RunwaySnapshot;
  status: AgentStatus;
}

export interface DecisionsResponse {
  decisions: Decision[];
  status: AgentStatus;
}

export interface StorageResponse {
  storage: StorageListing;
  status: AgentStatus;
}

export interface TickResponse {
  decision: Decision;
  status: AgentStatus;
  /**
   * True when a tick was already in flight and this is NOT a decision taken for
   * this request. Without it a coalesced response is indistinguishable from a
   * fresh one, and a caller would read a previous decision as the answer to the
   * tick it just asked for. See `runTick()` in `src/lib/agent.ts`.
   */
  coalesced: boolean;
}

/**
 * The result of the operator's SQUEEZE RUNWAY control.
 *
 * NOT a decision, and deliberately not shaped like one. A withdrawal from
 * Filecoin Pay back to the wallet is a HUMAN action that manufactures the
 * crisis; the agent's response to it on the next tick is the autonomous part.
 * Conflating the two would be the single most misleading thing this dashboard
 * could do, so the squeeze produces its own envelope, its own trace lines and
 * no `Decision` at all.
 */
export interface SqueezeResponse {
  /** USDFC actually withdrawn, after clamping to the configured bound. */
  amountUsdfc: string;
  txHash: string;
  explorerUrl: string;
  /** The reading taken immediately before the withdrawal. */
  before: RunwaySnapshot;
  /** The reading taken immediately after it, or null if that read failed. */
  after: RunwaySnapshot | null;
}

export interface ApiError {
  error: string;
}
