/**
 * Blob journal tests.
 *
 * The journal is this project's evidence. Moving it off the filesystem is only
 * acceptable if every property that made it evidence survives the move, so
 * these assert exactly those properties against the Blob-backed implementation:
 *
 *   - APPEND-ONLY. A line, once written, is never removed or rewritten away. A
 *     sealed segment is never uploaded again, and a second writer never touches
 *     the first writer's objects — which is the failure mode a single shared
 *     file would have had, and the one an evidence log may not have.
 *   - MOCK/LIVE STAMPING, per record, exactly as on disk.
 *   - MODE-SCOPED READS, including the `byMode` counts that back the
 *     dashboard's "N records were withheld from this view" disclosure.
 *   - NON-FATAL FAILURE. A store that rejects writes disables the journal and
 *     the agent carries on; it never throws into the caller.
 *
 * The store is a map in memory. No token, no network.
 */

import type { ListBlobResult, PutBlobResult } from "@vercel/blob";
import { describe, expect, it } from "vitest";

import {
  BLOB_PREFIX_ENV,
  BLOB_TOKEN_ENV,
  BlobDecisionJournal,
  blobJournalEnabled,
  blobPrefix,
  readBlobJournal,
  selectJournal,
  type BlobIO,
} from "./blobJournal";
import { hiddenByScope } from "./journal";
import type { AgentMode, Decision } from "./types";

const TOKEN = "vercel_blob_rw_TESTSTORE_secret";

/* ---------- an in-memory Blob store ---------- */

interface StoredBlob {
  body: string;
  uploadedAt: number;
  writes: number;
}

class FakeBlobStore implements BlobIO {
  readonly objects = new Map<string, StoredBlob>();
  /** Every put, in order, so "was this key rewritten?" is answerable. */
  readonly puts: string[] = [];
  failWith: Error | null = null;
  private clock = 1_700_000_000_000;

  async put(pathname: string, body: string): Promise<PutBlobResult> {
    if (this.failWith) throw this.failWith;
    this.puts.push(pathname);
    const existing = this.objects.get(pathname);
    this.clock += 1000;
    this.objects.set(pathname, {
      body,
      uploadedAt: this.clock,
      writes: (existing?.writes ?? 0) + 1,
    });
    return {
      url: `https://blob.test/${pathname}`,
      downloadUrl: `https://blob.test/${pathname}?download=1`,
      pathname,
      contentType: "application/x-ndjson",
      contentDisposition: "inline",
    } as PutBlobResult;
  }

  async list(options: { prefix: string }): Promise<ListBlobResult> {
    if (this.failWith) throw this.failWith;
    const blobs = [...this.objects.entries()]
      .filter(([pathname]) => pathname.startsWith(options.prefix))
      .map(([pathname, blob]) => ({
        url: `https://blob.test/${pathname}`,
        downloadUrl: `https://blob.test/${pathname}?download=1`,
        pathname,
        size: blob.body.length,
        uploadedAt: new Date(blob.uploadedAt),
        etag: String(blob.uploadedAt),
      }));
    return { blobs, hasMore: false };
  }

  async fetchText(url: string): Promise<string> {
    if (this.failWith) throw this.failWith;
    const pathname = url.replace("https://blob.test/", "").split("?")[0];
    const blob = this.objects.get(pathname);
    if (!blob) throw new Error(`404 ${pathname}`);
    return blob.body;
  }

  /** Every line currently in the store, whichever segment holds it. */
  lines(): string[] {
    return [...this.objects.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([, blob]) => blob.body.split("\n").filter((line) => line.trim() !== ""));
  }
}

/* ---------- fixtures ---------- */

function decision(id: string, at: number, outcome: Decision["outcome"] = "NO_ACTION"): Decision {
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
    outcome,
  };
}

function journalFor(
  store: FakeBlobStore,
  mode: AgentMode,
  instanceId: string,
  startedAt: number,
  segmentMaxLines = 3,
): BlobDecisionJournal {
  return new BlobDecisionJournal({
    mode,
    token: TOKEN,
    prefix: "test/journal",
    io: store,
    instanceId,
    startedAt,
    segmentMaxLines,
  });
}

/* ---------- tests ---------- */

describe("BlobDecisionJournal writes", () => {
  it("appends without throwing and makes the record readable back", async () => {
    const store = new FakeBlobStore();
    const journal = journalFor(store, "LIVE", "aaaa", 1_000);

    journal.append(decision("d1", 10));
    journal.append(decision("d2", 20));
    await journal.flush();

    expect(store.lines()).toHaveLength(2);
    const loaded = journal.load();
    expect(loaded.decisions.map((d) => d.id)).toEqual(["d2", "d1"]);
  });

  it("stamps every record with the journal's mode", async () => {
    const store = new FakeBlobStore();
    const journal = journalFor(store, "LIVE", "aaaa", 1_000);
    journal.append(decision("d1", 10));
    await journal.flush();

    const record = JSON.parse(store.lines()[0]) as { mode: string; v: number };
    expect(record.mode).toBe("LIVE");
    expect(record.v).toBe(1);
  });

  it("seals a full segment and never writes to it again", async () => {
    const store = new FakeBlobStore();
    const journal = journalFor(store, "LIVE", "aaaa", 1_000, 2);

    for (let i = 1; i <= 5; i += 1) {
      journal.append(decision(`d${i}`, i));
      await journal.flush();
    }

    // Two full segments plus a tail; every line is still there.
    expect(store.lines()).toHaveLength(5);
    const sealed = journal.sealedKeys;
    expect(sealed.length).toBe(2);
    // A sealed object was written the number of times it had lines added, and
    // NOT once more after sealing — that is what makes the history immutable.
    const putsAfterSealing = store.puts.slice(store.puts.lastIndexOf(sealed[1]) + 1);
    expect(putsAfterSealing).not.toContain(sealed[0]);
    expect(putsAfterSealing).not.toContain(sealed[1]);
  });

  it("keeps a decision's later status transitions, superseding on read", async () => {
    const store = new FakeBlobStore();
    const journal = journalFor(store, "LIVE", "aaaa", 1_000);

    journal.append({ ...decision("d1", 10), outcome: "PENDING" });
    journal.append({ ...decision("d1", 10), outcome: "EXECUTED", txHash: "0xabc" });
    await journal.flush();

    // Both lines are on the record — nothing is rewritten...
    expect(store.lines()).toHaveLength(2);
    // ...and the read shows the settled one.
    const loaded = journal.load();
    expect(loaded.decisions).toHaveLength(1);
    expect(loaded.decisions[0].outcome).toBe("EXECUTED");
  });

  it("disables itself, without throwing, when the store rejects a write", async () => {
    const store = new FakeBlobStore();
    store.failWith = new Error("store suspended");
    const journal = journalFor(store, "LIVE", "aaaa", 1_000);

    expect(() => journal.append(decision("d1", 10))).not.toThrow();
    await journal.flush();

    expect(journal.enabled).toBe(false);
    expect(journal.lastError).toContain("store suspended");
    // And it stays quiet from then on, exactly like the file journal.
    expect(() => journal.append(decision("d2", 20))).not.toThrow();
  });
});

describe("BlobDecisionJournal reads", () => {
  it("merges another writer's segments without either overwriting the other", async () => {
    const store = new FakeBlobStore();
    const first = journalFor(store, "LIVE", "aaaa", 1_000);
    const second = journalFor(store, "LIVE", "bbbb", 2_000);

    first.append(decision("d1", 10));
    second.append(decision("d2", 20));
    await Promise.all([first.flush(), second.flush()]);

    // Two writers, two objects, no interleaving and no lost line. This is the
    // property a shared read-modify-write file could not have offered.
    expect(store.objects.size).toBe(2);
    expect(store.lines()).toHaveLength(2);

    const loaded = await first.loadAsync();
    expect(loaded.decisions.map((d) => d.id).sort()).toEqual(["d1", "d2"]);
  });

  it("scopes reads to its own mode and reports what it withheld", async () => {
    const store = new FakeBlobStore();
    const live = journalFor(store, "LIVE", "aaaa", 1_000);
    const mock = journalFor(store, "MOCK", "bbbb", 2_000);

    live.append(decision("live-1", 10));
    mock.append(decision("mock-1", 20));
    mock.append(decision("mock-2", 30));
    await Promise.all([live.flush(), mock.flush()]);

    const loaded = await live.loadAsync();

    // A LIVE process must not be able to total or list a simulated decision...
    expect(loaded.decisions.map((d) => d.id)).toEqual(["live-1"]);
    // ...and must be able to say how many it left out, or the omission is
    // indistinguishable from records that never existed.
    expect(loaded.byMode).toEqual({ LIVE: 1, MOCK: 2 });
    expect(hiddenByScope(loaded)).toBe(2);
  });

  it("reads every mode when explicitly asked, for the ops CLI", async () => {
    const store = new FakeBlobStore();
    const live = journalFor(store, "LIVE", "aaaa", 1_000);
    const mock = journalFor(store, "MOCK", "bbbb", 2_000);
    live.append(decision("live-1", 10));
    mock.append(decision("mock-1", 20));
    await Promise.all([live.flush(), mock.flush()]);

    const loaded = await live.loadAsync(null);
    expect(loaded.decisions.map((d) => d.id).sort()).toEqual(["live-1", "mock-1"]);
  });

  it("survives a corrupt line, counting it rather than losing the file", async () => {
    const store = new FakeBlobStore();
    await store.put("test/journal/live/0000000009999-cccc-0000.jsonl", "{ not json\n");
    const journal = journalFor(store, "LIVE", "aaaa", 1_000);
    journal.append(decision("d1", 10));
    await journal.flush();

    const loaded = await journal.loadAsync();
    expect(loaded.skipped).toBe(1);
    expect(loaded.decisions.map((d) => d.id)).toEqual(["d1"]);
  });

  it("keeps what it last saw when the store becomes unreachable", async () => {
    const store = new FakeBlobStore();
    const writer = journalFor(store, "LIVE", "bbbb", 2_000);
    writer.append(decision("d1", 10));
    await writer.flush();

    const reader = journalFor(store, "LIVE", "aaaa", 1_000);
    expect((await reader.loadAsync()).decisions).toHaveLength(1);

    store.failWith = new Error("network down");
    const again = await reader.loadAsync();
    expect(again.decisions).toHaveLength(1);
    expect(reader.lastError).toContain("network down");
  });
});

describe("readBlobJournal", () => {
  it("reads the whole store for the ops CLI, unscoped", async () => {
    const store = new FakeBlobStore();
    const live = journalFor(store, "LIVE", "aaaa", 1_000);
    const mock = journalFor(store, "MOCK", "bbbb", 2_000);
    live.append(decision("live-1", 10, "EXECUTED"));
    mock.append(decision("mock-1", 20));
    await Promise.all([live.flush(), mock.flush()]);

    const loaded = await readBlobJournal(
      null,
      { [BLOB_TOKEN_ENV]: TOKEN, [BLOB_PREFIX_ENV]: "test/journal" },
      store,
    );

    expect(loaded.decisions.map((d) => d.id).sort()).toEqual(["live-1", "mock-1"]);
    expect(loaded.files).toHaveLength(2);
    expect(loaded.errors).toEqual([]);
  });

  it("reports a missing token as an error rather than as an empty journal", async () => {
    // "There are no records" and "I could not look" must not read the same.
    const loaded = await readBlobJournal(null, {}, new FakeBlobStore());
    expect(loaded.decisions).toEqual([]);
    expect(loaded.errors[0].error).toContain(BLOB_TOKEN_ENV);
  });
});

describe("selectJournal", () => {
  it("keeps the filesystem journal locally, even with a token present", () => {
    // A token in `.env.local` (pulled to read the deployment) must not quietly
    // move the LOCAL record off disk, where `npm run decisions` expects it.
    const journal = selectJournal({
      FILRUNWAY_MODE: "live",
      [BLOB_TOKEN_ENV]: TOKEN,
    });
    expect(journal.synchronous).not.toBe(false);
    expect(journal.path).toContain("decisions.jsonl");
  });

  it("uses Blob on Vercel when a store is connected", () => {
    const journal = selectJournal({
      VERCEL: "1",
      FILRUNWAY_MODE: "live",
      [BLOB_TOKEN_ENV]: TOKEN,
    });
    expect(journal.synchronous).toBe(false);
    expect(journal.path).toContain("blob:");
    expect(journal.mode).toBe("LIVE");
  });

  it("falls back to the filesystem on Vercel with no Blob store", () => {
    // A misconfiguration that then disables itself loudly, rather than a silent
    // switch to a store that does not exist.
    expect(blobJournalEnabled({ VERCEL: "1" })).toBe(false);
    expect(selectJournal({ VERCEL: "1", FILRUNWAY_MODE: "live" }).synchronous).not.toBe(false);
  });

  it("honours FILRUNWAY_DECISION_LOG=off on Vercel too", () => {
    const journal = selectJournal({
      VERCEL: "1",
      [BLOB_TOKEN_ENV]: TOKEN,
      FILRUNWAY_DECISION_LOG: "off",
    });
    expect(journal.enabled).toBe(false);
    expect(journal.path).toBeNull();
  });

  it("defaults the prefix and accepts an override", () => {
    expect(blobPrefix({})).toBe("filrunway/journal");
    expect(blobPrefix({ [BLOB_PREFIX_ENV]: "/custom/place/" })).toBe("custom/place");
  });
});
