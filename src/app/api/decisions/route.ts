import { ensureAgentLoop, getStatus } from "@/lib/agent";
import { getStore } from "@/lib/store";
import type { DecisionsResponse } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(request: Request) {
  ensureAgentLoop();
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? "50");
  const store = getStore();
  const body: DecisionsResponse = {
    decisions: store.decisions.slice(0, Number.isFinite(limit) ? limit : 50),
    status: await getStatus(),
  };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
