/**
 * Display helpers that a judge reads off the screen: the gauge legend, the
 * rule label on every decision card, and the burn-rate tile. Each of these
 * failed in a specific way at a non-round demo scale or against a real 20-digit
 * live reading, so the properties are pinned here.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  depositsTile,
  formatBurnRate,
  formatBytes,
  formatDays,
  ruleLabel,
} from "./format";
import { ALWAYS_THRESHOLD_DAYS, DEFAULT_RULES } from "./policy";
import type { PolicyRule } from "./types";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Re-import the display layer with a demo scale in force. */
async function atScale(scale: string) {
  vi.stubEnv("NEXT_PUBLIC_FILRUNWAY_DEMO_SCALE", scale);
  vi.resetModules();
  const [format, demo] = await Promise.all([import("./format"), import("./demo")]);
  return { ...format, ...demo };
}

describe("formatDays", () => {
  it("prints small figures exactly", () => {
    expect(formatDays(14)).toBe("14");
    expect(formatDays(760)).toBe("760");
    expect(formatDays(2_660)).toBe("2,660");
    expect(formatDays(5_320)).toBe("5,320");
  });

  it("never rounds a threshold up into a lie", () => {
    // The bug: 2,660 rendered as "3k", a 12.8% overstatement, beside an exact
    // "760d" in the same legend.
    expect(formatDays(2_660)).not.toBe("3k");
    expect(formatDays(12_345)).toBe("12,345");
  });

  it("compacts only when the compaction is exact", () => {
    expect(formatDays(14_000)).toBe("14k");
    expect(formatDays(26_600)).toBe("26.6k");
    expect(formatDays(14_000_000)).toBe("14M");
    expect(formatDays(2_660_000)).toBe("2.66M");
  });

  it("stays short enough for the gauge legend", () => {
    for (const days of [760, 2_660, 5_320, 14_000, 26_600, 14_000_000]) {
      expect(formatDays(days).length).toBeLessThanOrEqual(8);
    }
  });

  it("handles a fractional scale and the unbounded sentinel", () => {
    expect(formatDays(2_663.5)).toBe("2,663.5");
    expect(formatDays(Number.POSITIVE_INFINITY)).toBe("∞");
  });
});

describe("formatBurnRate", () => {
  it("fits a real 20-significant-digit live reading in a stat tile", () => {
    const burn = formatBurnRate("0.000002777832968892");
    expect(burn).toEqual({ value: "2.77783", unit: "µUSDFC/epoch" });
    expect(burn.value.length).toBeLessThanOrEqual(8);
  });

  it("keeps the figure in engineering range whatever the magnitude", () => {
    expect(formatBurnRate("0.00041")).toEqual({ value: "410", unit: "µUSDFC/epoch" });
    expect(formatBurnRate("1.5")).toEqual({ value: "1.5", unit: "USDFC/epoch" });
    expect(formatBurnRate("0.0025")).toEqual({ value: "2.5", unit: "mUSDFC/epoch" });
  });

  it("reads back as the same quantity it was given, to 6 significant digits", () => {
    const raw = "0.000002777832968892";
    const { value, unit } = formatBurnRate(raw);
    const factor = unit.startsWith("µ") ? 1e-6 : 1;
    // Relative, not absolute: the tile shows 6 significant digits and the
    // exact string stays on its title attribute.
    expect((Number(value.replace(/,/g, "")) * factor) / Number(raw)).toBeCloseTo(1, 5);
  });

  it("treats a zero burn rate as zero, not as a prefixed number", () => {
    expect(formatBurnRate("0")).toEqual({ value: "0", unit: "USDFC/epoch" });
  });
});

describe("ruleLabel", () => {
  it("falls back when no rule fired", () => {
    expect(ruleLabel(null)).toBe("NO RULE");
  });

  it("is the identity when no demo scale is in force", () => {
    for (const rule of DEFAULT_RULES) {
      expect(ruleLabel(rule)).toBe(rule.label);
    }
  });

  it("prints the threshold actually in force at a non-round scale", async () => {
    const { ruleLabel: scaledLabel, scaleRules } = await atScale("380");
    const rules = scaleRules(DEFAULT_RULES);
    const label = (id: string) => scaledLabel(rules.find((r) => r.id === id) as PolicyRule);

    expect(label("emergency-2d")).toBe("EMERGENCY TOP-UP < 760d ×380 DEMO");
    expect(label("topup-7d")).toBe("SCHEDULED TOP-UP < 2,660d ×380 DEMO");
    // The catch-all HOLD rule keeps its sentinel threshold, so its label is
    // derived from the tightest top-up threshold in force instead.
    expect(label("hold")).toBe("HOLD >= 2,660d ×380 DEMO");
  });

  it("agrees with the gauge legend's HOLD entry", async () => {
    const { ruleLabel: scaledLabel, formatDays: scaledDays, DEMO_BAND_WARNING_DAYS, scaleRules } =
      await atScale("380");
    const hold = scaleRules(DEFAULT_RULES).find((r) => r.id === "hold") as PolicyRule;

    expect(hold.thresholdDays).toBe(ALWAYS_THRESHOLD_DAYS);
    expect(scaledLabel(hold)).toContain(`${scaledDays(DEMO_BAND_WARNING_DAYS)}d`);
  });
});

describe("formatBytes", () => {
  it("uses binary units, because piece sizes are powers of two", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KiB");
    expect(formatBytes(1_048_576)).toBe("1 MiB");
    expect(formatBytes(1_610_612_736)).toBe("1.5 GiB");
  });

  it("returns an em dash rather than inventing a zero for an unknown size", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

/**
 * The AUTONOMOUS DEPOSITS tile.
 *
 * This is the single figure a judge reads as "the agent moved this much money
 * onchain". It totalled MOCK and LIVE together, so a dashboard running LIVE
 * claimed 80 USDFC across 6 transactions when 5 USDFC across 1 transaction was
 * real. The totals are mode-scoped upstream now; what is pinned here is that
 * the tile can never PRESENT a simulated figure as a real one.
 */
describe("depositsTile", () => {
  const simulated = {
    depositedUsdfc: "75",
    executed: 5,
    decisions: 1234,
    journalPath: "/repo/data/decisions.mock.jsonl",
  };

  it("marks a MOCK total as simulated in three independent places", () => {
    const tile = depositsTile({ ...simulated, mode: "MOCK" });

    // 1. the label, with the word first so a truncated label keeps it
    expect(tile.label.startsWith("SIMULATED")).toBe(true);
    expect(tile.label).not.toContain("AUTONOMOUS");
    // 2. the hazard yellow the mode badge and stripe already use
    expect(tile.accent).toBe("var(--mock)");
    // 3. the sub-line, again leading
    expect(tile.sub.startsWith("MOCK ·")).toBe(true);
    expect(tile.sub).toContain("5 sim tx");
    expect(tile.title).toContain("SIMULATED");
    expect(tile.title).toContain("not onchain");
  });

  it("presents a LIVE total plainly, and says MOCK is excluded", () => {
    const tile = depositsTile({
      mode: "LIVE",
      depositedUsdfc: "5",
      executed: 1,
      decisions: 28,
      journalPath: "/repo/data/decisions.jsonl",
    });

    expect(tile.label).toBe("AUTONOMOUS DEPOSITS");
    expect(tile.value).toBe("5");
    expect(tile.accent).toBe("var(--ok)");
    expect(tile.sub).toBe("1 transaction · 28 decisions");
    expect(tile.title).toContain("/repo/data/decisions.jsonl");
    expect(tile.title).toContain("MOCK records are excluded");
    // Nothing about a LIVE tile may read as simulated.
    expect(tile.label).not.toContain("SIMULATED");
    expect(tile.sub).not.toContain("MOCK");
  });

  it("withholds a figure until the adapter mode is confirmed", () => {
    const tile = depositsTile({ ...simulated, mode: null });

    expect(tile.value).toBe("—");
    expect(tile.accent).toBeUndefined();
    expect(tile.sub).toContain("confirming");
  });

  it("does not claim durability when persistence is off", () => {
    const tile = depositsTile({ ...simulated, mode: "LIVE", journalPath: null });
    expect(tile.title).toContain("This session only");
  });

  it("keeps the plain treatment when a LIVE agent has executed nothing", () => {
    const tile = depositsTile({
      mode: "LIVE",
      depositedUsdfc: "0",
      executed: 0,
      decisions: 3,
      journalPath: null,
    });
    expect(tile.accent).toBeUndefined();
    expect(tile.sub).toBe("0 transactions · 3 decisions");
  });
});
