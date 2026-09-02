/**
 * Agent store: a fast in-memory view in front of a durable journal.
 *
 * The ring buffers below are the hot path — they back the SSE stream and the
 * dashboard, and they stay bounded so a long-running server cannot grow without
 * limit. They are still per-process and still die with the server.
 *
 * What no longer dies with the server is the RECORD. Every decision, and every
 * later status transition of it, is appended to `src/lib/journal.ts` before it
 * reaches the ring, and the ring is rehydrated from that journal on start. The
 * cap therefore bounds what the UI holds and nothing else: the journal keeps
 * every line, and `totals` covers the whole of it — a decision that has aged
 * out of the ring is folded into `baseline` on the way out, never dropped.
 *
 * Persistence is best-effort by construction. A journal that cannot be written
 * disables itself, publishes one warning, and the agent carries on in memory —
 * exactly the behaviour this file had before the journal existed.
 *
 * NOTICES vs EVENTS
 * -----------------
 * `events` is a rolling window and `backlog()` replays only its tail, so a
 * message published at startup is unreachable to a browser that connects a few
 * minutes later. Most startup lines can afford that. The ones that DISCLOSE
 * something cannot: "N MOCK decisions in this file were not restored" is the
 * only place a viewer learns that records exist and were withheld, and it used
 * to expire silently. Those facts are therefore held in `notices` as state and
 * republished per connection. See `AgentNotice` in `src/lib/types.ts`.
 */

import { mergeDecisions } from "./decisions";
import {
  createJournal,
  emptyTotals,
  hiddenByScope,
  totalsFor,
  type DecisionJournal,
  type JournalLoad,
} from "./journal";
import type {
  AgentEvent,
  AgentNotice,
  Decision,
  DecisionTotals,
  LogLevel,
  RunwaySnapshot,
} from "./types";

/** How many decisions the in-memory ring holds. Does NOT bound the journal. */
export const MAX_DECISIONS = 200;
const MAX_EVENTS = 400;

type Subscriber = (event: AgentEvent) => void;

class AgentStore {
  snapshot: RunwaySnapshot | null = null;
  decisions: Decision[] = [];
  events: AgentEvent[] = [];
  lastTickAt: number | null = null;
  tickInFlight = false;
  /**
   * The tick currently running, if any. A caller that arrives while a tick is
   * in flight, and has no completed decision that could be shown instead, can
   * await this rather than being handed nothing. See `runTick()` in `agent.ts`.
   */
  inFlightTick: Promise<Decision> | null = null;
  loopStarted = false;
  /**
   * Standing disclosures, oldest first. Append-only and deduplicated by key.
   *
   * These are the facts that must reach a viewer whenever they arrive, so they
   * live here as STATE rather than only as trace lines: `events` is a rolling
   * window that a few minutes of ticks empties completely. See `AgentNotice`.
   */
  notices: AgentNotice[] = [];

  readonly journal: DecisionJournal;

  private subscribers = new Set<Subscriber>();
  private seq = 0;
  /**
   * Totals for decisions that are no longer in the ring: journal history older
   * than the cap, plus anything evicted since. Their outcomes are final, so
   * folding them in once is exact.
   */
  private baseline: DecisionTotals = emptyTotals();

  constructor(journal: DecisionJournal = createJournal()) {
    this.journal = journal;
  }

  /**
   * Whole-history aggregates: the settled baseline plus the live ring. Derived
   * rather than incremented, so an outcome flipping PENDING -> EXECUTED inside
   * the ring can never leave a stale count behind.
   */
  get totals(): DecisionTotals {
    return totalsFor(this.decisions, this.baseline);
  }

  nextEventId(): string {
    this.seq += 1;
    return `evt_${this.seq.toString(36)}_${Date.now().toString(36)}`;
  }

  /**
   * Replay the durable journal into the ring. Called once, when the store is
   * created. Returns a line for the agent trace, or null when there was nothing
   * to say. Never throws — the journal swallows its own I/O errors.
   *
   * The load is SCOPED to the journal's own mode (see `src/lib/journal.ts`), so
   * a LIVE process replaying a file that also holds MOCK lines restores its own
   * history and nothing else. That is what keeps the AUTONOMOUS DEPOSITS tile
   * and the decision feed from presenting simulated spend as real. Records left
   * out are counted in the restore line rather than silently dropped.
   */
  hydrate(): { level: LogLevel; message: string } | null {
    const loaded = this.journal.load();
    if (loaded.read === 0 && loaded.skipped === 0) {
      if (this.journal.lastError === null) return null;
      const message = `Decision log unreadable (${this.journal.lastError}); continuing in memory only.`;
      // A record that could not be read is an omission too, and it outlives the
      // trace line just as the withheld-records disclosure does.
      this.addNotice({ key: "journal-unreadable", level: "warn", message });
      return { level: "warn", message };
    }

    // `mergeDecisions` orders exactly the way the journal load does, so the
    // ring is the newest slice and everything past the cap is settled history.
    this.decisions = mergeDecisions([], loaded.decisions, MAX_DECISIONS);
    this.baseline = totalsFor(loaded.decisions.slice(MAX_DECISIONS));
    this.lastTickAt = loaded.totals.lastAt;

    const skipped =
      loaded.skipped > 0
        ? ` ${loaded.skipped} unreadable line${loaded.skipped === 1 ? "" : "s"} skipped.`
        : "";
    // Say what was left out and where to read it. An omission a viewer cannot
    // see is indistinguishable from a file that never held those records.
    const hidden = hiddenByScope(loaded);
    const other = this.journal.mode === "LIVE" ? "MOCK" : "LIVE";
    const excluded =
      hidden > 0
        ? ` ${hidden} ${other} decision${hidden === 1 ? "" : "s"} in this file ` +
          `${hidden === 1 ? "was" : "were"} not restored (this process is ` +
          `${this.journal.mode}); read ${hidden === 1 ? "it" : "them"} with ` +
          `\`npm run decisions -- --mode ${other.toLowerCase()}\`.`
        : "";
    // The same facts again, but as standing disclosures rather than one line
    // that ages out of the trace within minutes of boot.
    this.discloseOmissions(loaded);

    const count = loaded.decisions.length;
    return {
      level: "info",
      message:
        `Restored ${count} ${this.journal.mode} decision${count === 1 ? "" : "s"} from ` +
        `${this.journal.path} (${loaded.totals.executed} executed, ` +
        `${loaded.totals.depositedUsdfc} USDFC deposited).${skipped}${excluded}`,
    };
  }

  /**
   * Pin what this load LEFT OUT, so it stays visible to a viewer who connects
   * hours later rather than only to one watching the boot messages scroll past.
   *
   * Deliberately raised only when there is genuinely something to disclose. A
   * journal holding nothing but this mode's own records, read without a single
   * bad line, produces no notice at all — the dashboard must never imply
   * withheld records that do not exist.
   */
  private discloseOmissions(loaded: JournalLoad): void {
    const hidden = hiddenByScope(loaded);
    if (hidden > 0) {
      const other = this.journal.mode === "LIVE" ? "MOCK" : "LIVE";
      const plural = hidden === 1 ? "" : "s";
      this.addNotice({
        key: "journal-withheld",
        level: "info",
        message:
          `${hidden} ${other} decision${plural} in ${this.journal.path} ` +
          `${hidden === 1 ? "is" : "are"} withheld from this ${this.journal.mode} view. ` +
          `Read ${hidden === 1 ? "it" : "them"} with ` +
          `\`npm run decisions -- --mode ${other.toLowerCase()}\`.`,
      });
    }

    if (loaded.skipped > 0) {
      const plural = loaded.skipped === 1 ? "" : "s";
      this.addNotice({
        key: "journal-skipped",
        level: "warn",
        message:
          `${loaded.skipped} unreadable line${plural} in ${this.journal.path} ` +
          `${loaded.skipped === 1 ? "was" : "were"} skipped and ${loaded.skipped === 1 ? "is" : "are"} ` +
          "not counted anywhere on this dashboard.",
      });
    }
  }

  /**
   * Record a standing disclosure and republish the whole set.
   *
   * Idempotent by `key`: raising the same notice twice — a repeated write
   * failure, a second hydrate — changes nothing and publishes nothing, so a
   * disclosure can never turn into a stream of repeated lines.
   */
  addNotice(notice: AgentNotice): void {
    if (this.notices.some((existing) => existing.key === notice.key)) return;
    this.notices = [...this.notices, notice];
    this.publishNotices();
  }

  /** Push the current disclosure set to every connected client. */
  publishNotices(): void {
    this.publish({
      id: this.nextEventId(),
      at: Date.now(),
      type: "notices",
      notices: this.notices,
    });
  }

  setSnapshot(snapshot: RunwaySnapshot): void {
    this.snapshot = snapshot;
  }

  /**
   * Insert or replace a decision by id, newest first, and append it to the
   * durable journal.
   *
   * The journal write comes FIRST and is not conditional on the ring: the
   * record is the point, the ring is only the view. Republishes totals so an
   * open tab never has to re-derive them from the cards it happens to hold.
   */
  upsertDecision(decision: Decision): void {
    this.appendToJournal(decision);

    const existing = this.decisions.findIndex((d) => d.id === decision.id);
    if (existing >= 0) {
      this.decisions[existing] = decision;
    } else {
      this.decisions.unshift(decision);
      if (this.decisions.length > MAX_DECISIONS) {
        // Fold the evicted tail into the settled baseline instead of losing it.
        this.baseline = totalsFor(this.decisions.slice(MAX_DECISIONS), this.baseline);
        this.decisions.length = MAX_DECISIONS;
      }
    }

    this.publishTotals();
  }

  /**
   * Append to the journal, and say so once if the journal gives up. A
   * persistence failure degrades the agent to in-memory; it never stops it.
   */
  private appendToJournal(decision: Decision): void {
    if (!this.journal.enabled) return;
    this.journal.append(decision);
    if (!this.journal.enabled) {
      const message =
        `Decision log write failed (${this.journal.lastError}); continuing in memory only. ` +
        "Decisions from here on will not survive a restart.";
      this.publish({
        id: this.nextEventId(),
        at: Date.now(),
        type: "log",
        level: "warn",
        message,
      });
      // Losing durability is not a passing event: every decision taken from
      // here on is unbacked, so it has to stay on screen rather than scroll by.
      this.addNotice({ key: "journal-write-failed", level: "warn", message });
    }
  }

  markTick(at: number): void {
    this.lastTickAt = at;
  }

  publish(event: AgentEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        // A broken SSE consumer must never take the agent loop down.
      }
    }
  }

  /** Push the current whole-history aggregates to every connected client. */
  publishTotals(): void {
    this.publish({
      id: this.nextEventId(),
      at: Date.now(),
      type: "totals",
      totals: this.totals,
    });
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /**
   * Events to replay to a client that just connected.
   *
   * A ROLLING TAIL, deliberately: an arriving tab wants recent activity, not
   * the whole session. Nothing that must survive the session may depend on it
   * — put that in `notices` (or `totals`), which the stream sends in full.
   */
  backlog(limit = 40): AgentEvent[] {
    return this.events.slice(-limit);
  }
}

export type { AgentStore };

const STORE_KEY = Symbol.for("filrunway.store");
type GlobalWithStore = typeof globalThis & { [STORE_KEY]?: AgentStore };

function createStore(journal?: DecisionJournal): AgentStore {
  const store = new AgentStore(journal);
  const note = store.hydrate();
  if (note) {
    store.publish({
      id: store.nextEventId(),
      at: Date.now(),
      type: "log",
      level: note.level,
      message: note.message,
    });
  }
  return store;
}

export function getStore(): AgentStore {
  const g = globalThis as GlobalWithStore;
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = createStore();
  }
  return g[STORE_KEY];
}

/**
 * Test/demo hook: replace the process-wide store, optionally with a journal of
 * your own. Pass `nullJournal()` to keep a test off the filesystem entirely.
 */
export function resetStore(journal?: DecisionJournal): AgentStore {
  const g = globalThis as GlobalWithStore;
  const store = createStore(journal);
  g[STORE_KEY] = store;
  return store;
}
