"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The two things a HUMAN can do to this agent, and the line between them and
 * everything the agent does by itself.
 *
 * WHAT THESE CONTROLS ARE
 * -----------------------
 *   RUN TICK NOW    advances the loop. It causes nothing except the cycle that
 *                   would have run on the next schedule anyway; the decision
 *                   that comes out of it is the agent's.
 *   SQUEEZE RUNWAY  withdraws USDFC from Filecoin Pay back to the agent's own
 *                   wallet. It is the OPERATOR creating a crisis on purpose,
 *                   because the real account has years of runway and would
 *                   otherwise show a judge nothing but HOLD. The funds are not
 *                   spent or lost, the runway that follows is a true reading,
 *                   and the agent's answer to it is the autonomous part.
 *
 * The second one is styled and worded so it cannot be read as the agent acting:
 * its own bordered group labelled OPERATOR, an explicit caption, a two-step
 * arm-then-confirm, and a result line that says what a human just did.
 *
 * WHERE THE SECRET LIVES
 * ----------------------
 * `/api/tick` and `/api/squeeze` both move money, so on a deployment both
 * require `CRON_SECRET`. That secret is NOT in this file, not in the client
 * bundle, and not in the server-rendered HTML — Next.js only inlines
 * `NEXT_PUBLIC_*`, and nothing here reads one. A human pastes it into the input
 * below; it is held in this component's React state and sent as the
 * `x-filrunway-tick-secret` request header. It reaches exactly one origin —
 * this app's own — and it is gone the moment the page unloads.
 *
 * Deliberately NOT persisted to `sessionStorage` or `localStorage`. Keeping it
 * only in memory means a reload cannot resurrect it, a second tab does not
 * inherit it, and nothing on disk in the browser profile has to be cleaned up
 * after a demo. The cost is retyping it after a refresh, which the dashboard
 * does not otherwise need.
 *
 * When `authRequired` is false (local development, where the endpoints are
 * open) the input is not rendered at all, and the buttons behave exactly as the
 * old RUN TICK NOW button did.
 */

/** How long a result line stays on screen before it clears. */
const RESULT_TTL_MS = 12_000;

export interface OperatorControlsProps {
  /** Whether the endpoints demand the shared secret on this deployment. */
  authRequired: boolean;
  /** True while a tick this component started is still running. */
  ticking: boolean;
  /**
   * Runs one cycle. Receives the operator's secret, or "" when none is
   * required; it is the caller's job to put it on the request header.
   */
  onTick: (secret: string) => void;
  /** Withdraws from Filecoin Pay. Resolves to a line to show the operator. */
  onSqueeze: (secret: string) => Promise<string>;
}

export function OperatorControls({
  authRequired,
  ticking,
  onTick,
  onSqueeze,
}: OperatorControlsProps) {
  const [secret, setSecret] = useState("");
  const [armed, setArmed] = useState(false);
  const [squeezing, setSqueezing] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Arming is not a commitment. A squeeze left armed and forgotten must not
  // still be one click from firing several minutes later.
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 8_000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  useEffect(() => {
    if (result === null) return;
    const timer = window.setTimeout(() => setResult(null), RESULT_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [result]);

  const locked = authRequired && secret.trim() === "";
  const busy = ticking || squeezing;

  const runSqueeze = useCallback(async () => {
    setArmed(false);
    setSqueezing(true);
    try {
      const message = await onSqueeze(secret.trim());
      if (mounted.current) setResult(message);
    } finally {
      if (mounted.current) setSqueezing(false);
    }
  }, [onSqueeze, secret]);

  return (
    <div className="flex min-w-0 flex-col gap-1 border-l border-line px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[9px] tracking-[0.26em] text-ink-faint">OPERATOR</span>

        {authRequired && (
          <input
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            placeholder="CRON_SECRET"
            aria-label="Operator secret"
            autoComplete="off"
            spellCheck={false}
            className="w-[130px] border border-line bg-panel-2 px-2 py-1 text-[11px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            title={
              "The deployment's shared secret. It is not in this page — paste it to arm the " +
              "controls. Held in memory for this page only, never stored, and sent as a " +
              "request header to this app's own API."
            }
          />
        )}

        <button
          type="button"
          onClick={() => onTick(secret.trim())}
          disabled={busy || locked}
          title={
            locked
              ? "Paste the deployment's CRON_SECRET to arm this control."
              : "Run one sense → decide → act cycle now instead of waiting for the schedule. " +
                "The decision it produces is the agent's, not yours."
          }
          className="border border-line-bright bg-panel-2 px-3 py-1.5 text-[11px] font-bold tracking-[0.18em] text-ink transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          {ticking ? "RUNNING…" : "RUN TICK NOW"}
        </button>

        <button
          type="button"
          onClick={() => (armed ? void runSqueeze() : setArmed(true))}
          disabled={busy || locked}
          title={
            locked
              ? "Paste the deployment's CRON_SECRET to arm this control."
              : "OPERATOR ACTION. Withdraws USDFC from Filecoin Pay back to the agent's own " +
                "wallet, which really shortens the runway so the policy engine has a real " +
                "crisis to answer. Nothing is spent and nothing is simulated."
          }
          className="border-2 px-3 py-1.5 text-[11px] font-bold tracking-[0.18em] transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          style={
            armed
              ? { borderColor: "var(--crit)", background: "var(--crit)", color: "#05070c" }
              : { borderColor: "var(--crit)", color: "var(--crit)" }
          }
        >
          {squeezing ? "WITHDRAWING…" : armed ? "CONFIRM SQUEEZE" : "SQUEEZE RUNWAY"}
        </button>
      </div>

      {/* The line that keeps the two apart. Always present, never a tooltip:
          a screenshot of this strip has to carry it. */}
      <p className="max-w-[440px] text-[10px] leading-snug text-ink-faint">
        {armed
          ? "Click again to withdraw. This is YOUR action, not the agent's."
          : "SQUEEZE is an operator action that creates the crisis by withdrawing from " +
            "Filecoin Pay. What the agent decides about it is the autonomous part."}
      </p>

      {result && (
        <p className="max-w-[440px] text-[10px] leading-snug" style={{ color: "var(--warn)" }}>
          {result}
        </p>
      )}
    </div>
  );
}
