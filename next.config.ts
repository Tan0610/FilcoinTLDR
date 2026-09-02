import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The Synapse SDK and its core are ESM-only and reach for Node built-ins at
   * runtime. Keeping them external means the server bundle `require`s them from
   * node_modules instead of trying to inline an ESM graph, which is both faster
   * to build and the only arrangement the SDK supports. Nothing here is ever
   * bundled for the browser: the SDK is only reachable through
   * `src/lib/chain/synapse.ts`, which is server-only.
   */
  serverExternalPackages: ["@filoz/synapse-sdk", "@filoz/synapse-core"],

  /**
   * The floating dev-tools badge sits bottom-left, on top of the AGENT TRACE
   * panel, and would appear in any screen recording made from `next dev`.
   */
  devIndicators: false,
};

export default nextConfig;
