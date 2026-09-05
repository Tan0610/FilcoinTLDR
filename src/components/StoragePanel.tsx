"use client";

import { useEffect, useState } from "react";

import { formatBytes, truncateMiddle } from "@/lib/format";
import type {
  ApiError,
  DataSetProofState,
  StorageListing,
  StorageResponse,
} from "@/lib/types";
import { SCROLL_FADE_STYLE, useScrollFade } from "@/lib/useScrollFade";

/**
 * The data sets behind the burn rate.
 *
 * Without this the dashboard shows a cost stream and asks a judge to take on
 * faith that real data sits behind it: PDP and Warm Storage are used, but
 * invisibly. Every row here is a chain reading — data set id, service provider,
 * bytes, active piece CIDs. An empty account says so, and a failed read says
 * that; neither is ever papered over with a placeholder row.
 *
 * Deliberately subordinate to the gauge and the decision feed: one dense line
 * per data set, its own short scroller, and a fixed ceiling so it cannot push
 * the AGENT TRACE panel off a 1366x768 screen.
 */

/** Slower than the gauge: data sets change only when the agent uploads. */
const POLL_MS = 30_000;

type State =
  | { kind: "loading" }
  | { kind: "ready"; listing: StorageListing }
  | { kind: "error"; message: string };

/**
 * The proof chip, and the three states it must keep apart.
 *
 * PROVING / OVERDUE / PROOF? are deliberately three values, not two. Collapsing
 * an unreadable proof state into "overdue" is the exact mistake the agent is
 * built not to make — it is what would have it terminate healthy storage on an
 * RPC wobble — so the panel a judge checks the agent's reasoning against has to
 * show the same three-way distinction the policy engine acts on.
 */
function ProofChip({ proof }: { proof: DataSetProofState }) {
  if (!proof.readable) {
    return (
      <span
        className="shrink-0 text-[10px]"
        style={{ color: "var(--ink-faint)" }}
        title={`Proof state unknown: ${proof.unknownReason ?? "read failed"}. Treated as unknown, never as a missed proof.`}
      >
        PROOF?
      </span>
    );
  }

  if (proof.isDelinquent) {
    return (
      <span
        className="shrink-0 text-[10px] font-bold"
        style={{ color: "var(--crit)" }}
        title={
          `Past its proving deadline (epoch ${proof.provingDeadline}) by ` +
          `${proof.epochsOverdue?.toLocaleString("en-US") ?? "?"} epochs with no proof this ` +
          "period. This data set is being paid for and is not earning its cost."
        }
      >
        OVERDUE
      </span>
    );
  }

  if (proof.isLive !== true) {
    return (
      <span
        className="shrink-0 text-[10px]"
        style={{ color: "var(--ink-faint)" }}
        title="Not live in PDPVerifier — terminated or never activated."
      >
        NOT LIVE
      </span>
    );
  }

  return (
    <span
      className="shrink-0 text-[10px]"
      style={{ color: "var(--ok)" }}
      title={
        `Proven this period. Last proven at epoch ${proof.lastProvenEpoch ?? "unread"}; ` +
        `proving deadline epoch ${proof.provingDeadline ?? "unread"}.`
      }
    >
      PROVING
    </span>
  );
}

function Row({
  dataSetId,
  provider,
  size,
  pieceCid,
  pieceCount,
  isLive,
  withCDN,
  proof,
}: {
  dataSetId: string;
  provider: string;
  size: string;
  pieceCid: string | null;
  pieceCount: number;
  isLive: boolean;
  withCDN: boolean;
  proof: DataSetProofState;
}) {
  return (
    <li className="flex shrink-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line/60 px-4 py-1.5 last:border-b-0 text-[11px]">
      <span className="tnum shrink-0 text-ink" title={`Warm Storage data set ${dataSetId}`}>
        #{dataSetId}
      </span>
      <span
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: isLive ? "var(--ok)" : "var(--ink-faint)" }}
        title={isLive ? "Data set live" : "Data set not live"}
        aria-hidden
      />
      <span className="shrink-0 text-ink-faint" title={provider}>
        SP {truncateMiddle(provider, 6, 4)}
      </span>
      <span className="tnum shrink-0 text-ink-dim">{size}</span>
      <ProofChip proof={proof} />
      {withCDN && <span className="shrink-0 text-[10px] text-accent">CDN</span>}
      {pieceCid ? (
        <span className="min-w-0 flex-1 truncate text-right text-accent" title={pieceCid}>
          {truncateMiddle(pieceCid, 12, 8)}
          {pieceCount > 1 && (
            <span className="text-ink-faint"> +{pieceCount - 1}</span>
          )}
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-right text-ink-faint">
          no active piece read
        </span>
      )}
    </li>
  );
}

export function StoragePanel() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await fetch("/api/storage", { cache: "no-store" });
        const body = (await response.json()) as StorageResponse | ApiError;
        if (cancelled) return;
        if (!response.ok || "error" in body) {
          setState({
            kind: "error",
            message: "error" in body ? body.error : `HTTP ${response.status}`,
          });
          return;
        }
        setState({ kind: "ready", listing: body.storage });
      } catch (error) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const dataSets = state.kind === "ready" ? state.listing.dataSets : [];
  const { ref: listRef, showFade } = useScrollFade<HTMLUListElement>(dataSets.length);

  const summary =
    state.kind === "ready"
      ? `${dataSets.length} data set${dataSets.length === 1 ? "" : "s"} · ${formatBytes(
          state.listing.totalSizeBytes,
        )}`
      : state.kind === "error"
        ? "unavailable"
        : "reading…";

  return (
    <section className="flex shrink-0 flex-col border border-line bg-panel">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-2">
        <h2 className="text-[11px] tracking-[0.28em] text-ink-dim">
          STORED DATA <span className="text-ink-faint">· PDP / WARM STORAGE</span>
        </h2>
        <span className="tnum shrink-0 text-[11px] text-ink-faint">{summary}</span>
      </header>

      <div className="relative">
        {state.kind === "loading" && (
          <p className="px-4 py-3 text-[11px] text-ink-faint">Reading data sets&hellip;</p>
        )}

        {state.kind === "error" && (
          <p className="px-4 py-3 text-[11px] text-crit">
            Could not read the storage listing: {state.message}
          </p>
        )}

        {state.kind === "ready" && dataSets.length === 0 && (
          <p className="px-4 py-3 text-[11px] text-ink-faint">
            No data sets on this account. The agent is not paying for storage yet.
          </p>
        )}

        {state.kind === "ready" && dataSets.length > 0 && (
          <ul
            ref={listRef}
            className="flex max-h-[104px] flex-col overflow-y-auto"
          >
            {dataSets.map((set) => (
              <Row
                key={set.id}
                dataSetId={set.id}
                provider={set.provider}
                size={formatBytes(set.sizeBytes)}
                pieceCid={set.pieceCids[0] ?? null}
                pieceCount={set.pieceCids.length}
                isLive={set.isLive}
                withCDN={set.withCDN}
                proof={set.proof}
              />
            ))}
          </ul>
        )}

        {showFade && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-5"
            style={SCROLL_FADE_STYLE}
          />
        )}
      </div>
    </section>
  );
}
