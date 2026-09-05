/**
 * Durable, append-only decision journal.
 *
 * WHY THIS EXISTS
 * ---------------
 * `bootstrap -- fund 5` and an autonomous TOP_UP produce byte-identical
 * transactions on Filecoin Pay. Nothing on chain records which one made the
 * deposit. The ONLY evidence that the agent — rather than the operator's CLI —
 * authored a transaction is the `Decision` that preceded it: the reading it was
 * taken from, the rule that fired, the reasoning, and the tx hash it produced.
 *
 * `src/lib/store.ts` holds those decisions in a per-process ring buffer, so
 * that evidence died with the server. This file is the durable record behind
 * it: every decision, and every later status transition of that decision, is
 * appended as one JSON line to a file on disk. Nothing is ever rewritten or
 * deleted, so the file is a monotonic history rather than a mutable view.
 *
 * FORMAT
 * ------
 * JSON Lines (`.jsonl`): one `JournalRecord` per line, newline-terminated.
 *
 *   {"v":1,"seq":12,"writtenAt":1756800000000,"mode":"LIVE","decision":{…}}
 *
 * Each record embeds the WHOLE `Decision`, snapshot included, so any single
 * line stands on its own as an audit record and the file can be read with
 * `head`, `grep` or `jq` with no schema knowledge. Later lines for the same
 * `decision.id` supersede earlier ones on read (PENDING -> EXECUTED / FAILED),
 * and the earlier ones stay on disk as the proof of the transition.
 *
 * `mode` is stamped per record on purpose: a MOCK record must never be
 * mistakable for a LIVE one when the file is read back months later.
 *
 * MODE SEPARATION
 * ---------------
 * Stamping was only half the job. Two things now act on that stamp:
 *
 *   1. READS ARE SCOPED. `load()` returns only the records written in the
 *      journal's own mode, and reports what it left out (`byMode`) so the
 *      omission is disclosed rather than silent. A dashboard running LIVE
 *      therefore cannot total, list or replay a simulated decision, whatever
 *      is in the file.
 *   2. WRITES ARE SEPARATED BY DEFAULT. The default path is derived per mode —
 *      LIVE keeps `data/decisions.jsonl` (the evidentiary file, unmoved), MOCK
 *      goes to `data/decisions.mock.jsonl` — so a demo run cannot append
 *      simulated spend into the record that proves the agent's real
 *      transaction. An explicit `FILRUNWAY_DECISION_LOG` is still honoured
 *      verbatim for both modes; scoped reads keep even that shared file honest.
 *
 * Both matter. (2) prevents the problem for everything written from now on;
 * (1) is what makes an ALREADY mixed file — which cannot be rewritten, because
 * it is evidence — read correctly.
 *
 * FAILURE MODES (all non-fatal by design)
 * ---------------------------------------
 * A journal problem must never take down the agent loop or the server, so
 * every operation is wrapped and the journal simply switches itself off:
 *
 *   - unwritable / uncreatable directory  -> disabled at first append, reason
 *     kept in `lastError()`, agent continues in memory only
 *   - corrupt or half-written trailing line (a crash mid-append) -> skipped on
 *     load and counted in `skipped`; every well-formed line before it survives
 *   - concurrent appends -> `appendFileSync` in a single-threaded process
 *     completes before the next turn of the event loop runs, so lines can never
 *     interleave. Two *processes* sharing one file is out of scope; run the
 *     second with its own `FILRUNWAY_DECISION_LOG`.
 *
 * CONFIGURATION
 * -------------
 * `FILRUNWAY_DECISION_LOG` — path to the JSONL file. Unset, it is derived from
 * `FILRUNWAY_MODE`: `<cwd>/data/decisions.jsonl` in LIVE and
 * `<cwd>/data/decisions.mock.jsonl` in MOCK (both gitignored). Set explicitly
 * it is used verbatim in both modes. Set it to `off` to disable persistence
 * entirely and keep the old in-memory-only behaviour.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { AgentMode, Decision, DecisionTotals } from "./types";
import { addDecimal } from "./units";

/**
 * The slice of the environment this module reads. Deliberately a plain record
 * rather than `NodeJS.ProcessEnv`, which Next.js augments with required keys —
 * a caller (or a test) can hand over exactly the two variables that matter.
 */
export type JournalEnv = Record<string, string | undefined>;

/** Current line schema. Bump only for a breaking change to `JournalRecord`. */
export const JOURNAL_VERSION = 1 as const;

/**
 * Default LIVE location, relative to the process working directory.
 *
 * Deliberately unchanged: this file already holds the agent's real onchain
 * record, every reference to it (README, `.env.example`, an operator's shell
 * history) still resolves, and nothing about the existing evidence moves.
 */
export const DEFAULT_JOURNAL_PATH = "data/decisions.jsonl";

/**
 * Default MOCK location. Simulated spend is diverted here so it can never be
 * appended into the evidentiary file again.
 */
export const MOCK_JOURNAL_PATH = "data/decisions.mock.jsonl";

/** Which records a read wants. `null` means "every mode", for the ops CLI. */
export type JournalScope = AgentMode | null;

/** One decision as it was found on disk, with the mode that produced it. */
export interface JournalEntry {
  mode: AgentMode;
  decision: Decision;
}

/** How many distinct decisions a file holds per mode, BEFORE any scoping. */
export type ModeCounts = Record<AgentMode, number>;

/** One line of the journal. */
export interface JournalRecord {
  /** Line schema version. */
  v: typeof JOURNAL_VERSION;
  /** Append sequence within this file, 1-based. Gaps mean lost lines. */
  seq: number;
  /** Wall-clock ms when this line was appended (not when the decision was taken). */
  writtenAt: number;
  /** Adapter mode that produced the decision. MOCK records are not evidence. */
  mode: AgentMode;
  /** The decision exactly as it stood at this append. */
  decision: Decision;
  /**
   * Set only on a line COPIED out of another journal file by
   * `npm run decisions -- --split`: the file it was copied from, and when. The
   * decision itself is untouched, and the source file is never modified — this
   * says where the copy came from so the duplicate is self-explaining rather
   * than mysterious.
   */
  importedFrom?: string;
  importedAt?: number;
}

/** What a load found on disk, after scoping. */
export interface JournalLoad {
  /** Latest record per decision id IN SCOPE, newest first. */
  decisions: Decision[];
  /** The same list, carrying the mode each decision was recorded in. */
  entries: JournalEntry[];
  /** Aggregates over every in-scope decision, not just the slice the UI holds. */
  totals: DecisionTotals;
  /** Distinct decisions per mode found in the file, before scoping. */
  byMode: ModeCounts;
  /** The scope this load was taken at; `null` when every mode was included. */
  scope: JournalScope;
  /** Lines that could not be parsed (corruption, or a half-written tail). */
  skipped: number;
  /** Lines successfully read — ALL modes, so `seq` stays right. */
  read: number;
}

export interface DecisionJournal {
  /** Absolute path of the file, or null when persistence is off. */
  readonly path: string | null;
  /** The mode this journal stamps its writes with, and reads back by default. */
  readonly mode: AgentMode;
  /** False once disabled — either by configuration or by a write failure. */
  readonly enabled: boolean;
  /** Why the journal disabled itself, if it did. */
  readonly lastError: string | null;
  /**
   * Replay the file. Never throws: an unreadable file loads as empty.
   * Scoped to this journal's own mode unless another scope is asked for.
   */
  load(scope?: JournalScope): JournalLoad;
  /** Append one record. Never throws. */
  append(decision: Decision): void;

  /* ---------- remote journals only ---------- */

  /**
   * Whether `load()` alone is authoritative.
   *
   * True (or absent) for a journal backed by the local filesystem, which is
   * every journal this project had before it was deployable: the store
   * hydrates from it inside its own constructor and nothing has to wait.
   *
   * False for a journal whose records live somewhere that has to be fetched.
   * The store then hydrates through `loadAsync()` instead, and callers wait on
   * `AgentStore.ready` before trusting what they read.
   */
  readonly synchronous?: boolean;

  /**
   * Re-read the backing store. Never throws. Required when `synchronous` is
   * false; a synchronous journal has no reason to implement it.
   *
   * Also the refresh path: on a serverless host the tick that wrote the last
   * decision ran in a different process from the one now serving the
   * dashboard, and this is how the second one finds out. See
   * `AgentStore.refresh()`.
   */
  loadAsync?(scope?: JournalScope): Promise<JournalLoad>;

  /** Wait for queued writes to reach the store. Never throws. */
  flush?(): Promise<void>;
}

/** Zero mode counts. */
export function emptyModeCounts(): ModeCounts {
  return { MOCK: 0, LIVE: 0 };
}

/** The answer for an empty, absent or unreadable journal. */
export function emptyLoad(scope: JournalScope = null): JournalLoad {
  return {
    decisions: [],
    entries: [],
    totals: emptyTotals(),
    byMode: emptyModeCounts(),
    scope,
    skipped: 0,
    read: 0,
  };
}

/** Distinct decisions this load left out because they belong to another mode. */
export function hiddenByScope(load: JournalLoad): number {
  if (load.scope === null) return 0;
  return load.byMode.MOCK + load.byMode.LIVE - load.byMode[load.scope];
}

/** Zero totals — also the answer for an empty or absent journal. */
export function emptyTotals(): DecisionTotals {
  return { decisions: 0, executed: 0, depositedUsdfc: "0", firstAt: null, lastAt: null };
}

/**
 * Fold one decision into aggregate totals. Pure; returns a new object.
 *
 * `depositedUsdfc` sums the *rule's* `topUpAmount` over EXECUTED decisions,
 * which is exactly the amount the agent asked the chain to move. Deliberately
 * the same definition the dashboard tile already used when it derived this from
 * the current tab's state, so moving it server-side changes the SCOPE of the
 * figure and nothing else about how it is computed.
 */
export function accumulate(totals: DecisionTotals, decision: Decision): DecisionTotals {
  const executed = decision.outcome === "EXECUTED";
  return {
    decisions: totals.decisions + 1,
    executed: totals.executed + (executed ? 1 : 0),
    depositedUsdfc: executed
      ? addDecimal(totals.depositedUsdfc, decision.ruleFired?.topUpAmount ?? "0")
      : totals.depositedUsdfc,
    firstAt: totals.firstAt === null ? decision.at : Math.min(totals.firstAt, decision.at),
    lastAt: totals.lastAt === null ? decision.at : Math.max(totals.lastAt, decision.at),
  };
}

/** Fold a whole set of decisions, optionally onto an existing baseline. */
export function totalsFor(
  decisions: Iterable<Decision>,
  base: DecisionTotals = emptyTotals(),
): DecisionTotals {
  let totals = base;
  for (const decision of decisions) totals = accumulate(totals, decision);
  return totals;
}

/** Newest first, ties broken on id so the order is stable across reloads. */
function newestFirst(a: Decision, b: Decision): number {
  return b.at - a.at || b.id.localeCompare(a.id);
}

/**
 * Structural check for a line read back off disk. The file is plain text an
 * operator can edit, so a record is trusted only once it looks like one.
 */
function isJournalRecord(value: unknown): value is JournalRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<JournalRecord>;
  const decision = record.decision as Partial<Decision> | undefined;
  return (
    typeof decision === "object" &&
    decision !== null &&
    typeof decision.id === "string" &&
    decision.id !== "" &&
    typeof decision.at === "number" &&
    typeof decision.outcome === "string" &&
    typeof decision.snapshot === "object" &&
    decision.snapshot !== null
  );
}

/**
 * The mode a line claims. Anything that is not literally "LIVE" — including a
 * record written before `mode` existed — reads as MOCK. Downgrading an unknown
 * record is the only safe default: a line may not be promoted into evidence by
 * being unreadable.
 */
function recordMode(record: JournalRecord): AgentMode {
  return record.mode === "LIVE" ? "LIVE" : "MOCK";
}

/** Fold one file's text into `byId`, keeping the last record for each id. */
function collect(
  text: string,
  byId: Map<string, JournalEntry>,
): { read: number; skipped: number } {
  let skipped = 0;
  let read = 0;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A crash mid-append leaves exactly one truncated line, always the last.
      // Everything before it is still good, so skip and keep going.
      skipped += 1;
      continue;
    }
    if (!isJournalRecord(parsed)) {
      skipped += 1;
      continue;
    }
    read += 1;
    // Last write for an id wins: a decision only ever gains information.
    byId.set(parsed.decision.id, { mode: recordMode(parsed), decision: parsed.decision });
  }

  return { read, skipped };
}

/** Count, scope, sort and total a set of collected entries. */
function finalize(
  byId: Map<string, JournalEntry>,
  scope: JournalScope,
  read: number,
  skipped: number,
): JournalLoad {
  const byMode = emptyModeCounts();
  for (const entry of byId.values()) byMode[entry.mode] += 1;

  const entries = [...byId.values()]
    .filter((entry) => scope === null || entry.mode === scope)
    .sort((a, b) => newestFirst(a.decision, b.decision));
  const decisions = entries.map((entry) => entry.decision);

  return { decisions, entries, totals: totalsFor(decisions), byMode, scope, skipped, read };
}

/**
 * Parse JSONL text into the latest record per decision id.
 *
 * `scope` defaults to `null` — every mode — because this is the raw parser and
 * a caller that wants only its own mode says so. The journal instance below
 * defaults the other way round, which is the safe default for the app.
 */
export function parseJournal(text: string, scope: JournalScope = null): JournalLoad {
  const byId = new Map<string, JournalEntry>();
  const { read, skipped } = collect(text, byId);
  return finalize(byId, scope, read, skipped);
}

/** A file read that could not be completed, with the reason. */
export interface JournalFileError {
  path: string;
  error: string;
}

/** What reading several journal files at once found. */
export interface JournalFilesLoad extends JournalLoad {
  /** Files that were present and read. */
  files: string[];
  /** Files that could not be read. A missing file is NOT an error. */
  errors: JournalFileError[];
}

/**
 * Read and merge several journal files. Used by the ops CLI, which may be
 * asked for a mode other than the one this process runs as, and therefore for
 * a file this process does not itself write. Later paths win on a shared id.
 * Never throws.
 */
export function readJournalFiles(paths: string[], scope: JournalScope): JournalFilesLoad {
  const byId = new Map<string, JournalEntry>();
  const files: string[] = [];
  const errors: JournalFileError[] = [];
  let read = 0;
  let skipped = 0;

  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      // A journal that was never written is an absence, not a fault.
      if (code !== "ENOENT") errors.push({ path, error: errorMessage(error) });
      continue;
    }
    files.push(path);
    const counted = collect(text, byId);
    read += counted.read;
    skipped += counted.skipped;
  }

  return { ...finalize(byId, scope, read, skipped), files, errors };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** JSONL file journal. Construct via `createJournal()`. */
class FileDecisionJournal implements DecisionJournal {
  readonly path: string;
  readonly mode: AgentMode;
  /** The file is right here; `load()` is the whole story. */
  readonly synchronous = true;
  private on = true;
  private error: string | null = null;
  private seq = 0;

  constructor(path: string, mode: AgentMode) {
    this.path = path;
    this.mode = mode;
  }

  get enabled(): boolean {
    return this.on;
  }

  get lastError(): string | null {
    return this.error;
  }

  private disable(error: unknown): void {
    this.on = false;
    this.error = errorMessage(error);
  }

  /**
   * Scoped to this journal's own mode by default. That default is the whole
   * point: a LIVE server replaying a file that also holds MOCK lines gets its
   * own history back and nothing else, so neither the totals tile nor the
   * decision feed can present simulated spend as real.
   */
  load(scope: JournalScope = this.mode): JournalLoad {
    try {
      const text = readFileSync(this.path, "utf8");
      const result = parseJournal(text, scope);
      // Continue the sequence rather than restarting it, so `seq` stays
      // monotonic across restarts and a gap is visible as a gap. Counted over
      // every line in the file, not just the in-scope ones.
      this.seq = result.read + result.skipped;
      return result;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      // No file yet is the normal first-run case, not a failure.
      if (code !== "ENOENT") this.error = errorMessage(error);
      return emptyLoad(scope);
    }
  }

  append(decision: Decision): void {
    if (!this.on) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      this.seq += 1;
      const record: JournalRecord = {
        v: JOURNAL_VERSION,
        seq: this.seq,
        writtenAt: Date.now(),
        mode: this.mode,
        decision,
      };
      // Synchronous on purpose: it completes before the event loop turns, so
      // two decisions written in the same tick cannot interleave their bytes.
      appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
    } catch (error) {
      this.disable(error);
    }
  }
}

/** A journal that persists nothing. Used when persistence is switched off. */
export function nullJournal(mode: AgentMode = "MOCK"): DecisionJournal {
  return {
    path: null,
    mode,
    enabled: false,
    lastError: null,
    synchronous: true,
    load: (scope: JournalScope = mode) => emptyLoad(scope),
    append: () => undefined,
  };
}

/**
 * The adapter mode this environment selects.
 *
 * Mirrors `getChainMode()` in `src/lib/chain`; it is read straight from the
 * environment here so the journal (and the CLI that reads it) never pulls in
 * the chain adapters or the Synapse SDK.
 */
export function journalMode(env: JournalEnv = process.env): AgentMode {
  return env.FILRUNWAY_MODE === "live" ? "LIVE" : "MOCK";
}

/**
 * Where a given mode's journal lives. Returns null when persistence is off.
 *
 * An explicit `FILRUNWAY_DECISION_LOG` is honoured verbatim for BOTH modes —
 * an operator who names a file means that file, and pointing two modes at one
 * file is still safe because every read is scoped. Unset, the path is derived
 * per mode so the two streams cannot mix in the first place.
 */
export function journalPathFor(
  mode: AgentMode,
  env: JournalEnv = process.env,
): string | null {
  const raw = env.FILRUNWAY_DECISION_LOG?.trim();
  if (raw && raw.toLowerCase() === "off") return null;
  const relative =
    raw && raw !== "" ? raw : mode === "LIVE" ? DEFAULT_JOURNAL_PATH : MOCK_JOURNAL_PATH;
  // turbopackIgnore: the path is resolved at RUNTIME from the environment, so
  // there is nothing here for the bundler to trace. Without the marker the
  // dynamic argument makes Turbopack include the whole project in the server
  // output "just in case".
  return resolve(/* turbopackIgnore: true */ process.cwd(), relative);
}

/**
 * Resolve this process's journal path. Returns null when persistence is off.
 * Exported so the ops CLI reports the same path the server writes.
 */
export function journalPath(env: JournalEnv = process.env): string | null {
  return journalPathFor(journalMode(env), env);
}

/** Both modes' paths, de-duplicated, for a reader that wants everything. */
export function journalPaths(env: JournalEnv = process.env): string[] {
  const paths = [journalPathFor("LIVE", env), journalPathFor("MOCK", env)];
  return [...new Set(paths.filter((path): path is string => path !== null))];
}

/** The journal this process should use. */
export function createJournal(env: JournalEnv = process.env): DecisionJournal {
  const mode = journalMode(env);
  const path = journalPathFor(mode, env);
  if (path === null) return nullJournal(mode);
  return new FileDecisionJournal(path, mode);
}
