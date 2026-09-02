"use client";

import { memo } from "react";

import { explorerMessageUrl } from "@/lib/constants";
import {
  ACTION_LABEL,
  ACTION_VAR,
  formatClock,
  ruleLabel,
  truncateMiddle,
} from "@/lib/format";
import type { Decision, DecisionOutcome } from "@/lib/types";
import { SCROLL_FADE_STYLE, useScrollFade } from "@/lib/useScrollFade";

const OUTCOME_STYLE: Record<DecisionOutcome, { label: string; color: string }> = {
  PENDING: { label: "SUBMITTING", color: "var(--accent)" },
  EXECUTED: { label: "EXECUTED", color: "var(--ok)" },
  FAILED: { label: "FAILED", color: "var(--crit)" },
  NO_ACTION: { label: "NO ACTION", color: "var(--ink-faint)" },
};

function HoldCard({ decision }: { decision: Decision }) {
  return (
    <li className="enter flex gap-3 border border-dashed border-line bg-transparent px-4 py-2.5">
      <span className="mt-[3px] text-[11px] text-ink-faint">
        {formatClock(decision.at)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-bold tracking-[0.2em] text-ink-dim">HOLD</span>
          <span className="text-[10px] tracking-[0.14em] text-ink-faint">
            {ruleLabel(decision.ruleFired)}
          </span>
          <span className="tnum ml-auto text-[11px] text-ink-faint">
            {decision.snapshot.daysRemaining.toFixed(2)}d
          </span>
        </div>
        {/* This paragraph is the evidence of the agent's judgement, so it gets
            a step up from the faint metadata around it: 13px at 6.43:1 rather
            than 12px at 2.92:1. Still quieter than an action card's 14px
            --ink at 16.92:1, so the hierarchy is unchanged. */}
        <p className="mt-1 font-sans text-[13px] leading-relaxed text-ink-dim">
          {decision.reasoning}
        </p>
      </div>
    </li>
  );
}

/**
 * The agent wanted to act and cannot afford to. Not a resting state like HOLD
 * and not an executed action like TOP_UP — so it gets its own treatment: a
 * heavy solid rail, a red wash, an inverted header bar and an explicit
 * operator-action footer. Nothing was submitted; there is no tx row.
 */
function BlockedCard({ decision }: { decision: Decision }) {
  const color = ACTION_VAR.INSUFFICIENT_FUNDS;

  return (
    <li
      className="enter border-2"
      style={{
        borderColor: color,
        background:
          "linear-gradient(rgba(255, 77, 99, 0.08), rgba(255, 77, 99, 0.08)), var(--panel-2)",
      }}
    >
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2"
        style={{ background: color, color: "#05070c" }}
      >
        <span className="tnum text-[12px] font-bold">{formatClock(decision.at)}</span>
        <span className="blink text-[12px] font-black tracking-[0.16em]">
          &#9650; {ACTION_LABEL[decision.action]}
        </span>
        <span className="text-[11px] font-bold tracking-[0.14em]">
          {ruleLabel(decision.ruleFired)}
        </span>
        <span className="ml-auto flex items-center gap-3">
          <span className="tnum text-[12px] font-bold">
            {decision.snapshot.daysRemaining.toFixed(2)}d
          </span>
          <span
            className="border px-2 py-0.5 text-[10px] font-bold tracking-[0.16em]"
            style={{ borderColor: "#05070c" }}
          >
            BLOCKED
          </span>
        </span>
      </div>

      <p className="px-4 py-3 font-sans text-[14px] leading-relaxed text-ink">
        {decision.reasoning}
      </p>

      <div
        className="border-t px-4 py-2 font-sans text-[12px]"
        style={{ borderColor: color, color }}
      >
        Operator action required &mdash; fund the agent wallet. No transaction was
        attempted.
      </div>
    </li>
  );
}

/**
 * Anything whose `outcome` is FAILED, whatever its `action`.
 *
 * A failed chain read is recorded as `{action: "HOLD", outcome: "FAILED"}` (see
 * `src/lib/agent.ts`), and routing on `action` alone sent it to HoldCard —
 * which renders neither the outcome pill nor `decision.error`, so an RPC
 * outage looked exactly like a calm, healthy hold. A failure is never a resting
 * state, so it gets the alarm chrome BlockedCard uses, plus the FAILED pill
 * ActionCard already defines and the error text itself.
 */
function FailureCard({ decision }: { decision: Decision }) {
  const color = OUTCOME_STYLE.FAILED.color;

  return (
    <li
      className="enter border-2"
      style={{
        borderColor: color,
        background:
          "linear-gradient(rgba(255, 77, 99, 0.08), rgba(255, 77, 99, 0.08)), var(--panel-2)",
      }}
    >
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2"
        style={{ background: color, color: "#05070c" }}
      >
        <span className="tnum text-[12px] font-bold">{formatClock(decision.at)}</span>
        <span className="text-[12px] font-black tracking-[0.16em]">
          &#9650; {ACTION_LABEL[decision.action]}
        </span>
        <span className="text-[11px] font-bold tracking-[0.14em]">
          {ruleLabel(decision.ruleFired)}
        </span>
        <span className="ml-auto flex items-center gap-3">
          <span className="tnum text-[12px] font-bold">
            {decision.snapshot.daysRemaining.toFixed(2)}d
          </span>
          <span
            className="blink border px-2 py-0.5 text-[10px] font-black tracking-[0.16em]"
            style={{ borderColor: "#05070c" }}
          >
            {OUTCOME_STYLE.FAILED.label}
          </span>
        </span>
      </div>

      <p className="px-4 py-3 font-sans text-[14px] leading-relaxed text-ink">
        {decision.reasoning}
      </p>

      {decision.txHash && (
        <div className="flex flex-wrap items-center gap-2 border-t px-4 py-2 text-[12px]" style={{ borderColor: color }}>
          <span className="text-ink-faint">TX</span>
          <a
            className="text-accent underline underline-offset-4 hover:text-ink"
            href={explorerMessageUrl(decision.txHash)}
            target="_blank"
            rel="noreferrer"
          >
            {truncateMiddle(decision.txHash, 14, 10)}
          </a>
          <span className="text-ink-faint">&rarr; filfox</span>
        </div>
      )}

      <div
        className="border-t px-4 py-2 font-sans text-[12px]"
        style={{ borderColor: color, color }}
      >
        {decision.error ?? "No error detail was recorded."}
      </div>
    </li>
  );
}

function ActionCard({ decision }: { decision: Decision }) {
  const color = ACTION_VAR[decision.action];
  const outcome = OUTCOME_STYLE[decision.outcome];

  return (
    <li
      className="enter border bg-panel-2"
      style={{ borderColor: color, boxShadow: `inset 4px 0 0 0 ${color}` }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2">
        <span className="tnum text-[12px] text-ink-dim">{formatClock(decision.at)}</span>
        <span
          className="px-2 py-0.5 text-[12px] font-black tracking-[0.16em]"
          style={{ background: color, color: "#05070c" }}
        >
          {ACTION_LABEL[decision.action]}
        </span>
        <span className="text-[11px] tracking-[0.14em] text-ink-dim">
          {ruleLabel(decision.ruleFired)}
        </span>
        <span className="ml-auto flex items-center gap-3">
          <span className="tnum text-[12px]" style={{ color }}>
            {decision.snapshot.daysRemaining.toFixed(2)}d
          </span>
          <span
            className="border px-2 py-0.5 text-[10px] font-bold tracking-[0.16em]"
            style={{ borderColor: outcome.color, color: outcome.color }}
          >
            {outcome.label}
          </span>
        </span>
      </div>

      <p className="px-4 py-3 font-sans text-[14px] leading-relaxed text-ink">
        {decision.reasoning}
      </p>

      {decision.txHash && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2 text-[12px]">
          <span className="text-ink-faint">TX</span>
          <a
            className="text-accent underline underline-offset-4 hover:text-ink"
            href={explorerMessageUrl(decision.txHash)}
            target="_blank"
            rel="noreferrer"
          >
            {truncateMiddle(decision.txHash, 14, 10)}
          </a>
          <span className="text-ink-faint">&rarr; filfox</span>
          {decision.ruleFired && (
            <span className="ml-auto tnum text-ink-dim">
              +{decision.ruleFired.topUpAmount} USDFC
            </span>
          )}
        </div>
      )}

      {decision.error && (
        <div className="border-t border-line px-4 py-2 font-sans text-[12px] text-crit">
          {decision.error}
        </div>
      )}
    </li>
  );
}

export const DecisionFeed = memo(function DecisionFeed({
  decisions,
}: {
  decisions: Decision[];
}) {
  const { ref: feedRef, showFade: feedFade } = useScrollFade<HTMLUListElement>(
    decisions.length,
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col border border-line bg-panel">
      <header className="flex shrink-0 items-center justify-between border-b border-line px-4 py-2">
        <h2 className="text-[11px] tracking-[0.28em] text-ink-dim">DECISION LOG</h2>
        <span className="tnum text-[11px] text-ink-faint">{decisions.length} entries</span>
      </header>

      {decisions.length === 0 ? (
        <p className="px-4 py-8 text-center text-[12px] text-ink-faint">
          Waiting for the first sense &rarr; decide cycle&hellip;
        </p>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <ul
            ref={feedRef}
            className="flex min-h-0 max-h-[70vh] flex-1 flex-col gap-2 overflow-y-auto p-3 lg:max-h-none"
          >
            {decisions.map((decision) => {
              // Outcome outranks action: a FAILED decision is a failure whether
              // the agent was holding, topping up or blocked when it broke.
              if (decision.outcome === "FAILED") {
                return <FailureCard key={decision.id} decision={decision} />;
              }
              if (decision.action === "HOLD") {
                return <HoldCard key={decision.id} decision={decision} />;
              }
              if (decision.action === "INSUFFICIENT_FUNDS") {
                return <BlockedCard key={decision.id} decision={decision} />;
              }
              return <ActionCard key={decision.id} decision={decision} />;
            })}
          </ul>
          {/* Without this the last card is sliced flush against the panel
              border and reads as truncated rather than scrollable. */}
          {feedFade && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-8"
              style={SCROLL_FADE_STYLE}
            />
          )}
        </div>
      )}
    </section>
  );
});
