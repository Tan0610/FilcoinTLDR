"use client";

import { GAUGE_MAX_DAYS, isUnboundedDays, isUnboundedEpochs } from "@/lib/constants";
import {
  DEMO_BAND_CRITICAL_DAYS,
  DEMO_BAND_WARNING_DAYS,
  DEMO_GAUGE_MAX_DAYS,
  DEMO_LABEL,
  DEMO_SCALE,
  DEMO_SCALED,
} from "@/lib/demo";
import { BAND_LABEL, BAND_VAR, formatDays, runwayBand } from "@/lib/format";
import { groupDigits } from "@/lib/units";

const CX = 160;
const CY = 152;
const R = 118;
const START_ANGLE = 135;
const SWEEP = 270;
const ARC_LENGTH = 2 * Math.PI * R * (SWEEP / 360);

function polar(angle: number, radius: number) {
  const rad = (angle * Math.PI) / 180;
  return { x: CX + radius * Math.cos(rad), y: CY + radius * Math.sin(rad) };
}

function angleForDays(days: number) {
  const clamped = Math.min(Math.max(days, 0), DEMO_GAUGE_MAX_DAYS);
  return START_ANGLE + SWEEP * (clamped / DEMO_GAUGE_MAX_DAYS);
}

const arcStart = polar(START_ANGLE, R);
const arcEnd = polar(START_ANGLE + SWEEP, R);
const ARC_PATH = `M ${arcStart.x.toFixed(2)} ${arcStart.y.toFixed(2)} A ${R} ${R} 0 1 1 ${arcEnd.x.toFixed(2)} ${arcEnd.y.toFixed(2)}`;

/**
 * Always 15 graduations, whatever the demo scale: the divisions stay at
 * 1/14ths of the axis and only the day value they represent is multiplied.
 */
const TICKS = Array.from({ length: GAUGE_MAX_DAYS + 1 }, (_, i) => ({
  index: i,
  days: i * DEMO_SCALE,
}));

/**
 * Centre-numeral type scale, stepped by how many integer digits it has to hold.
 *
 * The numeral is an HTML overlay centred on the arc, so its width grows with
 * the digit count while the space inside the arc does not. Geist Mono advances
 * a fixed 0.6em per glyph, so the arithmetic is exact: at 1366x768 the arc's
 * inner edge sits ~101px either side of centre, while at the base size
 * "2969.86" needs ~150px and even "999.99" needs ~124px. Both overhang the
 * track. (Reported live at 2969.86 — the runway a real 5 USDFC top-up buys on
 * Calibration — so this is the ordinary LIVE case, not an edge case, and the
 * three-digit readings a running demo passes through collide too.)
 *
 * Each step is sized so the widest value it can hold clears the arc at 1366x768
 * — the tightest of the three target viewports, since the gauge is height-bound
 * there and width-bound higher up. Two digits and fewer keep the original scale
 * untouched, so the mock demo's opening frame looks exactly as it always did.
 * Measured at 1366x768, 1440x900 and 1920x1080 against real renders.
 *
 * The class strings are written out in full because Tailwind extracts literals
 * from source; a computed class name would never be generated.
 */
const NUMERAL_SIZE = {
  /** <= 2 integer digits, e.g. "9.60". The original scale, untouched. */
  base: {
    whole: "text-[clamp(2.5rem,min(8vw,12vh),6.5rem)]",
    decimals: "text-[clamp(1.25rem,min(4vw,6vh),3.25rem)]",
  },
  /** 3 integer digits, e.g. "195.15" — the LIVE demo's usual range. 0.74x. */
  mid: {
    whole: "text-[clamp(1.85rem,min(5.9vw,8.9vh),4.8rem)]",
    decimals: "text-[clamp(0.9rem,min(2.95vw,4.45vh),2.4rem)]",
  },
  /** 4 integer digits, e.g. "2969.86". 0.60x, verified at 1366x768. */
  wide: {
    whole: "text-[clamp(1.5rem,min(4.8vw,7.2vh),3.9rem)]",
    decimals: "text-[clamp(0.75rem,min(2.4vw,3.6vh),1.95rem)]",
  },
  /** 5 or more, e.g. "52000.00" at a large demo timescale. 0.46x. */
  widest: {
    whole: "text-[clamp(1.15rem,min(3.7vw,5.5vh),3rem)]",
    decimals: "text-[clamp(0.6rem,min(1.85vw,2.75vh),1.5rem)]",
  },
} as const;

type NumeralStep = keyof typeof NUMERAL_SIZE;

/** Which step the integer part needs. `whole` is already a formatted string. */
function sizeStepFor(whole: string): NumeralStep {
  const digits = whole.length;
  if (digits >= 5) return "widest";
  if (digits === 4) return "wide";
  if (digits === 3) return "mid";
  return "base";
}

export interface RunwayGaugeProps {
  days: number;
  epochs: number;
  stale: boolean;
}

export function RunwayGauge({ days, epochs, stale }: RunwayGaugeProps) {
  // A zero burn rate means the runway is unbounded, not zero. Peg the needle at
  // full scale and print an infinity glyph rather than a 13-digit sentinel.
  const unbounded = isUnboundedDays(days);
  const safeDays = unbounded ? DEMO_GAUGE_MAX_DAYS : Math.max(days, 0);
  const band = runwayBand(days);
  const color = BAND_VAR[band];
  const fraction = Math.min(safeDays / DEMO_GAUGE_MAX_DAYS, 1);
  const dashOffset = ARC_LENGTH * (1 - fraction);
  const needle = polar(angleForDays(safeDays), R + 14);
  const needleInner = polar(angleForDays(safeDays), R - 22);

  const [whole, decimals] = safeDays.toFixed(2).split(".");
  const numeral = NUMERAL_SIZE[sizeStepFor(whole)];

  return (
    <section
      className="relative flex shrink-0 flex-col border border-line bg-panel lg:min-h-0 lg:flex-[3_1_0%]"
      aria-label="Runway gauge"
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-2">
        <h2 className="text-[11px] tracking-[0.28em] text-ink-dim">RUNWAY</h2>
        {DEMO_SCALED && (
          <span
            className="truncate border px-1.5 py-0.5 text-[9px] tracking-[0.16em]"
            style={{ borderColor: "var(--mock)", color: "var(--mock)" }}
            title="Policy thresholds and gauge graduations are multiplied by this factor. Every number shown is a real onchain reading."
          >
            {DEMO_LABEL} · READINGS REAL
          </span>
        )}
        <span
          className="text-[11px] font-bold tracking-[0.22em]"
          style={{ color, transition: "color 220ms linear" }}
        >
          {BAND_LABEL[band]}
        </span>
      </header>

      <div className="px-3 py-2 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
        {/* The gauge fills whatever height the column has left, so the panels
            below it are never pushed past the fold on a laptop viewport. The
            viewBox is cropped to the drawing's real extent (y 6..268) so the
            trimmed panel spends its height on the arc rather than on padding. */}
        <div className="relative lg:flex lg:min-h-0 lg:flex-1 lg:flex-col lg:justify-center">
        <svg
          viewBox="0 6 320 262"
          className="mx-auto block w-full max-h-[min(46vh,440px)] lg:h-full lg:max-h-none"
          role="img"
          aria-label={
            unbounded
              ? "Runway is unbounded: the burn rate is zero"
              : `${safeDays.toFixed(2)} days of runway remaining`
          }
        >
          <defs>
            <filter id="gauge-glow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="6" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* graduations */}
          {TICKS.map(({ index, days: tickDays }) => {
            const major = index % 7 === 0;
            const a = angleForDays(tickDays);
            const outer = polar(a, R + 20);
            const inner = polar(a, major ? R + 8 : R + 14);
            return (
              <line
                key={index}
                x1={inner.x}
                y1={inner.y}
                x2={outer.x}
                y2={outer.y}
                stroke={major ? "var(--line-bright)" : "var(--line)"}
                strokeWidth={major ? 2 : 1}
              />
            );
          })}

          {/* track */}
          <path
            d={ARC_PATH}
            fill="none"
            stroke="var(--panel-3)"
            strokeWidth={22}
            strokeLinecap="butt"
          />

          {/* threshold bands on the track */}
          {[DEMO_BAND_CRITICAL_DAYS, DEMO_BAND_WARNING_DAYS].map((threshold) => {
            const a = angleForDays(threshold);
            const p1 = polar(a, R - 11);
            const p2 = polar(a, R + 11);
            return (
              <line
                key={threshold}
                x1={p1.x}
                y1={p1.y}
                x2={p2.x}
                y2={p2.y}
                stroke={threshold === DEMO_BAND_CRITICAL_DAYS ? "var(--crit)" : "var(--warn)"}
                strokeWidth={2.5}
                opacity={0.85}
              />
            );
          })}

          {/* value */}
          <path
            d={ARC_PATH}
            fill="none"
            stroke={color}
            strokeWidth={22}
            strokeLinecap="butt"
            strokeDasharray={ARC_LENGTH}
            strokeDashoffset={dashOffset}
            filter="url(#gauge-glow)"
            // Same duration and easing as the numeral's colour crossfade below,
            // so the arc and the number are never two different palettes.
            style={{ transition: "stroke-dashoffset 220ms linear, stroke 220ms linear" }}
          />

          {/* needle */}
          <line
            x1={needleInner.x}
            y1={needleInner.y}
            x2={needle.x}
            y2={needle.y}
            stroke="var(--ink)"
            strokeWidth={2}
            style={{ transition: "all 220ms linear" }}
          />

          <text
            x={polar(START_ANGLE, R + 34).x}
            y={polar(START_ANGLE, R + 34).y}
            fill="var(--ink-faint)"
            fontSize="11"
            textAnchor="middle"
          >
            0d
          </text>
          <text
            x={polar(START_ANGLE + SWEEP, R + 34).x}
            y={polar(START_ANGLE + SWEEP, R + 34).y}
            fill="var(--ink-faint)"
            fontSize="11"
            textAnchor="middle"
          >
            {formatDays(DEMO_GAUGE_MAX_DAYS)}d
          </text>
        </svg>

        <div className="pointer-events-none absolute inset-x-0 top-[55.7%] flex -translate-y-1/2 flex-col items-center">
          {band === "crit" && (
            <span
              className="crit-ring absolute h-40 w-40 rounded-full border-2"
              style={{ borderColor: "var(--crit)" }}
            />
          )}
          <div
            className="tnum leading-[0.85] font-bold"
            style={{
              color,
              textShadow: `0 0 28px ${color}55`,
              transition: "color 220ms linear, text-shadow 220ms linear",
            }}
          >
            {unbounded ? (
              <span className={NUMERAL_SIZE.base.whole}>&#8734;</span>
            ) : (
              <>
                <span className={numeral.whole}>{whole}</span>
                <span className={`${numeral.decimals} opacity-70`}>.{decimals}</span>
              </>
            )}
          </div>
          <div className="mt-1 text-[12px] tracking-[0.4em] text-ink-dim">DAYS LEFT</div>
          <div className="tnum mt-3 text-[13px] text-ink-faint">
            {isUnboundedEpochs(epochs)
              ? "zero burn rate"
              : `${groupDigits(Math.max(0, Math.floor(epochs)))} epochs`}
          </div>
          {stale && (
            <div className="mt-2 text-[11px] tracking-[0.2em] text-crit">SIGNAL LOST</div>
          )}
        </div>
        </div>
      </div>

      <footer className="flex shrink-0 items-center justify-between border-t border-line px-4 py-2 text-[11px] text-ink-faint">
        <span>
          <span className="text-crit">&#9646;</span> EMERGENCY &lt;{" "}
          {formatDays(DEMO_BAND_CRITICAL_DAYS)}d
        </span>
        <span>
          <span className="text-warn">&#9646;</span> TOP UP &lt;{" "}
          {formatDays(DEMO_BAND_WARNING_DAYS)}d
        </span>
        <span>
          <span className="text-ok">&#9646;</span> HOLD &ge; {formatDays(DEMO_BAND_WARNING_DAYS)}d
        </span>
      </footer>
    </section>
  );
}
