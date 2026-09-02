/**
 * Fixed-point helpers for USDFC decimal strings.
 *
 * USDFC has 18 decimals. Every balance that crosses the ChainAdapter boundary
 * is a human-readable decimal string; internally we do the arithmetic in BigInt
 * base units so 0.1 + 0.2 problems never reach the policy engine.
 */

export const USDFC_DECIMALS = 18;

const DECIMAL_RE = /^-?(\d+(\.\d*)?|\.\d+)$/;

/** "1.25" -> 1250000000000000000n */
export function parseUnits(value: string, decimals = USDFC_DECIMALS): bigint {
  const trimmed = value.trim();
  if (!DECIMAL_RE.test(trimmed)) {
    throw new Error(`parseUnits: not a decimal string: ${JSON.stringify(value)}`);
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholePart, fractionPart = ""] = unsigned.split(".");
  const whole = wholePart === "" ? "0" : wholePart;
  const fraction = (fractionPart + "0".repeat(decimals)).slice(0, decimals);
  const scaled =
    BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction === "" ? "0" : fraction);
  return negative ? -scaled : scaled;
}

/** 1250000000000000000n -> "1.25" */
export function formatUnits(value: bigint, decimals = USDFC_DECIMALS): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = (abs / base).toString();
  const fraction = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const out = fraction ? `${whole}.${fraction}` : whole;
  return negative ? `-${out}` : out;
}

/** Decimal string -> number, for display and ratios only. */
export function toNumber(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Clamp a decimal string to a fixed number of places, e.g. "11.335680". */
export function toFixedString(value: string, places: number): string {
  return toNumber(value).toFixed(places);
}

/** Add two decimal strings exactly. */
export function addDecimal(a: string, b: string, decimals = USDFC_DECIMALS): string {
  return formatUnits(parseUnits(a, decimals) + parseUnits(b, decimals), decimals);
}

/** Subtract, floored at zero (balances never go negative in this model). */
export function subDecimalFloor(a: string, b: string, decimals = USDFC_DECIMALS): string {
  const result = parseUnits(a, decimals) - parseUnits(b, decimals);
  return formatUnits(result > 0n ? result : 0n, decimals);
}

/**
 * How many whole epochs `funds` buys at `rate` USDFC/epoch.
 * Returns Infinity when the burn rate is zero (nothing is being spent).
 */
export function epochsFor(funds: string, rate: string, decimals = USDFC_DECIMALS): number {
  const rateUnits = parseUnits(rate, decimals);
  if (rateUnits <= 0n) return Number.POSITIVE_INFINITY;
  const fundsUnits = parseUnits(funds, decimals);
  if (fundsUnits <= 0n) return 0;
  return Number(fundsUnits / rateUnits);
}

/** Thousands separators, preserving up to `places` decimals. */
export function groupDigits(value: number, places = 0): string {
  if (!Number.isFinite(value)) return "\u221e";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
}
