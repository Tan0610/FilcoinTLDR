# FilRunway — deep dive

The reference companion to [`README.md`](../README.md). The README answers "what is this and can I verify it in two minutes". This file answers everything after that: how the evidence mechanism works, what every module is for, the full environment reference, the deploy runbook, and the long-form rationale behind the honest disclaimers.

Every `path:line` citation here was checked against the tree at the time of writing. Line numbers drift; the symbol names do not, so search for those if a number has moved.

## Contents

- [1. Proving the agent authored a transaction](#1-proving-the-agent-authored-a-transaction)
- [2. The journal: mode scoping, disclosures, `--split`](#2-the-journal-mode-scoping-disclosures---split)
- [3. Architecture in depth](#3-architecture-in-depth)
- [4. The tick, step by step](#4-the-tick-step-by-step)
- [5. The policy engine](#5-the-policy-engine)
- [6. PDP proof state and data-set eviction](#6-pdp-proof-state-and-data-set-eviction)
- [7. The operator squeeze](#7-the-operator-squeeze)
- [8. The agent's own spending cap](#8-the-agents-own-spending-cap)
- [9. The demo timescale](#9-the-demo-timescale)
- [10. Setup reference](#10-setup-reference)
- [11. Deploying to Vercel](#11-deploying-to-vercel)
- [12. What is real and what is not](#12-what-is-real-and-what-is-not)
- [13. Known limitations, in full](#13-known-limitations-in-full)
- [14. Tests](#14-tests)
- [15. Tech stack](#15-tech-stack)
- [16. Repository map](#16-repository-map)

---

## 1. Proving the agent authored a transaction

**Read this before you believe any autonomy claim in this project.**

An autonomous `TOP_UP` and an operator typing `npm run bootstrap -- fund 5` produce **byte-identical** transactions on Filecoin Pay. Nothing on chain records which one moved the money. A transaction hash on Filfox is therefore evidence that *something* deposited USDFC, and evidence of nothing else.

The only thing that separates the two is the `Decision` that preceded the agent's: the reading it was taken from, the rule that fired, the reasoning it wrote, and the tx hash it produced. Those decisions are appended to a durable, append-only JSON Lines file (`src/lib/journal.ts`), and `scripts/decisions.ts` reads it.

```bash
npm run decisions                  # summary + most recent decisions + every tx the agent authored
npm run decisions -- --mode live   # LIVE records only (default: whatever FILRUNWAY_MODE is)
npm run decisions -- --mode mock   # simulated records only
npm run decisions -- --mode all    # both, every row labelled with its mode
npm run decisions -- --limit 100   # show more than the default 20
npm run decisions -- --executed    # only decisions that moved money
npm run decisions -- --id <id>     # ONE decision in full: reading, rule, reasoning, outcome, tx hash
npm run decisions -- --json        # raw {mode, decision} records, for jq
npm run decisions -- --remote      # read the DEPLOYED agent's journal out of Vercel Blob
npm run decisions -- --split       # move historical MOCK records out of the LIVE journal (dry run)
npm run decisions -- --split --write   # actually apply that copy
```

`scripts/decisions.ts` needs **no private key and no running server**. In its default form it reads the local JSONL files and needs no network either. `--remote` points it at the deployed agent's Blob journal instead (`readBlobJournal()`, `src/lib/blobJournal.ts:661`) and needs only `BLOB_READ_WRITE_TOKEN`, which `vercel env pull .env.local` writes — still no private key, still no server. Every other flag behaves identically against either source, because both go through the same parser and the same mode scoping.

The bare form ends with a `transactions the agent authored` block that pairs every tx hash with its Filfox URL, the id of the decision that authored it, and the exact command to expand that decision.

To line the headline transaction up against the decision that produced it:

```bash
npm run decisions -- --executed          # find the decision id next to the hash
npm run decisions -- --id <that id>      # the full record: reading, rule, reasoning, hash
```

The `--id` view prints the Filecoin Pay reading the agent was looking at (epoch, funds available, lockup rate, runway in epochs, wallet balances), the rule that fired with its threshold and amount, the reasoning string the agent generated from those numbers, the outcome, and the hash — which you then paste into Filfox. Hash matches, reading matches, and the record was written *before* the transaction existed.

On the machine that ran the reference demo, the bare form reads (ANSI colour stripped):

```
decision log
------------
  file                   D:\Filecoin_TLDR\data\decisions.jsonl
                         D:\Filecoin_TLDR\data\decisions.mock.jsonl
  showing                LIVE records only
  decisions              1481
  executed               1
  deposited              5 USDFC
  covering               2026-09-02 12:30:30 .. 2026-09-02 18:51:51 UTC
  not shown              12 MOCK decisions (npm run decisions -- --mode mock)

most recent 20 of 1481
----------------------
  taken at            mode action             outcome        runway  tx
  2026-09-02 18:51:51 LIVE HOLD               NO_ACTION    3594.54d  —
  …

transactions the agent authored (LIVE, onchain)
-----------------------------------------------
  0x06e27a6a7fd532722727953b8d266f14d8109aaaa2c9edc8645bf17a1a2fcf6b
  https://calibration.filfox.info/en/message/0x06e27a6a7fd532722727953b8d266f14d8109aaaa2c9edc8645bf17a1a2fcf6b
  decision 1b2d98ef-4984-482f-b394-498ea99b29a6 · 2026-09-02 12:30:30 UTC
  npm run decisions -- --id 1b2d98ef-4984-482f-b394-498ea99b29a6
```

The decision count keeps climbing (a fresh run will show more than 1,481, and a later timestamp) because the agent ticks every 15 seconds and a dev server was running while this was captured — the hash, the decision id and the `deposited 5 USDFC` total are what stay fixed.

**One transaction and 5 USDFC**, not more. That same file also holds MOCK decisions from earlier mock sessions whose simulated top-ups total simulated USDFC — which is exactly why an *unscoped* read of it would have reported several transactions and a much larger figure, and why every read is now scoped. The decision count is whatever the journal holds when you run it and grows with every 15-second tick; the deposit figures do not.

Two caveats, stated up front:

- **`data/` is gitignored, and that no longer confines the evidence to one laptop.** A judge who clones this repo starts with an empty *local* log, and a record produced by a local run still has to be shown from the machine that produced it. The deployed agent, however, writes its journal to Vercel Blob, and `npm run decisions -- --remote` reads exactly those records — same parser, same mode scoping, same `--id`, `--executed` and `--json` views — from any machine holding the store's token. So "the evidence has to come from the operator's laptop" is true of a local run and **not** true of the deployment. Neither form is committed to the repo, because a journal that ships in git is a journal anyone can forge.
- **Records are stamped `MOCK` or `LIVE` per line**, and that stamp is acted on rather than merely written. See the next section.

---

## 2. The journal: mode scoping, disclosures, `--split`

A MOCK decision is a real record of a real decision, but its transaction hash was invented by the mock adapter and is on no chain anywhere. Presenting the two streams in one total is the single misrepresentation this feature exists to prevent, so the mode stamp drives three separate things.

### 2.1 Writes go to separate files by default

With `FILRUNWAY_DECISION_LOG` unset, the path is derived from `FILRUNWAY_MODE` (`journalPathFor()`, `src/lib/journal.ts:529`):

| `FILRUNWAY_MODE` | Journal file | |
|---|---|---|
| `live` | `data/decisions.jsonl` | The evidentiary record. **Unchanged locally**, so every existing reference to that path still resolves on a developer machine. It does **not** resolve on the deployment: a Vercel Function's filesystem is read-only apart from an ephemeral `/tmp`, so the journal is written to Vercel Blob instead and `AgentStatus.journalPath` reports `blob:filrunway/journal/live/…`. |
| `mock` | `data/decisions.mock.jsonl` | Simulated spend, diverted here so it can never be appended into the file above. |

Both are gitignored.

**Leave `FILRUNWAY_DECISION_LOG` unset.** Setting it explicitly points *both* modes at that one file. That is still safe — every record is stamped and every read is scoped, so the dashboard and the CLI stay separated either way — but it re-mixes the two streams into one file, which is the state the per-mode default exists to avoid. Set it to `off` to disable persistence entirely and keep decisions in memory only.

### 2.2 Reads are scoped to the running mode

`FileDecisionJournal.load()` (`src/lib/journal.ts:459`) defaults its scope to the journal's own mode, so a LIVE server replaying a file that also holds MOCK lines gets its own history back and nothing else. The Blob journal behaves identically: it concatenates its segments and hands the text to the same `parseJournal()` (`BlobDecisionJournal.load()`, `src/lib/blobJournal.ts:452`), so mode stamping, scoping, the `byMode` counts and the withheld-records disclosure are unchanged when the bytes move off disk.

Crucially, a record whose `mode` field is missing or unrecognised reads as **MOCK** (`recordMode()`, `src/lib/journal.ts:308`): downgrading an unknown line is the only safe default, because a line must never be promoted into evidence by being unreadable. What the scope leaves out is counted (`byMode`) and disclosed rather than silently dropped.

### 2.3 The dashboard shows one mode and says which

The AUTONOMOUS DEPOSITS tile and the decision feed are both fed from that scoped load, and `depositsTile()` (`src/lib/format.ts:214`) resolves the tile from the mode:

| Mode | Tile |
|---|---|
| LIVE | `AUTONOMOUS DEPOSITS` · `5` `USDFC` · sub-line `1 transaction · N decisions`. Green accent once anything has executed. |
| MOCK | `SIMULATED DEPOSITS` in hazard yellow (`var(--mock)`) · sub-line `MOCK · N sim tx · M decisions`. |
| not yet known | `AUTONOMOUS DEPOSITS` · `—` · `confirming adapter mode…`. Nothing is totalled under a mode nobody has confirmed. |

MOCK is marked in three independent places — the first word of the label, the hazard-yellow accent, and the leading `MOCK ·` of the sub-line — so no crop of a screenshot can hide it. The figure itself is never altered: it is a true count of simulated activity, not a fake count of real activity.

The AGENT TRACE says the same thing in words on startup (`AgentStore.hydrate()`, `src/lib/store.ts:166`, or `hydrateAsync()` at line 175 for a journal whose records have to be fetched). The restore line reads:

```
Restored 1481 LIVE decisions from D:\Filecoin_TLDR\data\decisions.jsonl (1 executed,
5 USDFC deposited). 12 MOCK decisions in this file were not restored (this process is
LIVE); read them with `npm run decisions -- --mode mock`.
```

That second sentence is the point. An omission a viewer cannot see is indistinguishable from a file that never held those records, so the line states how many records were withheld, why they were withheld, and the exact command that reads them.

### 2.4 The disclosure outlives the trace line

That restore line is an ordinary log event, and the trace it lands in is a rolling tail. Within minutes of boot it has scrolled away, and a judge opening the dashboard an hour later would have seen nothing. So the fact it carries is held separately, as state. `discloseOmissions()` (`src/lib/store.ts:313`) raises it as an `AgentNotice` — a key, a level and a message, and nothing else (`src/lib/types.ts:256`):

```
12 MOCK decisions in D:\Filecoin_TLDR\data\decisions.jsonl are withheld from this LIVE
view. Read them with `npm run decisions -- --mode mock`.
```

The same facts as the restore line, said again where they cannot expire. `addNotice()` (`src/lib/store.ts:349`) is idempotent by key and republishes the *whole* current set whenever it grows, and `/api/stream` sends that whole set on every connect *after* the backlog, so an older copy still sitting in the tail can never overwrite the authoritative one (`src/app/api/stream/route.ts`). The client replaces its copy rather than appending to it — `newerNotices()` (`src/lib/decisions.ts:104`) returns the existing array untouched when nothing is newer, so a reconnect restates the disclosure without re-rendering the row. It draws as a `PINNED` row above the rolling AGENT TRACE list, coloured by level (`src/components/Dashboard.tsx`).

Ten disclosures ride that channel, and each is raised behind an explicit conditional:

| Key | Raised when | Where |
|---|---|---|
| `journal-withheld` | the scope hid records of the other mode | `src/lib/store.ts:318` |
| `journal-skipped` | unreadable lines were skipped | `src/lib/store.ts:331` |
| `journal-unreadable` | the journal could not be read at all | `src/lib/store.ts:230` |
| `journal-write-failed` | a journal write failed mid-session | `src/lib/store.ts:443` |
| `journal-off` | persistence is switched off entirely | `src/lib/agent.ts:811` |
| `demo-scale-mismatch` | `FILRUNWAY_DEMO_SCALE` disagrees with its `NEXT_PUBLIC_` twin | `src/lib/agent.ts:833` |
| `driver-cron` | the cycle is driven by a scheduled call to `/api/tick` | `src/lib/agent.ts:847` |
| `spend-cap` | the rolling deposit cap is actually in force | `src/lib/agent.ts:795` |
| `eviction-armed` | `FILRUNWAY_ENABLE_EVICTION` is on, so a prune may execute | `src/lib/agent.ts:802` |
| `operator-squeeze` | a human has withdrawn funds in this session | `src/lib/agent.ts:691` |

The set starts empty, so a clean load in a single-mode journal pins nothing. **Nothing withheld means no notice at all**, which is the whole reason a pinned row is worth believing: it is only ever there because it is true. Claiming a limit that is not being enforced would be worse than silence, which is why `spend-cap` and `eviction-armed` are conditional on the capability actually being armed rather than merely configured.

### 2.5 What `--mode` can and cannot widen

`--mode live|mock|all` selects the scope and defaults to `FILRUNWAY_MODE` (`parseModeArg()`, `src/lib/journalReport.ts:32`). An unrecognised value is an error rather than a silent fallback, because a typo that quietly widened the scope back to "everything" would reintroduce the mixed listing this exists to remove.

- **Every listed row carries a `mode` column, at every scope.** A column that appears only sometimes trains a reader to stop looking for it.
- **A `not shown  N MOCK decisions` line appears whenever the scope hides records**, with the command that shows them (`scopeNotice()`, `src/lib/journalReport.ts:81`). A reader must be able to tell "there are no MOCK records" from "MOCK records exist and you are not looking at them".
- **The `transactions the agent authored (LIVE, onchain)` section can be narrowed but never widened.** It is handed the *whole* file, unscoped, and hard-filters to LIVE-with-a-hash (`evidenceEntries()`, `src/lib/journalReport.ts:55`). MOCK is excluded inside that function rather than by the caller's scope, so no argument, default or later refactor can put a simulated hash in it. At `--mode mock` the section still appears and reads `1 recorded, not listed at --mode mock` — out of scope rather than absent, and the difference is stated.
- **Simulated hashes get their own heading**, `simulated transaction hashes (MOCK — NOT onchain, not evidence)`, rather than being silently dropped.
- **`--id` searches every mode**, so an id that exists never reads as absent just because the current scope excludes it. A MOCK hit is printed under a `SIMULATED — MOCK ADAPTER` warning, its hash is labelled `tx hash (simulated)`, and **no explorer link is printed** — there is nothing on chain to link to.

Both journal files are opened on every run whatever the mode, so the scope decides what is *shown*, never what is *reachable*.

### 2.6 Un-mixing an already-mixed file: `--split`

A journal written before the per-mode split holds both streams. That file is append-only evidence and must not be rewritten, so nothing is done to it automatically. `--split` is the explicit, opt-in way to copy the MOCK records out of the LIVE journal into the MOCK one (`split()`, `scripts/decisions.ts:217`). It is a local-file operation: a Blob journal has nothing to split, because its segment keys carry the mode (`filrunway/journal/<mode>/…`) and the two streams were never in one object to begin with.

```bash
npm run decisions -- --split           # dry run: says what it would copy, writes nothing
npm run decisions -- --split --write   # append them to data/decisions.mock.jsonl
```

The dry run on the reference machine:

```
split MOCK records out of the LIVE journal
------------------------------------------
  source (read only)     D:\Filecoin_TLDR\data\decisions.jsonl
  target                 D:\Filecoin_TLDR\data\decisions.mock.jsonl
  mock lines to copy     11

  Dry run. Nothing was written. Re-run with --split --write to apply.
  D:\Filecoin_TLDR\data\decisions.jsonl is never modified.
```

11 lines for 6 decisions is not a discrepancy: the journal appends a line per *status transition*, so a decision that went PENDING → EXECUTED occupies two. Everything else in the tool counts distinct decisions; this one counts lines, because lines are what it copies.

Guarantees, all of them checkable in that one function:

- **Dry run unless `--write`.** The bare form prints the plan and exits without touching either file.
- **The source is opened read-only and is never modified**, `--write` included. Records are *copied*, not moved: the LIVE journal keeps every line it had.
- **Already-present decision ids are skipped**, so running it twice is a no-op rather than a duplication.
- Each copied line is renumbered into the target's own `seq` and stamped `importedFrom` / `importedAt`, so the duplicate is self-explaining rather than mysterious. The `decision` object itself is untouched.
- It refuses to run when an explicit `FILRUNWAY_DECISION_LOG` has pointed both modes at the same file, or when persistence is off — in neither case is there anything to split into.

Splitting is optional. Scoped reads already keep a mixed file honest; the split only tidies it.

### 2.7 Journal format and segment design

The record is JSON Lines: one JSON object per line, appended, never rewritten. Each line carries the decision's `mode` stamp, a monotonic `seq`, and the `decision` object itself. A decision that changes status — PENDING → EXECUTED, or PENDING → FAILED — is appended **again** rather than edited in place, so the record shows the transition rather than only its endpoint. `parseJournal()` folds those lines back into one decision per id, last write winning, while the raw file keeps the history.

Locally that is `appendFileSync` from one single-threaded process (`src/lib/journal.ts`).

On Vercel there is no such process. `src/lib/blobJournal.ts` rebuilds the same append-only semantics on Vercel Blob:

- **Per-writer segments.** Every writer gets its own object keys, `filrunway/journal/<mode>/<startedAt>-<instance>-<part>.jsonl`, so there is never a read-modify-write of a shared object and two Function instances ticking at the same moment cannot lose each other's lines.
- **Sealed at 50 lines.** A segment stops being appended to once it reaches its cap and the writer opens the next `part`, which bounds how much has to be re-uploaded per append.
- **Read is list-then-concatenate.** A read lists the whole prefix, fetches the segments, joins the text and hands it to the same `parseJournal()` the file journal uses. Mode scoping, `byMode` counts and the withheld-records disclosure are therefore identical on both storage backends.
- **`journalPath` is prefixed `blob:`** (`src/lib/blobJournal.ts:412`) so nobody reads it as a file on a disk that does not exist — and it is **null** whenever the journal is not writing, with the reason in the adjacent `journalError`, so a dead journal cannot report a location as though it were live.
- **`selectJournal()`** (`src/lib/blobJournal.ts:774`) picks disk or Blob from the environment.

`flushJournal()` (`src/lib/store.ts:460`, awaited by `runTick()` at `src/lib/agent.ts:377`) means a tick does not return until its record is actually durable. A Function instance can be frozen the instant it responds, and a queued journal write at that moment is a transaction with no evidence behind it.

---

## 3. Architecture in depth

```
                       Filecoin Calibration (chain 314159)
                       +--------------------------------------+
                       |  Filecoin Pay   Warm Storage / PDP    |
                       |  accountSummary()  storage.prepare()  |
                       |  fund()            storage.upload()   |
                       |  withdraw()        terminateService() |
                       |                    PDPVerifier reads  |
                       +---------------^-----------------------+
                                       | @filoz/synapse-sdk 1.2.1 (viem)
        +------------------------------+-------------------------------+
        |  src/lib/chain/          THE ONLY PLACE WITH A PRIVATE KEY   |
        |  +--------------------+        +--------------------------+  |
        |  | SynapseChainAdapter|        | MockChainAdapter         |  |
        |  | FILRUNWAY_MODE=live|        | default; simulated, fast |  |
        |  +--------------------+        +--------------------------+  |
        |              ChainAdapter interface  (chain/index.ts)        |
        +------------------------------+-------------------------------+
                                       | RunwaySnapshot (plain JSON)
        +------------------------------v-------------------------------+
        |  src/lib/agent.ts     runTick():  sense -> decide -> act     |
        |        |                                                     |
        |        +--> src/lib/proof.ts       PDP proof state, PURE      |
        |        |         readings -> is this data set delinquent?     |
        |        |                                                     |
        |        +--> src/lib/policy.ts      evaluate()  PURE, 25 tests |
        |        |         snapshot + PolicyRule[]  ->  Decision        |
        |        |                                                     |
        |        +--> src/lib/spendGuard.ts  checkSpend() PURE, 20 t.   |
        |        |         the agent's own rolling 24h deposit cap;     |
        |        |         a refusal becomes a SAFETY_CAP decision      |
        |        |                                                     |
        |        +--> src/lib/eviction.ts    may a PRUNE be submitted?  |
        |        |         off unless FILRUNWAY_ENABLE_EVICTION=on      |
        |        |                                                     |
        |        +--> src/lib/deployment.ts  driver: interval | cron    |
        |        |         read off VERCEL=1; decides whether a timer   |
        |        |         starts at all, and the real tick interval    |
        |        |                                                     |
        |        +--> src/lib/store.ts   ring buffer + SSE pub/sub      |
        |                  |                                            |
        |                  +--> src/lib/blobJournal.ts  selectJournal() |
        |                       |                                       |
        |                       +-- local   src/lib/journal.ts          |
        |                       |           append-only JSONL on disk   |
        |                       +-- Vercel  append-only JSONL segments  |
        |                                   in Vercel Blob              |
        |                       one stream per mode; same parser, same  |
        |                       scoping; rehydrated + refreshed on read |
        +------------------------------+-------------------------------+
                                       |
        +------------------------------v-------------------------------+
        |  /api/snapshot  /api/decisions  /api/stream  /api/storage    |
        |  /api/tick    <- src/lib/tickAuth.ts: CRON_SECRET, constant  |
        |  /api/squeeze    time. The only two endpoints that move funds|
        +---------^--------------------+-------------------------------+
                  |                    | EventSource (SSE)
  GitHub Actions -+   +----------------v-------------------------------+
  every 5 min         |  Dashboard: RunwayGauge · StatTile ·           |
  POST /api/tick      |             DecisionFeed · StoragePanel ·      |
  (vercel.ts daily    |             StatusStrip · OperatorControls     |
   cron = backstop)   +------------------------------------------------+
```

Nothing above `src/lib/chain/` imports the Synapse SDK or can see a private key. The whole product is written against `RunwaySnapshot` and `Decision` in `src/lib/types.ts`, which is why the same dashboard and the same policy engine run unchanged against a simulated chain and a live one.

A live-mode misconfiguration fails loudly at construction rather than falling back to the mock, because a demo showing simulated numbers under a LIVE badge is worse than an error page (`getChainAdapter()`, `src/lib/chain/index.ts:117`; the comment at line 123 states the argument). An unset `FILRUNWAY_MODE` still defaults to mock, silently.

### 3.1 The modules that exist only because the project is deployable

Four modules answer one question each that the local build never had to ask:

| Module | The question it answers |
|---|---|
| `src/lib/deployment.ts` | **What drives the cycle here?** `interval` (a `setInterval` in a long-lived process) or `cron` (an external scheduler calling `/api/tick`), decided from Vercel's own `VERCEL=1` marker (`agentDriver()`, line 73). It also decides the real tick interval (`tickIntervalMs()`, line 83) and whether the dashboard must poll (`dashboardPollMs()`, line 135). |
| `src/lib/blobJournal.ts` | **Where does the evidence live?** A Function's filesystem is read-only apart from a discarded `/tmp`, so on Vercel the append-only journal is rebuilt on Vercel Blob as per-writer segments. Local development keeps the filesystem journal untouched. |
| `src/lib/tickAuth.ts` | **Who may make this agent spend?** `/api/tick` and `/api/squeeze` are the endpoints that can move funds, and on a public URL holding a funded key they are behind a `CRON_SECRET` compared in constant time (`src/lib/tickAuth.ts:101`). Both fail **closed**: a deployment with the check required and no secret set refuses every call with 503. |
| `src/lib/spendGuard.ts` | **How much may it spend before someone looks?** A rolling 24-hour cap the agent enforces on itself, counted from the durable journal rather than from one process's memory. |

Two more modules exist because the agent can do something irreversible, and because a demo has to be able to show it deciding at all:

| Module | The question it answers |
|---|---|
| `src/lib/proof.ts` | **Is this data set actually earning its cost?** Pure. Turns five PDP/Warm Storage reads into one judgement, and refuses to call an unread field a missed proof. |
| `src/lib/eviction.ts` | **May a `PRUNE_DATASET` decision reach the chain?** Off unless `FILRUNWAY_ENABLE_EVICTION` is exactly `on` / `1` / `true` / `yes`. |
| `src/lib/squeeze.ts` | **How much may an operator withdraw to create a crisis?** Pure bounds-checking behind `POST /api/squeeze`. |

### 3.2 API surface

| Route | Returns |
|---|---|
| `GET /api/snapshot` | `{ snapshot: RunwaySnapshot, status: AgentStatus }` |
| `GET /api/decisions?limit=N` | `{ decisions: Decision[], status: AgentStatus }` |
| `GET /api/storage` | `{ storage: StorageListing, status: AgentStatus }`, or **503** with `{ error }` when the chain read fails. The gauge and decision feed do not depend on it, so it is allowed to fail alone rather than take the dashboard down. |
| `POST /api/tick` <br> `GET /api/tick` | `{ decision: Decision, status: AgentStatus, coalesced: boolean }`. `coalesced: true` means a cycle was already in flight and this decision was **not** taken for this request. It can spend, so under the cron driver both verbs require `Authorization: Bearer $CRON_SECRET` (or `x-filrunway-tick-secret`) and answer **401** without it, **503** when the deployment has no secret configured at all (`authorizeTick()`, `src/lib/tickAuth.ts:252`; `requiresTickAuth()`, line 153). `GET` exists because that is the verb a scheduler uses; `POST` stays the operator's. Both run the identical handler — there is no unauthenticated back door on either. |
| `POST /api/squeeze` | `{ amountUsdfc, txHash, explorerUrl, before, after }`. The operator's forced-decision control: withdraws USDFC from Filecoin Pay back to the agent's wallet. **POST only** — a GET that withdraws funds is a link that drains a wallet when something prefetches it. Same secret and same constant-time comparison as the tick, demanded on a **stricter** rule: `requiresSqueezeAuth()` (`src/lib/tickAuth.ts:158`) demands it whenever the adapter is LIVE, on every host and under every driver. See [§7](#7-the-operator-squeeze). |
| `GET /api/stream` | SSE: `snapshot`, `decision`, `tx`, `log`, `totals`, `notices`. The backlog replays first (`store.backlog()`, `src/lib/store.ts:542`), then the whole current disclosure set. |

`AgentStatus` carries `mode`, `address`, `tickIntervalMs`, `lastTickAt`, `nextTickAt`, plus `totals` (whole-history aggregates from the journal, **scoped to `mode`**), `journalPath` (where this mode's record is kept, or `null` when persistence is off or has disabled itself) and `notices` (the standing disclosures, oldest first, empty when there is nothing to disclose). `GET /api/decisions` serves the store's ring, which was hydrated under the same scope, so the feed a browser receives is single-mode by construction.

Two of those fields are deployment-aware rather than constant. `tickIntervalMs` reports the schedule **actually in force** — 15,000 locally, 60,000 under the cron driver by default (`CRON_TICK_INTERVAL_MS`, `src/lib/deployment.ts:49`), overridden to 300,000 on this deployment — so the dashboard's NEXT TICK countdown never runs to a deadline nothing observes. `journalPath` is an absolute filesystem path locally and a `blob:filrunway/journal/<mode>/…` key on the deployment.

---

## 4. The tick, step by step

The cycle is the same everywhere. What **drives** it is chosen from the environment rather than assumed, because the local answer is wrong on a serverless host and a wrong answer here silently decides whether the agent ticks at all. `agentDriver()` (`src/lib/deployment.ts:73`) reads Vercel's own `VERCEL=1` marker; `FILRUNWAY_AGENT_DRIVER` overrides it.

| Driver | Where | What starts the cycle | Interval |
|---|---|---|---|
| `interval` | `next dev`, `next start`, any long-lived process | `ensureAgentLoop()` (`src/lib/agent.ts:780`) sets two `setInterval` timers on the first API request, lazily, so nothing schedules work during `next build`. | sense 2s (`SENSE_INTERVAL_MS`), tick 15s (`TICK_INTERVAL_MS`) |
| `cron` | Vercel | **Nothing in this process.** `ensureAgentLoop()` starts no timer and takes no tick (it returns at `src/lib/agent.ts:854`); an external scheduler calls `/api/tick` instead, authenticated with `CRON_SECRET` — here, [`.github/workflows/agent-tick.yml`](../.github/workflows/agent-tick.yml) every 5 minutes, with the daily Vercel Cron Job in `vercel.ts` as a backstop. | tick 60s default, overridden to 300s by `FILRUNWAY_CRON_INTERVAL_MS` |

That second row is the whole point of the split, and the reason it is a hard branch rather than a fallback. A Function exists for the length of one request, so a timer set inside it either never fires or fires on an instance nobody is looking at — and the *immediate* first tick the local loop performs (`src/lib/agent.ts:867`) would mean that merely **reading the dashboard** could cause the agent to spend. Under the cron driver no route may start a cycle as a side effect of being read.

One tick, in order:

```
0. authorize                     tick/route.ts:35  under the cron driver, the shared
                                  secret is checked BEFORE anything else runs, so an
                                  unauthenticated caller cannot even provoke an RPC
                                  read by being refused. 401 (or 503, no secret set).

1. sense()                       agent.ts:387  accountSummary + both wallet balances
   read failed? --------------->  FAILED Decision recorded (agent.ts:391), agent HOLDs
                                  on stale data. An RPC outage is an audit-log entry,
                                  not a 500, and it renders as a red FAILED card
                                  carrying the error.

2. readProof(epoch)              agent.ts:420  five PDP / Warm Storage reads per data
                                  set, folded into a ProofSnapshot. Never throws: an
                                  unreadable listing becomes a stated UNKNOWN, never a
                                  delinquency. Done here rather than in sense(),
                                  because sense() runs every 2s to drive the gauge and
                                  the tick is the only place the answer is used.

3. evaluate(snapshot, RULES)     agent.ts:424  pure; Decision + reasoning string. It is
                                  TOLD whether eviction is armed (agent.ts:428) rather
                                  than reading the environment itself.

4. applySpendCap(decision)       agent.ts:430  (defined agent.ts:92) LIVE only. If the
                                  decision wants to deposit and the agent has already
                                  hit its own rolling 24h limit, the decision is
                                  rewritten to SAFETY_CAP / NO_ACTION *before* it is
                                  journalled, keeping the rule that fired and its
                                  reasoning in front of the refusal.

5. applyEvictionGate(decision)   agent.ts:431  (defined agent.ts:126) asks the
                                  environment a SECOND time before anything
                                  irreversible can be submitted.

6. journal + publish decision    store.ts:401  appended to the durable journal BEFORE
                                  it reaches the in-memory ring, then -> SSE -> the
                                  dashboard renders it immediately

7. action == SAFETY_CAP ? ---->  return. outcome = NO_ACTION. The agent declined
                                  itself. Nothing was submitted and nothing may be.
                                  agent.ts:442

8. action == INSUFFICIENT_FUNDS? ->  return. outcome = NO_ACTION. Rule fired but
                                  the wallet can't cover it; no deposit attempted.
                                  agent.ts:449

9. action == PRUNE_DATASET ? -->  executePrune()  agent.ts:461 -> agent.ts:564.
                                  With eviction disarmed the decision is already
                                  NO_ACTION and nothing is attempted (agent.ts:568).
                                  Armed, it submits terminateService, waits for the
                                  receipt, and invalidates the storage cache so the
                                  next tick cannot decide to cut the same rail twice
                                  (agent.ts:620).

10. action == HOLD ? --------->  return. outcome = NO_ACTION. Nothing is sent.

11. deposit(amount)              agent.ts:474  payments.fund() -> real tx hash
    publish tx event  SUBMITTED
    recordSpend(...)             agent.ts:493  counted against the cap the moment it
                                  reaches the chain, not when the journal is next read

12. waitForTransaction(hash)     synapse.ts:467  waitForTransactionReceipt
    publish tx event  CONFIRMED | FAILED
    the updated Decision is journalled again, so the PENDING line and the
    EXECUTED / FAILED line both survive in the record.
    FAILED? releaseSpend(id)     agent.ts:527  it did not stand, so it does not count

13. sense() again                agent.ts:548  so the gauge reflects the new balance
                                  at once

14. flushJournal()               agent.ts:377  runTick() does not return until the
                                  record is actually durable. A Function instance can
                                  be frozen the instant it responds, and a queued
                                  journal write at that moment is a transaction with
                                  no evidence behind it.
```

Only one cycle runs at a time. A tick that arrives mid-cycle does not start a second one and does not silently re-serve an older decision: the response carries `coalesced: true`, so a caller can tell that the decision it got back was not taken for its request (`runTick()`, `src/lib/agent.ts:352`, guard at line 357).

Steps 7 to 10 matter as much as step 11. HOLD, SAFETY_CAP, INSUFFICIENT_FUNDS and a withheld PRUNE_DATASET are all still decisions: each is recorded with full reasoning and rendered as its own card in the decision log. An agent that only logs when it acts, or that submits a transaction it already knows will fail, is not showing you its judgement.

### 4.1 The card taxonomy

Six treatments, and the difference between the declining ones is the point (`DecisionFeed.tsx`, `DECLINE_STYLE` at line 66; colours in `ACTION_VAR`, `src/lib/format.ts:47`):

| Decision | Card | Why that treatment |
|---|---|---|
| `HOLD` | Dashed grey, quiet | A resting state. It is recorded, with reasoning, but it is not an event. |
| `TOP_UP` / `EMERGENCY_TOP_UP` | Action card, amber / red, with the tx row | Something happened and there is a hash to follow. |
| outcome `FAILED` (any action) | Red failure card carrying the real error text | Outcome outranks action: a failure is a failure whether the agent was holding, topping up, pruning or blocked when it broke. |
| `INSUFFICIENT_FUNDS` | Heavy **red** rail, inverted header, pill `BLOCKED`, footer *"Operator action required — fund the agent wallet."* | The agent is stuck until a human acts. |
| `SAFETY_CAP` | Heavy **amber** rail, inverted header, pill `CAPPED`, footer *"Self-imposed limit — the agent declined to spend and will resume when the window rolls. No operator action required."* | The agent applied a limit it was given, on purpose, and will resume by itself. Painting that in alarm-red would misreport a working safety feature as a fault. |
| `PRUNE_DATASET` | Red, whether or not it executed, and carrying the target block: data set id, epochs overdue, the deferred top-up and the re-sized one | The one irreversible action the agent can take. A viewer must never scan past a card that says a data set was cut — or that the agent decided it should be. Only a deposit may print a USDFC figure in the amount slot (`DecisionFeed.tsx:285`), so a prune can never be misread as spend. |

The declining paths share a card component because they are the same kind of event — a rule fired, the agent recognised a constraint, nothing was submitted, there is no tx row — and are deliberately coloured apart because **one needs an operator and the other needs nobody**.

---

## 5. The policy engine

`DEFAULT_RULES`, `src/lib/policy.ts:41`. Rules are evaluated lowest-threshold-first; the first rule whose `thresholdDays` the runway has fallen below wins (`selectRule()`, `src/lib/policy.ts:140`).

| Rule id | Fires when | Action | Deposit |
|---------|-----------|--------|---------|
| `emergency-2d` | runway < 2 days | `EMERGENCY_TOP_UP` | 15 USDFC |
| `topup-7d` | runway < 7 days | `TOP_UP` | 5 USDFC |
| `hold` | otherwise | `HOLD` | 0 |

A rule can only ever ask for `TOP_UP`, `EMERGENCY_TOP_UP` or `HOLD` — `PolicyAction` has no fourth option (`src/lib/types.ts:117`), so this table cannot be configured to produce one. The agent can still reach **three further conclusions of its own**, none of which any rule can request (`DecisionAction`, `src/lib/types.ts:135`):

| Conclusion | Where it is decided | When |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `evaluate()`, `src/lib/policy.ts:337`. Pure. | The rule that fired wants a deposit larger than the wallet holds. The engine reports the shortfall instead of returning the rule's action. |
| `SAFETY_CAP` | `applySpendCap()`, `src/lib/agent.ts:92`. Deliberately **outside** `policy.ts`. | The wallet could cover it, but the agent has already made 3 deposits, or deposited 20 USDFC, inside the rolling 24-hour window. |
| `PRUNE_DATASET` | `evaluate()`, the eviction branch at `src/lib/policy.ts:245`. Pure — it is *told* whether execution is armed. | A rule has fired **and** a data set has been read to be live, past its proving deadline and unproven. Cutting it beats buying runway to keep paying for it. See [§6](#6-pdp-proof-state-and-data-set-eviction). |

`SAFETY_CAP` lives outside the policy engine for a reason worth stating: `evaluate()` is pure, and answering *"how much have I spent in the last 24 hours?"* needs the durable history that only the store has. Keeping the impure question out of the pure function is what lets the policy stay trivially testable. The same argument is why `evaluate()` is *handed* `evictionEnabled` as an explicit input (`EvaluateOptions.evictionEnabled`, `src/lib/policy.ts:97`) rather than reading `process.env` itself; it defaults to `false`, so a caller that forgets it gets the safe answer.

`INSUFFICIENT_FUNDS` and `HOLD` set `outcome` to `NO_ACTION` rather than `PENDING`, and in both cases nothing is submitted, so there is nothing to fail on-chain. `INSUFFICIENT_FUNDS` is reachable in live mode whenever the wallet is genuinely short; in mock mode the wallet starts at 250 USDFC (`INITIAL_WALLET_USDFC`, `src/lib/chain/mock.ts:30`), so the default demo never reaches it, and doing so on purpose takes roughly 16 emergency top-ups. `SAFETY_CAP` is reachable in **live mode only** by default; on the shipped defaults a fourth top-up in a day, or any top-up that would carry the day's total past 20 USDFC, is enough to reach it.

`isDepositAction()` (`src/lib/policy.ts:115`) is the single definition of "money left the wallet for Filecoin Pay". It exists because `PRUNE_DATASET` broke the old assumption that `outcome === "EXECUTED"` was enough: a prune keeps `ruleFired` — the top-up rule it was taken *instead of*, which is exactly what makes the decision legible — and it executes a transaction. Counting it the old way would have added that rule's `topUpAmount` to the AUTONOMOUS DEPOSITS tile and to the safety cap's ledger for a deposit that never happened. Both `journal.ts` (the tile) and `spendGuard.ts` (the cap) funnel through it, so the two figures cannot drift apart again.

`evaluate()` is pure: `(RunwaySnapshot, PolicyRule[]) -> Decision`. No clock read unless you inject one, no chain call, no side effect. That is deliberate. The part a judge is most likely to be suspicious of should be the part that is easiest to test. 25 unit tests in `src/lib/policy.test.ts` cover threshold boundaries, rule ordering, the unbounded-runway sentinel, wallet-shortfall detection and the reasoning text; a further 18 in `src/lib/policyProof.test.ts` cover the eviction branch specifically. The orchestration around it is not taken on trust either: `src/lib/agent.test.ts` drives `runTick()` against a scripted adapter (a read that throws, a deposit that reverts, a transaction that never confirms, a tick that arrives mid-cycle) with no network and no key.

### 5.1 The reasoning strings

Every `Decision` carries a `reasoning` string built from the numbers actually read, followed by a PDP sentence (`describeProof()`, `src/lib/proof.ts:234`) and, when a demo timescale is in force, a scale disclosure (`demoScaleNote()`, `src/lib/demo.ts:149`).

A real HOLD and a real TOP_UP read like this (base text only, at `FILRUNWAY_DEMO_SCALE=1`):

```
Runway 9.4 days (27,116 epochs) is at or above the 7-day top-up threshold.
Burn rate 0.00041 USDFC/epoch against 11.12 USDFC available. No deposit required.

Runway 4.3 days (12,384 epochs) is below the 7-day top-up threshold.
Burn rate 0.00041 USDFC/epoch against 5.08 USDFC available.
Depositing 5 USDFC extends runway to ~9.6 days.
```

An `INSUFFICIENT_FUNDS` decision reads differently: it states the shortfall and the fix, and deliberately omits any runway projection, since the agent must not promise runway it cannot buy.

```
Runway 1.2 days (3,456 epochs) is below the 2-day emergency top-up threshold.
Burn rate 0.00041 USDFC/epoch against 0.85 USDFC available. The rule calls for a
15 USDFC deposit but the wallet holds 3.00 USDFC — a shortfall of 12.00 USDFC.
No deposit attempted: fund the agent wallet with at least 12.00 USDFC for this
rule to execute.
```

A `SAFETY_CAP` decision keeps the reasoning the agent had already written — what it *wanted* to do, and why — and appends the refusal behind it, because the record has to show both. The refusal names the limit that was hit, the amounts on both sides of it, when the cap next relaxes, and the variable that widens it. The count limit:

```
Runway 1.7 days (4,896 epochs) is below the 2-day emergency top-up threshold.
Burn rate 0.00041 USDFC/epoch against 1.44 USDFC available. Depositing 15 USDFC
extends runway to ~19.9 days. Declined by the agent's own safety cap: 3 of a
maximum 3 deposits already made in the last 24h (15.00 USDFC). No transaction
was attempted and no funds moved. The cap relaxes as the oldest deposit ages out
at 2026-09-03 09:14:02 UTC. Raise FILRUNWAY_MAX_DEPOSITS_24H to widen the cap.
```

And the amount limit, which can fire well before the third deposit:

```
Runway 1.7 days (4,896 epochs) is below the 2-day emergency top-up threshold.
Burn rate 0.00041 USDFC/epoch against 1.44 USDFC available. Depositing 15 USDFC
extends runway to ~19.9 days. Declined by the agent's own safety cap: this rule
calls for 15 USDFC on top of 10.00 USDFC already deposited in the last 24h,
which would reach 25.00 USDFC against a cap of 20.00 USDFC. No transaction was
attempted and no funds moved. The cap relaxes as the oldest deposit ages out at
2026-09-03 09:14:02 UTC. Raise FILRUNWAY_MAX_DEPOSIT_USDFC_24H to widen the cap.
```

When a demo timescale is in force the thresholds quoted in the reasoning are the **scaled** ones, and every decision appends its own disclosure sentence so a decision card screenshotted on its own still says what it was compared against. At `×480` the same TOP_UP reads:

```
Runway 2969.9 days (8,553,196 epochs) is below the 3360-day top-up threshold.
Burn rate 0.000002777832968892 USDFC/epoch against 23.76 USDFC available.
Depositing 5 USDFC extends runway to ~3594.4 days.
Threshold shown is the 7-day rule at the ×480 demo timescale.
```

---

## 6. PDP proof state and data-set eviction

The brief allows three responses to a budget problem: top up, cut what you cannot afford, or decide what is worth paying to keep. `PRUNE_DATASET` is the second one, and it is the only irreversible thing this agent can do.

### 6.1 The reading

`src/lib/proof.ts` is pure, has no chain access and no clock, and is deliberately paranoid. The five reads behind the judgement are ordinary contract calls on a public RPC (`readProofStates()`, `src/lib/chain/synapse.ts:596`):

| Contract | Call | Role |
|---|---|---|
| PDPVerifier | `dataSetLive(id)` | **Decisive.** A terminated data set is not delinquent, it is gone. |
| WarmStorageStateView | `provingDeadline(id)` | **Decisive.** With no deadline there is nothing to be late for. |
| WarmStorageStateView | `provenThisPeriod(id)` | **Decisive.** The actual answer to "did it prove?". |
| PDPVerifier | `getDataSetLastProvenEpoch(id)` | Context only — makes the reasoning checkable against an explorer. |
| PDPVerifier | `getNextChallengeEpoch(id)` | Context only. |

These are direct reads through the chain definitions the SDK itself carries (`synapse.chain.contracts.pdp` and `.fwssView`), because `@filoz/synapse-sdk` 1.2.1 exposes no proof-state helper. `@filoz/synapse-core/pdp-verifier` exports two of the five as functions but not the other three, and mixing two call styles across one multicall would cost more than it saved.

### 6.2 The invariant

**An unread field is NEVER evidence of a missed proof.**

Those calls time out, they revert for a data set that is not live, and `provingDeadline` reverts outright with `ProvingPeriodNotInitialized` on a data set whose first proving period has not started. If any of that were folded into "not proven", a thirty-second RPC wobble would read as a delinquency and the agent would cut live, healthy, paid-for storage.

So a reading carries `null` for anything that did not answer, and `classifyProofState()` (`src/lib/proof.ts:93`) returns `readable: false` and `isDelinquent: false` unconditionally whenever any decisive field is missing or the chain epoch itself is unknown (`src/lib/proof.ts:118`). A non-live set is not delinquent (line 135). A `provingDeadline` of `0` — Warm Storage saying the first proving period has not been initialised — is not delinquent (line 145). Only when every decisive field answered does the judgement become arithmetic: `epochsOverdue = currentEpoch - deadline`, and `isDelinquent = overdue > 0 && !proven` (line 163).

`currentEpoch` is `RunwaySnapshot.epoch`, i.e. a true chain height from the same reading, never a local clock.

`delinquentSets()` (`src/lib/proof.ts:205`) returns only confirmed-delinquent sets, lowest id first so selection is stable. `liveSetCount()` (line 213) counts only sets confirmed `isLive === true`; unknown liveness does not count. Those two functions are the entire interface between the proof reading and the policy engine, which is what keeps the chain layer from being able to assert a delinquency directly.

### 6.3 The decision

The eviction branch fires when `action !== "HOLD"` **and** at least one data set is confirmed delinquent (`src/lib/policy.ts:245`). Its reasoning has four parts, in order: the trigger (the runway and the rule that fired), the evidence (the target's id, last proven epoch, proving deadline, next challenge epoch, and how many epochs overdue it is at the reading's own epoch), the choice (why terminating beats depositing), and — only when armed — `Submitting terminateService on the Warm Storage contract.`

The re-sizing arithmetic is stated as a bound rather than a measurement, and labelled as such wherever it is printed (`resizeTopUp()`, `src/lib/policy.ts:167`). Filecoin Pay reports **one aggregate `lockupRatePerEpoch`** for the account and offers no per-rail breakdown, so the exact rate that remains after a termination is not readable in advance — it is knowable only from the next reading. Rather than invent a per-data-set burn rate and present it as measured, the agent divides pro-rata by rail *count*, says so, and says it will re-decide against the real figure next tick. The whole calculation is carried on the decision as a `PruneTarget` (`src/lib/types.ts:149`) so the record of an irreversible action names its subject and its justification rather than leaving both buried in prose.

**The delinquency the agent saw and did not act on is always said out loud** (`src/lib/policy.ts:300`). If a data set is past its deadline but the runway is above the top-up threshold, the HOLD card says so: *"…is past its proving deadline, but the runway is above the top-up threshold: the agent is not taking an irreversible action it is not forced into, and will reconsider if the runway falls."* An agent that noticed dead weight and left it alone has to show that it noticed, or the decision is indistinguishable from not looking.

**The one case where the agent prefers the second-best move.** If eviction is *not* armed and the runway is inside the emergency threshold, the agent falls back to `EMERGENCY_TOP_UP` rather than proposing a cut it may not make (`emergencyWithoutOptIn`, `src/lib/policy.ts:243`). Sitting on its hands while the account dies, because the one remedy it preferred is not permitted, would be a worse decision than the second-best one it can still take. The card says exactly that: *"…would be cut in preference to this deposit, but the runway is inside the emergency threshold and eviction is not armed on this deployment — so the account is funded rather than left to die on an option the agent may not take."*

### 6.4 The gate

`terminateService` ends the PDP payment rail, the provider stops being paid to keep the pieces, and the data goes. There is no undo, and a demo is exactly the setting in which an unexpected destructive action does the most damage.

So execution is gated on `FILRUNWAY_ENABLE_EVICTION`, which is **off** unless the value is exactly `on`, `1`, `true` or `yes` (`evictionEnabled()`, `src/lib/eviction.ts:45`). Anything else — unset, empty, `off`, a typo — is off. A destructive capability must never be enabled by a value nobody meant.

The gate is checked **twice**: once in the policy engine, which is told the answer as an explicit input so it stays pure, and again in the agent runner immediately before the call (`applyEvictionGate()`, `src/lib/agent.ts:126`). A decision that says EXECUTE and an environment that says no results in nothing being submitted.

**With the gate off — the default, and what you want for a demo — the agent still MAKES the decision.** It records it, with its target, its reading and its full reasoning, in the durable journal, and the outcome says plainly that execution is disabled and which variable enables it (`evictionDisabledNote()`, `src/lib/eviction.ts:55`):

> Execution is DISABLED on this deployment: terminating a data set is irreversible, so it requires the explicit opt-in `FILRUNWAY_ENABLE_EVICTION=on`, which is not set. No transaction was attempted and data set #30292 is untouched. The decision is recorded as made — this is what the agent concluded, not what it did.

That record is the autonomy artifact; the transaction is only its consequence. An agent that can say *"I have decided this data set is not worth paying for, and I am not permitted to act on it"* is more honest than one that quietly holds.

When the capability *is* armed, a `eviction-armed` notice is pinned to the dashboard for the life of the session (`describeEvictionGate()`, `src/lib/eviction.ts:65`). There is deliberately no corresponding notice for the disarmed case: silence has to mean "no".

### 6.5 Execution, when armed

`executePrune()` (`src/lib/agent.ts:564`) submits `WarmStorageService.terminateService` directly on chain (`src/lib/chain/synapse.ts:686`), waits for the receipt, and then **invalidates the storage cache** (`invalidateStorageCache()`, `src/lib/agent.ts:207`, called at line 620). Left alone, the cached listing would still show the cut data set as live, the next tick would read it, judge it delinquent again, and decide to terminate a rail it has already terminated.

The SDK offers two termination paths and the direct one is used deliberately: `StorageManager.terminateService` is provider-relayed and refuses outright when the provider cannot be reached, whereas `WarmStorageService.terminateService` is one transaction the agent signs itself (`src/lib/chain/synapse.ts:660`).

### 6.6 Rehearsing it with nothing at stake

`FILRUNWAY_MOCK_PROOF` chooses which proof state the mock adapter reports for its **second** data set (`30292`):

| Value | What the agent sees |
|---|---|
| `healthy` (default) | Everything proving on schedule. The agent tops up and never proposes a cut. The local demo, unchanged. |
| `delinquent` | Data set 30292 is live, past its deadline and unproven. A short runway then produces a real `PRUNE_DATASET` decision. |
| `unreadable` | Its proof calls do not answer. The agent must treat that as UNKNOWN and must **not** propose a cut — the RPC-hiccup rehearsal. |

The first data set (`30291`) stays healthy in every mode, so the account is always mixed and the policy engine has to choose rather than blanket-apply.

---

## 7. The operator squeeze

The agent's real position on Calibration is ~2,970 days of runway against a burn of about a day per day. Nothing the policy engine can do will ever fire on that inside a demo, so a judge watching the deployed dashboard sees HOLD, forever, and has no way to tell a working agent from a screensaver.

The honest fix is not to fake a crisis but to **cause** one. `payments.withdraw` moves USDFC out of Filecoin Pay and back to the agent's own wallet (`src/lib/chain/synapse.ts:718`): the funds are not lost, but `availableFunds` really falls, so `runwayInEpochs` really collapses and the agent's next reading is a true reading of a genuinely short runway. Nothing is simulated, and nothing about the display changes.

### 7.1 Whose action it is

The operator's. This is the one control on the dashboard that a human uses to manufacture the situation the agent then responds to, and everything about it is built so it can never be read as the agent acting (`squeezeRunway()`, `src/lib/agent.ts:659`):

- it produces **no `Decision`** and touches no rule, so nothing it does can land in the decision log or the deposits tile;
- its trace lines are prefixed `OPERATOR ACTION`;
- it pins an `operator-squeeze` disclosure the moment it is first used (`src/lib/agent.ts:691`), idempotent by key, so a viewer arriving later can still tell that the crisis on screen was manufactured: *"An OPERATOR has withdrawn USDFC from Filecoin Pay to the agent wallet in this session, deliberately shortening the runway so the policy engine has a real crisis to answer. The withdrawal is a human action; the decisions that follow it are the agent's."*
- it waits for confirmation before returning, because an unconfirmed withdrawal leaves the runway unchanged and a demo would read as broken.

The autonomy on show is the response, not the squeeze.

### 7.2 Why it is bounded

It moves money from a funded wallet, so it is behind the same shared secret as `/api/tick` **and** behind a ceiling. `planSqueeze()` (`src/lib/squeeze.ts:97`) is pure — the caller supplies the request, the account's unlocked balance and the bounds — and every refusal names the number that caused it, so a 400 from this endpoint tells an operator what to change:

| Refusal | When |
|---|---|
| not a positive USDFC amount | the body named something unusable |
| exceeds the ceiling | `> FILRUNWAY_MAX_SQUEEZE_USDFC` (default 5) |
| the unlocked balance could not be read | no withdrawal can be shown to be safe |
| Filecoin Pay reports no unlocked funds | the runway is already at its floor |
| would leave the account in debt | `> fundsAvailable`, refused outright rather than clamped |

That last one is refused rather than clamped on purpose: an operator who asked for 5 and silently got 0.31 would misread the runway that followed. The reading it is checked against is a **fresh** `sense()` (`src/lib/agent.ts:674`), not the cached one, so the bound reflects the balance the withdrawal actually runs from.

| Variable | Default | Meaning |
|---|---|---|
| `FILRUNWAY_SQUEEZE_USDFC` | `1` | Withdrawn when the caller names no amount. |
| `FILRUNWAY_MAX_SQUEEZE_USDFC` | `5` | Hard ceiling per call. |

Set the default to whatever actually collapses the runway of the account in question; `npm run bootstrap -- status` prints the balance to size it from. A malformed value never throws — it falls back to the default (`squeezeLimits()`, `src/lib/squeeze.ts:77`).

### 7.3 Authentication, and why it is stricter than the tick's

Same secret (`CRON_SECRET`), same constant-time comparison, same fail-closed 503 when a deployment has none configured. One secret and one comparison means one place to get it wrong.

The **threshold** for demanding it is not the same, and the difference is the worst case behind each endpoint. `/api/tick` is open locally because the worst an unauthenticated local tick can do is run, a few seconds early, the cycle that was going to run anyway: the agent decides, and anything it spends is capped and is a deposit *into* its own Filecoin Pay account. This endpoint's worst case is money leaving that account, in an amount the caller chose. So `authorizeSqueeze()` (`src/lib/tickAuth.ts:268`, via `requiresSqueezeAuth()` at line 174) demands the secret whenever the chain adapter is LIVE — whatever the driver, whatever the host — and only leaves the door open for a local MOCK run, where there are no funds to take. A `next dev` in LIVE mode is a funded wallet on a listening port, and "it is only localhost" is not a boundary the handler can verify.

### 7.4 Where the secret lives

**Not in the browser bundle.** Next.js only inlines `NEXT_PUBLIC_*`, and nothing in `src/components/OperatorControls.tsx` reads one. A human pastes the secret into an input on the page; it is held in that one component's React state and sent as the `x-filrunway-tick-secret` request header. It reaches exactly one origin — this app's own — and it is gone the moment the page unloads.

Deliberately **not** persisted to `sessionStorage` or `localStorage`. Keeping it only in memory means a reload cannot resurrect it, a second tab does not inherit it, and nothing on disk in the browser profile has to be cleaned up after a demo. The cost is retyping it after a refresh.

The control is a two-step arm-then-confirm inside its own bordered group labelled OPERATOR, with an explicit caption and a result line that says what a human just did. `operatorAuthRequired()` (`src/lib/tickAuth.ts:148`) is resolved **server-side** in `src/app/page.tsx` and handed to the client, so the controls render in the right state on the first painted frame instead of offering a button that turns out to 401. When it is false — local development, where the endpoints are open — the secret input is not rendered at all.

### 7.5 Why the controls exist on the deployment at all

`manualTickEnabled()` (`src/lib/deployment.ts:116`) returns `true` everywhere. It used to be `agentDriver(env) === "interval"`, i.e. locally only, on a sound argument: `/api/tick` requires a shared secret on a deployment, and a button could only send that secret by carrying it, which would publish it to every visitor of a public URL holding a funded wallet key.

The premise was that the *page* would have to supply the secret. It does not. The controls render inert and a human arms them; a visitor without the secret has a control that 401s, which is exactly the protection `/api/tick` already provides on its own. What that buys is the thing the old arrangement cost: a judge on the deployed dashboard can advance the loop instead of waiting out a cron interval, and can trigger the squeeze that gives the agent something to decide about. **An agent whose autonomy cannot be observed inside a demo may as well not have any.**

---

## 8. The agent's own spending cap

The policy engine is bounded per **decision**: a rule deposits 5 or 15 USDFC and no more. Nothing bounded it per **day**. That was survivable while the agent ran on a laptop with a human watching it; deployed, it runs unattended, on a public URL, holding a funded key, driven by a scheduler. A misread burn rate, an RPC that reports a runway of zero, or simply a schedule firing more often than anyone intended, and the agent would keep topping up — correctly, according to its rules — until the wallet was empty.

So the agent is given a limit it enforces on itself (`src/lib/spendGuard.ts`):

| Setting | Default | Meaning |
|---|---|---|
| `FILRUNWAY_MAX_DEPOSITS_24H` | `3` | Deposits allowed inside the window. |
| `FILRUNWAY_MAX_DEPOSIT_USDFC_24H` | `20` | Total USDFC allowed inside the window. |
| `FILRUNWAY_SPEND_WINDOW_MS` | `86400000` | Length of the rolling window. |
| `FILRUNWAY_SPEND_CAP` | unset | `on` / `off` forces the cap regardless of mode. |

The defaults are tight on purpose and are fitted to the shipped rule set: one emergency top-up (15) plus one scheduled top-up (5) is exactly 20 USDFC, so the agent can answer a genuine emergency in full and must then stop for the day.

Four properties worth checking rather than taking on trust:

- **It is enforced in LIVE only** (`spendCapEnabled()`, `src/lib/spendGuard.ts:127`). In MOCK nothing can be spent, and a mock run ticks every 15 seconds, so a conservative daily cap would fire within minutes and change the local demo into something it is not. `FILRUNWAY_SPEND_CAP=on` turns it on anyway.
- **Hitting it is a decision, not an error.** `checkSpend()` (`src/lib/spendGuard.ts:180`) is pure — the caller supplies the history, the clock and the limits — and its refusal text is built there so the wording is identical wherever the cap fires and can be asserted in a test rather than eyeballed in a screenshot. `applySpendCap()` turns that refusal into a `SAFETY_CAP` decision with `outcome: NO_ACTION`, journalled like any other.
- **The window is counted from the durable journal, not from process memory** (`spendEntriesFrom()`, `src/lib/spendGuard.ts:243`, seeded into the store on every hydrate and refresh at `src/lib/store.ts:246`). On Vercel each tick may run on a different Function instance, and a cap that resets whenever an instance is recycled is not a cap.
- **A deposit counts once it has EXECUTED, for the amount the rule asked for** — the same definition `accumulate()` totals in `journal.ts`, routed through `isDepositAction()`, so the cap and the AUTONOMOUS DEPOSITS tile can never disagree about what was spent. A submitted transaction that then fails to confirm is released again (`releaseSpend()`, `src/lib/store.ts:489`, called from `src/lib/agent.ts:527`).

While the cap is in force the agent pins a standing disclosure stating the limits, so a viewer who arrives after a `CAPPED` card can still see what limit it was that fired: *"Safety cap in force: at most 3 deposits and 20.00 USDFC per 24h. Reaching it records a declining decision; it never transacts."*

**One honest limit on the guarantee.** Across Function instances the cap is eventually consistent, not transactionally exact. Each instance seeds its window from the shared journal and re-reads it on a 3-second TTL (`REFRESH_TTL_MS`, `src/lib/store.ts:60`), so two ticks landing on two instances inside the same 3-second window could each believe the other's deposit had not happened. At one tick every five minutes — the deployed schedule — that race is not reachable, and inside a single instance the cap is exact because a deposit is counted the moment it reaches the chain (`src/lib/agent.ts:493`). But it is a refresh window, not a lock, and this project would rather say so than let it be discovered.

---

## 9. The demo timescale

This needs stating plainly, because it is the one place where the demo departs from a production deployment.

**The problem.** Calibration Warm Storage costs $2.50/TiB/month/copy plus $0.024/data-set/month, and uploads default to two copies — each copy opens its own data set, so a single demo upload opens two data sets, not one, and the per-data-set fee is charged twice. Measured live, the largest cost stream a demo can honestly create is roughly **0.240005 USDFC/month (~$0.24), or ~0.008 USDFC/day**; a fixed per-data-set lockup of 0.928 USDFC (covering both data sets) dwarfs the 0.240008 USDFC rate-based lockup at this scale. Each 5 USDFC deposited into that account therefore buys about **625 days** of runway (5 / 0.240005 × 30 ≈ 625) — which is why the reference account read around 2,969.9 days before its autonomous top-up and around 3,594.5 days after it. A gauge scaled to 14 days pegs at full and never moves, and no policy threshold expressed in days ever fires. Producing a visible burn from the rate-based fee alone would take roughly 7 TiB of live storage (~1.2 USDFC/day).

**The fix.** `FILRUNWAY_DEMO_SCALE` (default `1`) multiplies the agent's **policy thresholds** and the gauge's **graduations** by N. It does not touch a single number read from the chain.

| | Scaled by `FILRUNWAY_DEMO_SCALE` | Untouched: always the raw chain reading |
|---|---|---|
| Policy thresholds (2d, 7d) | yes — `scaleRules()`, `src/lib/demo.ts:168` | |
| Gauge axis, band markers, legend | yes | |
| `daysRemaining`, `epochsRemaining` in `RunwaySnapshot` | | yes |
| `fundsAvailable`, `lockupRate`, `lockupCurrent` | | yes |
| `walletUsdfc`, `walletFil`, `epoch` | | yes |

Read it as: *for this demo, treat N days of runway the way a production agent would treat one day.* The agent's behaviour is real; only its risk appetite is rescaled.

The rejected alternative was dividing `daysRemaining` by N before display. That would put a number on screen that is not the chain's, and was rejected for exactly that reason.

### 9.1 Which numbers on screen are raw, and which are interpolated

The demo timescale never touches a reading. **Client-side animation does**, in exactly one place, and that place is the most eye-catching thing on the page. Stating it precisely:

| On screen | What it is |
|---|---|
| BURN RATE, FILECOIN PAY, WALLET stat tiles | **Raw.** Straight from the latest `RunwaySnapshot`. |
| AUTONOMOUS DEPOSITS tile | **Raw**, and server-computed over the whole journal, not this tab's session. **Scoped to the running mode**: in MOCK it is relabelled `SIMULATED DEPOSITS` in hazard yellow. |
| Every figure on a decision card, and its `reasoning` text | **Raw.** `evaluate()` is handed the snapshot as read; the reasoning quotes those numbers verbatim. |
| STORED DATA panel (data set ids, provider, size, CDN, piece CIDs, proof state) | **Raw**, read from the chain via `ChainAdapter.listStorage()`. |
| Epoch in the status strip | **Raw.** |
| **The big numeral in the middle of the gauge** | **Client-side interpolation**, to 2dp. |
| **The `N epochs` line under it** | **Derived from that same interpolated value** (`displayDays × 2880`), not from `epochsRemaining`. |
| **The gauge's band colour, needle and arc fill** | **Derived from that same interpolated value.** |

The mechanism, in `src/components/Dashboard.tsx`: the server publishes a fresh snapshot every 2 seconds, but the UI redraws 10 times a second. Between readings the gauge shows `displayDays = anchor.days − rate × elapsed`, where `anchor` is the last real reading, `rate` is an exponential moving average of the deltas actually measured between the last few readings, and `elapsed` is capped at `MAX_EXTRAPOLATION_MS` (8 seconds). `RunwayGauge` prints that number to two decimal places. The rate is *measured*, never assumed, so the interpolation cannot invent a trend the chain is not showing — and every server reading snaps the anchor back to truth, so the error is bounded by at most 2 seconds of drift.

The honest consequence, stated rather than buried: **the true onchain `epochsRemaining` is not displayed anywhere in the UI.** The gauge's epoch line is a smoothed re-derivation of it. If you want the raw value, it is in three places that do not interpolate at all: `npm run bootstrap -- status` (`runwayInEpochs (raw)`), any decision card's reasoning, and `npm run decisions -- --id <id>`.

### 9.2 What scaling does and does not prove

It multiplies policy thresholds. It does **not** multiply the burn rate, so the runway still falls at about one day per real day. Scaling on its own therefore *cannot* show the runway falling through a threshold — that would take months. What it shows is the agent crossing a threshold it was **already** past, acting on it, and then correctly holding *because of what it just did*. That self-caused TOP_UP → HOLD transition is the honest beat, and it is a real one: nothing about it is staged, and the second decision is caused by the first.

The thing that *does* make a threshold crossing watchable on a live account is the operator squeeze ([§7](#7-the-operator-squeeze)), and it is watchable precisely because it is a real withdrawal disclosed as a human action rather than a simulated drain. The only place a needle visibly falls on its own is mock mode, which is labelled as simulated wherever it appears.

### 9.3 Picking a scale

`npm run bootstrap -- status` suggests a scale by rounding up to a tidy power of ten (`suggestDemoScale()`, `src/lib/demo.ts:187`) — easy to read on an axis, but not the only valid choice; `FILRUNWAY_DEMO_SCALE` accepts any number, round or not. For a **live demo**, prefer the scale that resolves in exactly one top-up. On the reference account the pre-top-up runway was about **2,969.9 days**, and a 5 USDFC deposit buys roughly **625 more**:

| Scale | Top-up threshold (7 × N) | What a judge sees |
|---|---|---|
| 380 | 2,660 days | Runway 2,969.9 is already **above** it. The agent HOLDs forever and no decision ever lands. |
| **480** | **3,360 days** | Runway 2,969.9 is below it, so one TOP_UP fires; +625 days clears the threshold, so the next tick flips to HOLD. **Exactly one decision, then its consequence.** |
| 1000 (tool-suggested) | 7,000 days | Roughly eight consecutive deposits to cross. Reads as a stuck loop, not a decision. |

**480** is the recommended live-demo value for that reason, and it is what the demo machine is configured to: `.env` on the machine that produced the transaction holds `FILRUNWAY_DEMO_SCALE=480` and `NEXT_PUBLIC_FILRUNWAY_DEMO_SCALE=480`.

If your account's runway differs, pick N so that `7 × N` sits between your current runway and `runway + 625` — that is the whole rule, and it is arithmetic on your own `bootstrap -- status` output, not trial and error against the answer you want.

**Run mock mode at `FILRUNWAY_DEMO_SCALE=1`.** Mock is the one mode where the runway genuinely drains, so it needs no timescale — and since a demo scale multiplies the thresholds, leaving it at 480 would put the mock's 9.6-day opening runway thousands of days below the emergency threshold and fire an emergency top-up on the first tick instead of showing the bands being crossed.

### 9.4 How the scale is disclosed

When scaling is active the UI and the audit trail say so in three independent places, so no single cropped screenshot can hide it:

1. The gauge header carries a `DEMO TIMESCALE ×480 · READINGS REAL` badge (`src/components/RunwayGauge.tsx`).
2. Every rule label — including HOLD's, which carries no suffix of its own — is suffixed `×480 DEMO` and shows the *effective* (scaled) day figure next to its comparison operator, not the base one. At `×480` a card reads `SCHEDULED TOP-UP < 3,360d ×480 DEMO` or `HOLD >= 3,360d ×480 DEMO`, never the unscaled `< 7d` / `>= 7d`. This is `ruleLabel()` (`src/lib/format.ts:146`): a normal rule's threshold was already multiplied by `scaleRules()` upstream, while HOLD — the policy's catch-all rule, whose threshold is a `Number.MAX_SAFE_INTEGER` sentinel that must never be multiplied — has its figure substituted with `DEMO_BAND_WARNING_DAYS`, the same scaled top-up threshold, and gets the `×N DEMO` suffix appended explicitly, so all three decision cards read alike.
3. Every decision's `reasoning` ends with its own disclosure sentence, e.g. `Threshold shown is the 7-day rule at the ×480 demo timescale.` (`demoScaleNote()`, `src/lib/demo.ts:149`). This matters because a decision card is routinely screenshotted with the gauge header out of frame; without it, "below the 3360-day top-up threshold" would carry no hint that 3,360 is 7 × 480. At scale 1 the sentence is the empty string and nothing is added anywhere.

The agent also logs a warning line into the trace on startup whenever a timescale is in force. Unlike the journal disclosures, that banner deliberately stays an ordinary trace line rather than a durable `AgentNotice` — `src/lib/agent.ts:821` calls `log()`, not `notice()`, because the three places just listed already state the scale permanently and a late-arriving viewer cannot miss it. Durability is spent only where the fact would otherwise be unobtainable.

One thing the disclosures do **not** promise: that every card in the feed quotes the same scale. A card restored from the journal shows the threshold and suffix recorded with it, so a feed containing history from an earlier run at a different scale will show both. Each card is individually correct about the decision it describes. The `×380 DEMO` labels visible on older *mock* decision cards are not a contradiction and are not the current configuration: a restored card carries the rule label captured when that decision was taken, so it reports the scale in force at the time, which for that mock session was 380. See [limitation 9](#13-known-limitations-in-full).

One configuration trap, and the agent catches it for you: the gauge is a client component, and Next.js only inlines `NEXT_PUBLIC_*` into the browser bundle. Setting only the server-side `FILRUNWAY_DEMO_SCALE` makes the agent act on scaled thresholds while the gauge still draws a 14-day axis. `ensureAgentLoop()` compares the two raw values (`demoScaleAgreement()`, `src/lib/demo.ts:224`) and pins a `demo-scale-mismatch` **error** notice saying exactly which scale each half resolved (`src/lib/agent.ts:833`). Set both.

---

## 10. Setup reference

### 10.1 Requirements

Node 20.6+ (the bootstrap CLI uses `process.loadEnvFile`), npm, a browser.

### 10.2 A wallet

Create a fresh EOA for this. It is a hot key in a dotfile, so it must be a **Calibration testnet key you do not care about**. Never a mainnet key.

### 10.3 Fund it from both faucets

Two different tokens, both required:

| Token | Purpose | Faucet |
|-------|---------|--------|
| tFIL | gas for every transaction | https://faucet.calibnet.chainsafe-fil.io |
| USDFC | what storage is actually paid in | https://faucet.reiers.io |

The reference demo wallet is `0x48c54EAb7039f43DcAEd14ba44b999E16a9309bD`, funded with 119 tFIL and 2000 USDFC.
USDFC on Calibration is `0xb3042734b608a1B16e9e86B374A3f3e389B4cDf0`, 18 decimals.

### 10.4 `.env` vs `.env.local`

Next.js loads both `.env` and `.env.local` (and never commits either — see `.gitignore`), so `.env` works exactly as well as `.env.local` here; use whichever you prefer. The only difference is precedence: per the [load order in the Next.js docs](../node_modules/next/dist/docs/01-app/02-guides/environment-variables.md#environment-variable-load-order), `.env.local` overrides `.env` when both are present, so keep to one file to avoid values silently winning over the other. The README uses `.env` throughout because that is what the reference/demo machine runs.

### 10.5 The full environment reference

`.env.example` is the authoritative copy, with the rationale for each value written above it. Every variable, in one table:

| Variable | Default | What it does |
|---|---|---|
| `FILRUNWAY_MODE` | `mock` | `mock` runs `MockChainAdapter`: no keys, no RPC, no funds. `live` runs `SynapseChainAdapter` against Calibration for real. A `live` with a missing or malformed key fails **loudly** at startup and deliberately does not fall back. |
| `FILECOIN_PRIVATE_KEY` | — | Agent wallet key on Calibration. 32-byte hex, `0x` prefix optional. Read only by `src/lib/chain/synapse.ts` and `scripts/bootstrap.ts`. Never sent to the browser, never logged — only the derived address is. **Testnet only.** |
| `FILECOIN_RPC_URL` | SDK fallback set | Calibration RPC endpoint. Optional. |
| `NEXT_PUBLIC_FILRUNWAY_DEMO_SCALE` | `1` | The demo timescale the **gauge** draws. |
| `FILRUNWAY_DEMO_SCALE` | `1` | The demo timescale the **agent** acts on. Keep both at the same value; a mismatch pins an error notice. |
| `FILRUNWAY_DECISION_LOG` | unset | **Leave unset.** Unset, the journal path is derived per mode. Setting it points *both* modes at one file (still safe, but re-mixes the streams). `off` disables persistence entirely. |
| `FILRUNWAY_AGENT_DRIVER` | from `VERCEL=1` | Forces `interval` or `cron`. For a self-hosted long-running deployment that wants to keep the in-process timer. Anything other than those two literals is ignored rather than trusted — a typo must not silently disable the agent. |
| `FILRUNWAY_CRON_INTERVAL_MS` | `60000` | What the dashboard should **believe** the tick cadence is. Changes nothing about when a tick happens, only the NEXT TICK countdown. Set to `300000` on this deployment to match the GitHub Actions workflow. |
| `CRON_SECRET` | — | The shared secret `/api/tick` and `/api/squeeze` require, compared in constant time. Vercel's own name for it, so Vercel Cron sends `Authorization: Bearer $CRON_SECRET` with no extra wiring. A deployment that requires the check and has no secret **refuses every call with 503** rather than falling open. Generate with `openssl rand -hex 32`. |
| `FILRUNWAY_REQUIRE_TICK_AUTH` | unset | Forces the tick secret check on (`1`/`true`) or off (`0`/`false`) regardless of driver. Tests only. |
| `BLOB_READ_WRITE_TOKEN` | injected | **Never set by hand.** Injected when a Vercel Blob store is connected to the project. Without it, a deployment's journal disables itself loudly and pins a warning rather than silently writing to a `/tmp` that is about to be discarded. Works with a **public or a private** store. |
| `FILRUNWAY_BLOB_PREFIX` | `filrunway/journal` | Where in the Blob store the journal lives. Useful to give two deployments separate records in one store. |
| `FILRUNWAY_BLOB_ACCESS` | unset | **Leave unset.** Pins the store's access mode to `public` or `private`; unset, the journal works it out itself. An unrecognised value falls back to detection rather than to a guess. See [§11.4](#114-public-and-private-blob-stores). |
| `FILRUNWAY_MAX_DEPOSITS_24H` | `3` | Deposits the agent will allow itself inside the rolling window. |
| `FILRUNWAY_MAX_DEPOSIT_USDFC_24H` | `20` | Total USDFC it will allow itself inside the window. |
| `FILRUNWAY_SPEND_WINDOW_MS` | `86400000` | Length of that window. |
| `FILRUNWAY_SPEND_CAP` | unset | `on` / `off`, forcing the cap regardless of mode. Unset, it is enforced in LIVE and not in MOCK. |
| `FILRUNWAY_ENABLE_EVICTION` | unset (off) | Permits a `PRUNE_DATASET` decision to actually submit `terminateService`. On only for exactly `on` / `1` / `true` / `yes`. **Irreversible.** With it off the decision is still made and recorded. |
| `FILRUNWAY_SQUEEZE_USDFC` | `1` | Withdrawn by `POST /api/squeeze` when the caller names no amount. |
| `FILRUNWAY_MAX_SQUEEZE_USDFC` | `5` | Hard ceiling on a single squeeze. |
| `FILRUNWAY_MOCK_PROOF` | `healthy` | Mock only. `healthy` / `delinquent` / `unreadable` — which proof story the mock adapter's second data set tells. |
| `FILRUNWAY_MOCK_EPOCHS_PER_SECOND` | `120` | Mock only. Chain-time acceleration; 120 means one real second is about one hour of chain time. |

**There is no cron-schedule variable.** The schedule in `vercel.ts` is a hard-coded literal and has to be; see [§11.1](#111-cron-granularity-is-plan-gated).

### 10.6 Smoke-test the chain before touching the UI

```bash
npm run bootstrap -- status
```

Read-only, and it proves in one shot that the key parses, the RPC answers, the wallet holds gas and USDFC, Warm Storage is approved as a payments operator, and `accountSummary()` reads. It prints the raw `runwayInEpochs` value next to the derived days, the contract addresses resolved from the chain definition, and a suggested `FILRUNWAY_DEMO_SCALE`.

If approval is missing:

```bash
npm run bootstrap -- approve
```

### 10.7 Create a real cost stream

With nothing stored, `lockupRatePerEpoch` is `0`, `runwayInEpochs` is `maxUint256`, and the gauge correctly reads infinity forever. There is no budget to manage until the agent is paying for something.

```bash
npm run bootstrap -- fund 5            # deposit USDFC into Filecoin Pay
npm run bootstrap -- upload --demo     # 1 MiB of real data through PDP / Warm Storage
npm run bootstrap -- datasets          # confirm the data set exists onchain
```

`upload --demo` calls `storage.prepare()` (which covers the new cost stream, auto-depositing if the account lacks headroom) and then `storage.upload()`, which stores two copies. It prints the burn rate before and after, so you can watch a real cost stream come into existence.

### 10.8 Full CLI surface

```
npm run bootstrap -- status                        read-only smoke test
npm run bootstrap -- approve                       approve Warm Storage as operator
npm run bootstrap -- fund <amountUsdfc>            deposit USDFC into Filecoin Pay
npm run bootstrap -- upload <path>                 upload a file, creating a real cost stream
npm run bootstrap -- upload --demo [--size=1MiB]   upload generated filler instead
npm run bootstrap -- datasets                      list data sets and total stored bytes
```

`npx tsx scripts/bootstrap.ts <command>` is equivalent if you would rather skip the npm indirection.

```bash
npm run test         # 471 unit tests, 25 files
npm run typecheck
npm run lint
```

### 10.9 Running it

```bash
npm run dev          # http://localhost:3000
```

The agent starts on the first request to any API route and ticks every 15 seconds from then on. `RUN TICK NOW` in the status strip forces a cycle early; it is a convenience, not the mechanism. `SQUEEZE RUNWAY` next to it is the operator's forced-decision control — see [§7](#7-the-operator-squeeze). Locally, with `FILRUNWAY_MODE=mock`, neither asks for a secret.

---

## 11. Deploying to Vercel

The local agent is a `setInterval` in a process that stays alive. A Vercel Function exists for the length of one request, so that timer either never fires or fires on an instance nobody is looking at. Deploying therefore meant answering four questions the local build never had to — what drives the cycle, where the evidence lives, who is allowed to make the agent spend, and how much it may spend unattended — which is what `src/lib/deployment.ts`, `src/lib/blobJournal.ts`, `src/lib/tickAuth.ts` and `src/lib/spendGuard.ts` are.

### 11.1 Cron granularity is plan-gated

Vercel Cron's schedule resolution depends on your plan. **Hobby projects are limited to a small number of cron jobs that run at most about once a day, and the run may be up to an hour late.** Per-minute schedules need **Pro**. A once-a-day agent is a poor demo and a badly misleading one, since the dashboard's NEXT TICK countdown would be describing a schedule nobody would sit through.

This project is on Hobby, so it does this instead — it is exactly as autonomous, and the code cannot tell the difference:

1. `vercel.ts` declares a daily cron (`0 3 * * *`, `vercel.ts:64`) as a **backstop**, which is the finest the plan accepts, so the platform is satisfied.
2. The real cadence comes from an **external scheduler**: [`.github/workflows/agent-tick.yml`](../.github/workflows/agent-tick.yml), every 5 minutes, calling `POST https://filrunway.vercel.app/api/tick` with the **same** `Authorization: Bearer $CRON_SECRET` header Vercel Cron would have sent. (Add `CRON_SECRET` under the repository's **Settings → Secrets and variables → Actions** with the value the Vercel project holds. Any other scheduler — [cron-job.org](https://cron-job.org), anything that can issue an HTTP request — works identically.) The workflow uses a `concurrency` group so two runs cannot overlap, and its own comments note that GitHub's scheduled workflows are best-effort: five minutes is the floor of the interval, not a guarantee.
3. `FILRUNWAY_CRON_INTERVAL_MS` is set to that external cadence (`300000`), so the dashboard's NEXT TICK countdown describes the schedule actually in force rather than the 60s default.

Nothing about the agent changes: `/api/tick` is one handler behind one secret, and it does not know or care which scheduler called it.

**The cron schedule is a hard-coded literal in `vercel.ts`, and has to be.** There is no `FILRUNWAY_CRON_SCHEDULE` variable. On a **git-source** deployment the platform reads the config file **statically**, before any build runs, so it cannot resolve a `process.env` expression: it drops the key and schema validation fails with ``crons[0]`` missing required property ``schedule``. A local `vercel deploy` hid that for a long time, because there the CLI genuinely does compile `vercel.ts` on your machine and upload finished JSON. Change the backstop cadence by editing the one line in `vercel.ts` and redeploying; change the real cadence by editing the `cron:` in the workflow.

### 11.2 The steps, in order

```bash
# 1. Vercel CLI
npm i -g vercel
vercel login

# 2. Link this directory to a Vercel project
vercel link

# 3. Create a Blob store  ->  Vercel dashboard: Storage > Create > Blob,
#    then connect it to this project.
#    This INJECTS BLOB_READ_WRITE_TOKEN into the project's environment.
#    Never set that variable by hand.

# 4. Generate the tick secret
openssl rand -hex 32

# 5. Set the environment variables (see 10.5) on the project, in BOTH
#    Production and Preview. A preview deployment with no secret refuses
#    every tick; a preview deployment with no Blob store keeps no record
#    of the ones it does run.
vercel env add CRON_SECRET production
vercel env add CRON_SECRET preview
#    ... and likewise FILECOIN_PRIVATE_KEY, FILRUNWAY_MODE, the demo scale pair, etc.

# 6. Deploy
vercel deploy --prod
```

Step 3 is the one people skip. `BLOB_READ_WRITE_TOKEN` is **injected by the platform** when a Blob store is connected to the project — you do not paste it anywhere, and you should not add it as a manual environment variable. Locally, pull it down with `vercel env pull .env.local` when you want to read the deployed journal with `npm run decisions -- --remote`.

`vercel.ts` also sets `maxDuration` to 300s on the three long routes: `/api/tick` (line 75), `/api/squeeze` (line 83) and `/api/stream` (line 91). **Values are never printed in this repo.**

### 11.3 Which variables the deployment adds

Everything in [§10.5](#105-the-full-environment-reference) still applies. The ones that only matter deployed are `CRON_SECRET`, `BLOB_READ_WRITE_TOKEN`, `FILRUNWAY_CRON_INTERVAL_MS`, `FILRUNWAY_AGENT_DRIVER`, `FILRUNWAY_REQUIRE_TICK_AUTH`, `FILRUNWAY_BLOB_PREFIX` and `FILRUNWAY_BLOB_ACCESS`, plus the four spend-cap variables and the two squeeze bounds.

**`FILRUNWAY_DECISION_LOG`: do not set it on Vercel.** It names a filesystem path, and a Function's filesystem is read-only apart from an ephemeral `/tmp`. On a deployment with a Blob store connected, `selectJournal()` (`src/lib/blobJournal.ts:774`) honours exactly one value of it — `off`, which disables persistence entirely — and ignores any path, because a path there would be either an error or a `/tmp` file discarded with the instance. Setting it to `off` on a deployment means the agent's decisions leave no record at all, which is the one thing this project's autonomy claim cannot survive. Leave it unset.

### 11.4 Public and private Blob stores

A Vercel Blob store is provisioned **public or private**, and `@vercel/blob` (2.8) requires an explicit `access` on every write. The two are not interchangeable: writing `access: "public"` to a private store is refused with

```
Vercel Blob: Cannot use public access on a private store. The store is configured with private access.
```

and a private object is not readable with a plain `fetch` of `blob.url` at all — it is served from `<store>.private.blob.vercel-storage.com` and only to a request carrying the store's bearer token, which is why every read goes through the SDK's `get()` rather than `fetch()`.

**This once shipped hardcoded to `public` against a private store,** so every append was refused, the journal disabled itself, the agent silently fell back to in-memory only — and `journalPath` went on reporting `blob:filrunway/journal/…`, which the deposits tile renders as "from the durable decision log at …". The store held zero objects while the dashboard claimed a durable record. A journal that disables itself invisibly is worse than no journal, because the UI keeps making the claim.

The access mode is therefore **resolved, not assumed** (`src/lib/blobJournal.ts`), and the operator does not have to know which kind of store they connected:

1. `FILRUNWAY_BLOB_ACCESS`, if an operator has pinned it.
2. Otherwise **observed** from the store: one `list()` of a non-empty store returns object URLs on the `.public.` or `.private.` host, which settles it exactly, with no probe write.
3. Otherwise **corrected on first contact**: an access-mismatch rejection flips the mode and retries the same upload once. An empty store of the unexpected kind costs one refused request, once — not a dead journal.

Any other rejection (a suspended store, a network fault) still disables the journal as before, so the retry cannot mask a real failure. And a disabled journal reports `journalPath: null` plus a `journalError`, which pins a warning on the dashboard, drops the deposits tile's durability claim, and marks the DECISION LOG **NOT PERSISTED**.

### 11.5 Verifying the deployment

Run these in order. Each one fails loudly if the step before it was skipped.

1. **The backstop cron job is registered.** Vercel dashboard → your project → **Settings → Cron Jobs**. `/api/tick` must be listed at `0 3 * * *`. If the list is empty, `vercel.ts` did not make it into the build — check that there is no stray `vercel.json` competing with it, and that nothing in `vercel.ts` is computed at runtime (a git-source deploy reads that file statically and rejects what it cannot resolve). The **real** cadence is the GitHub Actions run history for `agent-tick`, not this list.

2. **The endpoint is closed.**

   ```bash
   curl -i https://<your-deployment>/api/tick
   ```

   Expect **`HTTP/2 401`** and a body saying the endpoint requires the deployment's shared secret. A **200** here means the deployment is spending on anyone's request — stop and fix `CRON_SECRET`. A **503** means the check is required and no secret is configured; the agent is safely doing nothing, and you need to set the variable and redeploy.

3. **The endpoint is open to the right caller.**

   ```bash
   curl -i -X POST https://<your-deployment>/api/tick \
     -H "Authorization: Bearer $CRON_SECRET"
   ```

   Expect **200** and a JSON body with `decision`, `status` and `coalesced`. `coalesced: true` just means a cycle was already running.

4. **The squeeze endpoint is closed too, and is POST-only.**

   ```bash
   curl -i https://<your-deployment>/api/squeeze              # expect 405
   curl -i -X POST https://<your-deployment>/api/squeeze      # expect 401 (LIVE)
   ```

5. **The dashboard agrees.** Open the deployment. You should see:
   - the `LIVE · CALIBRATION` badge (green, outlined) — correct on the **first painted frame**, because the mode is resolved server-side;
   - the OPERATOR control group with `RUN TICK NOW`, `SQUEEZE RUNWAY` and a secret input, rendered **inert** until a human pastes the secret;
   - a pinned `driver-cron` notice above the AGENT TRACE saying the agent is driven by a scheduled call to `/api/tick`, and a pinned `spend-cap` notice stating the deposit limits in force;
   - `NEXT TICK` counting down from the interval `FILRUNWAY_CRON_INTERVAL_MS` declares, not 15 seconds;
   - **no** `journal-write-failed` notice, and no `NOT PERSISTED` marker beside the DECISION LOG heading. Either one means the durable record is not being written and everything on screen is this instance's memory; the reason is in `status.journalError` on `/api/decisions`.

6. **Watch it act with nobody touching it.** Leave the page open, hands off. Decisions appear on their own. This is the strongest single demonstration the project has, and it is stronger than the local one: locally, opening the dashboard is what starts the loop. Here, nothing you do in the browser can cause a tick unless you have the secret.

7. **Read the deployed record from your own machine.**

   ```bash
   vercel env pull .env.local
   npm run decisions -- --remote
   npm run decisions -- --remote --executed
   npm run decisions -- --remote --id <id>
   ```

   Same parser, same mode scoping, same evidence section as the local reader. The `file` row reads `blob:filrunway/journal/` instead of a path.

8. **The store actually holds objects.** This is the only check that cannot be satisfied by a journal that has quietly given up, and it is the one that would have caught the private-store bug on the day it shipped. `journalPath` reporting `blob:…` is the agent's *intention*; the store's own listing is the *fact*.

   ```bash
   vercel env pull .env.local
   node -e "import('@vercel/blob').then(async ({ list }) => {
     const { blobs } = await list({ prefix: 'filrunway/journal/' });
     console.log('total blobs:', blobs.length);
     for (const b of blobs) console.log(' ', b.pathname, b.size + 'B', new URL(b.url).hostname);
   })"
   ```

   **`total blobs` must be greater than zero** after a tick has run, and each hostname tells you which kind of store you have (`.private.` or `.public.`). Zero objects while the dashboard shows decisions means persistence is failing — check the pinned notice and `status.journalError` on `/api/decisions`.

### 11.6 What is different on the deployment, honestly

Everything here is a real difference a viewer can notice. None of it is hidden by the UI.

| | Local (`npm run dev`) | Deployed (Vercel) |
|---|---|---|
| What drives a tick | `setInterval` in this process | An external scheduler calling `POST /api/tick` — GitHub Actions every 5 minutes, plus a daily Vercel Cron backstop |
| Tick interval | 15s | Whatever the scheduler runs at; `AgentStatus.tickIntervalMs` reports what `FILRUNWAY_CRON_INTERVAL_MS` declares (300s here), so NEXT TICK is honest |
| Operator controls | `RUN TICK NOW` and `SQUEEZE RUNWAY`, no secret required in mock | Present, but **inert until a human pastes `CRON_SECRET` into the page**. The secret is never in the bundle, never in the HTML, never stored |
| `journalPath` on screen | An absolute path, e.g. `D:\Filecoin_TLDR\data\decisions.jsonl` | `blob:filrunway/journal/live/…` |
| Gauge anchor readings | A fresh chain read every 2s (`SENSE_INTERVAL_MS`) | Every 10s at most (`REMOTE_SENSE_TTL_MS`, `src/lib/agent.ts:295`) — a TTL-gated shared cache, because that read is reachable from a public GET. The needle is smoother locally |
| Decision latency to the browser | Immediate — the tick and the SSE stream are the same process | Up to ~5s. The tick ran in one Function instance and the stream is held by another, so the page polls the shared journal every 5s (`REMOTE_POLL_MS`, `src/lib/deployment.ts:55`) and the stream republishes what the poll finds |
| SSE connection lifetime | Until you close the tab | Cut by the platform at `maxDuration` **300s** (`vercel.ts:91`). `EventSource` reconnects on its own (`retry: 3000`), the backlog replays, and the **whole pinned disclosure set is re-sent in full** on every connect — so a reconnect restates the disclosures rather than appending duplicates or losing them |
| Spending cap | Not enforced (MOCK), or enforced exactly within one process (LIVE) | Enforced across instances, but **eventually consistent** on a 3s refresh window rather than transactionally exact. Not reachable at one tick every five minutes; true anyway, and said here rather than discovered |
| `npm run bootstrap` | Full operator CLI | **Not reachable.** It is a local script, not a route: nothing on the deployment exposes `status`, `approve`, `fund`, `upload` or `datasets`. Run it against the same wallet from your own machine |
| `npm run decisions` | Reads `data/*.jsonl` | Add `--remote` to read the deployment's Blob journal |

---

## 12. What is real and what is not

### 12.1 Live mode (`FILRUNWAY_MODE=live`)

| Component | Status |
|-----------|--------|
| Agent address | Real. Derived locally from `FILECOIN_PRIVATE_KEY` via viem, with no RPC, so the status strip survives a node outage. |
| `runwayInEpochs`, `availableFunds`, `debt`, `lockupRatePerEpoch`, `totalLockup`, `epoch` | Real. `synapse.payments.accountSummary()` against Filecoin Pay on Calibration. |
| Wallet tFIL and USDFC balances | Real. `synapse.payments.walletBalance({ token })`, both tokens named explicitly. |
| Top-up transaction | Real. `synapse.payments.fund({ amount })`, submitted by the agent. The hash resolves on Filfox. |
| Transaction confirmation | Real. `client.waitForTransactionReceipt`; the tx event walks SUBMITTED to CONFIRMED or FAILED. |
| Stored data | Real. `storage.prepare()` then `storage.upload()`, two copies through Warm Storage and PDP. |
| The cost stream being managed | Real. It exists because real data sits under a real data set. |
| PDP proof state | Real. Five direct contract reads per data set — `PDPVerifier.dataSetLive`, `getDataSetLastProvenEpoch`, `getNextChallengeEpoch`, `WarmStorageStateView.provenThisPeriod`, `provingDeadline` — issued as one `multicall({ allowFailure: true })` and decoded so a revert or timeout arrives as an **absence**, never as a zero. |
| Data-set termination | Real, and **gated off by default**. `WarmStorageService.terminateService`, submitted only when `FILRUNWAY_ENABLE_EVICTION` is explicitly on. With it off the decision is still made, recorded and displayed; nothing is submitted and no data is touched. |
| The operator squeeze | Real, and **a human's action, not the agent's**. `synapse.payments.withdraw({ amount })` behind `CRON_SECRET` and a hard ceiling. It creates no `Decision`, adds nothing to the deposits tile, and pins a disclosure saying an operator caused the crisis on screen. |
| Contract addresses | Read from the chain definition at runtime (`synapse.chain.contracts`), never hardcoded. |
| Policy thresholds and gauge graduations | **Scaled** by `FILRUNWAY_DEMO_SCALE`. See [§9](#9-the-demo-timescale). |
| STORED DATA panel | Real. `ChainAdapter.listStorage()` reads the account's Warm Storage data sets, providers, sizes and active piece CIDs from the chain. Served by `/api/storage`; a failed read is a 503 the panel prints, never a placeholder row. |
| Gauge numeral, its epoch subtitle, and its band colour | **Not raw.** Interpolated client-side from a *measured* rate, anchored on the last real reading and capped at 8s of extrapolation. Every server reading snaps it back to truth. See [§9.1](#91-which-numbers-on-screen-are-raw-and-which-are-interpolated). |
| Decision history | Real and **durable**. Appended to an append-only JSONL journal, stamped MOCK / LIVE per line, and rehydrated into the store on start **scoped to the running mode**, so simulated spend can never be totalled as real. On disk locally; as append-only JSONL segments in Vercel Blob on the deployment, through the same parser. Read either with `npm run decisions`, adding `--remote` for the deployed one. |
| The spending cap | Real, and enforced against real money. At most 3 deposits and 20 USDFC per rolling 24h by default, counted from the durable journal. Reaching it records a `SAFETY_CAP` decision and submits nothing. LIVE only. |
| `/api/tick` authentication | Real on the deployment. `CRON_SECRET`, compared in constant time, required on both verbs; a deployment with the check required and no secret refuses every tick rather than falling open. Open on localhost, where the endpoint is not reachable from the internet and the default mode has no funds. |
| `/api/squeeze` authentication | Real **everywhere in LIVE mode**, localhost included, because this is the one endpoint that takes funds *out*. POST only. |

### 12.2 The onchain evidence

**The headline proof — cite this one.** The transaction the decision journal actually backs is [`0x06e27a6a…`](https://calibration.filfox.info/en/message/0x06e27a6a7fd532722727953b8d266f14d8109aaaa2c9edc8645bf17a1a2fcf6b) (status success, block 4,034,196, to the Filecoin Pay contract, 5 USDFC), paired with decision `1b2d98ef-4984-482f-b394-498ea99b29a6`. Run `npm run decisions -- --id 1b2d98ef-4984-482f-b394-498ea99b29a6` and it prints the reading, the rule that fired, the reasoning, and this exact hash — the one place where the proof command and the hash it names actually match, because it is the one hash the journal contains.

There is also an earlier autonomous top-up, [`0x17f5ecd7…`](https://calibration.filfox.info/en/message/0x17f5ecd765fdef0078241ec1e5b76d4017c96305f7ee80b347bbd29f50d03ac3) (status success, block 4,033,951, 5 USDFC, to the Filecoin Pay contract). It is real — made during live verification — but it predates the decision journal: it is not a line in `data/decisions.jsonl`, no `npm run decisions -- --id` command can produce it, and it must not be cited as agent-authored on the strength of this project's own evidence mechanism. Corroborating history, not proof.

And the transaction that funded the account in the first place, [`0x45ee3b49…`](https://calibration.filfox.info/en/message/0x45ee3b49ef5f247860181588b6a6f338fc09befcb3fe57af02de9b4a6608b005) — 20 USDFC, **operator-run** via `npm run bootstrap -- fund`, which also established the Warm Storage operator approval. Not agent-authored, and never presented as such.

Journals grow with every tick and a demo machine's file will not match this one line for line — always read the hash-and-decision pair off the machine you are demoing from rather than trusting a hash quoted in a document.

**The honest split, before you go looking for it.** Of the USDFC that has been deposited into this account's Filecoin Pay balance, **5 USDFC per top-up is agent-initiated and 20 USDFC was operator bootstrap** (`npm run bootstrap -- fund`, `0x45ee3b49…` above). The agent made one journal-provable autonomous deposit, not the whole balance. That is the claim, and it is the whole claim: the operator set the account up so there would be a cost stream to manage at all, and the agent then decided, on its own, to add to it.

The reason to say this first rather than let a judge find it: an autonomous top-up and an operator top-up are byte-identical on chain, so "the agent deposited this" is unverifiable from Filfox alone in either direction. What makes the one deposit *provably* the agent's is the decision recorded before it existed. Everything else in the account is the operator's, and is labelled as such here.

### 12.3 Mock mode (`FILRUNWAY_MODE=mock`, the default)

Entirely simulated. No key, no RPC, no funds. Chain time is accelerated to 120 epochs per real second (one real second is about one hour of chain time; override with `FILRUNWAY_MOCK_EPOCHS_PER_SECOND`), so a 9.6-day runway drains in roughly four minutes and the agent visibly crosses HOLD, then TOP_UP, then EMERGENCY_TOP_UP inside one sitting. The wallet starts at 250 USDFC. Transaction hashes and piece CIDs are random and resolve to nothing. The STORED DATA panel shows two fixed simulated data sets (`30291`, `30292`) holding the same piece, which is the shape a real 2-copy upload produces; `FILRUNWAY_MOCK_PROOF` decides what proof story the second one tells.

Mock mode cannot be mistaken for live, and that is true of the **first painted frame** as well as every frame after it. The mode badge has three states, not two: `MOCK DATA` (filled hazard-yellow, with the strip's yellow hazard stripe), `LIVE · CALIBRATION` (outlined green), and a neutral grey `CONNECTING` for the state where the mode is genuinely not known yet. It used to default to MOCK while unknown, which meant a LIVE demo's opening frame — the frame a screen recording starts on — was badged MOCK. `src/app/page.tsx` resolves the mode server-side with `getChainMode()` behind `connection()`, so the page is rendered per request and the badge is correct before any fetch happens. `connection()` rather than a prerender, so that a build in mock followed by a `next start` in live cannot ship a LIVE dashboard badged MOCK.

A live-mode misconfiguration fails loudly at construction rather than falling back to the mock (`src/lib/chain/index.ts:117`).

Decisions taken in mock mode are journalled too, to their **own file** — `data/decisions.mock.jsonl`, not the LIVE `data/decisions.jsonl` — and every line is stamped `"mode":"MOCK"`. So a mock record cannot reach the evidentiary file in the first place, and if it is already there (from a journal written before the split, or from an explicit `FILRUNWAY_DECISION_LOG` pointing both modes at one path) the scoped read keeps it out of the LIVE dashboard and the LIVE listing anyway. A mock record read back months later can never be mistaken for evidence of an onchain action.

---

## 13. Known limitations, in full

Ordered roughly by how much they would matter in production.

1. **Two of the brief's three responses, and the destructive one ships disarmed.** The brief allows three responses: top up, cut what you cannot afford, or decide what is worth paying to keep. The first is implemented and executes. The second is implemented as `PRUNE_DATASET` — the agent reads PDP proof state, judges a live-but-unproven data set not worth paying for, and decides to terminate its payment rail instead of buying runway — but **execution is off unless `FILRUNWAY_ENABLE_EVICTION` is explicitly set**, so on a default deployment the decision is made, recorded and displayed while nothing is submitted. The third, value-ranking across data sets, is not implemented: delinquency is the only criterion, and among delinquent sets the lowest id is chosen rather than the least valuable one.

2. **No partial top-up.** If the wallet holds less USDFC than a fired rule wants to deposit, the agent recognises this before acting: `evaluate()` returns `INSUFFICIENT_FUNDS` (outcome `NO_ACTION`), and `runTick()` returns before calling `deposit()`, so nothing is submitted and nothing can fail on-chain. It still does not deposit whatever partial balance is available, or down-shift to a smaller amount — an operator has to fund the wallet before the next tick can act. That down-shift is a reasonable future improvement.

3. **The post-prune re-sizing is a bound, not a measurement.** Filecoin Pay reports one aggregate `lockupRatePerEpoch` for the account with no per-rail split, so the burn rate that survives a termination is not readable in advance. `resizeTopUp()` divides pro-rata by rail *count*, the reasoning says so in those words, and the next reading re-decides against the true figure. It is stated rather than hidden, but it is still arithmetic standing in for a measurement.

4. **The local journal is single-writer; the deployed one is not, but neither is a database.** Decisions themselves are durable: every decision, and every later status transition of it, is appended to a JSON Lines record that `src/lib/store.ts` rehydrates on start. Locally that is `appendFileSync` from one single-threaded process, so two servers sharing one path would interleave and each would need its own `FILRUNWAY_DECISION_LOG`. (Two servers in *different* modes already get different files by default, so this is only a hazard for two servers in the same mode.) On Vercel that constraint is genuinely solved rather than inherited: `src/lib/blobJournal.ts` gives every writer its own segment objects, sealed at 50 lines, so there is no read-modify-write of a shared object and two Function instances ticking at the same moment cannot lose each other's lines. What is still *not* solved anywhere is querying and indexing — a read lists the whole prefix and concatenates it. The in-memory ring in front of it is still capped (200 decisions, 400 events), which bounds what the UI holds and nothing else; anything that ages out of the ring is folded into the server-side `totals` rather than lost. `store.backlog()` (`src/lib/store.ts:542`) is documented in code as a rolling tail that nothing durable may depend on, and the startup disclosures are exempt from aging out precisely because they travel as `notices` state rather than as backlog content. A journal that cannot be written disables itself with a warning and the agent carries on in memory, so a storage problem degrades the record rather than stopping the agent. It is an append-only evidence log, not a database.

5. **Two drivers, and only one of them is a timer.** `agentDriver()` (`src/lib/deployment.ts:73`) reads Vercel's own `VERCEL=1` marker and picks: `interval`, where `ensureAgentLoop()` starts `setInterval` timers from a route handler and a long-lived process owns them, or `cron`, where it starts **nothing** and an external scheduler calls `/api/tick` instead. The local timer is correct for `next dev` and `next start` and meaningless on a Function that lives for one request, so the deployed build does not pretend otherwise — and, importantly, under the cron driver no route may start a cycle as a side effect of being read, so merely opening the dashboard cannot make the agent spend. The residual limitation is that the two paths are genuinely different code: the cron path is covered by `src/lib/deployment.test.ts`, `src/lib/tickAuth.test.ts`, `src/lib/blobJournal.test.ts` and `src/app/api/tick/route.test.ts`, but a long-running deployment has not been observed for days at a time. See limitation 11.

6. **Hot key in a file.** `FILECOIN_PRIVATE_KEY` sits in `.env` (or `.env.local` — either is loaded). It is confined to two modules and scrubbed out of every error message that escapes them, but it is still a hot key. Testnet only.

7. **No backoff, though there is now a ceiling.** A failed deposit is recorded and retried on the next tick with the same amount, with no exponential backoff and no per-error retry cap. What it can no longer do is retry forever at the agent's own expense: `src/lib/spendGuard.ts` caps successful deposits at 3, and 20 USDFC, per rolling 24 hours in LIVE mode, and a retry that would cross either limit becomes a `SAFETY_CAP` decision instead of a transaction. That is a spend ceiling rather than a circuit breaker — it bounds the money, not the number of attempts, and a *failed* deposit consumes no cap because only EXECUTED decisions are counted. Proper backoff on the failure path is still the right improvement. The squeeze has no equivalent rate limit either: it is bounded per call, not per window.

8. **`getStoredItems()` in live mode lists only this process's own uploads**, not an onchain enumeration — it is empty on a freshly started server. The onchain answer is `ChainAdapter.listStorage()`, which is what `/api/storage`, the dashboard's STORED DATA panel and the proof reading use; `bootstrap -- datasets` prints the same thing from the CLI.

9. **The live gauge barely moves on its own, and the demo timescale does not change that.** At roughly $0.008/day of real burn, a runway of thousands of days does not visibly count down over a two-minute video. `FILRUNWAY_DEMO_SCALE` scales thresholds, not the burn rate, so runway still falls at about a day per real day and no threshold is ever *fallen through* by the passage of time on camera. The visible drain is a mock-mode phenomenon; on a live account the way to make a threshold crossing watchable is the operator squeeze, which is a real withdrawal disclosed as a human action.

10. **A restored decision card carries the rule label captured when the decision was taken.** This is within-mode staleness, not mode mixing, and it is pre-existing. `ruleLabel()` rewrites the day figure of the *catch-all* HOLD rule from the scale currently in force, but a rule that actually fired (`topup-7d`, `emergency-2d`) was scaled by `scaleRules()` at decision time and carries both its scaled `thresholdDays` and its `×N DEMO` suffix inside the stored `ruleFired.label`. So a mock session recorded at `×380` still displays `×380 DEMO` on its restored cards even when the current session runs at `×480`. That is correct as history — the card says what the agent actually compared against — but it does mean two cards in one feed can quote two different scales. The gauge badge, and every decision's own `reasoning` disclosure sentence, always state the scale that decision was taken at.

11. **Not verified against a long-running live deployment.** 471 unit tests across 25 files cover the pure logic, the journal and its mode scoping, the reader-side mode policy, the live adapter's helpers against the SDK's return shapes, the orchestration in `runTick()` against a scripted adapter, and every deployment-shaped module. What they do not cover is sustained multi-hour live behaviour, real Vercel Cron delivery, cross-instance journal convergence under genuine concurrency, RPC flakiness under load, provider-side upload failures, and an actual armed `terminateService` against a real delinquent data set — none of which have been exercised at length.

---

## 14. Tests

```bash
npm run test         # 471 tests across 25 files
npm run typecheck
npm run lint
```

Per file:

| File | Tests | What it pins |
|---|---:|---|
| `src/lib/journal.test.ts` | 44 | Append-only format, per-mode paths, mode-scoped reads, unknown-mode downgrade, totals. |
| `src/lib/tickAuth.test.ts` | 37 | Both header forms, the 401/503 split, the stricter squeeze rule, and that no rejection leaks whether a secret is configured. |
| `src/lib/blobJournal.test.ts` | 31 | Segmenting, sealing, re-read avoidance, mode scoping, selection, the remote reader, and public/private access resolution on both the write and read paths — against an injected IO fake. No network, no token. |
| `src/lib/agent.test.ts` | 28 | `runTick()` against a scripted adapter: failed reads, reverting deposits, unconfirmed transactions, concurrent ticks. |
| `src/lib/demo.test.ts` | 27 | Scaling, the HOLD sentinel, the disclosure sentence, scale agreement. |
| `src/lib/units.test.ts` | 27 | Decimal-string money maths. No floats anywhere. |
| `src/lib/policy.test.ts` | 25 | Threshold boundaries, rule ordering, the unbounded-runway sentinel, wallet shortfall, reasoning text. |
| `src/lib/chain/synapse.test.ts` | 25 | Pure helpers against the SDK's return shapes. |
| `src/lib/format.test.ts` | 21 | Rule labels, tile resolution, action colours. |
| `src/lib/journalReport.test.ts` | 21 | Reader-side mode policy: what counts as evidence, what a scope is hiding. |
| `src/lib/proof.test.ts` | 21 | The delinquency judgement, and every branch in which it must refuse to make one. |
| `src/lib/spendGuard.test.ts` | 20 | Window arithmetic, both limits, the refusal wording, EXECUTED-only accounting. |
| `src/app/api/squeeze/route.test.ts` | 20 | The withdraw endpoint: auth, POST-only, bounds, and that it produces no `Decision`. |
| `src/lib/decisions.test.ts` | 18 | Client-side decision and notice merging. |
| `src/lib/policyProof.test.ts` | 18 | The eviction branch of `evaluate()`, including the emergency fallback when eviction is disarmed. |
| `src/lib/deployment.test.ts` | 12 | The driver decision, including that a typo in the override is ignored rather than trusted. |
| `src/lib/squeeze.test.ts` | 11 | `planSqueeze()` bounds and every refusal's wording. |
| `src/lib/agentPrune.test.ts` | 10 | The prune end-to-end through `runTick()`, armed and disarmed. |
| `src/lib/agentSpendCap.test.ts` | 10 | The cap end-to-end through `runTick()`: a capped tick journals a `SAFETY_CAP` decision and submits nothing. |
| `src/app/api/tick/route.test.ts` | 9 | 401 without the secret, 503 when none is configured, 200 for both verbs with it, and that authorisation happens before anything else can run. |
| `src/app/api/stream/route.test.ts` | 9 | The real route handler with a real `Request`: backlog window, frame encoding, connect order. |
| `src/lib/chain/mock.test.ts` | 8 | The simulated adapter's clock and drain. |
| `src/lib/chain/proofDecode.test.ts` | 8 | Decoding a partial-failure `multicall` into a `ProofReading` — every revert and timeout must arrive as an absence, never as a zero. |
| `src/lib/agentSnapshot.test.ts` | 6 | The TTL-gated snapshot read the cron driver uses, including that a failed read falls back to the last true reading rather than a fabricated one. |
| `src/lib/eviction.test.ts` | 5 | That the destructive opt-in is off for everything except the four literal yes-values. |

---

## 15. Tech stack

| Layer | Choice |
|-------|--------|
| Framework | Next.js 16.3.4, App Router, React 19.2 |
| Language | TypeScript 5, strict |
| Styling | Tailwind CSS v4 |
| Filecoin | `@filoz/synapse-sdk` 1.2.1 — **viem-based, not ethers** — plus `@filoz/synapse-core` 0.8 for the PDPVerifier reads (`getDataSetSizes`, `getActivePiecesByCursor`) the SDK does not re-export |
| Chain client | viem 2.56 |
| Transport | Server-Sent Events (`/api/stream`), carrying `snapshot`, `decision`, `tx`, `log`, `totals` and `notices` events. No websocket. Locally there is no client polling loop except the STORED DATA panel, which polls `/api/storage` every 30s; on the deployment the dashboard also re-reads `/api/snapshot` and `/api/decisions` every 5s, because the tick and the stream live in different Function instances. |
| Persistence | Append-only JSON Lines, one stream per adapter mode. On disk locally (`src/lib/journal.ts`); as append-only segment objects in **Vercel Blob** (`@vercel/blob` 2.8, `src/lib/blobJournal.ts`) on Vercel, through the same parser. No database. |
| Deployment | Vercel. Project config in `vercel.ts`, type-checked against **`@vercel/config`** 0.7. Every value in it is static: a git-source deploy reads that file without evaluating it, so a computed value is dropped and fails schema validation. Cycle driven by a GitHub Actions workflow hitting `POST /api/tick` every 5 minutes, with a daily Vercel Cron Job as backstop; `maxDuration` 300s on the tick, squeeze and stream routes. |
| Tests | Vitest 4, **471 tests across 25 files** |
| Network | Filecoin Calibration, chain ID 314159, 30s epochs, 2880 epochs/day |
| Explorer | Filfox, `https://calibration.filfox.info/en/message/<hash>` |

Both `@filoz/synapse-sdk` and `@filoz/synapse-core` are listed in `serverExternalPackages` in `next.config.ts`: they are ESM-only and reach for Node built-ins, and they are only ever reachable through the server-only chain adapter.

A note on the SDK version, because most code samples online are stale: 1.2.1 removed the pre-1.0 surface. `Synapse.create({ account, source })` is synchronous and takes a viem account. `Synapse.create({ privateKey, rpcURL })`, `preflightUpload`, `getServicePrice`, `operatorApproval`, `RPC_URLS` and `terminateDataSet` no longer exist. There is also no proof-state helper, which is why `src/lib/proof.ts` and `readProofStates()` read the PDP and Warm Storage contracts directly through the chain definitions the SDK carries.

---

## 16. Repository map

| Path | What it is |
|------|-----------|
| `src/lib/types.ts` | The domain contract. The only thing shared across the chain boundary. |
| `src/lib/policy.ts` | `evaluate()`. Pure. The product. |
| `src/lib/proof.ts` | PDP proof state, and the one judgement the agent is allowed to make from it. Pure and paranoid: an unread field is never evidence of a missed proof. |
| `src/lib/eviction.ts` | The opt-in that lets a `PRUNE_DATASET` decision actually reach the chain. Off unless someone deliberately turned it on. |
| `src/lib/squeeze.ts` | Bounds for the operator's SQUEEZE RUNWAY control. Pure. |
| `src/lib/agent.ts` | `runTick()`: sense, decide, act. Plus tick coalescing, the storage listing cache, the spend and eviction gates, and `squeezeRunway()` — the one function here that is not the agent acting. |
| `src/lib/journal.ts` | The durable append-only decision journal. The evidence file. Per-mode paths, mode-scoped reads. |
| `src/lib/journalReport.ts` | Reader-side mode policy: `--mode` parsing, what counts as evidence, what a scope is hiding. Pure. |
| `src/lib/blobJournal.ts` | The same append-only journal on Vercel Blob: per-writer segments, sealed at 50 lines, no shared-object read-modify-write. Also `readBlobJournal()`, which is what `npm run decisions -- --remote` reads, and `selectJournal()`, which picks disk or Blob. |
| `src/lib/deployment.ts` | Where this process is running and what that changes: the `interval` / `cron` driver, the real tick interval, whether the dashboard must poll. |
| `src/lib/tickAuth.ts` | The shared-secret check on `/api/tick` and `/api/squeeze`. Constant time, fail-closed, identical rejection text whatever went wrong. |
| `src/lib/spendGuard.ts` | The agent's own rolling 24h deposit cap. Pure; the caller supplies history, clock and limits. |
| `src/lib/chain/index.ts` | `ChainAdapter` interface (including `listStorage()`, and the optional `terminateDataSet()` / `withdraw()`) and adapter selection. |
| `src/lib/chain/synapse.ts` | Live Calibration adapter. One of two files that see the key. Also `readProofStates()` and `decodeProofOutcomes()`. |
| `src/lib/chain/mock.ts` | Accelerated simulation for keyless demos, including the three proof stories. |
| `src/lib/demo.ts` | `FILRUNWAY_DEMO_SCALE`, and a long comment justifying it. |
| `src/lib/store.ts` | In-memory ring + SSE pub/sub, in front of the journal. Owns the standing disclosures. |
| `src/lib/units.ts` | Decimal-string money maths. No floats anywhere. |
| `src/app/page.tsx` | Server-rendered per request via `connection()`, so the mode badge and the operator controls' auth state are right on first paint. |
| `src/app/api/*` | `snapshot`, `decisions`, `tick`, `squeeze`, `stream`, `storage`. |
| `src/components/*` | `RunwayGauge`, `StatTile`, `DecisionFeed`, `StoragePanel`, `StatusStrip`, `OperatorControls`, `Dashboard`. |
| `vercel.ts` | Vercel project config: the daily backstop cron schedule (a static literal — a git-source deploy reads this file without evaluating it) and `maxDuration` on the tick, squeeze and stream routes. Type-checked against `@vercel/config`. |
| `.github/workflows/agent-tick.yml` | The real driver: `POST /api/tick` every 5 minutes with the shared secret. |
| `scripts/bootstrap.ts` | Operator CLI. The other file that sees the key. |
| `scripts/decisions.ts` | Decision-log reader, plus `--split` and `--remote`. Needs no key and no server. |
| `docs/DEMO_SCRIPT.md` | Shot-by-shot video script. |
| `docs/SHOWCASE.md` | Submission blurb and X thread. |

Test files sit next to what they test; see [§14](#14-tests) for the breakdown.
