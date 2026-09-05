/**
 * The LIVE stamp has to be earned.
 *
 * THE DEFECT THIS PINS DOWN
 * -------------------------
 * `mode` on a journal record is the whole provenance claim: LIVE means "this
 * hash is on Calibration, go and look". It used to be decided by
 * `journalMode()`, which reads `FILRUNWAY_MODE` out of the environment — a
 * statement of intent, not a statement of fact. The adapter that actually
 * produced the decision was never consulted, and the two can disagree inside
 * one process:
 *
 *   - `getChainAdapter()` caches on `globalThis`, so a process that built the
 *     mock adapter before the environment said `live` keeps the mock and gets
 *     a LIVE journal;
 *   - `setChainAdapter()` installs a scripted adapter regardless of the
 *     environment;
 *   - this repo's own `.env` carries `FILRUNWAY_MODE=live`, so any harness
 *     that loads it and runs against the mock is in exactly that state.
 *
 * The mock adapter mints hashes with `0x${hex(32)}`. One of those written
 * under a LIVE stamp is a fabricated onchain claim in the file the whole
 * project asks to be judged on. So: a MOCK adapter's decision may never be
 * journalled as LIVE, whatever the environment says.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MockChainAdapter,
  resetChainAdapter,
  setChainAdapter,
  type ChainAdapter,
} from "./chain";
import { createJournal, stampMode, type JournalRecord } from "./journal";
import { resetStore } from "./store";
import type { AgentMode, Decision } from "./types";

/* ---------- fixtures ---------- */

/** A hash shaped exactly like one the mock adapter invents. */
const SIMULATED_HASH = "0x4e32fb1b669d258647ec924a682feae7d9e4419d830f6980866eac527022a2c9";

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "dec-stamp-1",
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
    ruleFired: null,
    action: "EMERGENCY_TOP_UP",
    reasoning: "Runway below the emergency threshold.",
    outcome: "EXECUTED",
    txHash: SIMULATED_HASH,
    ...overrides,
  };
}

let dir: string;
let previousMode: string | undefined;

function records(path: string): JournalRecord[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JournalRecord);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "filrunway-stamp-"));
  previousMode = process.env.FILRUNWAY_MODE;
  resetChainAdapter();
});

afterEach(() => {
  if (previousMode === undefined) delete process.env.FILRUNWAY_MODE;
  else process.env.FILRUNWAY_MODE = previousMode;
  resetChainAdapter();
  rmSync(dir, { recursive: true, force: true });
});

/* ---------- the rule itself ---------- */

describe("stampMode", () => {
  it("stamps LIVE only when the journal AND the adapter both say LIVE", () => {
    expect(stampMode("LIVE", "LIVE")).toBe("LIVE");
  });

  it("refuses LIVE for a MOCK adapter, however the journal is configured", () => {
    expect(stampMode("LIVE", "MOCK")).toBe("MOCK");
  });

  it("resolves a disagreement downwards in both directions", () => {
    // A real transaction recorded as MOCK loses a claim; a simulated one
    // recorded as LIVE fabricates evidence. Only one of those is survivable.
    expect(stampMode("MOCK", "LIVE")).toBe("MOCK");
    expect(stampMode("MOCK", "MOCK")).toBe("MOCK");
  });
});

/* ---------- the file journal ---------- */

describe("file journal stamping", () => {
  it("stamps a mock-sourced decision MOCK even in a LIVE-configured journal", () => {
    const path = join(dir, "decisions.jsonl");
    const journal = createJournal({ FILRUNWAY_MODE: "live", FILRUNWAY_DECISION_LOG: path });
    expect(journal.mode).toBe("LIVE");

    journal.append(decision(), "MOCK");

    expect(records(path)[0].mode).toBe("MOCK");
  });

  it("still stamps LIVE when the live adapter is the source", () => {
    const path = join(dir, "decisions.jsonl");
    const journal = createJournal({ FILRUNWAY_MODE: "live", FILRUNWAY_DECISION_LOG: path });

    journal.append(decision({ id: "real" }), "LIVE");

    expect(records(path)[0].mode).toBe("LIVE");
  });

  it("stamps an operator squeeze the same way", () => {
    const path = join(dir, "decisions.jsonl");
    const journal = createJournal({ FILRUNWAY_MODE: "live", FILRUNWAY_DECISION_LOG: path });

    journal.appendSqueeze?.(
      { id: "sqz_1", at: 1_756_000_000_000, amountUsdfc: "2", txHash: SIMULATED_HASH },
      "MOCK",
    );

    expect(records(path)[0].mode).toBe("MOCK");
  });

  it("a mock-sourced record is not read back as evidence", () => {
    const path = join(dir, "decisions.jsonl");
    const journal = createJournal({ FILRUNWAY_MODE: "live", FILRUNWAY_DECISION_LOG: path });

    journal.append(decision(), "MOCK");

    // The LIVE journal's own default scope must not see it at all: this is
    // what keeps the dashboard's totals and the evidence listing honest.
    const load = journal.load();
    expect(load.decisions).toHaveLength(0);
    expect(load.byMode).toEqual({ MOCK: 1, LIVE: 0 });
  });
});

/* ---------- end to end, through the store ---------- */

describe("store stamping", () => {
  it("a MOCK adapter's decision can never be journalled as LIVE", () => {
    // Exactly the misconfiguration that produced the bad records: the
    // environment says live, the adapter in force is the mock.
    process.env.FILRUNWAY_MODE = "live";
    setChainAdapter(new MockChainAdapter());

    const path = join(dir, "decisions.jsonl");
    const journal = createJournal({ FILRUNWAY_MODE: "live", FILRUNWAY_DECISION_LOG: path });
    const store = resetStore(journal);

    store.upsertDecision(decision());

    const written = records(path);
    expect(written).toHaveLength(1);
    expect(written[0].mode).toBe("MOCK");
    // And the fabricated hash is still in the record — nothing is deleted,
    // it is simply no longer claimed to be onchain.
    expect(written[0].decision.txHash).toBe(SIMULATED_HASH);
  });

  it("stamps LIVE when the adapter really is the live one", () => {
    process.env.FILRUNWAY_MODE = "live";
    // A stand-in for the Synapse adapter: constructing the real one needs a
    // private key, and this test is about the stamp, not the SDK.
    setChainAdapter({ mode: "LIVE" } as unknown as ChainAdapter);

    const path = join(dir, "decisions.jsonl");
    const journal = createJournal({ FILRUNWAY_MODE: "live", FILRUNWAY_DECISION_LOG: path });
    const store = resetStore(journal);

    store.upsertDecision(decision({ id: "real" }));

    expect(records(path)[0].mode).toBe("LIVE");
  });

  it("stamps MOCK when the adapter cannot be built at all", () => {
    // `getChainAdapter()` throws for FILRUNWAY_MODE=live with no key. A store
    // that cannot find out which chain it is on has not thereby earned LIVE.
    process.env.FILRUNWAY_MODE = "live";
    const previousKey = process.env.FILECOIN_PRIVATE_KEY;
    delete process.env.FILECOIN_PRIVATE_KEY;
    resetChainAdapter();

    const path = join(dir, "decisions.jsonl");
    const journal = createJournal({ FILRUNWAY_MODE: "live", FILRUNWAY_DECISION_LOG: path });
    const store = resetStore(journal);

    store.upsertDecision(decision());

    expect(records(path)[0].mode).toBe("MOCK");
    if (previousKey !== undefined) process.env.FILECOIN_PRIVATE_KEY = previousKey;
  });

  it("an injected source mode overrides nothing upwards", () => {
    const path = join(dir, "decisions.jsonl");
    const journal = createJournal({ FILRUNWAY_MODE: "mock", FILRUNWAY_DECISION_LOG: path });
    const store = resetStore(journal, (): AgentMode => "LIVE");

    store.upsertDecision(decision());

    // The journal is a MOCK journal; a source claiming LIVE cannot promote it.
    expect(records(path)[0].mode).toBe("MOCK");
  });
});
