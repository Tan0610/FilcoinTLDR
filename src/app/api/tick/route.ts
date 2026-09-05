import { ensureAgentReady, getStatus, runTick } from "@/lib/agent";
import { authorizeTick } from "@/lib/tickAuth";
import type { ApiError, TickResponse } from "@/lib/types";

export const runtime = "nodejs";
/**
 * Never prerendered, never cached. A GET that can move funds must be evaluated
 * on every request, and its 401 must not be served from an edge cache to the
 * scheduler that is entitled to a 200.
 */
export const dynamic = "force-dynamic";

/**
 * Run one sense -> decide -> act cycle.
 *
 * THE ONLY ENDPOINT THAT CAN SPEND
 * --------------------------------
 * Every other route in this app reads. This one makes the agent evaluate its
 * policy and, if a rule fires, submit a deposit from a funded wallet whose key
 * is in the deployment's environment. On a public URL an unauthenticated
 * version of this is not an API, it is a faucet pointed the wrong way — so it
 * is behind a shared secret, checked in constant time, before anything else
 * runs. See `src/lib/tickAuth.ts` for the model and for why the check is
 * enforced on the deployment but not on localhost.
 *
 * GET as well as POST because that is how a scheduler calls it: a Vercel Cron
 * Job issues a plain GET, carrying `Authorization: Bearer $CRON_SECRET`. POST
 * remains the operator's verb and the one the local RUN TICK button uses.
 * Both run the identical handler — there is no unauthenticated back door on
 * either method.
 */
async function handle(request: Request): Promise<Response> {
  // Authorise FIRST. An unauthenticated caller must not be able to start the
  // agent loop, open a chain adapter or provoke an RPC read by being refused.
  const auth = authorizeTick(request.headers);
  if (!auth.ok) {
    const body: ApiError = { error: auth.error };
    return Response.json(body, {
      status: auth.status,
      headers: { "Cache-Control": "no-store" },
    });
  }

  await ensureAgentReady();

  try {
    // `coalesced` is passed straight through: when a cycle was already running
    // this decision was NOT taken for this request, and a caller that cannot
    // tell the difference would read a stale card as a fresh one.
    const { decision, coalesced } = await runTick();
    const body: TickResponse = { decision, status: await getStatus(), coalesced };
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const body: ApiError = {
      error: error instanceof Error ? error.message : String(error),
    };
    return Response.json(body, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

/** The scheduler's verb. Same handler, same secret, no exceptions. */
export async function GET(request: Request): Promise<Response> {
  return handle(request);
}
