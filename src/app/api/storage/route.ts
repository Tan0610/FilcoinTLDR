import { ensureAgentReady, getStatus, getStorage } from "@/lib/agent";
import type { ApiError, StorageResponse } from "@/lib/types";

export const runtime = "nodejs";
/**
 * Never prerendered: every response here is a live reading of the agent's own
 * state, and a build-time snapshot served from a cache would be a false one.
 */
export const dynamic = "force-dynamic";

/**
 * What the agent is paying to store: data sets, providers, sizes, piece CIDs.
 *
 * Unlike `/api/snapshot` this is allowed to fail without taking anything else
 * down — the dashboard's gauge and decision feed do not depend on it — so a
 * failed listing is a 503 carrying the message, which the panel prints in place
 * of its rows rather than substituting invented ones.
 */
export async function GET() {
  await ensureAgentReady();
  try {
    const [storage, status] = await Promise.all([getStorage(), getStatus()]);
    const body: StorageResponse = { storage, status };
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const body: ApiError = {
      error: error instanceof Error ? error.message : String(error),
    };
    return Response.json(body, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
