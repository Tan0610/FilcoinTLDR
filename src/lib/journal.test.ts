/**
 * Decision journal tests.
 *
 * The journal is the artifact's only evidence of agent authorship, so the
 * properties that matter are the durability ones: a record survives a restart,
 * a crash mid-append costs at most the line that was being written, and a
 * filesystem that refuses to cooperate degrades the agent instead of stopping
 * it. These run against a real temporary directory — mocking `fs` here would
 * test the mock rather than the behaviour under test.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_JOURNAL_PATH,
  JOURNAL_VERSION,
  MOCK_JOURNAL_PATH,
  createJournal,
  emptyLoad,
  emptyTotals,
  hiddenByScope,
  journalPath,
  journalPathFor,
  journalPaths,
  nullJournal,
  parseJournal,
  readJournalFiles,
  totalsFor,
  type JournalRecord,
} from "./journal";
import { MAX_DECISIONS, resetStore } from "./store";
import type { AgentMode, Decision, PolicyRule } from "./types";

/* ---------- fixtures ---------- */

const TOP_UP_RULE: PolicyRule = {
  id: "topup-7d",
  label: "SCHEDULED TOP-UP < 7d",
  thresholdDays: 7,
  action: "TOP_UP",
  topUpAmount: "5",
};

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "dec-1",
    at: 1_756_000_000_000,
    snapshot: {
      takenAt: 1_756_000_000_000,
      epoch: 2_960_000,
      fundsAvailable: "11.33568",
      lockupRate: "0.00041",
      lockupCurrent: "0.84870",
      epochsRemaining: 27_648,
      daysRemaining: 9.6,
      walletUsdfc: "250",
      walletFil: "4.9823",
    },
    ruleFired: TOP_UP_RULE,
    action: "TOP_UP",
    reasoning: "Runway 9.6 days is below the 7-day top-up threshold.",
    outcome: "PENDING",
    ...overrides,
  };
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "filrunway-journal-"));
  file = join(dir, "decisions.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function journal(path = file) {
  return createJournal({ FILRUNWAY_DECISION_LOG: path });
}

/* ---------- configuration ---------- */

const slash = (path: string | null) => path!.replace(/\\/g, "/");

describe("journalPath", () => {
  it("defaults to a DIFFERENT file per mode, so the two streams cannot mix", () => {
    expect(slash(journalPath({ FILRUNWAY_MODE: "live" }))).toContain(DEFAULT_JOURNAL_PATH);
    expect(slash(journalPath({}))).toContain(MOCK_JOURNAL_PATH);
    // …and the LIVE default is the file the existing evidence already lives in.
    expect(slash(journalPath({ FILRUNWAY_MODE: "live" }))).not.toContain(MOCK_JOURNAL_PATH);
  });

  it("resolves either mode's path from any process", () => {
    expect(slash(journalPathFor("LIVE", {}))).toContain(DEFAULT_JOURNAL_PATH);
    expect(slash(journalPathFor("MOCK", { FILRUNWAY_MODE: "live" }))).toContain(
      MOCK_JOURNAL_PATH,
    );
    expect(journalPaths({}).map(slash)).toHaveLength(2);
  });

  it("honours an explicit path, verbatim, in both modes", () => {
    expect(journalPath({ FILRUNWAY_DECISION_LOG: file })).toBe(file);
    expect(journalPath({ FILRUNWAY_DECISION_LOG: file, FILRUNWAY_MODE: "live" })).toBe(file);
    // A shared file is still safe: reads are scoped, not the path.
    expect(journalPaths({ FILRUNWAY_DECISION_LOG: file })).toEqual([file]);
  });

  it("switches persistence off entirely for 'off'", () => {
    expect(journalPath({ FILRUNWAY_DECISION_LOG: "off" })).toBeNull();
    expect(journalPath({ FILRUNWAY_DECISION_LOG: "OFF" })).toBeNull();
    expect(journalPaths({ FILRUNWAY_DECISION_LOG: "off" })).toEqual([]);
    expect(createJournal({ FILRUNWAY_DECISION_LOG: "off" }).enabled).toBe(
      false,
    );
  });

  it("treats an empty value as unset rather than as a path", () => {
    expect(slash(journalPath({ FILRUNWAY_DECISION_LOG: "  " }))).toContain(MOCK_JOURNAL_PATH);
  });
});

/* ---------- append + load ---------- */

describe("append", () => {
  it("creates the directory and writes one JSON line per record", () => {
    const j = journal(join(dir, "nested", "deep", "decisions.jsonl"));
    j.append(decision());
    j.append(decision({ outcome: "EXECUTED", txHash: "0xabc" }));

    const lines = readFileSync(j.path!, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]) as JournalRecord;
    expect(first.v).toBe(JOURNAL_VERSION);
    expect(first.seq).toBe(1);
    expect(first.mode).toBe("MOCK");
    expect(first.decision.outcome).toBe("PENDING");
    expect(JSON.parse(lines[1]).seq).toBe(2);
  });

  it("never rewrites history: the superseded line stays on disk", () => {
    const j = journal();
    j.append(decision());
    j.append(decision({ outcome: "EXECUTED", txHash: "0xabc" }));

    const raw = readFileSync(file, "utf8");
    expect(raw).toContain('"outcome":"PENDING"');
    expect(raw).toContain('"outcome":"EXECUTED"');

    // …but a read resolves to the latest state of each decision.
    const loaded = j.load();
    expect(loaded.decisions).toHaveLength(1);
    expect(loaded.decisions[0].outcome).toBe("EXECUTED");
    expect(loaded.decisions[0].txHash).toBe("0xabc");
  });

  it("stamps LIVE records so they can never be confused with MOCK ones", () => {
    const live = createJournal({
      FILRUNWAY_DECISION_LOG: file,
      FILRUNWAY_MODE: "live",
    });
    live.append(decision());
    expect((JSON.parse(readFileSync(file, "utf8").trim()) as JournalRecord).mode).toBe("LIVE");
  });

  it("carries the whole evidentiary record on every line", () => {
    const j = journal();
    j.append(decision({ outcome: "EXECUTED", txHash: "0xdeadbeef" }));
    const record = JSON.parse(readFileSync(file, "utf8").trim()) as JournalRecord;

    expect(record.decision.id).toBeTruthy();
    expect(record.decision.at).toBeGreaterThan(0);
    expect(record.decision.snapshot.fundsAvailable).toBe("11.33568");
    expect(record.decision.ruleFired?.id).toBe("topup-7d");
    expect(record.decision.action).toBe("TOP_UP");
    expect(record.decision.reasoning).toContain("threshold");
    expect(record.decision.outcome).toBe("EXECUTED");
    expect(record.decision.txHash).toBe("0xdeadbeef");
  });

  it("keeps a sequence that continues across a restart", () => {
    const first = journal();
    first.append(decision({ id: "a" }));
    first.append(decision({ id: "b" }));

    const restarted = journal();
    restarted.load();
    restarted.append(decision({ id: "c" }));

    const seqs = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as JournalRecord).seq);
    expect(seqs).toEqual([1, 2, 3]);
  });
});

describe("load", () => {
  it("is empty and blameless when the file does not exist yet", () => {
    const j = journal();
    const loaded = j.load();
    expect(loaded).toEqual(emptyLoad("MOCK"));
    expect(j.lastError).toBeNull();
    expect(j.enabled).toBe(true);
  });

  it("returns decisions newest first", () => {
    const j = journal();
    j.append(decision({ id: "old", at: 1 }));
    j.append(decision({ id: "new", at: 3 }));
    j.append(decision({ id: "mid", at: 2 }));

    expect(j.load().decisions.map((d) => d.id)).toEqual(["new", "mid", "old"]);
  });

  it("survives a crash mid-append: only the truncated line is lost", () => {
    const j = journal();
    j.append(decision({ id: "a", outcome: "EXECUTED" }));
    j.append(decision({ id: "b" }));
    // Simulate a process killed part-way through writing the third line.
    writeFileSync(file, `${readFileSync(file, "utf8")}{"v":1,"seq":3,"decisi`, "utf8");

    const loaded = j.load();
    expect(loaded.read).toBe(2);
    expect(loaded.skipped).toBe(1);
    expect(loaded.decisions.map((d) => d.id).sort()).toEqual(["a", "b"]);
  });

  it("skips garbage anywhere in the file, not just at the end", () => {
    writeFileSync(
      file,
      [
        "not json at all",
        JSON.stringify({ v: 1, seq: 1, writtenAt: 1, mode: "MOCK", decision: decision({ id: "a" }) }),
        "{}",
        '{"decision":{"id":42}}',
        "",
        JSON.stringify({ v: 1, seq: 2, writtenAt: 2, mode: "MOCK", decision: decision({ id: "b" }) }),
      ].join("\n"),
      "utf8",
    );

    const loaded = journal().load();
    expect(loaded.read).toBe(2);
    expect(loaded.skipped).toBe(3);
    expect(loaded.decisions).toHaveLength(2);
  });

  it("tolerates a file with no trailing newline", () => {
    writeFileSync(
      file,
      JSON.stringify({ v: 1, seq: 1, writtenAt: 1, mode: "MOCK", decision: decision() }),
      "utf8",
    );
    expect(journal().load().read).toBe(1);
  });
});

/* ---------- failure handling ---------- */

describe("failure handling", () => {
  it("disables itself instead of throwing when the path cannot be written", () => {
    // A file where the journal expects a directory: mkdir and append both fail.
    const blocker = join(dir, "blocked");
    writeFileSync(blocker, "not a directory", "utf8");
    const j = journal(join(blocker, "decisions.jsonl"));

    expect(() => j.append(decision())).not.toThrow();
    expect(j.enabled).toBe(false);
    expect(j.lastError).toBeTruthy();
    // And it stays off rather than retrying on every decision.
    expect(() => j.append(decision({ id: "b" }))).not.toThrow();
  });

  it("loads as empty when the path is a directory", () => {
    mkdirSync(join(dir, "adir"));
    const j = journal(join(dir, "adir"));
    expect(j.load().read).toBe(0);
  });
});

describe("nullJournal", () => {
  it("persists nothing and claims nothing", () => {
    const j = nullJournal();
    expect(j.enabled).toBe(false);
    expect(j.path).toBeNull();
    j.append(decision());
    expect(j.load().read).toBe(0);
  });
});

/* ---------- pure helpers ---------- */

describe("parseJournal / totalsFor", () => {
  it("aggregates only EXECUTED decisions into the deposited figure", () => {
    const totals = totalsFor([
      decision({ id: "a", outcome: "EXECUTED", at: 10 }),
      decision({ id: "b", outcome: "FAILED", at: 20 }),
      decision({ id: "c", outcome: "NO_ACTION", ruleFired: null, at: 30 }),
      decision({ id: "d", outcome: "EXECUTED", at: 5 }),
    ]);

    expect(totals.decisions).toBe(4);
    expect(totals.executed).toBe(2);
    expect(totals.depositedUsdfc).toBe("10");
    expect(totals.firstAt).toBe(5);
    expect(totals.lastAt).toBe(30);
  });

  it("counts a decision once however many transitions it went through", () => {
    const text = [
      { id: "a", outcome: "PENDING" as const },
      { id: "a", outcome: "EXECUTED" as const },
      { id: "a", outcome: "EXECUTED" as const },
    ]
      .map((d, i) =>
        JSON.stringify({ v: 1, seq: i, writtenAt: i, mode: "MOCK", decision: decision(d) }),
      )
      .join("\n");

    const loaded = parseJournal(text);
    expect(loaded.read).toBe(3);
    expect(loaded.totals.decisions).toBe(1);
    expect(loaded.totals.executed).toBe(1);
    expect(loaded.totals.depositedUsdfc).toBe("5");
  });

  it("folds onto a baseline without double counting it", () => {
    const base = totalsFor([decision({ id: "a", outcome: "EXECUTED" })]);
    const combined = totalsFor([decision({ id: "b", outcome: "EXECUTED" })], base);
    expect(combined.decisions).toBe(2);
    expect(combined.depositedUsdfc).toBe("10");
  });
});

/* ---------- mode separation ---------- */

/**
 * The shape of the real `data/decisions.jsonl` at the time this was written: a
 * LIVE session's records and an earlier MOCK session's records in one file,
 * because both modes used to share a path. Five simulated top-ups of 15 USDFC
 * and one real top-up of 5, which is how the dashboard came to claim 80 USDFC
 * across 6 transactions when only 5 USDFC across 1 transaction was real.
 */
const REAL_DECISION_ID = "1b2d98ef-4984-482f-b394-498ea99b29a6";
const REAL_TX_HASH = "0x06e27a6a7fd532722727953b8d266f14d8109aaaa2c9edc8645bf17a1a2fcf6b";

function record(mode: AgentMode, seq: number, d: Decision): string {
  return JSON.stringify({ v: 1, seq, writtenAt: 1_756_000_000_000 + seq, mode, decision: d });
}

/** A file holding both modes, as the real one does. */
function writeMixed(path = file): void {
  const lines = [
    // Five simulated top-ups, 15 USDFC each, from an earlier MOCK session.
    ...[0, 1, 2, 3, 4].map((i) =>
      record(
        "MOCK",
        i + 1,
        decision({
          id: `mock-${i}`,
          at: 1_756_000_000_000 + i,
          outcome: "EXECUTED",
          txHash: `0xsimulated${i}`,
          ruleFired: { ...TOP_UP_RULE, label: "SCHEDULED TOP-UP < 7d ×380 DEMO", topUpAmount: "15" },
        }),
      ),
    ),
    // A LIVE hold, and the one real transaction the project's claim rests on.
    record(
      "LIVE",
      6,
      decision({ id: "live-hold", at: 1_756_000_000_010, outcome: "NO_ACTION", ruleFired: null }),
    ),
    record("LIVE", 7, decision({ id: REAL_DECISION_ID, at: 1_756_000_000_020 })),
    record(
      "LIVE",
      8,
      decision({
        id: REAL_DECISION_ID,
        at: 1_756_000_000_020,
        outcome: "EXECUTED",
        txHash: REAL_TX_HASH,
      }),
    ),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

describe("mode-scoped reads", () => {
  it("gives a LIVE journal its own history and none of the simulated spend", () => {
    writeMixed();
    const live = createJournal({ FILRUNWAY_DECISION_LOG: file, FILRUNWAY_MODE: "live" });
    const loaded = live.load();

    // The defect: this used to be 6 transactions and 80 USDFC.
    expect(loaded.totals.executed).toBe(1);
    expect(loaded.totals.depositedUsdfc).toBe("5");
    expect(loaded.totals.decisions).toBe(2);
    expect(loaded.decisions.map((d) => d.id)).toEqual([REAL_DECISION_ID, "live-hold"]);
    expect(loaded.entries.every((e) => e.mode === "LIVE")).toBe(true);
  });

  it("gives a MOCK journal only the simulated spend, and calls it MOCK", () => {
    writeMixed();
    const loaded = journal().load();

    expect(loaded.totals.executed).toBe(5);
    expect(loaded.totals.depositedUsdfc).toBe("75");
    expect(loaded.entries.every((e) => e.mode === "MOCK")).toBe(true);
    expect(loaded.decisions.some((d) => d.id === REAL_DECISION_ID)).toBe(false);
  });

  it("counts what it left out rather than omitting it silently", () => {
    writeMixed();
    const loaded = createJournal({
      FILRUNWAY_DECISION_LOG: file,
      FILRUNWAY_MODE: "live",
    }).load();

    expect(loaded.byMode).toEqual({ MOCK: 5, LIVE: 2 });
    expect(loaded.scope).toBe("LIVE");
    expect(hiddenByScope(loaded)).toBe(5);
    // `read` covers every line in the file, so `seq` cannot drift.
    expect(loaded.read).toBe(8);
  });

  it("deletes nothing: an explicit all-modes read still returns everything", () => {
    writeMixed();
    const everything = journal().load(null);

    expect(everything.decisions).toHaveLength(7);
    expect(hiddenByScope(everything)).toBe(0);
    expect(everything.totals.depositedUsdfc).toBe("80");
    // The real record is still there, still attributable, still LIVE.
    const real = everything.entries.find((e) => e.decision.id === REAL_DECISION_ID);
    expect(real?.mode).toBe("LIVE");
    expect(real?.decision.txHash).toBe(REAL_TX_HASH);
    expect(real?.decision.outcome).toBe("EXECUTED");
  });

  it("never promotes an unstamped record into evidence", () => {
    writeFileSync(
      file,
      [
        JSON.stringify({ v: 1, seq: 1, writtenAt: 1, decision: decision({ id: "legacy" }) }),
        JSON.stringify({ v: 1, seq: 2, writtenAt: 2, mode: "live", decision: decision({ id: "lower" }) }),
      ].join("\n"),
      "utf8",
    );

    const loaded = parseJournal(readFileSync(file, "utf8"), null);
    expect(loaded.byMode).toEqual({ MOCK: 2, LIVE: 0 });
  });

  it("reads both modes' files at once for the ops CLI", () => {
    const mockFile = join(dir, "decisions.mock.jsonl");
    writeMixed();
    writeFileSync(mockFile, record("MOCK", 1, decision({ id: "elsewhere", at: 5 })) + "\n", "utf8");

    const all = readJournalFiles([file, mockFile], null);
    expect(all.files).toEqual([file, mockFile]);
    expect(all.decisions).toHaveLength(8);

    const liveOnly = readJournalFiles([file, mockFile], "LIVE");
    expect(liveOnly.decisions).toHaveLength(2);
    expect(liveOnly.byMode).toEqual({ MOCK: 6, LIVE: 2 });

    const mockOnly = readJournalFiles([file, mockFile], "MOCK");
    // Includes the MOCK records stranded in the LIVE file, so the hint the
    // dashboard prints ("read them with --mode mock") actually finds them.
    expect(mockOnly.decisions.map((d) => d.id)).toContain("mock-0");
    expect(mockOnly.decisions.map((d) => d.id)).toContain("elsewhere");
  });

  it("treats a missing file as an absence and a broken one as an error", () => {
    const missing = join(dir, "not-there.jsonl");
    mkdirSync(join(dir, "adirectory"));

    const load = readJournalFiles([missing, join(dir, "adirectory")], null);
    expect(load.files).toEqual([]);
    expect(load.errors.map((e) => e.path)).toEqual([join(dir, "adirectory")]);
    expect(load.decisions).toEqual([]);
  });
});

/* ---------- the store on top of it ---------- */

describe("store hydration", () => {
  it("restores history across a restart", () => {
    const first = journal();
    first.append(decision({ id: "a", outcome: "EXECUTED", txHash: "0xaaa" }));
    first.append(decision({ id: "b", at: 1_756_000_001_000, outcome: "NO_ACTION" }));

    // A brand new process, pointed at the same file.
    const store = resetStore(journal());

    expect(store.decisions.map((d) => d.id)).toEqual(["b", "a"]);
    expect(store.totals.decisions).toBe(2);
    expect(store.totals.executed).toBe(1);
    expect(store.totals.depositedUsdfc).toBe("5");
    expect(store.lastTickAt).toBe(1_756_000_001_000);
    // …and it says so in the trace, so the restore is visible rather than magic.
    expect(store.events.some((e) => e.type === "log" && e.message.includes("Restored"))).toBe(true);
  });

  it("restores only the current mode's decisions into the feed", () => {
    writeMixed();
    const store = resetStore(
      createJournal({ FILRUNWAY_DECISION_LOG: file, FILRUNWAY_MODE: "live" }),
    );

    // The feed the dashboard renders. No simulated card, and no stale
    // "×380 DEMO" rule label, can appear beside the LIVE ones.
    expect(store.decisions.map((d) => d.id)).toEqual([REAL_DECISION_ID, "live-hold"]);
    expect(store.decisions.some((d) => d.ruleFired?.label.includes("DEMO"))).toBe(false);
    expect(store.totals.executed).toBe(1);
    expect(store.totals.depositedUsdfc).toBe("5");
  });

  it("says in the trace what it did not restore, and where to read it", () => {
    writeMixed();
    const store = resetStore(
      createJournal({ FILRUNWAY_DECISION_LOG: file, FILRUNWAY_MODE: "live" }),
    );

    const note = store.events.find((e) => e.type === "log" && e.message.includes("Restored"));
    const message = note?.type === "log" ? note.message : "";
    expect(message).toContain("Restored 2 LIVE decisions");
    expect(message).toContain("5 MOCK decisions in this file were not restored");
    expect(message).toContain("--mode mock");
  });

  it("keeps a MOCK session's history to itself too", () => {
    writeMixed();
    const store = resetStore(journal());

    expect(store.decisions.every((d) => d.id.startsWith("mock-"))).toBe(true);
    expect(store.totals.depositedUsdfc).toBe("75");
  });

  it("bounds what the UI holds without bounding what the totals cover", () => {
    const j = journal();
    const count = MAX_DECISIONS + 25;
    for (let i = 0; i < count; i += 1) {
      j.append(decision({ id: `d${i}`, at: 1_756_000_000_000 + i, outcome: "EXECUTED" }));
    }

    const store = resetStore(journal());

    expect(store.decisions).toHaveLength(MAX_DECISIONS);
    expect(store.totals.decisions).toBe(count);
    expect(store.totals.executed).toBe(count);
    expect(Number(store.totals.depositedUsdfc)).toBe(count * 5);
  });

  it("keeps the totals whole as decisions age out of the ring", () => {
    const store = resetStore(journal());
    const count = MAX_DECISIONS + 10;
    for (let i = 0; i < count; i += 1) {
      store.upsertDecision(
        decision({ id: `d${i}`, at: 1_756_000_000_000 + i, outcome: "EXECUTED" }),
      );
    }

    expect(store.decisions).toHaveLength(MAX_DECISIONS);
    expect(store.totals.decisions).toBe(count);
    expect(Number(store.totals.depositedUsdfc)).toBe(count * 5);
  });

  it("recounts in place when a decision leaves PENDING", () => {
    const store = resetStore(journal());
    store.upsertDecision(decision({ id: "a", outcome: "PENDING" }));
    expect(store.totals.executed).toBe(0);

    store.upsertDecision(decision({ id: "a", outcome: "EXECUTED", txHash: "0xa" }));
    expect(store.totals.decisions).toBe(1);
    expect(store.totals.executed).toBe(1);
    expect(store.totals.depositedUsdfc).toBe("5");

    // A later FAILED confirmation takes it back out again.
    store.upsertDecision(decision({ id: "a", outcome: "FAILED", txHash: "0xa" }));
    expect(store.totals.executed).toBe(0);
    expect(store.totals.depositedUsdfc).toBe("0");
  });

  it("publishes totals so an open tab never has to re-derive them", () => {
    const store = resetStore(journal());
    store.upsertDecision(decision({ id: "a", outcome: "EXECUTED" }));

    const totalsEvents = store.events.filter((e) => e.type === "totals");
    expect(totalsEvents).toHaveLength(1);
    expect(totalsEvents[0].type === "totals" && totalsEvents[0].totals.executed).toBe(1);
  });

  it("starts clean and silent when persistence is off", () => {
    const store = resetStore(nullJournal());
    expect(store.decisions).toEqual([]);
    expect(store.totals).toEqual(emptyTotals());
    expect(store.events).toEqual([]);
  });
});

/* ---------- standing disclosures ---------- */

/**
 * The restore line is a trace line, and the trace is a rolling window — three
 * minutes of ticks empty it. What must NOT expire is the fact that records
 * exist in the file and were withheld from this view, so that fact is held as
 * store state. These cover the store side; `src/app/api/stream/route.test.ts`
 * covers what a late browser connection actually receives.
 */
describe("store disclosures", () => {
  it("pins what it withheld, with the command that reads it", () => {
    writeMixed();
    const store = resetStore(
      createJournal({ FILRUNWAY_DECISION_LOG: file, FILRUNWAY_MODE: "live" }),
    );

    expect(store.notices.map((n) => n.key)).toEqual(["journal-withheld"]);
    expect(store.notices[0].message).toContain("5 MOCK decisions");
    expect(store.notices[0].message).toContain("withheld from this LIVE view");
    expect(store.notices[0].message).toContain("npm run decisions -- --mode mock");
  });

  it("pins nothing when nothing was withheld", () => {
    const first = journal();
    first.append(decision({ id: "a" }));
    first.append(decision({ id: "b", at: 1_756_000_001_000 }));

    const store = resetStore(journal());

    // The history restored fine; there is simply no omission to declare, and a
    // disclosure of records that do not exist would be a false claim.
    expect(store.decisions).toHaveLength(2);
    expect(store.notices).toEqual([]);
  });

  it("pins a single withheld record in the singular, and points at the one file", () => {
    writeFileSync(
      file,
      [
        record("LIVE", 1, decision({ id: "live-1" })),
        record("MOCK", 2, decision({ id: "mock-1", at: 1_756_000_002_000 })),
      ].join("\n") + "\n",
      "utf8",
    );
    const store = resetStore(
      createJournal({ FILRUNWAY_DECISION_LOG: file, FILRUNWAY_MODE: "live" }),
    );

    expect(store.notices[0].message).toContain("1 MOCK decision in");
    expect(store.notices[0].message).toContain("is withheld");
    expect(store.notices[0].message).toContain(file);
  });

  it("pins an unreadable journal, so a degraded record is not silent", () => {
    mkdirSync(join(dir, "adir"));
    const store = resetStore(journal(join(dir, "adir")));

    expect(store.notices.map((n) => n.key)).toEqual(["journal-unreadable"]);
    expect(store.notices[0].level).toBe("warn");
  });

  it("pins a lost write once, however many decisions follow it", () => {
    const broken = journal(join(dir, "nope", "\0", "decisions.jsonl"));
    const store = resetStore(broken);

    store.upsertDecision(decision({ id: "a" }));
    store.upsertDecision(decision({ id: "b", at: 1_756_000_002_000 }));

    expect(broken.enabled).toBe(false);
    expect(store.notices.filter((n) => n.key === "journal-write-failed")).toHaveLength(1);
    expect(
      store.notices.find((n) => n.key === "journal-write-failed")?.message,
    ).toContain("will not survive a restart");
  });

  it("is idempotent by key, so a repeat can never become noise", () => {
    const store = resetStore(nullJournal());
    const note = { key: "k", level: "info" as const, message: "said once" };

    store.addNotice(note);
    store.addNotice({ ...note, message: "said differently" });

    expect(store.notices).toEqual([note]);
    // One republish, not two: the second call changed nothing.
    expect(store.events.filter((e) => e.type === "notices")).toHaveLength(1);
  });

  it("republishes the whole set so a client replaces rather than appends", () => {
    const store = resetStore(nullJournal());
    store.addNotice({ key: "a", level: "info", message: "one" });
    store.addNotice({ key: "b", level: "warn", message: "two" });

    const published = store.events.filter((e) => e.type === "notices");
    expect(published).toHaveLength(2);
    expect(published[0].type === "notices" && published[0].notices).toHaveLength(1);
    expect(published[1].type === "notices" && published[1].notices).toHaveLength(2);
  });
});

/* ---------- operator withdrawals ---------- */

describe("operator squeeze records", () => {
  const squeeze = (id = "sqz_1", at = 1_756_000_000_000, amountUsdfc = "1") => ({
    id,
    at,
    amountUsdfc,
    txHash: `0x${id}`,
  });

  it("writes a squeeze into the same file and the same sequence as a decision", () => {
    // One ordered history of everything that happened to this account. Reading
    // a withdrawal in its true place among the decisions is what makes "the
    // operator caused this, the agent answered it" checkable months later.
    const j = journal();
    j.append(decision());
    j.appendSqueeze!(squeeze());
    j.append(decision({ id: "dec-2" }));

    const lines = readFileSync(j.path!, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    const parsed = lines.map((line) => JSON.parse(line) as { seq: number; kind?: string });
    expect(parsed.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(parsed.map((r) => r.kind)).toEqual([undefined, "squeeze", undefined]);
  });

  it("reads them back separately from decisions, and never among them", () => {
    const j = journal();
    j.append(decision());
    j.appendSqueeze!(squeeze());

    const load = j.load();
    expect(load.decisions).toHaveLength(1);
    expect(load.squeezes).toEqual([squeeze()]);
    // The disclosure counts and the totals are about DECISIONS. A withdrawal
    // entering either of them would put an operator action into the evidence.
    expect(load.byMode).toEqual({ MOCK: 1, LIVE: 0 });
    expect(load.totals.decisions).toBe(1);
  });

  it("does NOT count a squeeze line as corruption", () => {
    // The line is well-formed and deliberate. Counting it as skipped would have
    // the dashboard reporting unreadable records that do not exist.
    const j = journal();
    j.appendSqueeze!(squeeze());
    expect(j.load().skipped).toBe(0);
    expect(j.load().read).toBe(1);
  });

  it("scopes them by mode, exactly as it scopes decisions", () => {
    const live = createJournal({ FILRUNWAY_DECISION_LOG: file, FILRUNWAY_MODE: "live" });
    const mock = createJournal({ FILRUNWAY_DECISION_LOG: file });
    live.appendSqueeze!(squeeze("sqz_live"));
    mock.appendSqueeze!(squeeze("sqz_mock"));

    expect(live.load().squeezes.map((s) => s.id)).toEqual(["sqz_live"]);
    expect(mock.load().squeezes.map((s) => s.id)).toEqual(["sqz_mock"]);
    expect(live.load(null).squeezes).toHaveLength(2);
  });

  it("keeps the last record for a repeated id, and orders newest first", () => {
    const j = journal();
    j.appendSqueeze!(squeeze("sqz_1", 1_000, "1"));
    j.appendSqueeze!(squeeze("sqz_1", 1_000, "2"));
    j.appendSqueeze!(squeeze("sqz_2", 2_000, "3"));

    const loaded = j.load().squeezes;
    expect(loaded.map((s) => s.id)).toEqual(["sqz_2", "sqz_1"]);
    expect(loaded.at(-1)?.amountUsdfc).toBe("2");
  });

  it("rejects a squeeze line that is missing the fields the cap needs", () => {
    writeFileSync(
      file,
      `${JSON.stringify({ v: 1, kind: "squeeze", seq: 1, mode: "MOCK", squeeze: { id: "" } })}\n`,
      "utf8",
    );
    const load = parseJournal(readFileSync(file, "utf8"));
    expect(load.squeezes).toEqual([]);
    expect(load.skipped).toBe(1);
  });

  it("loads an old file, with no squeeze lines at all, as having none", () => {
    const j = journal();
    j.append(decision());
    expect(j.load().squeezes).toEqual([]);
    expect(emptyLoad().squeezes).toEqual([]);
  });

  it("surfaces them through readJournalFiles, so the ops CLI sees them too", () => {
    const j = journal();
    j.appendSqueeze!(squeeze());
    expect(readJournalFiles([file], null).squeezes).toEqual([squeeze()]);
  });

  it("is a no-op on a journal with persistence switched off", () => {
    const off = nullJournal("LIVE");
    expect(() => off.appendSqueeze!(squeeze())).not.toThrow();
    expect(off.load().squeezes).toEqual([]);
  });
});
