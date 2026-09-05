"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { DecisionFeed } from "./DecisionFeed";
import { RunwayGauge } from "./RunwayGauge";
import { StatTile } from "./StatTile";
import { StatusStrip } from "./StatusStrip";
import { StoragePanel } from "./StoragePanel";
import { EPOCHS_PER_DAY, UNBOUNDED_EPOCHS, isUnboundedDays } from "@/lib/constants";
import {
  MAX_FEED_DECISIONS,
  mergeDecisions,
  mergeLastTickAt,
  newerNotices,
  newerTotals,
} from "@/lib/decisions";
import {
  BAND_VAR,
  depositsTile,
  formatBurnRate,
  formatClock,
  runwayBand,
} from "@/lib/format";
import type {
  AgentEvent,
  AgentMode,
  ApiError,
  SqueezeResponse,
  AgentNotice,
  AgentStatus,
  Decision,
  DecisionTotals,
  DecisionsResponse,
  LogLevel,
  RunwaySnapshot,
  SnapshotResponse,
} from "@/lib/types";
import { addDecimal, toFixedString, toNumber } from "@/lib/units";
import { SCROLL_FADE_STYLE, useScrollFade } from "@/lib/useScrollFade";

const UI_TICK_MS = 100;
/** Never extrapolate the gauge more than this far past the last reading. */
const MAX_EXTRAPOLATION_MS = 8_000;
/** Sanity cap on the learned burn rate: 2 days of runway per second. */
const MAX_RATE_DAYS_PER_MS = 2e-3;
const MAX_LOGS = 8;

interface LogLine {
  id: string;
  at: number;
  level: LogLevel;
  message: string;
}

const LOG_COLOR: Record<LogLevel, string> = {
  info: "var(--ink-dim)",
  warn: "var(--warn)",
  error: "var(--crit)",
};

export interface DashboardProps {
  /**
   * Adapter mode resolved server-side in `src/app/page.tsx`, so the status
   * strip is already correct on first paint instead of guessing until
   * `/api/snapshot` resolves. See `StatusStrip`.
   */
  initialMode?: AgentMode;
  /**
   * Whether this build offers the operator controls. Resolved on the server so
   * they are present (or absent) in the first painted frame rather than
   * appearing a moment later.
   */
  manualTick?: boolean;
  /**
   * Whether those controls must ask for the deployment's shared secret before
   * they will do anything. The secret itself is never in this bundle — a human
   * pastes it into the page. See `OperatorControls`.
   */
  operatorAuthRequired?: boolean;
  /**
   * How often to re-read `/api/snapshot` and `/api/decisions`, in ms. 0 (the
   * local default) means never: the SSE stream is served by the same process
   * that runs the agent, so it already carries everything.
   *
   * Non-zero under the cron driver, where it is not. There the tick runs in one
   * Function instance and this page's stream is held by another; both share the
   * durable journal, so the page polls endpoints that read it. Merged, never
   * replaced — see `src/lib/decisions.ts` for why that distinction matters.
   */
  pollMs?: number;
}

export function Dashboard({
  initialMode,
  manualTick = true,
  operatorAuthRequired = false,
  pollMs = 0,
}: DashboardProps = {}) {
  const [snapshot, setSnapshot] = useState<RunwaySnapshot | null>(null);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  /**
   * Whole-history aggregates, owned by the server. Deriving these from the
   * decisions this tab happens to hold made the AUTONOMOUS DEPOSITS tile
   * session-scoped: a tab opened after the deposit read zero, and two tabs
   * disagreed. Seeded from the hydrate and kept current by `totals` events.
   */
  const [totals, setTotals] = useState<DecisionTotals | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  /**
   * Standing disclosures, pinned above the rolling trace.
   *
   * These used to be ordinary trace lines, which meant they expired: the server
   * replays a bounded backlog and this component keeps MAX_LOGS lines, so a few
   * minutes of ticks pushed the journal restore line — the only place a viewer
   * is told which records were withheld from this view — off screen for good.
   * They are server state now, delivered by the hydrate AND by every stream
   * connect, so arriving late no longer hides them.
   */
  const [notices, setNotices] = useState<AgentNotice[]>([]);
  const [lastTickAt, setLastTickAt] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const [ticking, setTicking] = useState(false);
  const [now, setNow] = useState(0);
  const [displayDays, setDisplayDays] = useState(0);

  // Anchor + measured burn rate let the gauge count down smoothly between the
  // server's 2s readings, and this works for any adapter (mock or live)
  // because the rate is measured rather than assumed.
  const anchorRef = useRef<{ days: number; t: number } | null>(null);
  const rateRef = useRef(0);

  const applySnapshot = useCallback((next: RunwaySnapshot) => {
    setSnapshot((prev) => (prev && prev.takenAt > next.takenAt ? prev : next));

    const t = Date.now();
    const anchor = anchorRef.current;
    if (anchor) {
      const dt = t - anchor.t;
      const dd = anchor.days - next.daysRemaining;
      if (dt >= 500 && dd > 0) {
        const instant = dd / dt;
        if (instant < MAX_RATE_DAYS_PER_MS) {
          rateRef.current =
            rateRef.current > 0 ? rateRef.current * 0.5 + instant * 0.5 : instant;
        }
      }
    }
    anchorRef.current = { days: next.daysRemaining, t };
  }, []);

  const pushLog = useCallback((line: LogLine) => {
    setLogs((prev) => [line, ...prev].slice(0, MAX_LOGS));
  }, []);

  const applyDecision = useCallback((decision: Decision) => {
    setDecisions((prev) => {
      const index = prev.findIndex((d) => d.id === decision.id);
      if (index >= 0) {
        const next = [...prev];
        next[index] = decision;
        return next;
      }
      return [decision, ...prev].slice(0, MAX_FEED_DECISIONS);
    });
    setLastTickAt((prev) => mergeLastTickAt(prev, decision.at));
  }, []);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * Read the server's own view of the agent and fold it in.
   *
   * Used for the initial hydrate and, under the cron driver, for the poll. It
   * is the same operation in both cases, and it is safe to repeat because every
   * write below MERGES: `mergeDecisions` keeps the more advanced record of any
   * pair, `newerTotals` / `newerNotices` / `mergeLastTickAt` refuse to move
   * backwards. So a response that raced the stream and lost cannot undo it.
   */
  const readServer = useCallback(async () => {
    const [snapRes, decRes] = await Promise.all([
      fetch("/api/snapshot", { cache: "no-store" }),
      fetch("/api/decisions?limit=60", { cache: "no-store" }),
    ]);
    const snap = (await snapRes.json()) as SnapshotResponse;
    const dec = (await decRes.json()) as DecisionsResponse;
    if (!mounted.current) return;
    setStatus(snap.status);
    setTotals((prev) => newerTotals(prev, dec.status.totals));
    setNotices((prev) => newerNotices(prev, snap.status.notices));
    applySnapshot(snap.snapshot);
    // MERGE, never replace. This response is what starts the agent loop, so
    // it usually arrives empty while the first tick is still running, and it
    // is gated behind the (slow, in LIVE mode) snapshot read beside it — by
    // which time the stream may already have delivered that first decision.
    // See src/lib/decisions.ts.
    setDecisions((prev) => mergeDecisions(prev, dec.decisions));
    setLastTickAt((prev) => mergeLastTickAt(prev, dec.status.lastTickAt));
  }, [applySnapshot]);

  /* ---- initial hydrate ---- */
  useEffect(() => {
    // If this fails the SSE stream will fill everything in shortly.
    void readServer().catch(() => undefined);
  }, [readServer]);

  /* ---- poll, only where the stream is not authoritative ---- */
  useEffect(() => {
    if (pollMs <= 0) return;
    const timer = window.setInterval(() => {
      void readServer().catch(() => undefined);
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [pollMs, readServer]);

  /* ---- live event stream ---- */
  useEffect(() => {
    const source = new EventSource("/api/stream");

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      setConnected(true);
      let event: AgentEvent;
      try {
        event = JSON.parse(message.data) as AgentEvent;
      } catch {
        return;
      }

      switch (event.type) {
        case "snapshot":
          applySnapshot(event.snapshot);
          break;
        case "decision":
          applyDecision(event.decision);
          break;
        case "tx":
          pushLog({
            id: event.id,
            at: event.at,
            level: "info",
            message: `tx ${event.status.toLowerCase()} · ${event.amountUsdfc} USDFC · ${event.txHash.slice(0, 14)}…`,
          });
          break;
        case "log":
          pushLog({
            id: event.id,
            at: event.at,
            level: event.level,
            message: event.message,
          });
          break;
        case "totals":
          setTotals((prev) => newerTotals(prev, event.totals));
          break;
        case "notices":
          // The whole set, not an addition: replacing is what makes a
          // reconnect restate a disclosure instead of duplicating it.
          setNotices((prev) => newerNotices(prev, event.notices));
          break;
      }
    };

    return () => source.close();
  }, [applyDecision, applySnapshot, pushLog]);

  /* ---- animation clock ---- */
  useEffect(() => {
    const advance = () => {
      const t = Date.now();
      setNow(t);
      const anchor = anchorRef.current;
      if (anchor) {
        const elapsed = Math.min(t - anchor.t, MAX_EXTRAPOLATION_MS);
        setDisplayDays(Math.max(0, anchor.days - rateRef.current * elapsed));
      }
    };
    advance();
    const timer = window.setInterval(advance, UI_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  /**
   * The operator's secret travels as a REQUEST HEADER and never anywhere else.
   *
   * `x-filrunway-tick-secret` rather than `Authorization` because the latter is
   * the header proxies are most likely to rewrite, and `tickAuth` accepts both.
   * It is omitted entirely when empty, so the local (open) case sends exactly
   * the request it always did.
   */
  const authHeaders = useCallback((secret: string): HeadersInit => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (secret) headers["x-filrunway-tick-secret"] = secret;
    return headers;
  }, []);

  const onTick = useCallback(
    async (secret: string) => {
      setTicking(true);
      try {
        await fetch("/api/tick", { method: "POST", headers: authHeaders(secret) });
      } finally {
        setTicking(false);
      }
    },
    [authHeaders],
  );

  /**
   * The operator's forced-decision control.
   *
   * Returns a line for the strip to show rather than throwing, because every
   * outcome here is information the operator needs: a 401 means the secret is
   * wrong, a 400 means the bound refused the amount, and a success needs the
   * before/after runway so it is obvious the drop was real. Nothing about this
   * touches the decision feed — a withdrawal is not a decision.
   */
  const onSqueeze = useCallback(
    async (secret: string): Promise<string> => {
      try {
        const response = await fetch("/api/squeeze", {
          method: "POST",
          headers: authHeaders(secret),
          body: JSON.stringify({}),
        });
        const body = (await response.json()) as SqueezeResponse | ApiError;
        if (!response.ok || "error" in body) {
          return "error" in body ? body.error : `Squeeze refused (HTTP ${response.status}).`;
        }
        // Fold the post-withdrawal reading straight in so the gauge drops
        // without waiting for the next 2s sense.
        applySnapshot(body.after ?? body.before);
        const after = body.after
          ? `${body.after.daysRemaining.toFixed(2)}d`
          : "unread";
        return (
          `OPERATOR withdrew ${body.amountUsdfc} USDFC from Filecoin Pay. Runway ` +
          `${body.before.daysRemaining.toFixed(2)}d → ${after}. The agent decides what to ` +
          "do about it on its next tick."
        );
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    [applySnapshot, authHeaders],
  );

  const band = runwayBand(displayDays);
  const burnPerEpoch = snapshot?.lockupRate ?? "0";
  const burnPerDay = toNumber(burnPerEpoch) * EPOCHS_PER_DAY;
  // A live lockupRate carries 20 significant digits; the tile shows an
  // SI-prefixed figure and keeps the exact reading on hover.
  const burn = formatBurnRate(burnPerEpoch);

  // Prefer the server's whole-history figures; fall back to this tab's own
  // decisions only while the hydrate is still in flight, so the tile is never
  // blank and never silently narrower than it claims once totals arrive.
  //
  // Both sources are single-mode by construction. The server restores only its
  // own mode's records from the journal (see `src/lib/journal.ts`), and this
  // tab's decisions all came from this server, so neither can carry the other
  // mode's spend. `depositsTile` then makes that mode legible.
  const sessionExecuted = decisions.filter((d) => d.outcome === "EXECUTED");
  const deposits = depositsTile({
    mode: status?.mode ?? initialMode ?? null,
    depositedUsdfc: totals
      ? totals.depositedUsdfc
      : sessionExecuted.reduce(
          (total, d) => addDecimal(total, d.ruleFired?.topUpAmount ?? "0"),
          "0",
        ),
    executed: totals ? totals.executed : sessionExecuted.length,
    decisions: totals ? totals.decisions : decisions.length,
    journalPath: status?.journalPath ?? null,
  });

  const stale = now > 0 && !connected;

  const { ref: traceRef, showFade: traceFade } = useScrollFade<HTMLUListElement>(
    logs.length,
  );

  return (
    <main className="grid-etch flex min-h-dvh flex-col gap-3 p-3 lg:h-dvh lg:min-h-0 lg:overflow-hidden lg:p-4">
      <StatusStrip
        status={status}
        initialMode={initialMode}
        epoch={snapshot?.epoch ?? null}
        connected={connected}
        now={now}
        lastTickAt={lastTickAt}
        ticking={ticking}
        manualTick={manualTick}
        operatorAuthRequired={operatorAuthRequired}
        onTick={(secret) => void onTick(secret)}
        onSqueeze={onSqueeze}
      />

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(380px,0.85fr)_1.15fr]">
        {/* The column never scrolls: the gauge and the trace share the leftover
            height 3:1, so both are always on screen at 1366x768 and up. */}
        <div className="flex min-h-0 flex-col gap-3 lg:overflow-hidden">
          <RunwayGauge
            days={displayDays}
            epochs={
              // Do not let the unbounded sentinel drift through a float multiply.
              isUnboundedDays(displayDays) ? UNBOUNDED_EPOCHS : displayDays * EPOCHS_PER_DAY
            }
            stale={stale}
          />

          <div className="grid shrink-0 grid-cols-2 gap-3">
            <StatTile
              label="BURN RATE"
              value={burn.value}
              unit={burn.unit}
              title={`${burnPerEpoch} USDFC/epoch`}
              accent={BAND_VAR[band]}
              emphasis
              sub={`≈ ${burnPerDay.toFixed(4)} USDFC / day`}
            />
            <StatTile
              label="FILECOIN PAY"
              value={snapshot ? toFixedString(snapshot.fundsAvailable, 4) : "—"}
              unit="USDFC"
              emphasis
              sub={
                snapshot
                  ? `${toFixedString(snapshot.lockupCurrent, 4)} USDFC locked`
                  : "reading…"
              }
            />
            <StatTile
              label="WALLET"
              value={snapshot ? toFixedString(snapshot.walletUsdfc, 2) : "—"}
              unit="USDFC"
              sub={snapshot ? `${snapshot.walletFil} FIL for gas` : "reading…"}
            />
            <StatTile
              label={deposits.label}
              value={deposits.value}
              unit={deposits.unit}
              accent={deposits.accent}
              title={deposits.title}
              sub={deposits.sub}
            />
          </div>

          <section className="flex min-h-[132px] flex-1 flex-col border border-line bg-panel lg:min-h-[120px] lg:flex-[1_1_0%]">
            <header className="shrink-0 border-b border-line px-4 py-2 text-[11px] tracking-[0.28em] text-ink-dim">
              AGENT TRACE
            </header>

            {/* Pinned above the rolling lines, never inside them: these are
                standing facts about this process, not things that happened at
                a moment. The list below keeps exactly the behaviour it had. */}
            {notices.length > 0 && (
              <ul
                aria-label="Standing disclosures"
                className="max-h-[50%] shrink-0 overflow-y-auto border-b border-line bg-panel-2 px-4 py-1.5 text-[11px]"
              >
                {notices.map((n) => (
                  <li
                    key={n.key}
                    className="flex gap-2"
                    title="Pinned: shown to every viewer for as long as it is true, unlike the trace below."
                  >
                    <span className="shrink-0 pt-[3px] text-[9px] tracking-[0.26em] text-ink-faint">
                      PINNED
                    </span>
                    <span style={{ color: LOG_COLOR[n.level] }}>{n.message}</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="relative min-h-0 flex-1">
              <ul
                ref={traceRef}
                className="flex h-full flex-col gap-1 overflow-y-auto px-4 py-2 text-[11px]"
              >
                {logs.length === 0 && <li className="text-ink-faint">idle&hellip;</li>}
                {logs.map((line) => (
                  <li key={line.id} className="flex shrink-0 gap-2">
                    <span className="tnum text-ink-faint">{formatClock(line.at)}</span>
                    <span style={{ color: LOG_COLOR[line.level] }}>{line.message}</span>
                  </li>
                ))}
              </ul>
              {traceFade && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-5"
                  style={SCROLL_FADE_STYLE}
                />
              )}
            </div>
          </section>
        </div>

        {/* The decision feed keeps every pixel it had; the storage panel is
            pinned under it at its own small fixed height, so the left column
            (gauge + tiles + AGENT TRACE) is untouched and still fits 1366x768. */}
        <div className="flex min-h-0 flex-col gap-3">
          <DecisionFeed decisions={decisions} />
          <StoragePanel />
        </div>
      </div>
    </main>
  );
}
