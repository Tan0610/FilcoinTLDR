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
  BLOB_ACCESS_ENV,
  BLOB_PREFIX_ENV,
  BLOB_TOKEN_ENV,
  BlobDecisionJournal,
  accessFromUrl,
  blobAccess,
  blobJournalEnabled,
  blobPrefix,
  isAccessMismatch,
  readBlobJournal,
  selectJournal,
  type BlobAccess,
  type BlobGetOptions,
  type BlobIO,
  type BlobPutOptions,
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

/** The store id the SDK would parse out of `TOKEN`. */
const STORE_ID = "teststore";

/**
 * A store with no configured access mode: it accepts either kind of write and
 * serves objects from a host that says nothing about access. That is what the
 * pre-existing tests were written against and it stays the default, so every
 * property asserted below is asserted independently of the access question.
 *
 * Pass `storeAccess` to model a REAL provisioned store instead: URLs then look
 * like the ones `@vercel/blob` builds (`<store>.<access>.blob.vercel-storage.com`),
 * a mismatched write is refused with the message the API actually returns, and
 * a read without the right access and a token is refused outright — which is
 * exactly how a private store defeated the old plain-`fetch` read path.
 */
class FakeBlobStore implements BlobIO {
  readonly objects = new Map<string, StoredBlob>();
  /** Every put, in order, so "was this key rewritten?" is answerable. */
  readonly puts: string[] = [];
  /** The access of every put ATTEMPT, refused ones included. */
  readonly putAccess: BlobAccess[] = [];
  /** Every read's options, so an unauthenticated read is detectable. */
  readonly reads: BlobGetOptions[] = [];
  failWith: Error | null = null;
  private clock = 1_700_000_000_000;

  constructor(readonly storeAccess: BlobAccess | null = null) {}

  private url(pathname: string): string {
    if (this.storeAccess === null) return `https://blob.test/${pathname}`;
    return `https://${STORE_ID}.${this.storeAccess}.blob.vercel-storage.com/${pathname}`;
  }

  async put(
    pathname: string,
    body: string,
    // Optional so a test can seed the store directly, the way another
    // deployment's object would already be there.
    options: BlobPutOptions = { access: this.storeAccess ?? "public" } as BlobPutOptions,
  ): Promise<PutBlobResult> {
    if (this.failWith) throw this.failWith;
    this.putAccess.push(options.access);
    if (this.storeAccess !== null && options.access !== this.storeAccess) {
      // Verbatim shape of the API's own rejection, which is what the write
      // path has to recognise in order to correct itself.
      throw new Error(
        `Vercel Blob: Cannot use ${options.access} access on a ${this.storeAccess} store. ` +
          `The store is configured with ${this.storeAccess} access.`,
      );
    }
    this.puts.push(pathname);
    const existing = this.objects.get(pathname);
    this.clock += 1000;
    this.objects.set(pathname, {
      body,
      uploadedAt: this.clock,
      writes: (existing?.writes ?? 0) + 1,
    });
    return {
      url: this.url(pathname),
      downloadUrl: `${this.url(pathname)}?download=1`,
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
        url: this.url(pathname),
        downloadUrl: `${this.url(pathname)}?download=1`,
        pathname,
        size: blob.body.length,
        uploadedAt: new Date(blob.uploadedAt),
        etag: String(blob.uploadedAt),
      }));
    return { blobs, hasMore: false };
  }

  async fetchText(url: string, options: BlobGetOptions): Promise<string> {
    if (this.failWith) throw this.failWith;
    this.reads.push(options);
    if (this.storeAccess !== null) {
      // A private object is not served to a caller that has not presented the
      // store's credential, and is not addressable on the public host.
      if (options.access !== this.storeAccess) {
        throw new Error(`401 Unauthorized reading ${url} as ${options.access}`);
      }
      if (this.storeAccess === "private" && !options.token) {
        throw new Error(`401 Unauthorized reading ${url} without a token`);
      }
    }
    const pathname = url.replace(/^https:\/\/[^/]+\//, "").split("?")[0];
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
  access: BlobAccess | null = null,
): BlobDecisionJournal {
  return new BlobDecisionJournal({
    mode,
    token: TOKEN,
    prefix: "test/journal",
    io: store,
    instanceId,
    startedAt,
    segmentMaxLines,
    access,
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

/* ---------- private stores ---------- */

/**
 * The bug these pin down.
 *
 * `access: "public"` was hardcoded on every write. The provisioned store is
 * PRIVATE, so the API refused every append with "Cannot use public access on a
 * private store", the journal called `disable()` — and then went on reporting
 * `blob:<key>` as its path, which the deposits tile renders as "from the
 * durable decision log at ...". The store held zero objects while the
 * dashboard claimed a durable record. That is a worse failure than having no
 * journal at all, and every assertion below exists to keep it from returning.
 */
describe("BlobDecisionJournal against a private store", () => {
  it("writes successfully, correcting an access mode it had to guess", async () => {
    const store = new FakeBlobStore("private");
    const journal = journalFor(store, "LIVE", "aaaa", 1_000);

    journal.append(decision("d1", 10));
    await journal.flush();

    // The write landed. Before the fix this was zero objects and a dead journal.
    expect(store.objects.size).toBe(1);
    expect(store.lines()).toHaveLength(1);
    expect(journal.enabled).toBe(true);
    expect(journal.lastError).toBeNull();

    // It got there by being refused once and retrying with the right mode...
    expect(store.putAccess).toEqual(["public", "private"]);
    // ...and the correction is remembered, so it is not re-learned every append.
    expect(journal.resolvedAccess).toEqual({ access: "private", known: true });

    journal.append(decision("d2", 20));
    await journal.flush();
    expect(store.putAccess).toEqual(["public", "private", "private"]);
  });

  it("reads its own records back through an authenticated get", async () => {
    const store = new FakeBlobStore("private");
    const writer = journalFor(store, "LIVE", "bbbb", 2_000);
    writer.append(decision("d1", 10));
    await writer.flush();

    // A second process — the one serving the dashboard — with no memory of the
    // write and no way to reach a private object without the store's token.
    const reader = journalFor(store, "LIVE", "aaaa", 1_000);
    const loaded = await reader.loadAsync();

    expect(loaded.decisions.map((d) => d.id)).toEqual(["d1"]);
    expect(reader.lastError).toBeNull();
    // The read presented the credential and asked for the private object; a
    // plain unauthenticated fetch of `blob.url` is what used to happen here.
    expect(store.reads).toHaveLength(1);
    expect(store.reads[0].access).toBe("private");
    expect(store.reads[0].token).toBe(TOKEN);
    // And it read past the CDN, because the tail segment is rewritten on every
    // append and a 60s-cached copy is one that is missing the last decision.
    expect(store.reads[0].useCache).toBe(false);
  });

  it("detects the store from what it lists, before any write is refused", async () => {
    const store = new FakeBlobStore("private");
    // Something already in the store, written by an earlier deployment.
    const seed = journalFor(store, "LIVE", "bbbb", 2_000, 3, "private");
    seed.append(decision("d0", 5));
    await seed.flush();
    expect(store.putAccess).toEqual(["private"]);

    const journal = journalFor(store, "LIVE", "aaaa", 1_000);
    expect(journal.resolvedAccess.known).toBe(false);

    await journal.loadAsync();
    // One listed object settles it: no probe write, no refused request.
    expect(journal.resolvedAccess).toEqual({ access: "private", known: true });

    journal.append(decision("d1", 10));
    await journal.flush();
    expect(store.putAccess).toEqual(["private", "private"]);
  });

  it("works the same way against a public store", async () => {
    // The correction runs in both directions, so a deployment that pins the
    // wrong mode — or a store that is later re-provisioned — still writes.
    const store = new FakeBlobStore("public");
    const journal = journalFor(store, "LIVE", "aaaa", 1_000, 3, "private");

    journal.append(decision("d1", 10));
    await journal.flush();

    expect(store.putAccess).toEqual(["private", "public"]);
    expect(journal.enabled).toBe(true);
    expect(store.lines()).toHaveLength(1);
    expect(journal.resolvedAccess).toEqual({ access: "public", known: true });
  });

  it("honours an explicit pin, so no request is wasted learning it", async () => {
    const store = new FakeBlobStore("private");
    const journal = journalFor(store, "LIVE", "aaaa", 1_000, 3, "private");

    journal.append(decision("d1", 10));
    await journal.flush();

    expect(store.putAccess).toEqual(["private"]);
    expect(store.lines()).toHaveLength(1);
  });

  it("still disables on a failure that is NOT an access mismatch", async () => {
    // The retry must not swallow real errors into an infinite hopeful loop.
    const store = new FakeBlobStore("private");
    store.failWith = new Error("store suspended");
    const journal = journalFor(store, "LIVE", "aaaa", 1_000);

    journal.append(decision("d1", 10));
    await journal.flush();

    expect(journal.enabled).toBe(false);
    expect(journal.lastError).toContain("store suspended");
  });

  it("lets the ops CLI read a private store with only the token", async () => {
    const store = new FakeBlobStore("private");
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

    // `npm run decisions -- --remote` is the tool that turns "the agent
    // authored this transaction" into something checkable; it has to work
    // against the store the deployment actually has.
    expect(loaded.decisions.map((d) => d.id).sort()).toEqual(["live-1", "mock-1"]);
    expect(loaded.errors).toEqual([]);
    expect(store.reads.every((r) => r.access === "private" && r.token === TOKEN)).toBe(true);
  });
});

/* ---------- a disabled journal must never look live ---------- */

describe("a disabled journal's reported path", () => {
  it("is null, so the dashboard cannot claim a record it is not writing", async () => {
    const store = new FakeBlobStore();
    const journal = journalFor(store, "LIVE", "aaaa", 1_000);

    // While it works, it says where the record is.
    expect(journal.path).toBe("blob:test/journal/live/0000000001000-aaaa-0000.jsonl");

    store.failWith = new Error("Vercel Blob: store suspended");
    journal.append(decision("d1", 10));
    await journal.flush();

    expect(journal.enabled).toBe(false);
    // `depositsTile` renders any non-null path as "from the durable decision
    // log at ...". A disabled journal reporting one is the dashboard asserting
    // durability for records that exist only in this process's memory.
    expect(journal.path).toBeNull();
  });

  it("is null for the access mismatch specifically, if it ever gets that far", async () => {
    const store = new FakeBlobStore("private");
    // A store that refuses BOTH modes: the retry runs and still fails, which is
    // the only remaining way an access problem can disable the journal.
    const journal = new BlobDecisionJournal({
      mode: "LIVE",
      token: TOKEN,
      prefix: "test/journal",
      instanceId: "aaaa",
      startedAt: 1_000,
      io: {
        put: async (_p: string, _b: string, options: BlobPutOptions) => {
          throw new Error(
            `Vercel Blob: Cannot use ${options.access} access on a private store. ` +
              "The store is configured with private access.",
          );
        },
        list: store.list.bind(store),
        fetchText: store.fetchText.bind(store),
      },
    });

    journal.append(decision("d1", 10));
    await journal.flush();

    expect(journal.enabled).toBe(false);
    expect(journal.lastError).toContain("private store");
    expect(journal.path).toBeNull();
  });
});

/* ---------- access resolution helpers ---------- */

describe("access detection", () => {
  it("reads the mode off a Vercel Blob URL, and nothing off any other", () => {
    expect(accessFromUrl("https://abc123.private.blob.vercel-storage.com/x.jsonl")).toBe(
      "private",
    );
    expect(accessFromUrl("https://abc123.public.blob.vercel-storage.com/x.jsonl")).toBe("public");
    // Anything else says nothing, rather than guessing.
    expect(accessFromUrl("https://blob.test/x.jsonl")).toBeNull();
    expect(accessFromUrl("not a url")).toBeNull();
  });

  it("recognises the store's own rejection, in both directions", () => {
    expect(
      isAccessMismatch(
        new Error(
          "Vercel Blob: Cannot use public access on a private store. " +
            "The store is configured with private access.",
        ),
      ),
    ).toBe(true);
    expect(
      isAccessMismatch(new Error("Vercel Blob: Cannot use private access on a public store.")),
    ).toBe(true);
    // A real failure must not be mistaken for one, or the retry masks it.
    expect(isAccessMismatch(new Error("store suspended"))).toBe(false);
    expect(isAccessMismatch(new Error("fetch failed"))).toBe(false);
  });

  it("takes an explicit pin and degrades a typo to detection", () => {
    expect(blobAccess({})).toBeNull();
    expect(blobAccess({ [BLOB_ACCESS_ENV]: "private" })).toBe("private");
    expect(blobAccess({ [BLOB_ACCESS_ENV]: " PUBLIC " })).toBe("public");
    // A misconfiguration must fall back to detecting, NOT to the exact wrong
    // guess this whole mechanism exists to survive.
    expect(blobAccess({ [BLOB_ACCESS_ENV]: "privtae" })).toBeNull();
  });

  it("passes an operator's pin through selectJournal", () => {
    const journal = selectJournal({
      VERCEL: "1",
      FILRUNWAY_MODE: "live",
      [BLOB_TOKEN_ENV]: TOKEN,
      [BLOB_ACCESS_ENV]: "private",
    }) as BlobDecisionJournal;
    expect(journal.resolvedAccess).toEqual({ access: "private", known: true });
  });

  it("leaves the mode to be detected when nothing is pinned", () => {
    const journal = selectJournal({
      VERCEL: "1",
      FILRUNWAY_MODE: "live",
      [BLOB_TOKEN_ENV]: TOKEN,
    }) as BlobDecisionJournal;
    expect(journal.resolvedAccess.known).toBe(false);
  });
});
