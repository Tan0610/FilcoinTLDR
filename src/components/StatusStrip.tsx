"use client";

import { explorerAddressUrl } from "@/lib/constants";
import { formatAgo, formatCountdown, truncateMiddle } from "@/lib/format";
import type { AgentMode, AgentStatus } from "@/lib/types";

/**
 * What the badge shows before `/api/snapshot` has resolved.
 *
 * The mode used to default to "MOCK" while unknown, so a LIVE demo's very first
 * painted frame — including the SSR'd HTML, and therefore the first frame of
 * any screen recording — carried the yellow hazard stripe and a black-on-yellow
 * MOCK DATA badge. That is the one claim this dashboard must never make
 * falsely, so the unknown state is now its own neutral third value.
 */
export type StripMode = AgentMode | "CONNECTING";

export interface StatusStripProps {
  status: AgentStatus | null;
  /**
   * Mode resolved on the server and rendered on first paint. `getChainMode()`
   * is a pure env read, so the page can hand it down and the badge is correct
   * before any fetch happens. Omitted (e.g. in isolation) the strip falls back
   * to CONNECTING until the snapshot lands.
   */
  initialMode?: AgentMode;
  epoch: number | null;
  connected: boolean;
  now: number;
  lastTickAt: number | null;
  ticking: boolean;
  onTick: () => void;
}

function Cell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 border-l border-line px-4 py-2 first:border-l-0">
      <span className="text-[9px] tracking-[0.26em] text-ink-faint">{label}</span>
      <span className="truncate text-[13px] text-ink">{children}</span>
    </div>
  );
}

/**
 * Three states, three treatments, none of which can be mistaken for another:
 * MOCK is a filled hazard-yellow chip, LIVE an outlined green one, and the
 * not-yet-known state a muted outline in the same grey as the strip's own
 * metadata. CONNECTING deliberately borrows nothing from the mock styling.
 */
function ModeBadge({ mode }: { mode: StripMode }) {
  const base = "border-2 px-2 py-0.5 text-[11px] font-black tracking-[0.18em]";

  if (mode === "MOCK") {
    return (
      <span
        className={base}
        style={{ background: "var(--mock)", borderColor: "var(--mock)", color: "#0a0a0a" }}
        title="Simulated chain adapter. No real funds move."
      >
        MOCK DATA
      </span>
    );
  }

  if (mode === "LIVE") {
    return (
      <span className={base} style={{ borderColor: "var(--ok)", color: "var(--ok)" }}>
        LIVE &middot; CALIBRATION
      </span>
    );
  }

  return (
    <span
      className={`${base} border-dashed`}
      style={{ borderColor: "var(--line-bright)", color: "var(--ink-faint)" }}
      title="Reading the chain adapter — mode not yet confirmed."
    >
      &mdash; CONNECTING
    </span>
  );
}

export function StatusStrip({
  status,
  initialMode,
  epoch,
  connected,
  now,
  lastTickAt,
  ticking,
  onTick,
}: StatusStripProps) {
  const mode: StripMode = status?.mode ?? initialMode ?? "CONNECTING";
  const isMock = mode === "MOCK";
  const interval = status?.tickIntervalMs ?? 15_000;
  const nextTickAt = lastTickAt === null ? null : lastTickAt + interval;
  const remaining = nextTickAt === null ? interval : Math.max(0, nextTickAt - now);
  const progress = 1 - Math.min(1, remaining / interval);

  return (
    <div className="border border-line bg-panel">
      {isMock && (
        <div
          className="h-2 w-full"
          style={{
            backgroundImage:
              "repeating-linear-gradient(45deg, var(--mock) 0 10px, #0a0a0a 10px 20px)",
          }}
          aria-hidden
        />
      )}

      <div className="flex flex-wrap items-stretch justify-between">
        <div className="flex min-w-0 flex-1 flex-wrap items-stretch">
          <div className="flex items-center gap-3 px-4 py-2">
            <span className="text-[15px] font-bold tracking-[0.3em] text-ink">
              FIL<span className="text-accent">RUNWAY</span>
            </span>
            <ModeBadge mode={mode} />
          </div>

          <Cell label="AGENT ADDRESS">
            {status ? (
              <a
                className="text-accent underline-offset-4 hover:underline"
                href={explorerAddressUrl(status.address)}
                target="_blank"
                rel="noreferrer"
              >
                {truncateMiddle(status.address)}
              </a>
            ) : (
              <span className="text-ink-faint">&mdash;</span>
            )}
          </Cell>

          <Cell label="EPOCH">
            <span className="tnum">{epoch === null ? "\u2014" : epoch.toLocaleString("en-US")}</span>
          </Cell>

          <Cell label="LAST TICK">
            <span className="tnum">
              {lastTickAt === null ? "\u2014" : formatAgo(lastTickAt, now)}
            </span>
          </Cell>

          <Cell label="NEXT TICK">
            <span className="tnum" style={{ color: "var(--accent)" }}>
              {formatCountdown(remaining)}
            </span>
          </Cell>

          <Cell label="STREAM">
            <span className="flex items-center gap-2">
              <span
                className={`inline-block h-2 w-2 rounded-full ${connected ? "blink" : ""}`}
                style={{ background: connected ? "var(--ok)" : "var(--crit)" }}
              />
              {connected ? "CONNECTED" : "OFFLINE"}
            </span>
          </Cell>
        </div>

        <div className="flex items-center border-l border-line px-3">
          <button
            type="button"
            onClick={onTick}
            disabled={ticking}
            className="border border-line-bright bg-panel-2 px-4 py-2 text-[12px] font-bold tracking-[0.2em] text-ink transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            {ticking ? "RUNNING\u2026" : "RUN TICK NOW"}
          </button>
        </div>
      </div>

      <div className="h-[3px] w-full bg-panel-3">
        <div
          className="h-full"
          style={{
            width: `${(progress * 100).toFixed(2)}%`,
            background: "var(--accent)",
            transition: "width 200ms linear",
          }}
        />
      </div>
    </div>
  );
}
