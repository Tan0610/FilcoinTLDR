import { ensureAgentLoop, getSnapshot, getStatus } from "@/lib/agent";
import type { SnapshotResponse } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  ensureAgentLoop();
  const [snapshot, status] = await Promise.all([getSnapshot(), getStatus()]);
  const body: SnapshotResponse = { snapshot, status };
  return Response.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}
