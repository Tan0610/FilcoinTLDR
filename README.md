# FilRunway

An autonomous agent that reads its own onchain balance and runway on Filecoin Pay, decides whether it can afford to keep its data alive, and tops itself up before it runs dry. You watch the decision happen on a live dashboard.

Built for **FilecoinTLDR Builder Challenge Cycle 4 — "Build an AI Agent That Manages Its Own Storage Budget."**
Direction: **Stay Alive + Show the Meter.**

Network: **Filecoin Calibration testnet**, chain ID `314159`. Nothing here touches mainnet.

---

## Why this exists

An agent that stores data on Filecoin is easy. An agent that knows whether it can *afford* the data it is storing is not. Storage through Warm Storage is a continuous cost stream: a lockup rate per epoch, drawn against a balance held in Filecoin Pay. When that balance runs out the account goes into debt and the data stops being paid for.

FilRunway closes that loop. Every 15 seconds it reads its own Filecoin Pay account, evaluates a policy against the runway it just read, and, with no human in the path, submits a real USDFC deposit when the runway is short. Every decision, including the decisions to do nothing, is written to a durable append-only audit log alongside the numbers it was based on — which is what makes "the agent authored this transaction" checkable rather than merely asserted. See [`npm run decisions`](#proving-the-agent-authored-the-transaction--npm-run-decisions).

The interesting part is not the transaction. It is the moment the agent looks at `runwayInEpochs` and concludes it should act.

---

## Where the decision happens

If you have one minute, read these five places in this order.

| # | What | File | Symbol / line |
|---|------|------|---------------|
| 1 | The runway is **read from the chain**, not derived | `src/lib/chain/synapse.ts` | `getSnapshot()` line 347 calls `synapse.payments.accountSummary()` — line 351 |
| 2 | `runwayInEpochs` becomes the snapshot | `src/lib/chain/synapse.ts` | `toRunwaySnapshot()` line 129, `runwayEpochsToNumber()` line 100 |
| 3 | **The decision itself.** Pure function, zero I/O | `src/lib/policy.ts` | `evaluate()` line 119; rule selection line 130; `selectRule()` line 92 |
| 4 | The agent acts on it, unprompted — or declines when it cannot afford to | `src/lib/agent.ts` | `executeTick()` (the body behind `runTick()`): `evaluate(...)` line 228, `INSUFFICIENT_FUNDS` early return line 239, `adapter.deposit(...)` line 260 |
| 5 | The deposit is a real onchain transaction | `src/lib/chain/synapse.ts` | `deposit()` line 375 calls `synapse.payments.fund({ amount })` — line 382 |

The single load-bearing line is `src/lib/policy.ts:130`:

```ts
const rule = selectRule(days, rules);
```

`days` came from `accountSummary().runwayInEpochs`. `rules` is the agent's policy. The transaction, the dashboard and the audit log are all downstream consequences of that one comparison — including the one case where there is no transaction: if the wallet cannot cover the deposit the fired rule wants, `evaluate()` returns `INSUFFICIENT_FUNDS` instead of the rule's action, and `runTick()` returns before ever calling `deposit()`.

### `runwayInEpochs` is a first-class onchain field

Worth stating explicitly, because it is the difference between an agent that *reads* its runway and one that *guesses* it.

`synapse.payments.accountSummary()` returns, from the Filecoin Pay contract:

| Field | Meaning |
|-------|---------|
| `runwayInEpochs` | How many epochs the account can keep paying. **Read, not computed.** |
| `availableFunds` | Unlocked USDFC available to cover future lockup |
| `funds` | Total USDFC held in Filecoin Pay |
| `debt` | USDFC owed; non-zero means the account is already underwater |
| `lockupRatePerEpoch` | The burn rate created by active storage commitments |
| `totalLockup` | USDFC currently locked against existing commitments |
| `grossCoverageInEpochs` | Coverage before debt is netted off |

FilRunway does not divide a balance by a burn rate and call the result runway. It asks the contract. Two edge cases the contract returns, both handled explicitly at `src/lib/chain/synapse.ts:100`:

- `runwayInEpochs == maxUint256` when `lockupRatePerEpoch == 0`, meaning nothing is being stored and the runway is unbounded. The gauge renders an infinity glyph.
- `runwayInEpochs == 0` when `debt > 0`, meaning the account is already in deficit.

Both map onto a large **finite** sentinel (`src/lib/constants.ts:49`) rather than `Infinity`, because `JSON.stringify(Infinity)` is `null`, and a null arriving over SSE would render as a critical zero — the exact opposite of the truth.

---

## Proving the agent authored the transaction — `npm run decisions`

**Read this before you believe any autonomy claim in this README.**

An autonomous `TOP_UP` and an operator typing `npm run bootstrap -- fund 5` produce **byte-identical** transactions on Filecoin Pay. Nothing on chain records which one moved the money. A transaction hash on Filfox is therefore evidence that *something* deposited USDFC, and evidence of nothing else.

The only thing that separates the two is the `Decision` that preceded the agent's: the reading it was taken from, the rule that fired, the reasoning it wrote, and the tx hash it produced. Those decisions are appended to a durable, append-only JSON Lines file (`src/lib/journal.ts`), and this command reads it:

```bash
npm run decisions                  # summary + most recent decisions + every tx the agent authored
npm run decisions -- --mode live   # LIVE records only (default: whatever FILRUNWAY_MODE is)
npm run decisions -- --mode mock   # simulated records only
npm run decisions -- --mode all    # both, every row labelled with its mode
npm run decisions -- --limit 100   # show more than the default 20
npm run decisions -- --executed    # only decisions that moved money
npm run decisions -- --id <id>     # ONE decision in full: reading, rule, reasoning, outcome, tx hash
npm run decisions -- --json        # raw {mode, decision} records, for jq
npm run decisions -- --split       # move historical MOCK records out of the LIVE journal (dry run)
```

`scripts/decisions.ts` needs **no private key, no RPC and no running server** — it only reads the file. The bare form ends with a `transactions the agent authored` block that pairs every tx hash with its Filfox URL, the id of the decision that authored it, and the exact command to expand that decision.

To line the headline transaction in this README up against the decision that produced it:

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
  showing                LIVE records only
  decisions              644
  executed               1
  deposited              5 USDFC
  covering               2026-09-02 12:30:30 .. 2026-09-02 15:17:14 UTC
  not shown              6 MOCK decisions (npm run decisions -- --mode mock)

most recent 20 of 644
---------------------
  taken at            mode action             outcome        runway  tx
  2026-09-02 15:17:14 LIVE HOLD               NO_ACTION    3594.68d  —
  …

transactions the agent authored (LIVE, onchain)
-----------------------------------------------
  0x06e27a6a7fd532722727953b8d266f14d8109aaaa2c9edc8645bf17a1a2fcf6b
  https://calibration.filfox.info/en/message/0x06e27a6a7fd532722727953b8d266f14d8109aaaa2c9edc8645bf17a1a2fcf6b
  decision 1b2d98ef-4984-482f-b394-498ea99b29a6 · 2026-09-02 12:30:30 UTC
  npm run decisions -- --id 1b2d98ef-4984-482f-b394-498ea99b29a6
```

The decision count keeps climbing (a fresh run will show more than 644, and a later timestamp) because the agent ticks every 15 seconds and the dev server was running while this was captured — the hash, the decision id and the `deposited 5 USDFC` total are what stay fixed.

**One transaction and 5 USDFC**, not more. That same file also holds 6 MOCK decisions from an earlier mock session whose 5 simulated top-ups total 75 simulated USDFC — which is exactly why an *unscoped* read of it would have reported `6 transactions` and `80 USDFC`, and why every read is now scoped. The decision count is whatever the journal holds when you run it and grows with every 15-second tick; the deposit figures do not.

Two caveats, stated up front:

- **`data/` is gitignored.** A judge who clones this repo starts with an empty log. The record has to be shown from the machine that actually ran the agent — a terminal capture in the demo video, or the file itself. There is no way to ship it in the repo without also making it forgeable.
- **Records are stamped `MOCK` or `LIVE` per line**, and that stamp is now acted on rather than merely written. See directly below.

### The journal is mode-scoped

A MOCK decision is a real record of a real decision, but its transaction hash was invented by the mock adapter and is on no chain anywhere. Presenting the two streams in one total is the single misrepresentation this feature exists to prevent, so the mode stamp now drives three separate things.

**1. Writes go to separate files by default.** With `FILRUNWAY_DECISION_LOG` unset, the path is derived from `FILRUNWAY_MODE` (`journalPathFor()`, `src/lib/journal.ts:488`):

| `FILRUNWAY_MODE` | Journal file | |
|---|---|---|
| `live` | `data/decisions.jsonl` | The evidentiary record. **Unchanged**, so every existing reference to that path still resolves. |
| `mock` | `data/decisions.mock.jsonl` | Simulated spend, diverted here so it can never be appended into the file above. |

Both are gitignored.

**Leave `FILRUNWAY_DECISION_LOG` unset.** Setting it explicitly points *both* modes at that one file. That is still safe — every record is stamped and every read is scoped, so the dashboard and the CLI stay separated either way — but it re-mixes the two streams into one file, which is the state the per-mode default exists to avoid. Set it to `off` to disable persistence entirely and keep decisions in memory only.

**2. Reads are scoped to the running mode.** `FileDecisionJournal.load()` (`src/lib/journal.ts:419`) defaults its scope to the journal's own mode, so a LIVE server replaying a file that also holds MOCK lines gets its own history back and nothing else. Crucially, a record whose `mode` field is missing or unrecognised reads as **MOCK** (`recordMode()`, `src/lib/journal.ts:270`): downgrading an unknown line is the only safe default, because a line must never be promoted into evidence by being unreadable. What the scope leaves out is counted (`byMode`) and disclosed rather than silently dropped.

**3. The dashboard shows one mode and says which.** The AUTONOMOUS DEPOSITS tile and the decision feed are both fed from that scoped load, and `depositsTile()` (`src/lib/format.ts:192`) resolves the tile from the mode:

| Mode | Tile |
|---|---|
| LIVE | `AUTONOMOUS DEPOSITS` · `5` `USDFC` · sub-line `1 transaction · 602 decisions`. Green accent once anything has executed. |
| MOCK | `SIMULATED DEPOSITS` in hazard yellow (`var(--mock)`) · sub-line `MOCK · 5 sim tx · 6 decisions`. |
| not yet known | `AUTONOMOUS DEPOSITS` · `—` · `confirming adapter mode…`. Nothing is totalled under a mode nobody has confirmed. |

MOCK is marked in three independent places — the first word of the label, the hazard-yellow accent, and the leading `MOCK ·` of the sub-line — so no crop of a screenshot can hide it. The figure itself is never altered: it is a true count of simulated activity, not a fake count of real activity.

The AGENT TRACE says the same thing in words on startup (`AgentStore.hydrate()`, `src/lib/store.ts:116`). On the reference machine the restore line reads:

```
Restored 602 LIVE decisions from D:\Filecoin_TLDR\data\decisions.jsonl (1 executed,
5 USDFC deposited). 6 MOCK decisions in this file were not restored (this process is
LIVE); read them with `npm run decisions -- --mode mock`.
```

That second sentence is the point. An omission a viewer cannot see is indistinguishable from a file that never held those records, so the line states how many records were withheld, why they were withheld, and the exact command that reads them.

### The disclosure outlives the trace line

That restore line is an ordinary log event, and the trace it lands in is a rolling tail. Within minutes of boot it has scrolled away, and a judge opening the dashboard an hour later would have seen nothing. So the fact it carries is now held separately, as state. `discloseOmissions()` (`src/lib/store.ts:171`) raises it as an `AgentNotice` — a key, a level and a message, and nothing else (`src/lib/types.ts:137-142`):

```
6 MOCK decisions in D:\Filecoin_TLDR\data\decisions.jsonl are withheld from this LIVE
view. Read them with `npm run decisions -- --mode mock`.
```

The same facts as the restore line, said again where they cannot expire. `addNotice()` (`src/lib/store.ts:207-221`) is idempotent by key and republishes the *whole* current set whenever it grows, and `/api/stream` sends that whole set on every connect *after* the backlog, so an older copy still sitting in the tail can never overwrite the authoritative one (`src/app/api/stream/route.ts`). The client replaces its copy rather than appending to it — `newerNotices()` (`src/lib/decisions.ts:104-110`) returns the existing array untouched when nothing is newer, so a reconnect restates the disclosure without re-rendering the row. It draws as a `PINNED` row above the rolling AGENT TRACE list, coloured by level (`src/components/Dashboard.tsx`).

Five siblings ride the same channel: unreadable lines skipped, a journal that could not be read at all, a journal write that failed mid-session, persistence switched off entirely, and a `FILRUNWAY_DEMO_SCALE` that disagrees with its `NEXT_PUBLIC_` twin. Every one is raised behind an explicit conditional and the set starts empty, so a clean load in a single-mode journal pins nothing. **Nothing withheld means no notice at all**, which is the whole reason a pinned row is worth believing: it is only ever there because it is true. A viewer arriving hours after boot still sees what was withheld and the exact command that reads it.

### What `--mode` can and cannot widen

`--mode live|mock|all` selects the scope and defaults to `FILRUNWAY_MODE` (`parseModeArg()`, `src/lib/journalReport.ts:32`). An unrecognised value is an error rather than a silent fallback, because a typo that quietly widened the scope back to "everything" would reintroduce the mixed listing this exists to remove.

- **Every listed row carries a `mode` column, at every scope.** A column that appears only sometimes trains a reader to stop looking for it.
- **A `not shown  N MOCK decisions` line appears whenever the scope hides records**, with the command that shows them (`scopeNotice()`, `src/lib/journalReport.ts:81`). A reader must be able to tell "there are no MOCK records" from "MOCK records exist and you are not looking at them".
- **The `transactions the agent authored (LIVE, onchain)` section can be narrowed but never widened.** It is handed the *whole* file, unscoped, and hard-filters to LIVE-with-a-hash (`evidenceEntries()`, `src/lib/journalReport.ts:55`). MOCK is excluded inside that function rather than by the caller's scope, so no argument, default or later refactor can put a simulated hash in it. At `--mode mock` the section still appears and reads `1 recorded, not listed at --mode mock` — out of scope rather than absent, and the difference is stated.
- **Simulated hashes get their own heading**, `simulated transaction hashes (MOCK — NOT onchain, not evidence)`, rather than being silently dropped.
- **`--id` searches every mode**, so an id that exists never reads as absent just because the current scope excludes it. A MOCK hit is printed under a `SIMULATED — MOCK ADAPTER` warning, its hash is labelled `tx hash (simulated)`, and **no explorer link is printed** — there is nothing on chain to link to.

Both journal files are opened on every run whatever the mode, so the scope decides what is *shown*, never what is *reachable*.

### Un-mixing an already-mixed file: `--split`

A journal written before the per-mode split holds both streams. That file is append-only evidence and must not be rewritten, so nothing is done to it automatically. `--split` is the explicit, opt-in way to copy the MOCK records out of the LIVE journal into the MOCK one (`split()`, `scripts/decisions.ts:210`):

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

---

## Architecture

```
                       Filecoin Calibration (chain 314159)
                       +--------------------------------------+
                       |  Filecoin Pay      Warm Storage/PDP  |
                       |  accountSummary()  storage.prepare() |
                       |  fund()            storage.upload()  |
                       +---------------^----------------------+
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
        |        +--> src/lib/policy.ts  evaluate()   PURE, 25 tests   |
        |        |         snapshot + PolicyRule[]  ->  Decision       |
        |        |                                                     |
        |        +--> src/lib/store.ts   ring buffer + SSE pub/sub     |
        |                  |                                           |
        |                  +--> src/lib/journal.ts  append-only JSONL  |
        |                       durable; one file per mode;             |
        |                       rehydrated on start, scoped to the mode |
        +------------------------------+-------------------------------+
                                       |
        +------------------------------v-------------------------------+
        |  /api/snapshot  /api/decisions  /api/tick  /api/stream       |
        |  /api/storage                                                |
        +------------------------------+-------------------------------+
                                       | EventSource (SSE)
        +------------------------------v-------------------------------+
        |  Dashboard: RunwayGauge · StatTile · DecisionFeed ·          |
        |             StoragePanel · StatusStrip                       |
        +--------------------------------------------------------------+
```

Nothing above `src/lib/chain/` imports the Synapse SDK or can see a private key. The whole product is written against `RunwaySnapshot` and `Decision` in `src/lib/types.ts`, which is why the same dashboard and the same policy engine run unchanged against a simulated chain and a live one.

### API surface

| Route | Returns |
|---|---|
| `GET /api/snapshot` | `{ snapshot: RunwaySnapshot, status: AgentStatus }` |
| `GET /api/decisions?limit=N` | `{ decisions: Decision[], status: AgentStatus }` |
| `GET /api/storage` | `{ storage: StorageListing, status: AgentStatus }`, or **503** with `{ error }` when the chain read fails. The gauge and decision feed do not depend on it, so it is allowed to fail alone rather than take the dashboard down. |
| `POST /api/tick` | `{ decision: Decision, status: AgentStatus, coalesced: boolean }`. `coalesced: true` means a cycle was already in flight and this decision was **not** taken for this request. |
| `GET /api/stream` | SSE: `snapshot`, `decision`, `tx`, `log`, `totals`, `notices`. The backlog replays first, then the whole current disclosure set. |

`AgentStatus` carries `mode`, `address`, `tickIntervalMs`, `lastTickAt`, `nextTickAt`, plus `totals` (whole-history aggregates from the journal, **scoped to `mode`**), `journalPath` (the absolute path of this mode's journal file, or `null` when persistence is off or has disabled itself) and `notices` (the standing disclosures, oldest first, empty when there is nothing to disclose). `GET /api/decisions` serves the store's ring, which was hydrated under the same scope, so the feed a browser receives is single-mode by construction.

---

## The loop

`ensureAgentLoop()` (`src/lib/agent.ts:336`) starts two timers on the first API request, lazily, so nothing schedules work during `next build`.

| Timer | Interval | Constant | Job |
|-------|----------|----------|-----|
| sense | 2s | `SENSE_INTERVAL_MS` | Read the chain, publish a snapshot. Drives the gauge. |
| tick | 15s | `TICK_INTERVAL_MS` | Full sense, decide, act cycle. |

One tick, in order:

```
1. sense()                       agent.ts:120  accountSummary + both wallet balances
   read failed? --------------->  FAILED Decision recorded, agent HOLDs on stale data.
                                  An RPC outage is an audit-log entry, not a 500, and
                                  it renders as a red FAILED card carrying the error.

2. evaluate(snapshot, RULES)     agent.ts:228  pure; Decision + reasoning string

3. journal + publish decision    store.ts:235  appended to the JSONL log BEFORE it
                                  reaches the in-memory ring, then -> SSE -> the
                                  dashboard renders it immediately

4. action == INSUFFICIENT_FUNDS? ->  return. outcome = NO_ACTION. Rule fired but
                                  the wallet can't cover it; no deposit attempted.
                                  agent.ts:239

5. action == HOLD ? ---------->  return. outcome = NO_ACTION. Nothing is sent.

6. deposit(amount)               agent.ts:260  payments.fund() -> real tx hash
   publish tx event  SUBMITTED

7. waitForTransaction(hash)      synapse.ts:387  waitForTransactionReceipt
   publish tx event  CONFIRMED | FAILED
   the updated Decision is journalled again, so the PENDING line and the
   EXECUTED / FAILED line both survive on disk

8. sense() again                 so the gauge reflects the new balance at once
```

Only one cycle runs at a time. A `POST /api/tick` that arrives mid-cycle does not start a second one and does not silently re-serve an older decision: the response carries `coalesced: true`, so a caller can tell that the decision it got back was not taken for its request (`runTick()`, `src/lib/agent.ts:171`).

Steps 4 and 5 matter as much as step 6. A HOLD and an INSUFFICIENT_FUNDS decision are still decisions: both are recorded with full reasoning and rendered as visually distinct cards in the decision log — INSUFFICIENT_FUNDS gets a red, inverted card of its own, separate from the grey HOLD card. An agent that only logs when it acts, or that submits a transaction it already knows will fail, is not showing you its judgement.

### The policy

`DEFAULT_RULES`, `src/lib/policy.ts:32`. Rules are evaluated lowest-threshold-first; the first rule whose `thresholdDays` the runway has fallen below wins.

| Rule id | Fires when | Action | Deposit |
|---------|-----------|--------|---------|
| `emergency-2d` | runway < 2 days | `EMERGENCY_TOP_UP` | 15 USDFC |
| `topup-7d` | runway < 7 days | `TOP_UP` | 5 USDFC |
| `hold` | otherwise | `HOLD` | 0 |

A rule can only ever ask for `TOP_UP`, `EMERGENCY_TOP_UP` or `HOLD` — `PolicyAction` has no fourth option, so this table cannot be configured to produce one. `evaluate()` can still conclude a fourth, un-configurable outcome, `INSUFFICIENT_FUNDS`: if the rule that fires wants a deposit larger than the wallet holds, the engine reports the shortfall instead of returning the rule's action, and `outcome` is `NO_ACTION` rather than `PENDING`. Nothing is submitted, so there is nothing to fail on-chain. This is reachable in live mode whenever the wallet is genuinely short; in mock mode the wallet starts at 250 USDFC, so the default demo never reaches it, and doing so on purpose takes roughly 16 emergency top-ups.

`evaluate()` is pure: `(RunwaySnapshot, PolicyRule[]) -> Decision`. No clock read unless you inject one, no chain call, no side effect. That is deliberate. The part a judge is most likely to be suspicious of should be the part that is easiest to test. 25 unit tests in `src/lib/policy.test.ts` cover threshold boundaries, rule ordering, the unbounded-runway sentinel, wallet-shortfall detection and the reasoning text. The orchestration around it is no longer taken on trust either: `src/lib/agent.test.ts` drives `runTick()` against a scripted adapter (a read that throws, a deposit that reverts, a transaction that never confirms, a tick that arrives mid-cycle) with no network and no key.

Every `Decision` carries a `reasoning` string built from the numbers actually read. A real HOLD and a real TOP_UP read like this:

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

Those three are at `FILRUNWAY_DEMO_SCALE=1`. When a demo timescale is in force the thresholds quoted in the reasoning are the **scaled** ones, and every decision appends its own disclosure sentence (`demoScaleNote()`, `src/lib/demo.ts:149`) so a decision card screenshotted on its own still says what it was compared against. At `×480` the same TOP_UP reads:

```
Runway 2969.9 days (8,553,196 epochs) is below the 3360-day top-up threshold.
Burn rate 0.000002777832968892 USDFC/epoch against 23.76 USDFC available.
Depositing 5 USDFC extends runway to ~3594.4 days.
Threshold shown is the 7-day rule at the ×480 demo timescale.
```

---

## Setup from zero

### 0. Requirements

Node 20.6+ (the bootstrap CLI uses `process.loadEnvFile`), npm, a browser.

### 1. A wallet

Create a fresh EOA for this. It is a hot key in a dotfile, so it must be a **Calibration testnet key you do not care about**. Never a mainnet key.

### 2. Fund it from both faucets

Two different tokens, both required:

| Token | Purpose | Faucet |
|-------|---------|--------|
| tFIL | gas for every transaction | https://faucet.calibnet.chainsafe-fil.io |
| USDFC | what storage is actually paid in | https://faucet.reiers.io |

The reference demo wallet is `0x48c54EAb7039f43DcAEd14ba44b999E16a9309bD`, funded with 119 tFIL and 2000 USDFC.
USDFC on Calibration is `0xb3042734b608a1B16e9e86B374A3f3e389B4cDf0`, 18 decimals.

### 3. Install and configure

```bash
npm install
cp .env.example .env
```

Next.js loads both `.env` and `.env.local` (and never commits either — see `.gitignore`), so `.env` works exactly as well as `.env.local` here; use whichever you prefer. The only difference is precedence: per the [load order in the Next.js docs](node_modules/next/dist/docs/01-app/02-guides/environment-variables.md#environment-variable-load-order), `.env.local` overrides `.env` when both are present, so keep to one file to avoid values silently winning over the other. This README uses `.env` throughout because that is what the reference/demo machine runs.

`.env`:

```bash
# 'mock' (the default) needs no key, no RPC and no funds.
FILRUNWAY_MODE=live

# Calibration only. Read by src/lib/chain/synapse.ts and scripts/bootstrap.ts, nowhere else.
FILECOIN_PRIVATE_KEY=0x...

# Optional. Unset uses the SDK's built-in Calibration fallback transport set.
FILECOIN_RPC_URL=https://api.calibration.node.glif.io/rpc/v1

# Demo timescale. See "The demo timescale" below. Set BOTH to the same value.
# `npm run bootstrap -- status` suggests a round number (usually 1000) for
# your account, but for a LIVE demo the recommended value is 480 — see below.
# If only the server-side variable is set, the agent logs an error at startup
# saying the browser gauge will draw a different axis.
FILRUNWAY_DEMO_SCALE=480
NEXT_PUBLIC_FILRUNWAY_DEMO_SCALE=480

# Where the durable decision journal is written. LEAVE THIS UNSET: unset, the
# path is derived per mode -- data/decisions.jsonl in live, data/decisions.mock.jsonl
# in mock -- so a demo run can never append simulated spend into the file that
# proves the agent's real transaction. Setting it points BOTH modes at that one
# file, which is still safe (reads are mode-scoped) but re-mixes the two streams.
# `off` disables persistence entirely and keeps decisions in memory only.
# FILRUNWAY_DECISION_LOG=
```

`.env.example` carries the same guidance: both scale variables (defaulted to `1`, off), and `FILRUNWAY_DECISION_LOG` left commented out, with the per-mode default paths and the reason to leave it that way spelled out in the comment above it.

### 4. Smoke-test the chain before touching the UI

```bash
npm run bootstrap -- status
```

Read-only, and it proves in one shot that the key parses, the RPC answers, the wallet holds gas and USDFC, Warm Storage is approved as a payments operator, and `accountSummary()` reads. It prints the raw `runwayInEpochs` value next to the derived days, the contract addresses resolved from the chain definition, and a suggested `FILRUNWAY_DEMO_SCALE`.

If approval is missing:

```bash
npm run bootstrap -- approve
```

### 5. Create a real cost stream

With nothing stored, `lockupRatePerEpoch` is `0`, `runwayInEpochs` is `maxUint256`, and the gauge correctly reads infinity forever. There is no budget to manage until the agent is paying for something.

```bash
npm run bootstrap -- fund 5            # deposit USDFC into Filecoin Pay
npm run bootstrap -- upload --demo     # 1 MiB of real data through PDP / Warm Storage
npm run bootstrap -- datasets          # confirm the data set exists onchain
```

`upload --demo` calls `storage.prepare()` (which covers the new cost stream, auto-depositing if the account lacks headroom) and then `storage.upload()`, which stores two copies. It prints the burn rate before and after, so you can watch a real cost stream come into existence.

### 6. Set the demo timescale, then run

Re-run `bootstrap -- status`. It now prints a real runway and, if that runway is off the top of the gauge, a suggested scale — rounded up to a tidy power of ten (usually `1000`) purely for readability. For a **live demo**, use **`480`** instead (see "The demo timescale" below for why); `FILRUNWAY_DEMO_SCALE` accepts any number, round or not. Put whichever value you choose in **both** `FILRUNWAY_DEMO_SCALE` and `NEXT_PUBLIC_FILRUNWAY_DEMO_SCALE`, then:

```bash
npm run dev          # http://localhost:3000
```

The agent starts on the first request to any API route and ticks every 15 seconds from then on. `RUN TICK NOW` in the status strip forces a cycle early; it is a convenience, not the mechanism.

### Full CLI surface

```
npm run bootstrap -- status                        read-only smoke test
npm run bootstrap -- approve                       approve Warm Storage as operator
npm run bootstrap -- fund <amountUsdfc>            deposit USDFC into Filecoin Pay
npm run bootstrap -- upload <path>                 upload a file, creating a real cost stream
npm run bootstrap -- upload --demo [--size=1MiB]   upload generated filler instead
npm run bootstrap -- datasets                      list data sets and total stored bytes
```

`npx tsx scripts/bootstrap.ts <command>` is equivalent if you would rather skip the npm indirection.

### Reading the decision log

```
npm run decisions                                  summary + recent decisions + tx list
npm run decisions -- --mode live|mock|all          scope the listing (default: FILRUNWAY_MODE)
npm run decisions -- --limit 100                   show more than the default 20
npm run decisions -- --executed                    only decisions that moved money
npm run decisions -- --id <decisionId>             one decision in full (searches every mode)
npm run decisions -- --json                        raw {mode, decision} records, for jq
npm run decisions -- --split                       copy MOCK records out of the LIVE journal (dry run)
npm run decisions -- --split --write               actually apply that copy
```

No key, no RPC, no server. Every row carries its mode, and the `transactions the agent authored` section is LIVE-only at every scope. See "Proving the agent authored the transaction" above.

### Other scripts

```bash
npm run test         # 239 unit tests, 10 files
npm run typecheck
npm run lint
```

Per file: `journal` 44, `units` 27, `demo` 27, `policy` 25, `chain/synapse` 25 (pure helpers), `agent` 23, `journalReport` 21, `format` 20, `decisions` 18, `stream/route` 9.

---

## The demo timescale

This needs stating plainly, because it is the one place where the demo departs from a production deployment.

**The problem.** Calibration Warm Storage costs $2.50/TiB/month/copy plus $0.024/data-set/month, and uploads default to two copies — each copy opens its own data set, so a single demo upload opens two data sets, not one, and the per-data-set fee is charged twice. Measured live, the largest cost stream a demo can honestly create is roughly **0.240005 USDFC/month (~$0.24), or ~0.008 USDFC/day**; a fixed per-data-set lockup of 0.928 USDFC (covering both data sets) dwarfs the 0.240008 USDFC rate-based lockup at this scale. Each 5 USDFC deposited into that account therefore buys about **625 days** of runway (5 / 0.240005 × 30 ≈ 625) — which is why the reference account, after its bootstrap funding, currently reads around 2,969.9 days. A gauge scaled to 14 days pegs at full and never moves, and no policy threshold expressed in days ever fires. Producing a visible burn from the rate-based fee alone would take roughly 7 TiB of live storage (~1.2 USDFC/day).

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

### Which numbers on screen are raw, and which are interpolated

The demo timescale never touches a reading. **Client-side animation does**, in exactly one place, and that place is the most eye-catching thing on the page. Stating it precisely:

| On screen | What it is |
|---|---|
| BURN RATE, FILECOIN PAY, WALLET stat tiles | **Raw.** Straight from the latest `RunwaySnapshot`. |
| AUTONOMOUS DEPOSITS tile | **Raw**, and server-computed over the whole journal, not this tab's session. **Scoped to the running mode**: in MOCK it is relabelled `SIMULATED DEPOSITS` in hazard yellow. |
| Every figure on a decision card, and its `reasoning` text | **Raw.** `evaluate()` is handed the snapshot as read; the reasoning quotes those numbers verbatim. |
| STORED DATA panel (data set ids, provider, size, CDN, piece CIDs) | **Raw**, read from the chain via `ChainAdapter.listStorage()`. |
| Epoch in the status strip | **Raw.** |
| **The big numeral in the middle of the gauge** | **Client-side interpolation**, to 2dp. |
| **The `N epochs` line under it** | **Derived from that same interpolated value** (`displayDays × 2880`), not from `epochsRemaining`. |
| **The gauge's band colour, needle and arc fill** | **Derived from that same interpolated value.** |

The mechanism, in `src/components/Dashboard.tsx`: the server publishes a fresh snapshot every 2 seconds, but the UI redraws 10 times a second. Between readings the gauge shows `displayDays = anchor.days − rate × elapsed`, where `anchor` is the last real reading, `rate` is an exponential moving average of the deltas actually measured between the last few readings, and `elapsed` is capped at `MAX_EXTRAPOLATION_MS` (8 seconds). `RunwayGauge` prints that number to two decimal places. The rate is *measured*, never assumed, so the interpolation cannot invent a trend the chain is not showing — and every server reading snaps the anchor back to truth, so the error is bounded by at most 2 seconds of drift.

The honest consequence, stated rather than buried: **the true onchain `epochsRemaining` is not displayed anywhere in the UI.** The gauge's epoch line is a smoothed re-derivation of it. If you want the raw value, it is in three places that do not interpolate at all: `npm run bootstrap -- status` (`runwayInEpochs (raw)`), any decision card's reasoning, and `npm run decisions -- --id <id>`.

**What scaling does and does not prove.** It multiplies policy thresholds. It does **not** multiply the burn rate, so the runway still falls at about one day per real day. The demo therefore *cannot* show the runway falling through a threshold — that would take months. What it shows is the agent crossing a threshold it was **already** past, acting on it, and then correctly holding *because of what it just did*. That self-caused TOP_UP → HOLD transition is the honest beat, and it is a real one: nothing about it is staged, and the second decision is caused by the first. But it is not a countdown, and this README does not claim one. The only place a needle visibly falls is mock mode, which is labelled as simulated wherever it appears.

**Picking a scale.** `npm run bootstrap -- status` suggests a scale by rounding up to a tidy power of ten (`suggestDemoScale()`, `src/lib/demo.ts:187`) — easy to read on an axis, but not the only valid choice; `FILRUNWAY_DEMO_SCALE` accepts any number, round or not. For a **live demo**, prefer the scale that resolves in exactly one top-up. On the reference account the real runway is about **2,969.9 days**, and a 5 USDFC deposit buys roughly **625 more**:

| Scale | Top-up threshold (7 × N) | What a judge sees |
|---|---|---|
| 380 | 2,660 days | Runway 2,969.9 is already **above** it. The agent HOLDs forever and no decision ever lands. |
| **480** | **3,360 days** | Runway 2,969.9 is below it, so one TOP_UP fires; +625 days clears the threshold, so the next tick flips to HOLD. **Exactly one decision, then its consequence.** |
| 1000 (tool-suggested) | 7,000 days | Roughly eight consecutive deposits to cross. Reads as a stuck loop, not a decision. |

**480** is the recommended live-demo value for that reason, and it is what the demo machine is already configured to: `.env` on the machine that produced the transaction above holds `FILRUNWAY_DEMO_SCALE=480` and `NEXT_PUBLIC_FILRUNWAY_DEMO_SCALE=480`. Nothing needs changing there before a take.

The `×380 DEMO` labels visible on older *mock* decision cards are not a contradiction and are not the current configuration: a restored card carries the rule label captured when that decision was taken, so it reports the scale in force at the time, which for that mock session was 380. See limitation 9.

If your account's runway differs from the reference account's, pick N so that `7 × N` sits between your current runway and `runway + 625` — that is the whole rule, and it is arithmetic on your own `bootstrap -- status` output, not trial and error against the answer you want.

When scaling is active the UI and the audit trail say so in three independent places, so no single cropped screenshot can hide it:

1. The gauge header carries a `DEMO TIMESCALE ×480 · READINGS REAL` badge (`src/components/RunwayGauge.tsx`).
2. Every rule label — including HOLD's, which carries no suffix of its own — is suffixed `×480 DEMO` and shows the *effective* (scaled) day figure next to its comparison operator, not the base one. At `×480` a card reads `SCHEDULED TOP-UP < 3,360d ×480 DEMO` or `HOLD >= 3,360d ×480 DEMO`, never the unscaled `< 7d` / `>= 7d`. This is `ruleLabel()` (`src/lib/format.ts`): a normal rule's threshold was already multiplied by `scaleRules()` upstream, while HOLD — the policy's catch-all rule, whose threshold is a `Number.MAX_SAFE_INTEGER` sentinel that must never be multiplied — has its figure substituted with `DEMO_BAND_WARNING_DAYS`, the same scaled top-up threshold, and gets the `×N DEMO` suffix appended explicitly, so all three decision cards read alike.
3. Every decision's `reasoning` now ends with its own disclosure sentence, e.g. `Threshold shown is the 7-day rule at the ×480 demo timescale.` (`demoScaleNote()`, `src/lib/demo.ts:149`). This matters because a decision card is routinely screenshotted with the gauge header out of frame; without it, "below the 3360-day top-up threshold" would carry no hint that 3,360 is 7 × 480. At scale 1 the sentence is the empty string and nothing is added anywhere.

The agent also logs a warning line into the trace on startup whenever a timescale is in force. Unlike the journal disclosures above, that banner deliberately stays an ordinary trace line rather than a durable `AgentNotice` — `src/lib/agent.ts:355-364` calls `log()`, not `notice()`, because the three places just listed already state the scale permanently and a late-arriving viewer cannot miss it. Durability is spent only where the fact would otherwise be unobtainable.

One thing the disclosures do **not** promise: that every card in the feed quotes the same scale. A card restored from the journal shows the threshold and suffix recorded with it, so a feed containing history from an earlier run at a different scale will show both. Each card is individually correct about the decision it describes. See limitation 9.

One configuration trap, and the agent now catches it for you: the gauge is a client component, and Next.js only inlines `NEXT_PUBLIC_*` into the browser bundle. Setting only the server-side `FILRUNWAY_DEMO_SCALE` makes the agent act on scaled thresholds while the gauge still draws a 14-day axis. `ensureAgentLoop()` compares the two raw values (`demoScaleAgreement()`, `src/lib/demo.ts:224`) and logs an **error** into the trace saying exactly which scale each half resolved. Set both.

---

## What is real and what is not

### Live mode (`FILRUNWAY_MODE=live`)

| Component | Status |
|-----------|--------|
| Agent address | Real. Derived locally from `FILECOIN_PRIVATE_KEY` via viem, with no RPC, so the status strip survives a node outage. |
| `runwayInEpochs`, `availableFunds`, `debt`, `lockupRatePerEpoch`, `totalLockup`, `epoch` | Real. `synapse.payments.accountSummary()` against Filecoin Pay on Calibration. |
| Wallet tFIL and USDFC balances | Real. `synapse.payments.walletBalance({ token })`, both tokens named explicitly. |
| Top-up transaction | Real. `synapse.payments.fund({ amount })`, submitted by the agent. The hash resolves on Filfox. |
| Transaction confirmation | Real. `client.waitForTransactionReceipt`; the tx event walks SUBMITTED to CONFIRMED or FAILED. |
| Stored data | Real. `storage.prepare()` then `storage.upload()`, two copies through Warm Storage and PDP. |
| The cost stream being managed | Real. It exists because real data sits under a real data set. |
| Contract addresses | Read from the chain definition at runtime (`synapse.chain.contracts`), never hardcoded. |
| Policy thresholds and gauge graduations | **Scaled** by `FILRUNWAY_DEMO_SCALE`. See above. |
| STORED DATA panel | Real. `ChainAdapter.listStorage()` reads the account's Warm Storage data sets, providers, sizes and active piece CIDs from the chain. Served by `/api/storage`; a failed read is a 503 the panel prints, never a placeholder row. |
| Gauge numeral, its epoch subtitle, and its band colour | **Not raw.** Interpolated client-side from a *measured* rate, anchored on the last real reading and capped at 8s of extrapolation. Every server reading snaps it back to truth. See "Which numbers on screen are raw, and which are interpolated" above. |
| Decision history | Real and **durable**. Appended to an append-only JSONL journal (`data/decisions.jsonl` in live mode, `data/decisions.mock.jsonl` in mock), stamped MOCK / LIVE per line, and rehydrated into the store on start **scoped to the running mode**, so simulated spend can never be totalled as real. Read it with `npm run decisions`. |

**The headline proof — cite this one.** The transaction the decision journal actually backs is [`0x06e27a6a…`](https://calibration.filfox.info/en/message/0x06e27a6a7fd532722727953b8d266f14d8109aaaa2c9edc8645bf17a1a2fcf6b) (status success, block 4,034,196, to the Filecoin Pay contract, 5 USDFC), paired with decision `1b2d98ef-4984-482f-b394-498ea99b29a6`. Run `npm run decisions -- --id 1b2d98ef-4984-482f-b394-498ea99b29a6` and it prints the reading, the rule that fired, the reasoning, and this exact hash — the one place in this README where the proof command and the hash it names actually match, because it is the one hash the journal contains.

There is also an earlier autonomous top-up, [`0x17f5ecd7…`](https://calibration.filfox.info/en/message/0x17f5ecd765fdef0078241ec1e5b76d4017c96305f7ee80b347bbd29f50d03ac3) (status success, block 4,033,951, 5 USDFC, to the Filecoin Pay contract). It is real — made during live verification — but it predates the decision journal: it is not a line in `data/decisions.jsonl`, no `npm run decisions -- --id` command can produce it, and it must not be cited as agent-authored on the strength of this project's own evidence mechanism. Corroborating history, not proof.

And the transaction that funded the account in the first place, [`0x45ee3b49…`](https://calibration.filfox.info/en/message/0x45ee3b49ef5f247860181588b6a6f338fc09befcb3fe57af02de9b4a6608b005) — 20 USDFC, **operator-run** via `npm run bootstrap -- fund`, which also established the Warm Storage operator approval. Not agent-authored, and never presented as such.

Journals grow with every tick and a demo machine's file will not match this one line for line — always read the hash-and-decision pair off the machine you are demoing from rather than trusting a hash quoted in a document.

**The honest split, before you go looking for it.** Of the USDFC that has been deposited into this account's Filecoin Pay balance, **5 USDFC per top-up is agent-initiated and 20 USDFC was operator bootstrap** (`npm run bootstrap -- fund`, `0x45ee3b49…` above). The agent made one journal-provable autonomous deposit, not the whole balance. That is the claim, and it is the whole claim: the operator set the account up so there would be a cost stream to manage at all, and the agent then decided, on its own, to add to it.

The reason to say this first rather than let a judge find it: an autonomous top-up and an operator top-up are byte-identical on chain, so "the agent deposited this" is unverifiable from Filfox alone in either direction. What makes the one deposit *provably* the agent's is the decision recorded before it existed — `npm run decisions -- --id <id>` prints the reading, the rule, the reasoning and the hash together, and the hash lines up with Filfox. Everything else in the account is the operator's, and is labelled as such here.

### Mock mode (`FILRUNWAY_MODE=mock`, the default)

Entirely simulated. No key, no RPC, no funds. Chain time is accelerated to 120 epochs per real second (one real second is about one hour of chain time; override with `FILRUNWAY_MOCK_EPOCHS_PER_SECOND`), so a 9.6-day runway drains in roughly four minutes and the agent visibly crosses HOLD, then TOP_UP, then EMERGENCY_TOP_UP inside one sitting. Transaction hashes and piece CIDs are random and resolve to nothing. The STORED DATA panel shows two fixed simulated data sets holding the same piece, which is the shape a real 2-copy upload produces.

**Run mock mode at `FILRUNWAY_DEMO_SCALE=1`.** Mock is the one mode where the runway genuinely drains, so it needs no timescale — and since a demo scale multiplies the thresholds, leaving it at 480 would put the mock's 9.6-day opening runway thousands of days below the emergency threshold and fire an emergency top-up on the first tick instead of showing the bands being crossed.

Mock mode cannot be mistaken for live, and that is now true of the **first painted frame** as well as every frame after it. The mode badge has three states, not two: `MOCK DATA` (filled hazard-yellow, with the strip's yellow hazard stripe), `LIVE · CALIBRATION` (outlined green), and a neutral grey `CONNECTING` for the state where the mode is genuinely not known yet. It used to default to MOCK while unknown, which meant a LIVE demo's opening frame — the frame a screen recording starts on — was badged MOCK. `src/app/page.tsx` now resolves the mode server-side with `getChainMode()` behind `connection()`, so the page is rendered per request and the badge is correct before any fetch happens. `connection()` rather than a prerender, so that a build in mock followed by a `next start` in live cannot ship a LIVE dashboard badged MOCK.

A live-mode misconfiguration fails loudly at construction rather than falling back to the mock, because a demo showing simulated numbers under a LIVE badge is worse than an error page (`src/lib/chain/index.ts:99`).

Decisions taken in mock mode are journalled too, to their **own file** — `data/decisions.mock.jsonl`, not the LIVE `data/decisions.jsonl` — and every line is stamped `"mode":"MOCK"`. So a mock record cannot reach the evidentiary file in the first place, and if it is already there (from a journal written before the split, or from an explicit `FILRUNWAY_DECISION_LOG` pointing both modes at one path) the scoped read keeps it out of the LIVE dashboard and the LIVE listing anyway. A mock record read back months later can never be mistaken for evidence of an onchain action.

---

## Known limitations

Ordered roughly by how much they would matter in production.

1. **Top-up only.** The brief allows three responses: top up, cut what you cannot afford, or decide what is worth paying to keep. This implements the first. There is no eviction, data-set termination or value-ranking path. `PolicyAction` is `TOP_UP | EMERGENCY_TOP_UP | HOLD` and nothing else.
2. **No partial top-up.** If the wallet holds less USDFC than a fired rule wants to deposit, the agent recognises this before acting: `evaluate()` returns `INSUFFICIENT_FUNDS` (outcome `NO_ACTION`), and `runTick()` returns before calling `deposit()`, so nothing is submitted and nothing can fail on-chain. It still does not deposit whatever partial balance is available, or down-shift to a smaller amount — an operator has to fund the wallet before the next tick can act. That down-shift is a reasonable future improvement.
3. **Single-writer journal.** Decisions themselves are durable: `src/lib/journal.ts` appends every decision, and every later status transition of it, to a JSON Lines file that `src/lib/store.ts` rehydrates on start. What is *not* solved is concurrency and scale — the file is appended with `appendFileSync` from one single-threaded process, so two servers sharing one path would interleave and each would need its own `FILRUNWAY_DECISION_LOG`. (Two servers in *different* modes already get different files by default, so this is only a hazard for two servers in the same mode.) The in-memory ring in front of it is still capped (200 decisions, 400 events), which bounds what the UI holds and nothing else; anything that ages out of the ring is folded into the server-side `totals` rather than lost. `store.backlog()` (`src/lib/store.ts:319`) is documented in code as a rolling tail that nothing durable may depend on, and the startup disclosures are exempt from aging out precisely because they travel as `notices` state rather than as backlog content. A journal that cannot be written disables itself with a warning and the agent carries on in memory, so a disk problem degrades the record rather than stopping the agent. It is an append-only evidence file, not a database.
4. **The agent runs inside the web process.** `ensureAgentLoop()` starts `setInterval` timers from a route handler. Fine for a local demo, wrong for a serverless deployment where those timers would not survive.
5. **Hot key in a file.** `FILECOIN_PRIVATE_KEY` sits in `.env` (or `.env.local` — see setup above, either is loaded). It is confined to two modules and scrubbed out of every error message that escapes them, but it is still a hot key. Testnet only.
6. **No backoff.** A failed deposit is recorded and retried on the next 15-second tick with the same amount. No exponential backoff, no circuit breaker, no retry cap.
7. **`getStoredItems()` in live mode lists only this process's own uploads**, not an onchain enumeration — it is empty on a freshly started server. The onchain answer is `ChainAdapter.listStorage()`, which is what `/api/storage` and the dashboard's STORED DATA panel use; `bootstrap -- datasets` prints the same thing from the CLI.
8. **The live gauge barely moves, and the demo timescale does not change that.** At roughly $0.008/day of real burn (0.240005 USDFC/month, measured live), a runway of thousands of days does not visibly count down over a two-minute video. `FILRUNWAY_DEMO_SCALE` scales thresholds, not the burn rate, so runway still falls at about a day per real day and no threshold is ever *fallen through* on camera. The visible drain is a mock-mode phenomenon. In live mode the decision moment comes from where the runway *is* relative to the scaled threshold, and from the flip back to HOLD that the deposit itself causes, not from watching a needle fall.
9. **A restored decision card carries the rule label captured when the decision was taken.** This is within-mode staleness, not mode mixing, and it is pre-existing. `ruleLabel()` rewrites the day figure of the *catch-all* HOLD rule from the scale currently in force, but a rule that actually fired (`topup-7d`, `emergency-2d`) was scaled by `scaleRules()` at decision time and carries both its scaled `thresholdDays` and its `×N DEMO` suffix inside the stored `ruleFired.label`. So a mock session recorded at `×380` still displays `×380 DEMO` on its restored cards even when the current session runs at `×480`. That is correct as history — the card says what the agent actually compared against — but it does mean two cards in one feed can quote two different scales. The gauge badge, and every decision's own `reasoning` disclosure sentence, always state the scale that decision was taken at.
10. **Not verified against a long-running live deployment.** 239 unit tests cover the pure logic (policy, demo scaling, units, formatting, decision merging), the journal and its mode scoping, the reader-side mode policy in `src/lib/journalReport.ts`, the live adapter's helpers against the SDK's return shapes, and — since `src/lib/agent.test.ts` — the orchestration in `runTick()` against a scripted adapter. `src/app/api/stream/route.test.ts` goes one step further and drives the real route handler with a real `Request`, so the backlog window, the frame encoding and the connect order are tested rather than assumed — still unit-level, integration-lite, and no substitute for a live deployment. What they do not cover is sustained multi-hour live behaviour, RPC flakiness under load, and provider-side upload failures, none of which have been exercised at length.

---

## Tech stack

| Layer | Choice |
|-------|--------|
| Framework | Next.js 16.3.4, App Router, React 19.2 |
| Language | TypeScript 5, strict |
| Styling | Tailwind CSS v4 |
| Filecoin | `@filoz/synapse-sdk` 1.2.1 — **viem-based, not ethers** — plus `@filoz/synapse-core` 0.8 for the PDPVerifier reads (`getDataSetSizes`, `getActivePiecesByCursor`) the SDK does not re-export |
| Chain client | viem 2.56 |
| Transport | Server-Sent Events (`/api/stream`), carrying `snapshot`, `decision`, `tx`, `log`, `totals` and `notices` events. No websocket, no client polling loop, except the STORED DATA panel which polls `/api/storage` every 30s. |
| Persistence | Append-only JSON Lines on disk (`src/lib/journal.ts`), one file per adapter mode. No database. |
| Tests | Vitest 4, 239 tests across 10 files |
| Network | Filecoin Calibration, chain ID 314159, 30s epochs, 2880 epochs/day |
| Explorer | Filfox, `https://calibration.filfox.info/en/message/<hash>` |

Both `@filoz/synapse-sdk` and `@filoz/synapse-core` are listed in `serverExternalPackages` in `next.config.ts`: they are ESM-only and reach for Node built-ins, and they are only ever reachable through the server-only chain adapter.

A note on the SDK version, because most code samples online are stale: 1.2.1 removed the pre-1.0 surface. `Synapse.create({ account, source })` is synchronous and takes a viem account. `Synapse.create({ privateKey, rpcURL })`, `preflightUpload`, `getServicePrice`, `operatorApproval`, `RPC_URLS` and `terminateDataSet` no longer exist.

---

## Repository map

| Path | What it is |
|------|-----------|
| `src/lib/types.ts` | The domain contract. The only thing shared across the chain boundary. |
| `src/lib/policy.ts` | `evaluate()`. Pure. The product. |
| `src/lib/policy.test.ts` | 25 tests pinning the decision logic, including the wallet-shortfall (`INSUFFICIENT_FUNDS`) branch. |
| `src/lib/agent.ts` | `runTick()`: sense, decide, act. Plus tick coalescing and the storage listing cache. |
| `src/lib/agent.test.ts` | 23 tests driving `runTick()` against a scripted adapter — failed reads, reverting deposits, unconfirmed transactions, concurrent ticks. |
| `src/lib/journal.ts` | The durable append-only decision journal. The evidence file. Per-mode paths, mode-scoped reads. |
| `src/lib/journalReport.ts` | Reader-side mode policy: `--mode` parsing, what counts as evidence, what a scope is hiding. Pure, 21 tests. |
| `src/lib/chain/index.ts` | `ChainAdapter` interface (including `listStorage()`) and adapter selection. |
| `src/lib/chain/synapse.ts` | Live Calibration adapter. One of two files that see the key. |
| `src/lib/chain/mock.ts` | Accelerated simulation for keyless demos. |
| `src/lib/demo.ts` | `FILRUNWAY_DEMO_SCALE`, and a long comment justifying it. |
| `src/lib/store.ts` | In-memory ring + SSE pub/sub, in front of the journal. |
| `src/lib/units.ts` | Decimal-string money maths. No floats anywhere. |
| `src/app/page.tsx` | Server-rendered per request via `connection()`, so the mode badge is right on first paint. |
| `src/app/api/*` | `snapshot`, `decisions`, `tick`, `stream`, `storage`. |
| `src/app/api/stream/route.test.ts` | 9 tests driving the real route handler with a real `Request`, so the backlog window, the frame encoding and the connect order are under test rather than assumed. |
| `src/components/*` | `RunwayGauge`, `StatTile`, `DecisionFeed`, `StoragePanel`, `StatusStrip`, `Dashboard`. |
| `scripts/bootstrap.ts` | Operator CLI. The other file that sees the key. |
| `scripts/decisions.ts` | Decision-log reader, plus `--split`. Needs no key, no RPC, no server. |
| `docs/DEMO_SCRIPT.md` | Shot-by-shot video script. |
| `docs/SHOWCASE.md` | Submission blurb and X thread. |
