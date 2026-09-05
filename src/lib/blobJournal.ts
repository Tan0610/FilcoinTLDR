/**
 * The decision journal, on Vercel Blob.
 *
 * WHY THE FILE JOURNAL CANNOT SHIP
 * --------------------------------
 * `src/lib/journal.ts` appends to `data/decisions.jsonl`. That file is the
 * single most important artifact this project produces: `bootstrap -- fund 5`
 * and an autonomous TOP_UP are byte-identical on chain, so the ONLY evidence
 * that the agent authored a transaction is the decision recorded before it.
 *
 * A Vercel Function's filesystem is read-only apart from `/tmp`, and `/tmp` is
 * per-instance and discarded. Deployed unchanged, the journal would disable
 * itself on the first append and every claim the dashboard makes about the
 * agent's history would be reduced to whatever one Function instance happened
 * to remember. So the record moves to a durable store.
 *
 * WHY BLOB, AND NOT SOMETHING ELSE
 * --------------------------------
 *   - Neon Postgres would model an append-only log best of all — a table with
 *     an ordering key, atomic inserts, indexed reads. It is also a Marketplace
 *     product to provision, a schema to migrate and a driver to configure, for
 *     a record that is read a handful of times a day.
 *   - Upstash Redis (`RPUSH` / `LRANGE`) is an excellent fit mechanically, and
 *     is likewise a Marketplace product with its own provisioning step.
 *   - Edge Config is read-optimised and written out of band. It is explicitly
 *     not for data that is written at runtime.
 *   - Vercel Blob is first-party, provisioned by creating a store and pasting
 *     no credentials anywhere (`BLOB_READ_WRITE_TOKEN` is injected), and stores
 *     exactly what this journal already is: a text file of JSON lines that a
 *     human can read with `curl` and `jq`. The evidence stays a file.
 *
 * Blob has no append operation, which is the one thing this journal needs, so
 * the semantics are rebuilt on top of it rather than faked:
 *
 * SEGMENTS
 * --------
 * Every writer owns its own segment objects and never touches anyone else's:
 *
 *   filrunway/journal/<mode>/<startedAt>-<instance>-<part>.jsonl
 *
 * An append adds a line to the current segment and re-uploads THAT SEGMENT
 * only. A segment is sealed at `SEGMENT_MAX_LINES` and a new part is started,
 * so the re-upload cost is bounded instead of growing with the whole history,
 * and a sealed segment is never written again.
 *
 * This is what makes it genuinely append-only under concurrency. There is no
 * read-modify-write of a shared object, so two Function instances ticking at
 * the same moment cannot lose each other's lines — the failure mode a single
 * shared file would have had, and the one failure mode an evidence log may not
 * have. Nothing is ever deleted or rewritten in place; a line, once written,
 * stays written.
 *
 * READS
 * -----
 * A read lists the whole prefix — BOTH modes — concatenates the segments and
 * hands the text to `parseJournal()`, which is the same parser the file journal
 * uses. So mode stamping, mode-scoped reads, last-record-wins per decision id,
 * the `byMode` counts behind the "N records withheld" disclosure, and the
 * skipped-line counting all behave exactly as they do locally. Nothing about
 * the record's format changes; only where the bytes live.
 *
 * Segments already seen are not re-fetched: `list()` reports each object's
 * `uploadedAt` and `size`, so a refresh downloads only the tail segment that
 * actually changed.
 *
 * CONFIGURATION
 * -------------
 *   BLOB_READ_WRITE_TOKEN   injected by Vercel when a Blob store is linked.
 *   FILRUNWAY_BLOB_PREFIX   optional; defaults to `filrunway/journal`.
 *
 * With no token this journal is not selected at all and the filesystem journal
 * is used, so local development is untouched.
 */

import type { ListBlobResult, PutBlobResult } from "@vercel/blob";

import { isVercel, type DeploymentEnv } from "./deployment";
import {
  JOURNAL_VERSION,
  createJournal,
  emptyLoad,
  journalMode,
  nullJournal,
  parseJournal,
  type DecisionJournal,
  type JournalEnv,
  type JournalFileError,
  type JournalFilesLoad,
  type JournalLoad,
  type JournalRecord,
  type JournalScope,
} from "./journal";
import type { AgentMode, Decision } from "./types";

/** Where in the store the journal lives. */
export const DEFAULT_BLOB_PREFIX = "filrunway/journal";
export const BLOB_PREFIX_ENV = "FILRUNWAY_BLOB_PREFIX";
export const BLOB_TOKEN_ENV = "BLOB_READ_WRITE_TOKEN";

/**
 * Lines per segment before a new part is started.
 *
 * This is the whole cost model. An append re-uploads its current segment, so
 * the bytes written per append are proportional to this number, not to the
 * length of the history. At ~800 bytes per record, 50 lines caps a re-upload
 * at ~40 KB however long the agent has been running.
 */
export const SEGMENT_MAX_LINES = 50;

/** Blob's minimum cache lifetime is 60s; reads bust it with the upload stamp. */
const CACHE_MAX_AGE_S = 60;

/* ---------- injectable IO, so tests need no network and no token ---------- */

export interface BlobPutOptions {
  access: "public";
  addRandomSuffix: boolean;
  allowOverwrite: boolean;
  contentType: string;
  cacheControlMaxAge: number;
  token: string;
}

export interface BlobListOptions {
  prefix: string;
  cursor?: string;
  token: string;
}

export interface BlobIO {
  put(pathname: string, body: string, options: BlobPutOptions): Promise<PutBlobResult>;
  list(options: BlobListOptions): Promise<ListBlobResult>;
  fetchText(url: string): Promise<string>;
}

/** The real thing. Imported lazily so nothing loads the SDK in mock mode. */
export function liveBlobIO(): BlobIO {
  return {
    async put(pathname, body, options) {
      const { put } = await import("@vercel/blob");
      return put(pathname, body, options);
    },
    async list(options) {
      const { list } = await import("@vercel/blob");
      return list(options);
    },
    async fetchText(url) {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText} reading ${url}`);
      }
      return response.text();
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function randomId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface BlobJournalOptions {
  mode: AgentMode;
  token: string;
  prefix?: string;
  io?: BlobIO;
  /** Overridden in tests so segment keys are deterministic. */
  instanceId?: string;
  startedAt?: number;
  segmentMaxLines?: number;
}

/** One remote segment as last seen, so an unchanged one is not re-fetched. */
interface SeenSegment {
  text: string;
  uploadedAt: number;
  size: number;
}

/**
 * Append-only decision journal backed by Vercel Blob.
 *
 * `append()` stays synchronous and non-throwing, exactly like the file journal:
 * the line is added to this writer's segment immediately and the upload is
 * queued behind any upload already running. A write that fails disables the
 * journal and records why, and the agent carries on in memory — the same
 * best-effort contract `store.ts` was already written against.
 */
export class BlobDecisionJournal implements DecisionJournal {
  readonly mode: AgentMode;
  readonly synchronous = false;

  private readonly io: BlobIO;
  private readonly token: string;
  private readonly prefix: string;
  private readonly instanceId: string;
  private readonly startedAt: number;
  private readonly maxLines: number;

  /** Lines this writer has appended to the current (unsealed) segment. */
  private lines: string[] = [];
  private part = 0;
  private seq = 0;

  /** Remote segments, keyed by pathname. Excludes this writer's own segments. */
  private seen = new Map<string, SeenSegment>();
  /** Sealed segments this writer has already uploaded, in order. */
  private sealed: string[] = [];

  private on = true;
  private error: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private queued = false;

  constructor(options: BlobJournalOptions) {
    this.mode = options.mode;
    this.token = options.token;
    this.prefix = options.prefix ?? DEFAULT_BLOB_PREFIX;
    this.io = options.io ?? liveBlobIO();
    this.instanceId = options.instanceId ?? randomId();
    this.startedAt = options.startedAt ?? Date.now();
    this.maxLines = options.segmentMaxLines ?? SEGMENT_MAX_LINES;
  }

  /** The object this writer is currently appending to. */
  get key(): string {
    return this.segmentKey(this.part);
  }

  /**
   * What `AgentStatus.journalPath` reports. A `blob:` scheme rather than a bare
   * path so nobody reads it as a file on a disk that does not exist.
   */
  get path(): string {
    return `blob:${this.key}`;
  }

  get enabled(): boolean {
    return this.on;
  }

  get lastError(): string | null {
    return this.error;
  }

  private segmentKey(part: number): string {
    const started = String(this.startedAt).padStart(13, "0");
    const index = String(part).padStart(4, "0");
    return `${this.prefix}/${this.mode.toLowerCase()}/${started}-${this.instanceId}-${index}.jsonl`;
  }

  private disable(error: unknown): void {
    this.on = false;
    this.error = errorMessage(error);
  }

  /** Every line this journal knows about: remote segments plus its own. */
  private text(): string {
    const remote = [...this.seen.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, segment]) => segment.text)
      .join("");
    const own = this.lines.length > 0 ? `${this.lines.join("\n")}\n` : "";
    return remote + own;
  }

  /**
   * Scoped to this journal's own mode by default, exactly as the file journal
   * is: a LIVE process must not total or replay a simulated decision, whatever
   * the store holds.
   *
   * Synchronous, so it answers from what `loadAsync()` last fetched. Before the
   * first `loadAsync()` that is this writer's own lines and nothing else.
   */
  load(scope: JournalScope = this.mode): JournalLoad {
    try {
      return parseJournal(this.text(), scope);
    } catch (error) {
      this.error = errorMessage(error);
      return emptyLoad(scope);
    }
  }

  /**
   * Re-read the store. Never throws: an unreachable store loads as whatever
   * was last seen, with the reason kept in `lastError`.
   *
   * Both modes are listed on purpose. Scoping happens in the parser, which is
   * what keeps `byMode` — and therefore the dashboard's "N MOCK decisions were
   * not restored" disclosure — true rather than an artifact of what was read.
   */
  async loadAsync(scope: JournalScope = this.mode): Promise<JournalLoad> {
    try {
      const blobs = await this.listAll();
      const keep = new Map<string, SeenSegment>();

      await Promise.all(
        blobs.map(async (blob) => {
          if (!blob.pathname.endsWith(".jsonl")) return;
          // This writer's own segments are authoritative in memory; re-reading
          // them could only reintroduce a stale copy of what it just wrote.
          if (blob.pathname.startsWith(this.ownPrefix())) return;

          const uploadedAt = blob.uploadedAt.getTime();
          const previous = this.seen.get(blob.pathname);
          if (previous && previous.uploadedAt === uploadedAt && previous.size === blob.size) {
            keep.set(blob.pathname, previous);
            return;
          }
          // The stamp busts the CDN copy of a segment that was just rewritten.
          const url = `${blob.downloadUrl}${blob.downloadUrl.includes("?") ? "&" : "?"}ts=${uploadedAt}`;
          const text = await this.io.fetchText(url);
          keep.set(blob.pathname, { text, uploadedAt, size: blob.size });
        }),
      );

      this.seen = keep;
      this.error = null;
    } catch (error) {
      this.error = errorMessage(error);
    }

    const result = this.load(scope);
    // Continue the sequence rather than restarting it, so a gap in `seq` stays
    // visible as a gap. Counted over every line seen, not just the in-scope ones.
    this.seq = Math.max(this.seq, result.read + result.skipped);
    return result;
  }

  /** The key prefix of this writer's own segments. */
  private ownPrefix(): string {
    return `${this.prefix}/${this.mode.toLowerCase()}/${String(this.startedAt).padStart(13, "0")}-${this.instanceId}-`;
  }

  private async listAll(): Promise<ListBlobResult["blobs"]> {
    const blobs: ListBlobResult["blobs"] = [];
    let cursor: string | undefined;
    do {
      const page: ListBlobResult = await this.io.list({
        prefix: `${this.prefix}/`,
        cursor,
        token: this.token,
      });
      blobs.push(...page.blobs);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return blobs;
  }

  append(decision: Decision): void {
    if (!this.on) return;
    this.seq += 1;
    const record: JournalRecord = {
      v: JOURNAL_VERSION,
      seq: this.seq,
      writtenAt: Date.now(),
      mode: this.mode,
      decision,
    };
    this.lines.push(JSON.stringify(record));
    this.schedule();
  }

  /**
   * Queue an upload of the current segment.
   *
   * Uploads are serialised and coalesced: while one is in flight, further
   * appends do not each queue their own, because the upload reads `this.lines`
   * when it runs and therefore already carries them. That keeps a burst of
   * decisions to two uploads rather than one per line.
   */
  private schedule(): void {
    if (this.queued) return;
    this.queued = true;
    this.queue = this.queue.then(async () => {
      this.queued = false;
      await this.upload();
    });
  }

  private async upload(): Promise<void> {
    if (!this.on || this.lines.length === 0) return;
    const key = this.key;
    const lines = [...this.lines];
    try {
      await this.io.put(key, `${lines.join("\n")}\n`, {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/x-ndjson",
        cacheControlMaxAge: CACHE_MAX_AGE_S,
        token: this.token,
      });
    } catch (error) {
      this.disable(error);
      return;
    }

    if (lines.length >= this.maxLines) {
      // Seal it. The uploaded object is now final and will never be written
      // again; its text moves into `seen` so reads keep returning it.
      this.seen.set(key, {
        text: `${lines.join("\n")}\n`,
        uploadedAt: Date.now(),
        size: 0,
      });
      this.sealed.push(key);
      this.lines = this.lines.slice(lines.length);
      this.part += 1;
      if (this.lines.length > 0) this.schedule();
    }
  }

  /** Wait for every queued upload to reach the store. Never throws. */
  async flush(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  /** Segments this writer has sealed. Exposed for tests and diagnostics. */
  get sealedKeys(): readonly string[] {
    return this.sealed;
  }
}

/* ---------- reading a deployed journal from anywhere ---------- */

/**
 * Read the whole Blob journal, from any process holding the store's token.
 *
 * This is what keeps `npm run decisions` working against a deployment: the ops
 * CLI is the tool that turns "the agent authored this transaction" from an
 * assertion into something checkable, and it would be worth very little if it
 * could only ever read the developer's laptop. Given
 * `BLOB_READ_WRITE_TOKEN` — which `vercel env pull` writes into `.env.local` —
 * `npm run decisions -- --remote` reads exactly the records the deployed agent
 * wrote, through the same parser, with the same mode scoping.
 *
 * Shaped as a `JournalFilesLoad` so the CLI's listing, evidence section and
 * scope disclosures work on it unchanged; `files` carries blob pathnames rather
 * than filesystem paths. Never throws.
 */
export async function readBlobJournal(
  scope: JournalScope,
  env: DeploymentEnv = process.env,
  io: BlobIO = liveBlobIO(),
): Promise<JournalFilesLoad> {
  const token = blobToken(env);
  const prefix = blobPrefix(env);
  const files: string[] = [];
  const errors: JournalFileError[] = [];

  if (token === null) {
    return {
      ...emptyLoad(scope),
      files,
      errors: [
        {
          path: `blob:${prefix}/`,
          error: `${BLOB_TOKEN_ENV} is not set. Run \`vercel env pull .env.local\` first.`,
        },
      ],
    };
  }

  const found: { pathname: string; url: string }[] = [];
  try {
    let cursor: string | undefined;
    do {
      const page = await io.list({ prefix: `${prefix}/`, cursor, token });
      for (const blob of page.blobs) {
        if (!blob.pathname.endsWith(".jsonl")) continue;
        const stamp = blob.uploadedAt.getTime();
        const sep = blob.downloadUrl.includes("?") ? "&" : "?";
        found.push({ pathname: blob.pathname, url: `${blob.downloadUrl}${sep}ts=${stamp}` });
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  } catch (error) {
    return {
      ...emptyLoad(scope),
      files,
      errors: [{ path: `blob:${prefix}/`, error: errorMessage(error) }],
    };
  }

  found.sort((a, b) => a.pathname.localeCompare(b.pathname));

  const texts: string[] = [];
  for (const segment of found) {
    try {
      texts.push(await io.fetchText(segment.url));
      files.push(`blob:${segment.pathname}`);
    } catch (error) {
      errors.push({ path: `blob:${segment.pathname}`, error: errorMessage(error) });
    }
  }

  return { ...parseJournal(texts.join(""), scope), files, errors };
}

/* ---------- selection ---------- */

/** The token this deployment has for the Blob store, or null. */
export function blobToken(env: DeploymentEnv = process.env): string | null {
  const raw = env[BLOB_TOKEN_ENV]?.trim();
  return raw ? raw : null;
}

/** Where in the store this deployment keeps its journal. */
export function blobPrefix(env: DeploymentEnv = process.env): string {
  const raw = env[BLOB_PREFIX_ENV]?.trim().replace(/^\/+|\/+$/g, "");
  return raw ? raw : DEFAULT_BLOB_PREFIX;
}

/**
 * Whether the durable record should live in Blob rather than on disk.
 *
 * Deliberately BOTH conditions. Running on Vercel without a Blob store is a
 * misconfiguration worth surfacing (the journal disables itself loudly and the
 * dashboard pins the warning) rather than silently writing to a `/tmp` that is
 * about to be discarded. Holding a token locally must NOT quietly move the
 * local record off the filesystem, because `npm run decisions` and every
 * reference to `data/decisions.jsonl` expect it there.
 */
export function blobJournalEnabled(env: DeploymentEnv = process.env): boolean {
  return isVercel(env) && blobToken(env) !== null;
}

/**
 * The journal this process should use.
 *
 * Local (and any non-Vercel host) gets exactly what it got before: the
 * filesystem journal from `createJournal()`, with its per-mode default paths
 * and its `off` switch. Nothing about the local workflow changes.
 */
export function selectJournal(env: JournalEnv & DeploymentEnv = process.env): DecisionJournal {
  if (!blobJournalEnabled(env)) return createJournal(env);

  const mode = journalMode(env);
  if (env.FILRUNWAY_DECISION_LOG?.trim().toLowerCase() === "off") return nullJournal(mode);

  return new BlobDecisionJournal({
    mode,
    token: blobToken(env)!,
    prefix: blobPrefix(env),
  });
}
