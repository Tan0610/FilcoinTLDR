import { ensureAgentReady, getStatus } from "@/lib/agent";
import { getStore } from "@/lib/store";
import type { DecisionsResponse } from "@/lib/types";

export const runtime = "nodejs";
/**
 * Never prerendered: every response here is a live reading of the agent's own
 * state, and a build-time snapshot served from a cache would be a false one.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  await ensureAgentReady();
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? "50");
  const store = getStore();
  const body: DecisionsResponse = {
    decisions: store.decisions.slice(0, Number.isFinite(limit) ? limit : 50),
    status: await getStatus(),
  };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
