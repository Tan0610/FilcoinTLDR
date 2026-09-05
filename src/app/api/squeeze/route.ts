import { ensureAgentReady, squeezeRunway } from "@/lib/agent";
import { authorizeSqueeze } from "@/lib/tickAuth";
import type { ApiError, SqueezeResponse } from "@/lib/types";

export const runtime = "nodejs";
/**
 * Never prerendered, never cached. It moves money on every call, and a cached
 * 401 served to an operator entitled to a 200 would be worse than useless.
 */
export const dynamic = "force-dynamic";

/**
 * SQUEEZE RUNWAY — the operator's forced-decision control.
 *
 * WHAT IT IS FOR
 * --------------
 * The agent's real position is around 2,970 days of runway burning about a day
 * per day. No policy threshold will ever fire on that inside a demo, so a judge
 * watching the deployed dashboard sees HOLD forever and cannot tell a working
 * agent from a static page. This endpoint withdraws USDFC from Filecoin Pay
 * back to the agent's own wallet, which genuinely collapses
 * `runwayInEpochs` — the number on the gauge stays a true chain reading, it just
 * becomes a small one, and the agent's next tick has a real crisis to answer.
 *
 * WHOSE ACTION IT IS
 * ------------------
 * A HUMAN's. It creates no `Decision`, touches no rule, and adds nothing to the
 * deposits tile. What it does add is a pinned disclosure on the dashboard
 * saying an operator withdrew funds in this session, so nobody can later mistake
 * the crisis for something the agent did to itself. The autonomy on display is
 * the response, not the squeeze.
 *
 * WHY IT IS BEHIND THE SAME SECRET AS /api/tick — AND A STRICTER RULE
 * -------------------------------------------------------------------
 * The same secret (`CRON_SECRET`), the same constant-time comparison, the same
 * fail-closed 503 when a deployment has none configured. One secret and one
 * comparison means one place to get it wrong.
 *
 * The THRESHOLD for demanding it is not the same, and the difference is the
 * worst case behind each endpoint. `/api/tick` is open locally because the
 * worst an unauthenticated local tick can do is run, a few seconds early, the
 * cycle that was going to run anyway: the agent decides, and anything it spends
 * is capped and is a deposit INTO its own Filecoin Pay account. This endpoint's
 * worst case is money leaving that account, in an amount the caller chose. So
 * `authorizeSqueeze` demands the secret whenever the chain adapter is LIVE —
 * whatever the driver, whatever the host — and only leaves the door open for a
 * local MOCK run, where there are no funds to take. A `next dev` in LIVE mode
 * is a funded wallet on a listening port, and "it is only localhost" is not a
 * boundary the handler can verify. See `src/lib/tickAuth.ts`.
 *
 * The browser never carries that secret. The dashboard's operator controls are
 * inert until a human pastes it into the page, and it lives only in that tab's
 * memory — not `sessionStorage`, not `localStorage`; nothing about it is
 * compiled into the client bundle or rendered into the HTML. See
 * `src/components/OperatorControls.tsx`.
 *
 * POST only. Unlike the tick there is no scheduler that needs a GET, and a
 * GET that withdraws funds is a link that drains a wallet when something
 * prefetches it.
 *
 * AND BEHIND A ROLLING BUDGET
 * ---------------------------
 * Authentication answers "who may call this". It does not answer "how often",
 * and the two are different questions the moment the operator secret is
 * published in the README so judges can drive the live demo themselves. Nothing
 * can be stolen through this endpoint — a withdrawal moves USDFC from Filecoin
 * Pay to the agent's own wallet, both ends the same account — but a caller
 * looping it would walk the balance to nothing, exhaust the agent's own daily
 * deposit allowance answering, and leave a public dashboard showing a true
 * reading of a dead agent.
 *
 * So there is a second bound: at most N withdrawals and M USDFC per rolling
 * 24h, counted from the durable journal, with a reserve floor under the
 * unlocked balance. Reaching it answers 429 with a body naming the limit, what
 * has been used, and when it relaxes — never a generic error, because a judge
 * has to be able to tell a spent budget from a broken deployment. See
 * `src/lib/squeezeGuard.ts`.
 */
export async function POST(request: Request): Promise<Response> {
  // Authorise FIRST, before the agent loop starts or a chain adapter opens, so
  // an unauthenticated caller cannot even provoke an RPC read by being refused.
  const auth = authorizeSqueeze(request.headers);
  if (!auth.ok) {
    const body: ApiError = { error: auth.error };
    return Response.json(body, {
      status: auth.status,
      headers: { "Cache-Control": "no-store" },
    });
  }

  // An absent or malformed body is not an error: it means "use the configured
  // default amount". Only a body that names an unusable amount is refused, and
  // that refusal comes from `planSqueeze` with the number that caused it.
  let requested: string | undefined;
  try {
    const raw = (await request.json()) as unknown;
    if (raw && typeof raw === "object" && "amountUsdfc" in raw) {
      const value = (raw as { amountUsdfc: unknown }).amountUsdfc;
      requested = typeof value === "string" ? value : String(value);
    }
  } catch {
    requested = undefined;
  }

  await ensureAgentReady();

  try {
    const outcome = await squeezeRunway(requested);
    if (!outcome.ok) {
      const body: ApiError = { error: outcome.error };
      return Response.json(body, {
        status: outcome.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const body: SqueezeResponse = outcome.result;
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const body: ApiError = {
      error: error instanceof Error ? error.message : String(error),
    };
    return Response.json(body, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
