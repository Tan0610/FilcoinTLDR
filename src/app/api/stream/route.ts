import { ensureAgentReady } from "@/lib/agent";
import { SSE_HEARTBEAT_MS } from "@/lib/constants";
import { getStore } from "@/lib/store";
import type { AgentEvent } from "@/lib/types";

export const runtime = "nodejs";
/**
 * Never prerendered: every response here is a live reading of the agent's own
 * state, and a build-time snapshot served from a cache would be a false one.
 */
export const dynamic = "force-dynamic";

/**
 * Server-Sent Events feed of every AgentEvent.
 *
 * Replays a short backlog on connect so a page opened mid-demo is not blank,
 * then streams live. A comment heartbeat keeps proxies from closing the socket.
 *
 * THE BACKLOG IS NOT A RECORD
 * ---------------------------
 * `store.backlog()` is the tail of a rolling buffer, and ticks push snapshot /
 * decision / totals events through it continuously — so a startup line is out
 * of reach within a few minutes of uptime. That silently expired the ONE
 * message saying which journal records were withheld from this view: a judge
 * opening the dashboard an hour after boot read "AGENT TRACE: idle…" and the
 * disclosure was simply gone.
 *
 * Standing disclosures are therefore sent as state, in full, on every connect
 * — after the backlog, so this authoritative set can never be overwritten by an
 * older `notices` event that happens to still be in the tail.
 */
export async function GET(request: Request) {
  await ensureAgentReady();

  const store = getStore();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      const send = (event: AgentEvent) => {
        write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
      };

      write(`retry: 3000\n\n`);
      for (const event of store.backlog()) send(event);
      // Whole set, every connect, however old this process is. The client
      // REPLACES its copy with it, so a reconnect restates the disclosure
      // rather than appending a duplicate line to the trace.
      send({
        id: store.nextEventId(),
        at: Date.now(),
        type: "notices",
        notices: store.notices,
      });

      const unsubscribe = store.subscribe(send);
      const heartbeat = setInterval(() => write(`: ping\n\n`), SSE_HEARTBEAT_MS);

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      request.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
