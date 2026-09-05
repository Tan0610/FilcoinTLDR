import { ensureAgentReady, getSnapshot, getStatus } from "@/lib/agent";
import type { SnapshotResponse } from "@/lib/types";

export const runtime = "nodejs";
/**
 * Never prerendered: every response here is a live reading of the agent's own
 * state, and a build-time snapshot served from a cache would be a false one.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  await ensureAgentReady();
  const [snapshot, status] = await Promise.all([getSnapshot(), getStatus()]);
  const body: SnapshotResponse = { snapshot, status };
  return Response.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}
