import { connection } from "next/server";

import { Dashboard } from "@/components/Dashboard";
import { getChainMode } from "@/lib/chain";
import { dashboardPollMs, manualTickEnabled } from "@/lib/deployment";

/**
 * The mode badge must be right on the FIRST painted frame.
 *
 * `getChainMode()` is a pure `process.env` read with no chain access, so the
 * server can resolve MOCK / LIVE here and hand it to the client component as a
 * prop. Without it the strip renders its neutral CONNECTING state until
 * `/api/snapshot` resolves — honest, but in LIVE mode that is a real chain read
 * and noticeably slow, and it is the frame a demo recording opens on.
 *
 * `connection()` is what makes the env read happen per REQUEST rather than at
 * build time. Prerendered, this page would bake in whatever FILRUNWAY_MODE was
 * set during `next build`, so a build in mock followed by a `next start` in
 * live would ship a LIVE dashboard badged MOCK — precisely the failure this
 * change exists to remove. `connection()` rather than
 * `export const dynamic = "force-dynamic"` because the route segment config is
 * removed once Cache Components is enabled, and this must not quietly become a
 * no-op if that flag is ever turned on. The page is one component, so
 * rendering it per request costs nothing worth measuring.
 *
 * The same request-time read decides two deployment-shaped things, for the same
 * reason — the answer is in the environment, and it must be the SERVER's
 * answer:
 *
 *   - `manualTick`: whether to offer a RUN TICK button at all. On a public
 *     deployment `/api/tick` needs a shared secret, and the only way a browser
 *     button could send one is if the secret were in the page. It is not, so
 *     the button is not either. See `src/lib/deployment.ts`.
 *   - `pollMs`: whether the dashboard must poll. Locally the SSE stream comes
 *     from the very process running the agent and is authoritative. Under the
 *     cron driver it is not — the tick ran in a different Function instance —
 *     so the page also re-reads the shared journal.
 */
export default async function Home() {
  await connection();
  return (
    <Dashboard
      initialMode={getChainMode() === "live" ? "LIVE" : "MOCK"}
      manualTick={manualTickEnabled()}
      pollMs={dashboardPollMs()}
    />
  );
}
