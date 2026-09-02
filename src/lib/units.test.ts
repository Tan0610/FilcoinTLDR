/**
 * Fixed-point arithmetic tests.
 *
 * Every balance in FilRunway crosses this file: a chain read becomes a decimal
 * string here, the policy engine compares wallet against top-up here, and the
 * runway that drives the whole demo is `epochsFor()`. It was only ever covered
 * incidentally, through the policy tests that happen to call it. The properties
 * below are the ones a wrong answer would quietly corrupt — an agent that
 * mis-reads its own balance by a factor of ten is worse than one that holds.
 */

import { describe, expect, it } from "vitest";

import {
  USDFC_DECIMALS,
  addDecimal,
  epochsFor,
  formatUnits,
  groupDigits,
  parseUnits,
  subDecimalFloor,
  toFixedString,
  toNumber,
} from "./units";

describe("parseUnits", () => {
  it("scales by the token's decimals", () => {
    expect(parseUnits("1")).toBe(10n ** 18n);
    expect(parseUnits("1.25")).toBe(1_250_000_000_000_000_000n);
    expect(parseUnits("0")).toBe(0n);
  });

  it("accepts the shapes a chain read or a config file can produce", () => {
    expect(parseUnits("11.33568")).toBe(11_335_680_000_000_000_000n);
    expect(parseUnits(".5")).toBe(500_000_000_000_000_000n);
    expect(parseUnits("5.")).toBe(5n * 10n ** 18n);
    expect(parseUnits("  2.5  ")).toBe(2_500_000_000_000_000_000n);
    expect(parseUnits("-1.5")).toBe(-1_500_000_000_000_000_000n);
  });

  it("keeps full precision on a live-length burn rate", () => {
    // A real Calibration lockupRate carries every one of the 18 decimals.
    expect(parseUnits("0.000002777832968892")).toBe(2_777_832_968_892n);
  });

  it("truncates below the last representable decimal rather than rounding up", () => {
    // Rounding up would let the agent believe it holds money it does not.
    expect(parseUnits("0.0000000000000000009")).toBe(0n);
    expect(parseUnits("1.9999999999999999999")).toBe(1_999_999_999_999_999_999n);
  });

  it("honours a non-default decimal count", () => {
    expect(parseUnits("1.5", 6)).toBe(1_500_000n);
    expect(parseUnits("1.5", 0)).toBe(1n);
  });

  it("throws rather than guessing at anything that is not a decimal string", () => {
    for (const bad of ["", "abc", "1.2.3", "1e18", "0x10", "1,000", "Infinity", "NaN", "--1"]) {
      expect(() => parseUnits(bad)).toThrow(/not a decimal string/);
    }
  });
});

describe("formatUnits", () => {
  it("inverts parseUnits", () => {
    for (const value of ["0", "1", "1.25", "11.33568", "0.000002777832968892", "-3.5"]) {
      expect(formatUnits(parseUnits(value))).toBe(value === "-3.5" ? "-3.5" : value);
    }
  });

  it("drops trailing zeros but keeps the integer part", () => {
    expect(formatUnits(10n ** 18n)).toBe("1");
    expect(formatUnits(1_500_000_000_000_000_000n)).toBe("1.5");
    expect(formatUnits(0n)).toBe("0");
  });

  it("never emits a bare leading dot", () => {
    expect(formatUnits(500_000_000_000_000_000n)).toBe("0.5");
  });

  it("round-trips the largest balance the demo can plausibly see", () => {
    const big = "123456789.123456789012345678";
    expect(formatUnits(parseUnits(big))).toBe(big);
  });

  it("exposes the token's decimals as a constant the two sides share", () => {
    expect(USDFC_DECIMALS).toBe(18);
  });
});

describe("addDecimal", () => {
  it("is exact where floating point is not", () => {
    // 0.1 + 0.2 === 0.30000000000000004 as a float.
    expect(addDecimal("0.1", "0.2")).toBe("0.3");
  });

  it("adds a top-up to a balance without drift", () => {
    expect(addDecimal("11.33568", "5")).toBe("16.33568");
  });

  it("carries across the decimal point", () => {
    expect(addDecimal("0.999999999999999999", "0.000000000000000001")).toBe("1");
  });
});

describe("subDecimalFloor", () => {
  it("subtracts exactly", () => {
    expect(subDecimalFloor("16.33568", "5")).toBe("11.33568");
  });

  it("floors at zero: a balance in this model is never negative", () => {
    expect(subDecimalFloor("1", "5")).toBe("0");
    expect(subDecimalFloor("0", "0.000000000000000001")).toBe("0");
  });

  it("returns zero for an exact drain rather than a signed zero string", () => {
    expect(subDecimalFloor("5", "5")).toBe("0");
  });
});

describe("epochsFor", () => {
  it("divides funds by burn rate, truncating to whole epochs", () => {
    // 11.33568 / 0.00041 = 27648 exactly.
    expect(epochsFor("11.33568", "0.00041")).toBe(27_648);
    // A partial epoch is not runway you have.
    expect(epochsFor("0.0009", "0.0004")).toBe(2);
  });

  it("is unbounded when nothing is being spent", () => {
    expect(epochsFor("11.33568", "0")).toBe(Number.POSITIVE_INFINITY);
    expect(epochsFor("0", "0")).toBe(Number.POSITIVE_INFINITY);
  });

  it("is zero when there is nothing left, not unbounded", () => {
    expect(epochsFor("0", "0.00041")).toBe(0);
  });

  it("survives a real Calibration burn rate", () => {
    // 5 USDFC at 0.000002777832968892/epoch ~ 1.8m epochs ~ 625 days.
    const epochs = epochsFor("5", "0.000002777832968892");
    expect(epochs).toBeGreaterThan(1_700_000);
    expect(epochs / 2880).toBeGreaterThan(600);
  });
});

describe("toNumber", () => {
  it("parses a decimal string", () => {
    expect(toNumber("11.33568")).toBeCloseTo(11.33568, 10);
  });

  it("degrades to 0 rather than NaN, so display maths cannot poison a layout", () => {
    expect(toNumber("")).toBe(0);
    expect(toNumber("abc")).toBe(0);
    expect(toNumber("Infinity")).toBe(0);
  });
});

describe("toFixedString", () => {
  it("clamps to a fixed number of places", () => {
    expect(toFixedString("11.33568", 2)).toBe("11.34");
    expect(toFixedString("11.33568", 0)).toBe("11");
    expect(toFixedString("5", 4)).toBe("5.0000");
  });

  it("shows zero for an unparseable reading rather than NaN", () => {
    expect(toFixedString("nope", 2)).toBe("0.00");
  });
});

describe("groupDigits", () => {
  it("groups thousands", () => {
    expect(groupDigits(1234567)).toBe("1,234,567");
    expect(groupDigits(1234.5678, 2)).toBe("1,234.57");
  });

  it("prints the infinity glyph rather than a misleading number", () => {
    expect(groupDigits(Number.POSITIVE_INFINITY)).toBe("∞");
    expect(groupDigits(Number.NaN)).toBe("∞");
  });
});
