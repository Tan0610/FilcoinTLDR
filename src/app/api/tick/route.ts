import { ensureAgentLoop, getStatus, runTick } from "@/lib/agent";
import type { ApiError, TickResponse } from "@/lib/types";

export const runtime = "nodejs";

/** Run one sense -> decide -> act cycle on demand (the "RUN TICK" button). */
export async function POST() {
  ensureAgentLoop();
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
    return Response.json(body, { status: 500 });
  }
}
