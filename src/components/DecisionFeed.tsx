"use client";

import { memo } from "react";

import { EXPLORER_NAME, decisionTxUrl } from "@/lib/explorer";
import {
  ACTION_LABEL,
  ACTION_VAR,
  formatClock,
  ruleLabel,
  truncateMiddle,
} from "@/lib/format";
import { isDepositAction } from "@/lib/policy";
import type { AgentMode, Decision, DecisionOutcome } from "@/lib/types";
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
 * The two ways the agent DECLINES, and how each is dressed.
 *
 * They share a card because they are the same kind of event — a rule fired, the
 * agent recognised a constraint, and nothing was submitted — but they must not
 * look identical, because one needs a human and the other does not:
 *
 *   - INSUFFICIENT_FUNDS is red and asks for an operator. The agent is stuck
 *     until someone funds the wallet.
 *   - SAFETY_CAP is amber and asks for nobody. The agent applied a limit it was
 *     given, on purpose, and will resume of its own accord when the window
 *     rolls. Painting that in alarm-red would misreport a working safety
 *     feature as a fault.
 */
const DECLINE_STYLE = {
  INSUFFICIENT_FUNDS: {
    color: ACTION_VAR.INSUFFICIENT_FUNDS,
    wash: "rgba(255, 77, 99, 0.08)",
    pill: "BLOCKED",
    footer:
      "Operator action required — fund the agent wallet. No transaction was attempted.",
  },
  SAFETY_CAP: {
    color: ACTION_VAR.SAFETY_CAP,
    wash: "rgba(255, 182, 46, 0.08)",
    pill: "CAPPED",
    footer:
      "Self-imposed limit — the agent declined to spend and will resume when the window " +
      "rolls. No operator action required, and no transaction was attempted.",
  },
  /**
   * A prune the agent DECIDED on and was not permitted to carry out.
   *
   * Reached only when `outcome` is NO_ACTION: an executed prune is an
   * ActionCard, because it did something. This card exists so the withheld case
   * is visibly a decision rather than a gap — the agent worked out that a data
   * set was not earning its cost and said so, and the deployment declined to
   * let it act. Amber rather than red: nothing is broken and nobody needs to
   * rush, the capability is simply not armed.
   */
  PRUNE_DATASET: {
    color: "var(--warn)",
    wash: "rgba(255, 182, 46, 0.08)",
    pill: "NOT EXECUTED",
    footer:
      "Decision recorded, execution withheld — terminating a data set is irreversible, so " +
      "it requires the FILRUNWAY_ENABLE_EVICTION opt-in, which is not set. No transaction " +
      "was attempted and the data set is untouched.",
  },
} as const;

type DeclineAction = keyof typeof DECLINE_STYLE;

/**
 * The agent wanted to act and did not. Not a resting state like HOLD and not an
 * executed action like TOP_UP — so it gets its own treatment: a heavy solid
 * rail, a wash, an inverted header bar and an explicit footer saying what
 * happens next. Nothing was submitted; there is no tx row.
 */
function BlockedCard({ decision }: { decision: Decision }) {
  const style = DECLINE_STYLE[decision.action as DeclineAction] ?? DECLINE_STYLE.INSUFFICIENT_FUNDS;
  const color = style.color;

  return (
    <li
      className="enter border-2"
      style={{
        borderColor: color,
        background: `linear-gradient(${style.wash}, ${style.wash}), var(--panel-2)`,
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
            {style.pill}
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
        {style.footer}
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
/**
 * The one clickable piece of evidence on a card, and the one place that decides
 * whether it is clickable at all.
 *
 * A MOCK hash is minted by the mock adapter with `0x${hex(32)}` — well-formed,
 * and corresponding to no transaction on any chain. Linking it sends a reader
 * to a not-found page and, worse, dresses a simulated hash as chain evidence.
 * So in MOCK the hash is still shown — it is what the journal recorded, and
 * `npm run decisions` prints the same string — but as inert text under a
 * SIMULATED tag rather than as an anchor. `decisionTxUrl()` owns that rule;
 * see `src/lib/explorer.ts`.
 */
function TxRow({ decision, mode }: { decision: Decision; mode: AgentMode | null }) {
  const href = decisionTxUrl(decision.txHash, mode);
  const label = truncateMiddle(decision.txHash!, 14, 10);
  return (
    <>
      <span className="text-ink-faint">TX</span>
      {href === null ? (
        <>
          <span className="text-ink-dim">{label}</span>
          <span
            className="text-ink-faint"
            title="Simulated by the mock adapter. No such transaction exists on any chain, so there is nothing to link to."
          >
            &middot; SIMULATED &middot; not on chain
          </span>
        </>
      ) : (
        <>
          <a
            className="text-accent underline underline-offset-4 hover:text-ink"
            href={href}
            target="_blank"
            rel="noreferrer"
          >
            {label}
          </a>
          <span className="text-ink-faint">&rarr; {EXPLORER_NAME}</span>
        </>
      )}
    </>
  );
}

function FailureCard({ decision, mode }: { decision: Decision; mode: AgentMode | null }) {
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
          <TxRow decision={decision} mode={mode} />
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

function ActionCard({ decision, mode }: { decision: Decision; mode: AgentMode | null }) {
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
          <TxRow decision={decision} mode={mode} />
          {/* Only a deposit may print a USDFC figure here. A PRUNE_DATASET card
              also carries `ruleFired` — the top-up it was taken instead of —
              and printing that rule's amount beside a termination hash would
              claim a deposit that never happened. */}
          {decision.ruleFired && isDepositAction(decision.action) && (
            <span className="ml-auto tnum text-ink-dim">
              +{decision.ruleFired.topUpAmount} USDFC
            </span>
          )}
          {decision.action === "PRUNE_DATASET" && decision.target && (
            <span className="ml-auto tnum text-ink-dim">
              data set #{decision.target.dataSetId} cut &middot; no deposit
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
  mode = null,
  journalError = null,
}: {
  decisions: Decision[];
  /**
   * Which adapter produced these records. Decides whether a transaction hash
   * is linked to the explorer or shown as inert, SIMULATED text — see
   * `TxRow`. Defaults to null, which is treated as "not LIVE": withholding a
   * link costs a reader one click, and presenting a fabricated hash as onchain
   * costs the whole claim this project is making.
   */
  mode?: AgentMode | null;
  /**
   * Set when the durable log stopped being written. The count beside the
   * heading is otherwise read as "this is the record", and an empty feed above
   * a failed journal is indistinguishable from an agent that has simply not
   * decided anything yet — which is the reading this panel must not allow.
   */
  journalError?: string | null;
}) {
  const { ref: feedRef, showFade: feedFade } = useScrollFade<HTMLUListElement>(
    decisions.length,
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col border border-line bg-panel">
      <header className="flex shrink-0 items-center justify-between border-b border-line px-4 py-2">
        <h2 className="text-[11px] tracking-[0.28em] text-ink-dim">DECISION LOG</h2>
        {journalError === null ? (
          <span className="tnum text-[11px] text-ink-faint">{decisions.length} entries</span>
        ) : (
          <span
            className="tnum text-[11px] text-warn"
            title={`The durable decision log is not being written (${journalError}). These entries are this process's memory only, and any earlier ones are not shown.`}
          >
            {decisions.length} entries &middot; NOT PERSISTED
          </span>
        )}
      </header>

      {journalError !== null && (
        // Above the list, not inside it: it qualifies every row below — and,
        // when there are no rows, it is the only thing standing between an
        // empty feed and the reading "the agent has decided nothing yet".
        <p className="shrink-0 border-b border-line bg-panel-2 px-4 py-2 text-[11px] text-warn">
          Durable decision log unavailable ({journalError}). Records shown are held in memory by
          this process only; earlier decisions are not recoverable here.
        </p>
      )}

      {decisions.length === 0 ? (
        <p className="px-4 py-8 text-center text-[12px] text-ink-faint">
          {journalError === null
            ? "Waiting for the first sense → decide cycle…"
            : "No decisions in this process's memory — and the durable log is not being written, so this is not evidence that none were taken."}
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
                return <FailureCard key={decision.id} decision={decision} mode={mode} />;
              }
              if (decision.action === "HOLD") {
                return <HoldCard key={decision.id} decision={decision} />;
              }
              // Both declining paths: a rule fired and nothing was submitted.
              // `BlockedCard` tells them apart — see `DECLINE_STYLE`.
              if (
                decision.action === "INSUFFICIENT_FUNDS" ||
                decision.action === "SAFETY_CAP" ||
                // A prune that was decided and withheld. An EXECUTED one falls
                // through to ActionCard, where its tx link belongs.
                (decision.action === "PRUNE_DATASET" && decision.outcome === "NO_ACTION")
              ) {
                return <BlockedCard key={decision.id} decision={decision} />;
              }
              return <ActionCard key={decision.id} decision={decision} mode={mode} />;
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
