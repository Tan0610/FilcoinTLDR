/** Display-only helpers. Safe on both server and client. */

import { isUnboundedDays } from "./constants";
import {
  DEMO_BAND_CRITICAL_DAYS,
  DEMO_BAND_WARNING_DAYS,
  DEMO_RULE_SUFFIX,
  DEMO_SCALED,
} from "./demo";
import { ALWAYS_THRESHOLD_DAYS } from "./policy";
import type { AgentMode, DecisionAction, PolicyRule } from "./types";
import { groupDigits, toFixedString, toNumber } from "./units";

export type RunwayBand = "ok" | "warn" | "crit";

/**
 * Band thresholds come from `demo.ts`, which is the plain constants multiplied
 * by FILRUNWAY_DEMO_SCALE (1 by default, i.e. unchanged). `days` is always the
 * true onchain reading.
 */
export function runwayBand(days: number): RunwayBand {
  // Unbounded runway (zero burn rate) is the healthiest possible state; it must
  // never be coerced to 0 and rendered as CRITICAL.
  if (isUnboundedDays(days)) return "ok";
  if (days < DEMO_BAND_CRITICAL_DAYS) return "crit";
  if (days < DEMO_BAND_WARNING_DAYS) return "warn";
  return "ok";
}

export const BAND_VAR: Record<RunwayBand, string> = {
  ok: "var(--ok)",
  warn: "var(--warn)",
  crit: "var(--crit)",
};

/**
 * One state, one name. These are deliberately the same words the decision
 * cards (`ACTION_LABEL`) and the gauge legend use, so a judge never has to
 * work out that "NOMINAL", "HOLD >= 7d" and "HOLD" were the same thing.
 */
export const BAND_LABEL: Record<RunwayBand, string> = {
  ok: "HOLD",
  warn: "TOP UP",
  crit: "EMERGENCY",
};

export const ACTION_VAR: Record<DecisionAction, string> = {
  HOLD: "var(--ink-faint)",
  TOP_UP: "var(--warn)",
  EMERGENCY_TOP_UP: "var(--crit)",
  INSUFFICIENT_FUNDS: "var(--crit)",
  // Amber, not red. INSUFFICIENT_FUNDS needs an operator; a safety cap needs
  // nobody — the agent applied a limit it was given and will resume by itself.
  // Colouring the two the same would read as two alarms.
  SAFETY_CAP: "var(--warn)",
  // The one irreversible action the agent can take, so it gets the alarm
  // colour whether or not it executed: a viewer must never scan past a card
  // that says a data set was cut.
  PRUNE_DATASET: "var(--crit)",
};

export const ACTION_LABEL: Record<DecisionAction, string> = {
  HOLD: "HOLD",
  TOP_UP: "TOP UP",
  EMERGENCY_TOP_UP: "EMERGENCY TOP UP",
  INSUFFICIENT_FUNDS: "INSUFFICIENT FUNDS",
  SAFETY_CAP: "SAFETY CAP",
  // "CUT" rather than "PRUNE": the label has to say what happens to the data,
  // not name the mechanism. A judge reading one card must not have to work out
  // that pruning a data set means storage stops being paid for.
  PRUNE_DATASET: "CUT DATA SET",
};

/** 0x1234abcd...ef01 */
export function truncateMiddle(value: string, head = 10, tail = 8): string {
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}\u2026${value.slice(-tail)}`;
}

export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
}

export function formatAgo(ms: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

export function formatCountdown(msRemaining: number): string {
  const seconds = Math.max(0, Math.ceil(msRemaining / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/* ---------- day figures ---------- */

/**
 * Compact day figure for gauge graduations, axis ends and rule labels.
 *
 * A k/M suffix is used ONLY when it costs no precision: 14,000 renders "14k"
 * and 26,600 renders "26.6k", but 2,660 stays "2,660" rather than rounding to
 * "3k". At a non-round demo scale (e.g. ×380 every threshold is a non-round
 * number) a legend that overstates a threshold by 12.8% beside an exact one is
 * far worse than four extra characters.
 */
export function formatDays(days: number): string {
  if (!Number.isFinite(days)) return "∞";

  const plain = () => days.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const compact = (divisor: number, suffix: string): string | null => {
    const scaled = days / divisor;
    // Two decimals in the compacted unit, and only when nothing is lost.
    if (Math.abs(scaled - Number(scaled.toFixed(2))) > 1e-9) return null;
    return `${scaled.toLocaleString("en-US", { maximumFractionDigits: 2 })}${suffix}`;
  };

  if (days >= 1e6) return compact(1e6, "M") ?? compact(1e3, "k") ?? plain();
  // Below 10,000 the exact number is short enough to print in full.
  if (days >= 1e4) return compact(1e3, "k") ?? plain();
  return plain();
}

/** The day figure inside a rule label, e.g. the "7d" of "HOLD >= 7d". */
const DAY_FIGURE_RE = /\d[\d,]*(?:\.\d+)?\s*d\b/;

/**
 * The label to print for a rule, carrying the threshold ACTUALLY in force.
 *
 * `scaleRules` multiplies each finite threshold but leaves the authored day
 * figure in the label text, and it skips the catch-all HOLD rule entirely —
 * that rule's `thresholdDays` is the JSON-safe `ALWAYS_THRESHOLD_DAYS`
 * sentinel, which must never be multiplied. Both leave a decision card printing
 * a day count that disagrees with the gauge legend and with the decision's own
 * reasoning text. So the figure is rewritten here, in the display layer:
 *
 *   - a normal rule shows its own (already scaled) `thresholdDays`;
 *   - the catch-all HOLD rule shows the tightest top-up threshold in force,
 *     which is what "HOLD" actually means and is the same number the gauge
 *     legend's HOLD entry uses.
 *
 * At scale 1 every figure already matches, so this is the identity.
 */
export function ruleLabel(rule: PolicyRule | null): string {
  if (!rule) return "NO RULE";

  const catchAll =
    !Number.isFinite(rule.thresholdDays) || rule.thresholdDays >= ALWAYS_THRESHOLD_DAYS;
  const effective = catchAll ? DEMO_BAND_WARNING_DAYS : rule.thresholdDays;
  const label = rule.label.replace(DAY_FIGURE_RE, `${formatDays(effective)}d`);

  // scaleRules never reaches the catch-all, so it also never carries the
  // "×N DEMO" disclosure its siblings do. Add it so all three cards read alike.
  return catchAll && DEMO_SCALED && !label.includes(DEMO_RULE_SUFFIX)
    ? `${label}${DEMO_RULE_SUFFIX}`
    : label;
}

/* ---------- the deposits tile ---------- */

/** Everything the AUTONOMOUS DEPOSITS tile renders, resolved from the mode. */
export interface DepositsTile {
  label: string;
  value: string;
  unit: string;
  sub: string;
  /** CSS colour for the swatch and figure, or undefined for the plain treatment. */
  accent: string | undefined;
  /** Hover text: where the figure comes from and what it does NOT include. */
  title: string;
}

export interface DepositsTileInput {
  /** The adapter mode these totals belong to. `null` = not yet confirmed. */
  mode: AgentMode | null;
  /** Sum of `ruleFired.topUpAmount` over EXECUTED decisions, decimal USDFC. */
  depositedUsdfc: string;
  executed: number;
  decisions: number;
  /** Where the totals are backed, or null when persistence is off. */
  journalPath: string | null;
}

/**
 * Present the deposits figure, WITHOUT ever mixing modes.
 *
 * The totals handed in are already single-mode: the store restores only its own
 * mode's records from the journal, and everything it adds afterwards was
 * decided by this process. This function's job is to make the mode of the
 * figure impossible to misread — a simulated total presented in the plain LIVE
 * treatment is the one claim this dashboard must never make falsely.
 *
 * MOCK is marked in three independent places, so no crop of a screenshot can
 * hide it: the label word ("SIMULATED", first, so a truncated label keeps it),
 * the hazard-yellow accent the mode badge and stripe already use, and the
 * leading "MOCK ·" of the sub-line. The figure itself is unchanged — it is a
 * true count of simulated activity, not a fake count of real activity.
 *
 * The mode-unknown state is its own third value rather than a guess, exactly as
 * `StatusStrip`'s CONNECTING badge is: nothing is totalled under a mode nobody
 * has confirmed yet.
 */
export function depositsTile({
  mode,
  depositedUsdfc,
  executed,
  decisions,
  journalPath,
}: DepositsTileInput): DepositsTile {
  if (mode === null) {
    return {
      label: "AUTONOMOUS DEPOSITS",
      value: "—",
      unit: "USDFC",
      sub: "confirming adapter mode…",
      accent: undefined,
      title:
        "The adapter mode is not confirmed yet, so no total is shown. A figure here " +
        "would be a claim about which chain it came from.",
    };
  }

  const value = toFixedString(depositedUsdfc, 0);
  const backing =
    journalPath === null
      ? "This session only: decision persistence is off, so nothing here survives a restart."
      : `Whole recorded history for this mode, from the durable decision log at ${journalPath}.`;

  if (mode === "MOCK") {
    return {
      label: "SIMULATED DEPOSITS",
      value,
      unit: "USDFC",
      // "sim tx" rather than "simulated tx": measured at 1366x768 the longer
      // wording is 244px in a 241px box, so the tile's `truncate` would eat the
      // decision count. This fits in the same width the LIVE sub-line uses.
      sub: `MOCK · ${executed} sim tx · ${groupDigits(decisions)} decisions`,
      accent: "var(--mock)",
      title:
        "SIMULATED. The mock adapter moves no funds and its transaction hashes are not " +
        `onchain. ${backing} LIVE records are excluded.`,
    };
  }

  return {
    label: "AUTONOMOUS DEPOSITS",
    value,
    unit: "USDFC",
    sub: `${executed} transaction${executed === 1 ? "" : "s"} · ${groupDigits(decisions)} decisions`,
    accent: executed > 0 ? "var(--ok)" : undefined,
    title: `${backing} MOCK records are excluded.`,
  };
}

/* ---------- byte figures ---------- */

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/**
 * Binary byte figure for the storage panel, e.g. "1 MiB", "1.5 GiB".
 *
 * Binary units, not decimal, because Filecoin piece sizes are powers of two and
 * Warm Storage prices per TiB. Returns an em dash for an unknown size — the
 * panel must never print a 0 it did not read.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(digits)).toLocaleString("en-US")} ${BYTE_UNITS[unit]}`;
}

/* ---------- burn rate ---------- */

/** SI prefixes for the exponents `formatBurnRate` may shift into. */
const RATE_PREFIX: Record<number, string> = {
  0: "",
  [-3]: "m",
  [-6]: "µ",
  [-9]: "n",
  [-12]: "p",
};

export interface BurnRateDisplay {
  /** Short readable figure, e.g. "2.77783". */
  value: string;
  /** The unit that figure is expressed in, e.g. "µUSDFC/epoch". */
  unit: string;
}

/**
 * Render a burn rate at a size a stat tile can hold.
 *
 * A live `lockupRate` is a 20-significant-digit decimal string
 * ("0.000002777832968892"). Printed raw at the tile's display size it runs off
 * the tile and under its neighbour. Shifting into an SI-prefixed unit keeps the
 * figure in [1, 1000) and shows 6 significant digits — "2.77783 µUSDFC/epoch" —
 * which is readable and still a true reading. Callers keep the exact string
 * available (the tile's `title`), so no precision is hidden, only re-based.
 */
export function formatBurnRate(rate: string, base = "USDFC/epoch"): BurnRateDisplay {
  const value = toNumber(rate);
  if (!Number.isFinite(value) || value <= 0) return { value: "0", unit: base };

  // Engineering notation: step the exponent in 3s, and never past pico.
  const exponent = Math.min(0, Math.max(-12, Math.floor(Math.log10(value) / 3) * 3));
  const scaled = value * 10 ** -exponent;

  return {
    value: Number(scaled.toPrecision(6)).toLocaleString("en-US", {
      maximumFractionDigits: 20,
    }),
    unit: `${RATE_PREFIX[exponent]}${base}`,
  };
}
