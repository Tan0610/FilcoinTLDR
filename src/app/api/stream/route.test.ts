/**
 * SSE connect tests — what a browser actually receives, and when.
 *
 * THE DEFECT THESE EXIST FOR
 * --------------------------
 * The journal restore line is the only place a viewer is told that records of
 * the other mode exist in the file and were deliberately withheld from this
 * view. It was published once, at boot, as an ordinary trace line, and
 * `store.backlog()` replays only the last 40 events. Ticks emit snapshot /
 * decision / totals events continuously, so within a few minutes of uptime the
 * disclosure was unreachable: a judge opening the dashboard later saw
 * "AGENT TRACE: idle…" and no disclosure at all. An omission a viewer cannot
 * see is indistinguishable from a file that never held those records.
 *
 * So the tests below all connect LATE — after enough events to flush the
 * backlog completely — because that is the state the defect lived in and the
 * only state that proves the fix.
 *
 * These drive the real route handler with a real `Request`, so the backlog
 * window, the frame encoding and the connect order are all under test rather
 * than assumed. `loopStarted` is pinned true so `ensureAgentLoop()` cannot
 * schedule timers or reach for a chain adapter.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "./route";
import { getStatus } from "@/lib/agent";
import { createJournal, type JournalRecord } from "@/lib/journal";
import { resetStore, type AgentStore } from "@/lib/store";
import type { AgentEvent, AgentMode, Decision } from "@/lib/types";

/* ---------- fixtures ---------- */

function decision(id: string, at: number): Decision {
  return {
    id,
    at,
    snapshot: {
      takenAt: at,
      epoch: 2_960_000,
      fundsAvailable: "11.33568",
      lockupRate: "0.00041",
      lockupCurrent: "0.84870",
      epochsRemaining: 27_648,
      daysRemaining: 9.6,
      walletUsdfc: "250",
      walletFil: "4.9823",
    },
    ruleFired: null,
    action: "HOLD",
    reasoning: "fixture",
    outcome: "NO_ACTION",
  };
}

function line(mode: AgentMode, seq: number, d: Decision): string {
  const record: JournalRecord = { v: 1, seq, writtenAt: d.at, mode, decision: d };
  return JSON.stringify(record);
}

let dir: string;
let file: string;
let store: AgentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "filrunway-stream-"));
  file = join(dir, "decisions.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A LIVE store over a journal holding `live` LIVE and `mock` MOCK decisions. */
function bootLive(live: number, mock: number, extraLines: string[] = []): AgentStore {
  const lines: string[] = [];
  let seq = 0;
  for (let i = 0; i < live; i += 1) {
    seq += 1;
    lines.push(line("LIVE", seq, decision(`live-${i}`, 1_756_000_000_000 + i)));
  }
  for (let i = 0; i < mock; i += 1) {
    seq += 1;
    lines.push(line("MOCK", seq, decision(`mock-${i}`, 1_756_000_100_000 + i)));
  }
  writeFileSync(file, [...lines, ...extraLines].join("\n") + "\n", "utf8");

  const s = resetStore(
    createJournal({ FILRUNWAY_DECISION_LOG: file, FILRUNWAY_MODE: "live" }),
  );
  // `ensureAgentLoop()` must not schedule timers or touch a chain adapter here.
  s.loopStarted = true;
  return s;
}

/**
 * Age the process past the replay window.
 *
 * `backlog()` keeps the last 40 events and a live tick emits three of them, so
 * this is roughly three minutes of an idle HOLD demo — the point at which the
 * boot messages became unreachable.
 */
function runUntilBacklogFlushed(s: AgentStore, count = 60): void {
  for (let i = 0; i < count; i += 1) s.publishTotals();
}

/**
 * Everything one connection receives on connect, in order.
 *
 * The burst is the replayed backlog plus the single trailing `notices` frame,
 * all written synchronously in `start()`. Reading exactly that many events and
 * then aborting keeps the test off the live tail, which has no timers running
 * and would otherwise block forever.
 */
async function connect(): Promise<AgentEvent[]> {
  const expected = store.backlog().length + 1;
  const controller = new AbortController();
  const response = await GET(
    new Request("http://localhost/api/stream", { signal: controller.signal }),
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: AgentEvent[] = [];
  let buffer = "";

  while (events.length < expected) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split = buffer.indexOf("\n\n");
    while (split >= 0) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      for (const row of frame.split("\n")) {
        if (row.startsWith("data: ")) events.push(JSON.parse(row.slice(6)) as AgentEvent);
      }
      split = buffer.indexOf("\n\n");
    }
  }

  controller.abort();
  await reader.cancel().catch(() => undefined);
  return events;
}

const noticesIn = (events: AgentEvent[]) =>
  events.flatMap((event) => (event.type === "notices" ? event.notices : []));

const logsIn = (events: AgentEvent[]) =>
  events.flatMap((event) => (event.type === "log" ? [event.message] : []));

/* ---------- the defect ---------- */

describe("late connect", () => {
  it("loses the boot trace line once the backlog has rolled over", async () => {
    store = bootLive(2, 5);
    // Present at boot: this is what a viewer used to have to be there for.
    expect(store.events.some((e) => e.type === "log" && e.message.includes("Restored"))).toBe(
      true,
    );
    expect(logsIn(await connect()).some((m) => m.includes("Restored"))).toBe(true);

    runUntilBacklogFlushed(store);

    // …and gone. The replayed window no longer contains a single log line, so
    // the dashboard renders "AGENT TRACE: idle…". Asserted so that a future
    // change to `backlog()` cannot quietly make this test vacuous.
    const late = await connect();
    expect(logsIn(late)).toEqual([]);
    expect(store.events.some((e) => e.type === "log" && e.message.includes("Restored"))).toBe(
      true,
    );
  });

  it("still discloses the withheld records, and how to read them", async () => {
    store = bootLive(2, 5);
    runUntilBacklogFlushed(store);

    const notices = noticesIn(await connect());
    const withheld = notices.find((n) => n.key === "journal-withheld");

    expect(withheld).toBeDefined();
    expect(withheld!.message).toContain("5 MOCK decisions");
    expect(withheld!.message).toContain("withheld from this LIVE view");
    expect(withheld!.message).toContain("npm run decisions -- --mode mock");
    expect(withheld!.message).toContain(file);
  });

  it("delivers the disclosure however long the process has been up", async () => {
    store = bootLive(2, 5);

    // What the client is left holding: the last `notices` frame of the burst.
    const settled = (events: AgentEvent[]) =>
      events.filter((e) => e.type === "notices").at(-1)?.notices;

    const early = settled(await connect());
    runUntilBacklogFlushed(store, 500);
    const late = settled(await connect());

    expect(late).toEqual(early);
    expect(late!.some((n) => n.key === "journal-withheld")).toBe(true);
  });
});

/* ---------- accuracy ---------- */

describe("nothing withheld", () => {
  it("says nothing at all rather than implying records that do not exist", async () => {
    store = bootLive(3, 0);
    runUntilBacklogFlushed(store);

    const events = await connect();
    expect(noticesIn(events)).toEqual([]);
    // The restore itself still happened; only the omission claim is absent.
    expect(store.decisions).toHaveLength(3);
    expect(
      store.events.some(
        (e) => e.type === "log" && /not restored|withheld/i.test(e.message),
      ),
    ).toBe(false);
  });

  it("says nothing when there is no journal to read at all", async () => {
    store = bootLive(0, 0);
    runUntilBacklogFlushed(store);

    expect(noticesIn(await connect())).toEqual([]);
  });

  it("discloses unreadable lines separately from withheld ones", async () => {
    store = bootLive(2, 0, ["{ this is not json", '{"v":1,"seq":9,"mode":"LIVE"}']);
    runUntilBacklogFlushed(store);

    const notices = noticesIn(await connect());
    expect(notices.map((n) => n.key)).toEqual(["journal-skipped"]);
    expect(notices[0].message).toContain("2 unreadable lines");
    expect(notices[0].level).toBe("warn");
  });
});

/* ---------- no noise ---------- */

describe("repeat connections", () => {
  it("restates the disclosure as state, never as another trace line", async () => {
    store = bootLive(2, 5);
    runUntilBacklogFlushed(store);

    const first = await connect();
    const second = await connect();
    const third = await connect();

    for (const events of [first, second, third]) {
      // Exactly one `notices` frame per connect, and no log line to accumulate.
      expect(events.filter((e) => e.type === "notices")).toHaveLength(1);
      expect(logsIn(events)).toEqual([]);
      expect(noticesIn(events)).toHaveLength(1);
    }
    // Identical every time, so a client that replaces its copy shows one row
    // however many times the stream drops and reconnects.
    expect(noticesIn(third)).toEqual(noticesIn(first));
    expect(store.notices).toHaveLength(1);
  });

  it("sends the authoritative set last, after the rolling backlog", async () => {
    store = bootLive(2, 5);
    const events = await connect();

    expect(events.at(-1)?.type).toBe("notices");
    // An older `notices` event may still be sitting in the backlog; the final
    // frame is what the client ends up holding.
    expect(noticesIn(events).at(-1)?.key).toBe("journal-withheld");
  });
});

/* ---------- the other carrier ---------- */

describe("hydrate", () => {
  it("carries the same disclosures on AgentStatus", async () => {
    store = bootLive(2, 5);
    runUntilBacklogFlushed(store);

    const status = await getStatus();
    expect(status.notices).toEqual(store.notices);
    expect(status.notices[0].message).toContain("withheld from this LIVE view");
  });
});
