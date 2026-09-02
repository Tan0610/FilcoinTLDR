/**
 * Mode selection for readers of the decision journal.
 *
 * The journal stamps every record MOCK or LIVE. `src/lib/journal.ts` acts on
 * that stamp when it loads; this file holds the small amount of policy a
 * READER needs on top of it, kept pure so the ops CLI's honesty properties can
 * be tested without spawning a terminal:
 *
 *   - what `--mode` was asked for, and what it defaults to;
 *   - which entries may appear as EVIDENCE (a LIVE record with a tx hash, and
 *     nothing else — a simulated hash beside a real one is exactly the
 *     misrepresentation the journal exists to prevent);
 *   - which entries are simulated hashes, so they can be shown under their own
 *     unmistakable heading rather than silently dropped;
 *   - what a given scope is hiding, so the CLI can say so instead of quietly
 *     omitting records an operator might be looking for.
 */

import type { JournalEntry, JournalScope, ModeCounts } from "./journal";
import type { AgentMode } from "./types";

/** What `--mode` accepts. `ALL` reads both, labelled. */
export type ModeArg = AgentMode | "ALL";

export const MODE_ARGS: readonly string[] = ["live", "mock", "all"];

/**
 * Parse a `--mode` value. Anything unrecognised is an error rather than a
 * silent fallback: a typo that quietly widened the scope back to "everything"
 * would reintroduce the mixed listing this exists to remove.
 */
export function parseModeArg(
  raw: string | undefined,
  fallback: AgentMode,
): { scope: ModeArg; error?: undefined } | { scope?: undefined; error: string } {
  if (raw === undefined) return { scope: fallback };
  const value = raw.trim().toLowerCase();
  if (value === "live") return { scope: "LIVE" };
  if (value === "mock") return { scope: "MOCK" };
  if (value === "all") return { scope: "ALL" };
  return { error: `Unknown --mode ${raw}. Expected one of: ${MODE_ARGS.join(", ")}.` };
}

/** The journal scope a `--mode` argument selects. */
export function scopeFor(arg: ModeArg): JournalScope {
  return arg === "ALL" ? null : arg;
}

/**
 * The entries that may be cited as proof the AGENT authored an onchain
 * transaction: LIVE, and carrying a hash. MOCK is excluded unconditionally —
 * not filtered by the caller's scope, excluded here — so no argument, default
 * or future refactor can put a simulated hash in that section.
 */
export function evidenceEntries(entries: JournalEntry[]): JournalEntry[] {
  return entries.filter((entry) => entry.mode === "LIVE" && Boolean(entry.decision.txHash));
}

/** Simulated hashes. Real records of a real decision; not onchain, not evidence. */
export function simulatedEntries(entries: JournalEntry[]): JournalEntry[] {
  return entries.filter((entry) => entry.mode === "MOCK" && Boolean(entry.decision.txHash));
}

/** What a scope is showing and what it is leaving out. */
export interface ScopeNotice {
  /** Distinct decisions inside the scope. */
  shown: number;
  /** Distinct decisions excluded by it. */
  hidden: number;
  /** The mode those hidden decisions are in, or null when nothing is hidden. */
  hiddenMode: AgentMode | null;
  /** The command that would show them, or null when nothing is hidden. */
  hint: string | null;
}

/**
 * Describe the effect of a scope on a set of mode counts, so the CLI can print
 * it. A reader must be able to tell "there are no MOCK records" from "MOCK
 * records exist and you are not looking at them".
 */
export function scopeNotice(byMode: ModeCounts, arg: ModeArg): ScopeNotice {
  const total = byMode.MOCK + byMode.LIVE;
  if (arg === "ALL") {
    return { shown: total, hidden: 0, hiddenMode: null, hint: null };
  }
  const other: AgentMode = arg === "LIVE" ? "MOCK" : "LIVE";
  const hidden = byMode[other];
  return {
    shown: byMode[arg],
    hidden,
    hiddenMode: hidden > 0 ? other : null,
    hint: hidden > 0 ? `npm run decisions -- --mode ${other.toLowerCase()}` : null,
  };
}
