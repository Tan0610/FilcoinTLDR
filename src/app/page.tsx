import { connection } from "next/server";

import { Dashboard } from "@/components/Dashboard";
import { getChainMode } from "@/lib/chain";

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
 */
export default async function Home() {
  await connection();
  return <Dashboard initialMode={getChainMode() === "live" ? "LIVE" : "MOCK"} />;
}
