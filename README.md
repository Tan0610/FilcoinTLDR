# FilRunway

**An agent that reads its own onchain runway on Filecoin Pay, decides whether it can afford to keep its data alive, and tops itself up — or cuts what is not earning its cost — before it runs dry.**

### ▶ Live: **https://filrunway.vercel.app**

Built for **FilecoinTLDR Builder Challenge Cycle 4 — "Build an AI Agent That Manages Its Own Storage Budget."** Direction: **Stay Alive + Show the Meter.**
Network: **Filecoin Calibration testnet**, chain ID `314159`. Nothing here touches mainnet.

Deep reference: **[`docs/DEEP_DIVE.md`](docs/DEEP_DIVE.md)** · Video script: [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) · Showcase copy: [`docs/SHOWCASE.md`](docs/SHOWCASE.md)

---

## What it does, and why that is the hard part

An agent that stores data on Filecoin is easy. An agent that knows whether it can *afford* the data it is storing is not.

Storage through Warm Storage is a continuous cost stream: a lockup rate per epoch, drawn against a balance held in Filecoin Pay. When that balance runs out the account goes into debt and the data stops being paid for. **Agents can store. They cannot decide whether it is worth it.**

FilRunway closes that loop. Every 15 seconds locally — every 5 minutes on the deployment, where an external scheduler drives the cycle because a serverless Function has no process to hold a timer — it reads its own Filecoin Pay account, reads the PDP proof state of every data set it is paying for, evaluates a policy against both, and with no human in the path either submits a real USDFC deposit, decides a data set is not worth keeping, or records why it is doing neither.

Every decision, **including the decisions to do nothing**, is written to a durable append-only audit log alongside the numbers it was based on. That is what makes "the agent authored this transaction" checkable rather than merely asserted.

The interesting part is not the transaction. It is the moment the agent looks at `runwayInEpochs` and concludes it should act.

---

## Where the decision happens

If you have one minute, read these five places in this order.

| # | What | File | Symbol / line |
|---|------|------|---------------|
| 1 | The runway is **read from the chain**, not derived | `src/lib/chain/synapse.ts` | `getSnapshot()` line 423 calls `synapse.payments.accountSummary()` — line 427 |
| 2 | `runwayInEpochs` becomes the snapshot | `src/lib/chain/synapse.ts` | `toRunwaySnapshot()` line 131, `runwayEpochsToNumber()` line 102 |
| 3 | **The decision itself.** Pure function, zero I/O | `src/lib/policy.ts` | `evaluate()` line 211; rule selection line 223; `selectRule()` line 140 |
| 4 | The agent acts on it, unprompted — or declines, in one of three ways | `src/lib/agent.ts` | `executeTick()` line 382: `evaluate(...)` line 424, `applySpendCap(...)` line 430 (defined line 92), `applyEvictionGate(...)` line 431 (defined line 126), `SAFETY_CAP` return line 442, `INSUFFICIENT_FUNDS` return line 449, `PRUNE_DATASET` branch line 461, `adapter.deposit(...)` line 474 |
| 5 | The deposit is a real onchain transaction | `src/lib/chain/synapse.ts` | `deposit()` line 451 calls `synapse.payments.fund({ amount })` — line 458 |

The single load-bearing line is **`src/lib/policy.ts:223`**:

```ts
const rule = selectRule(days, rules);
```

`days` came from `accountSummary().runwayInEpochs`. `rules` is the agent's policy. The transaction, the dashboard and the audit log are all downstream consequences of that one comparison.

`runwayInEpochs` is a **first-class onchain field**, not a number this project computes. `synapse.payments.accountSummary()` returns it alongside `availableFunds`, `funds`, `debt`, `lockupRatePerEpoch`, `totalLockup` and `grossCoverageInEpochs`. FilRunway does not divide a balance by a burn rate and call the result runway — it asks the contract. Two contract edge cases are handled explicitly at `src/lib/chain/synapse.ts:102`: `maxUint256` when the burn rate is zero (nothing stored, runway unbounded — the gauge renders infinity), and `0` when `debt > 0` (already underwater). Both map onto a large **finite** sentinel (`src/lib/constants.ts:49`) rather than `Infinity`, because `JSON.stringify(Infinity)` is `null`, and a null arriving over SSE would render as a critical zero — the exact opposite of the truth.

---

## Proof the agent acted

An autonomous `TOP_UP` and an operator typing `npm run bootstrap -- fund 5` produce **byte-identical** transactions on Filecoin Pay. Nothing on chain records which one moved the money. A Filfox hash is evidence that *something* deposited USDFC, and evidence of nothing else.

What separates them is the `Decision` recorded *before* the transaction existed. Every decision is appended to a durable, append-only JSON Lines journal, and one command produces the decision behind a hash:

```bash
npm run decisions -- --id 1b2d98ef-4984-482f-b394-498ea99b29a6
```

| | |
|---|---|
| **Transaction** | [`0x06e27a6a…`](https://calibration.filfox.info/en/message/0x06e27a6a7fd532722727953b8d266f14d8109aaaa2c9edc8645bf17a1a2fcf6b) — success, block 4,034,196, 5 USDFC to the Filecoin Pay contract |
| **Authored by decision** | `1b2d98ef-4984-482f-b394-498ea99b29a6` |
| **The command above prints** | the exact Filecoin Pay reading the agent was looking at, the rule that fired with its threshold, the reasoning string it generated from those numbers, the outcome, and this hash |

Hash matches, reading matches, and the record was written before the transaction existed. `scripts/decisions.ts` needs **no private key and no running server**; the default form needs no network either.

```bash
npm run decisions                  # summary + recent decisions + every tx the agent authored
npm run decisions -- --executed    # only decisions that moved money
npm run decisions -- --remote      # the DEPLOYED agent's journal, out of Vercel Blob
npm run decisions -- --mode mock   # simulated records, kept in a separate file and never totalled as real
```

Records are stamped `MOCK` or `LIVE` per line, writes go to separate files per mode, reads are scoped to the running mode, and the `transactions the agent authored (LIVE, onchain)` section hard-filters to LIVE-with-a-hash inside the function that builds it — so no argument, default or later refactor can put a simulated hash in it. What a scope hides is counted and disclosed, never silently dropped. Full mechanism: [**deep dive §1–2**](docs/DEEP_DIVE.md#1-proving-the-agent-authored-a-transaction).

> **`data/` is gitignored**, so a fresh clone starts with an empty *local* log — a journal that ships in git is a journal anyone can forge. The deployed agent writes to Vercel Blob instead, and `npm run decisions -- --remote` reads exactly those records from any machine holding the store's token.

---

## What a judge can do right now

1. **Open [filrunway.vercel.app](https://filrunway.vercel.app).** The gauge, the stat tiles and the decision feed are live against Calibration. The `LIVE · CALIBRATION` badge is correct on the first painted frame, because the mode is resolved server-side.
2. **Watch it decide with nobody touching it.** The cycle is driven by [`.github/workflows/agent-tick.yml`](.github/workflows/agent-tick.yml), every 5 minutes, calling `POST /api/tick` with the deployment's shared secret. Leave the page open, hands off; decisions appear on their own. Nothing you do in the browser can cause a tick unless you hold the secret — which is a *stronger* demonstration than the local one, where opening the dashboard is what starts the loop.
3. **Force a decision.** The real account has ~2,970 days of runway burning about a day per day, so no threshold fires on its own inside a demo. `SQUEEZE RUNWAY` in the OPERATOR group withdraws USDFC from Filecoin Pay back to the agent's own wallet — a **real** withdrawal, so `runwayInEpochs` genuinely collapses and the agent's next tick has a true crisis to answer. It creates no `Decision`, adds nothing to the deposits tile, and pins a disclosure saying a human caused it. The autonomy on show is the response, not the squeeze. Both operator controls are inert until someone pastes `CRON_SECRET` into the page; that secret is never in the client bundle, never in the HTML and never stored.
4. **Read the decision log.** `npm run decisions -- --remote` after `vercel env pull .env.local`. Same parser, same scoping, same `--id` view as the local reader.
5. **Read `src/lib/policy.ts`.** It is 368 lines, pure, and 43 tests across `policy.test.ts` and `policyProof.test.ts` pin its behaviour.

---

## The decision space

A rule may only ask for `TOP_UP`, `EMERGENCY_TOP_UP` or `HOLD` — `PolicyAction` has no fourth option (`src/lib/types.ts:117`). The agent reaches three further conclusions of its own, and **each of them is a decision, recorded with full reasoning, not a failure** (`DecisionAction`, `src/lib/types.ts:135`).

| Action | Meaning | Transacts? |
|---|---|---|
| `HOLD` | Runway is at or above the top-up threshold. Recorded with its reasoning, because an agent that only logs when it acts is not showing you its judgement. | No |
| `TOP_UP` | Runway below 7 days. Deposits 5 USDFC. | **Yes** |
| `EMERGENCY_TOP_UP` | Runway below 2 days. Deposits 15 USDFC. | **Yes** |
| `INSUFFICIENT_FUNDS` | The rule fired and the wallet cannot cover it. The engine states the shortfall and the fix instead of submitting a transaction guaranteed to revert (`src/lib/policy.ts:337`). | No |
| `SAFETY_CAP` | The wallet *could* cover it, but the agent has already made 3 deposits or spent 20 USDFC inside its own rolling 24h window. It declined itself (`src/lib/agent.ts:92`). Amber, not red: one needs an operator, the other needs nobody. | No |
| `PRUNE_DATASET` | A rule fired **and** a data set was read to be live, past its PDP proving deadline, and unproven. Terminating its payment rail is a better use of a short runway than buying more of it (`src/lib/policy.ts:245`). | Only if armed — see below |

**PDP proof state is a decision input, not decoration.** Before each decision the agent reads five contract fields per data set — `PDPVerifier.dataSetLive`, `getDataSetLastProvenEpoch`, `getNextChallengeEpoch`, `WarmStorageStateView.provenThisPeriod`, `provingDeadline` — and folds them into one judgement (`classifyProofState()`, `src/lib/proof.ts:93`). The invariant is absolute: **an unread field is never evidence of a missed proof.** A revert or a timeout arrives as an absence, `readable` is false unless all three decisive fields returned, and `isDelinquent` is false whenever `readable` is false. A thirty-second RPC wobble must not cause the agent to cut live, healthy, paid-for storage.

**Termination ships disarmed.** `terminateService` is irreversible — the payment rail ends and the provider stops being paid to keep the pieces — so execution requires `FILRUNWAY_ENABLE_EVICTION=on`, checked twice (once as an explicit input to the pure policy engine, once in the runner immediately before the call). **With it off, the agent still makes and records the decision**, with its target, its reading and its full reasoning; the outcome says execution is disabled and names the variable. That record is the autonomy artifact; the transaction is only its consequence.

A delinquency the agent *saw and did not act on* is always said out loud too. If a data set is overdue but the runway is healthy, the HOLD card says so — an agent that noticed dead weight and left it alone has to show that it noticed.

Reasoning is built from the numbers actually read:

```
Runway 2969.9 days (8,553,196 epochs) is below the 3360-day top-up threshold.
Burn rate 0.000002777832968892 USDFC/epoch against 23.76 USDFC available.
Depositing 5 USDFC extends runway to ~3594.4 days.
PDP: 2 of 2 data sets proving on schedule at epoch 3,073,144.
Threshold shown is the 7-day rule at the ×480 demo timescale.
```

Full rule table, every reasoning variant, and the card taxonomy: [**deep dive §5**](docs/DEEP_DIVE.md#5-the-policy-engine) and [**§6**](docs/DEEP_DIVE.md#6-pdp-proof-state-and-data-set-eviction).

---

## Architecture

```
                    Filecoin Calibration (chain 314159)
        Filecoin Pay: accountSummary() fund() withdraw()
        Warm Storage / PDP: prepare() upload() terminateService() proof reads
                                  ^
                                  | @filoz/synapse-sdk 1.2.1 (viem)
    +-----------------------------+------------------------------+
    |  src/lib/chain/       THE ONLY PLACE WITH A PRIVATE KEY    |
    |  SynapseChainAdapter (live)  |  MockChainAdapter (default) |
    |            ChainAdapter interface — chain/index.ts          |
    +-----------------------------+------------------------------+
                                  | RunwaySnapshot (plain JSON)
    +-----------------------------v------------------------------+
    |  src/lib/agent.ts    runTick():  sense -> decide -> act    |
    |    proof.ts       PDP proof state ...................PURE  |
    |    policy.ts      evaluate() -> Decision .............PURE  |
    |    spendGuard.ts  rolling 24h deposit cap ............PURE  |
    |    eviction.ts    may a PRUNE be submitted? ..........PURE  |
    |    squeeze.ts     operator withdrawal bounds .........PURE  |
    |    deployment.ts  driver: interval | cron                   |
    |    store.ts       ring buffer + SSE pub/sub                 |
    |      +-> journal.ts      append-only JSONL on disk (local)  |
    |      +-> blobJournal.ts  append-only JSONL segments (Vercel)|
    |          one stream per mode; same parser, same scoping     |
    +-----------------------------+------------------------------+
                                  |
    +-----------------------------v------------------------------+
    |  /api/snapshot  /api/decisions  /api/stream  /api/storage  |
    |  /api/tick  /api/squeeze  <- tickAuth.ts: CRON_SECRET,     |
    |     constant time. The only two routes that move funds.    |
    +--------^--------------------+------------------------------+
             |                    | EventSource (SSE)
  GitHub Actions            +-----v------------------------------+
  every 5 min, POST         |  Dashboard: RunwayGauge · StatTile |
  /api/tick with the        |  DecisionFeed · StoragePanel ·     |
  shared secret             |  StatusStrip · OperatorControls    |
  (Vercel Cron = backstop)  +------------------------------------+
```

Nothing above `src/lib/chain/` imports the Synapse SDK or can see a private key. The whole product is written against `RunwaySnapshot` and `Decision` in `src/lib/types.ts`, which is why the same dashboard and the same policy engine run unchanged against a simulated chain and a live one — and why the parts a judge is most likely to be suspicious of are the parts that are easiest to test. `evaluate()` is `(RunwaySnapshot, PolicyRule[]) -> Decision`: no clock read unless you inject one, no chain call, no side effect. **471 tests across 25 files**, no network and no key required.

One tick, in order (`src/lib/agent.ts`):

```
0. authorize          route.ts:35  under the cron driver the shared secret is checked
                                   BEFORE anything else, so an unauthenticated caller
                                   cannot even provoke an RPC read by being refused.
1. sense()                    387  accountSummary + both wallet balances.
   read failed? ------------------> FAILED Decision recorded; the agent HOLDs on stale
                                   data. An RPC outage is an audit-log entry, not a 500.
2. readProof(epoch)           420  PDP proof state. Never throws: an unreadable
                                   listing becomes a stated UNKNOWN, never a delinquency.
3. evaluate(snapshot, RULES)  424  pure. Decision + reasoning string.
4. applySpendCap()            430  rewrites to SAFETY_CAP *before* journalling, keeping
                                   the rule that fired in front of the refusal.
5. applyEvictionGate()        431  asks the environment a SECOND time before anything
                                   irreversible can be submitted.
6. journal + publish     store:401 durable FIRST, then the in-memory ring, then SSE.
7-10. SAFETY_CAP / INSUFFICIENT_FUNDS / PRUNE_DATASET / HOLD  442, 449, 461, 465
                                   each returns here. Nothing is submitted, and each is
                                   still a full decision with its reasoning on the card.
11. deposit(amount)           474  payments.fund() -> real tx hash; recordSpend() at 493
                                   counts it against the cap the moment it reaches chain.
12. waitForTransaction()      504  SUBMITTED -> CONFIRMED | FAILED, journalled again, so
                                   both lines survive. FAILED? releaseSpend() at 527.
13. sense() again             548  the gauge reflects the new balance at once.
14. flushJournal()            377  runTick() does not return until the record is durable.
```

Only one cycle runs at a time; a tick arriving mid-cycle gets `coalesced: true` rather than a silently re-served older decision. **Steps 7–10 matter as much as step 11** — an agent that only logs when it acts is not showing you its judgement.

Deploying added four modules that answer questions the local build never had to ask — `deployment.ts` (what drives the cycle: a `setInterval` here, an external scheduler there), `blobJournal.ts` (where the evidence lives, since a Function's filesystem is read-only), `tickAuth.ts` (who may make this agent spend), `spendGuard.ts` (how much it may spend unattended). Details, the full API surface and the tick sequence step by step: [**deep dive §3–4**](docs/DEEP_DIVE.md#3-architecture-in-depth).

---

## Setup

Node 20.6+, npm, a browser. **Mock mode needs no key, no RPC and no funds** — that is the two-command path:

```bash
npm install
npm run dev          # http://localhost:3000, FILRUNWAY_MODE=mock by default
```

Chain time is accelerated 120×, so the runway visibly drains and the agent crosses HOLD → TOP_UP → EMERGENCY_TOP_UP inside about four minutes. Everything is labelled `MOCK DATA` in hazard yellow, in three independent places, and mock decisions are journalled to their own file so they can never be totalled as real.

For **live mode** on Calibration:

```bash
cp .env.example .env                   # then set FILRUNWAY_MODE=live and FILECOIN_PRIVATE_KEY
npm run bootstrap -- status            # read-only smoke test: key, RPC, balances, operator approval
npm run bootstrap -- approve           # only if approval is missing
npm run bootstrap -- fund 5            # deposit USDFC into Filecoin Pay
npm run bootstrap -- upload --demo     # 1 MiB through PDP / Warm Storage — creates the cost stream
npm run bootstrap -- status            # now prints a real runway, and a suggested demo scale
npm run dev
```

Use a **fresh Calibration testnet key you do not care about**; it is a hot key in a dotfile. Fund it from both faucets — [tFIL](https://faucet.calibnet.chainsafe-fil.io) for gas, [USDFC](https://faucet.reiers.io) for storage. With nothing stored there is no budget to manage: `lockupRatePerEpoch` is `0` and the gauge correctly reads infinity forever.

Set `FILRUNWAY_DEMO_SCALE` **and** `NEXT_PUBLIC_FILRUNWAY_DEMO_SCALE` to the same value (`480` on the reference account — see below). Leave `FILRUNWAY_DECISION_LOG` unset so each mode keeps its own journal.

```bash
npm run test        # 471 tests, 25 files
npm run typecheck
npm run lint
npm run build
```

Full environment reference, the complete CLI surface, the Vercel deploy runbook and its verification sequence: [**deep dive §10–11**](docs/DEEP_DIVE.md#10-setup-reference).

---

## What is real and what is not

| Component | Status |
|---|---|
| `runwayInEpochs`, `availableFunds`, `debt`, `lockupRatePerEpoch`, `totalLockup`, `epoch` | **Real.** `synapse.payments.accountSummary()` against Filecoin Pay on Calibration. |
| Wallet tFIL and USDFC balances | **Real.** `payments.walletBalance({ token })`, both tokens named explicitly. |
| Top-up transaction and its confirmation | **Real.** `payments.fund({ amount })` submitted by the agent, then `waitForTransactionReceipt`. The hash resolves on Filfox. |
| Stored data and the cost stream being managed | **Real.** `storage.prepare()` then `storage.upload()`, two copies through Warm Storage and PDP. The cost stream exists because real data sits under a real data set. |
| PDP proof state | **Real.** Five direct contract reads per data set, issued as one `multicall({ allowFailure: true })` and decoded so a revert or timeout arrives as an absence, never as a zero. |
| Data-set termination | **Real, and gated off by default.** `WarmStorageService.terminateService`, submitted only with `FILRUNWAY_ENABLE_EVICTION=on`. With it off the decision is made, recorded and displayed; nothing is submitted. |
| The operator squeeze | **Real, and a human's action.** `payments.withdraw` behind `CRON_SECRET` and a hard ceiling. Creates no `Decision`, adds nothing to the deposits tile, pins a disclosure saying an operator caused it. |
| Contract addresses | **Real.** Read from the chain definition at runtime (`synapse.chain.contracts`), never hardcoded. |
| Decision history | **Real and durable.** Append-only JSONL, stamped MOCK/LIVE per line, rehydrated scoped to the running mode. On disk locally; in Vercel Blob on the deployment, through the same parser. |
| The spending cap | **Real,** and enforced against real money: at most 3 deposits and 20 USDFC per rolling 24h, counted from the durable journal. LIVE only. |
| `/api/tick` and `/api/squeeze` auth | **Real.** `CRON_SECRET`, constant-time comparison, **fail-closed** — a deployment that requires the check and has no secret refuses every call with 503 rather than falling open. |
| **Policy thresholds and gauge graduations** | **Scaled** by `FILRUNWAY_DEMO_SCALE`. Not a reading — see below. |
| **The big gauge numeral, its epoch subtitle, its band colour** | **Interpolated client-side**, to 2dp, from a *measured* rate anchored on the last real reading and capped at 8s of extrapolation. Every stat tile, every decision card figure, every `reasoning` string and the STORED DATA panel are raw. |
| Mock mode | **Entirely simulated.** No key, no RPC, no funds. Hashes and piece CIDs resolve to nothing. Labelled in the badge, the tile label, the accent colour and the sub-line. |

### The demo timescale, disclosed

Calibration Warm Storage is cheap enough that the largest cost stream a demo can honestly create is about **0.24 USDFC/month (~$0.008/day)**, so 5 USDFC buys roughly **625 days** of runway and the reference account reads in the thousands of days. A 14-day gauge pegs at full and no day-based threshold ever fires.

`FILRUNWAY_DEMO_SCALE` multiplies the agent's **policy thresholds** and the gauge's **graduations** by N. It does not touch a single number read from the chain. Read it as: *for this demo, treat N days of runway the way a production agent would treat one day.* The rejected alternative — dividing `daysRemaining` before display — would have put a number on screen that is not the chain's.

**What it does not do is speed up the burn.** Runway still falls at about a day per real day, so scaling alone cannot show the runway *falling through* a threshold. What it shows is the agent acting on a threshold it was already past and then holding *because of its own deposit* — a real, self-caused transition. The way to make a crossing watchable on a live account is the operator squeeze, which is a genuine withdrawal disclosed as a human action.

When a scale is in force it is disclosed in three places that cannot expire: a `DEMO TIMESCALE ×480 · READINGS REAL` badge on the gauge, the scaled figure and `×480 DEMO` suffix on every rule label, and a sentence at the end of every decision's `reasoning`. `×480` is the recommended live-demo value because it resolves in exactly one top-up on the reference account. Full arithmetic and the raw-vs-interpolated breakdown: [**deep dive §9**](docs/DEEP_DIVE.md#9-the-demo-timescale).

### The onchain evidence, and the honest funding split

The journal-backed transaction is [`0x06e27a6a…`](https://calibration.filfox.info/en/message/0x06e27a6a7fd532722727953b8d266f14d8109aaaa2c9edc8645bf17a1a2fcf6b), paired with decision `1b2d98ef-4984-482f-b394-498ea99b29a6`. Of the USDFC in this account's Filecoin Pay balance, **5 USDFC per top-up is agent-initiated and 20 USDFC was operator bootstrap** ([`0x45ee3b49…`](https://calibration.filfox.info/en/message/0x45ee3b49ef5f247860181588b6a6f338fc09befcb3fe57af02de9b4a6608b005), `npm run bootstrap -- fund`). The agent made one journal-provable autonomous deposit, not the whole balance. The operator set the account up so there would be a cost stream to manage at all; the agent then decided, on its own, to add to it.

There is an earlier autonomous top-up, [`0x17f5ecd7…`](https://calibration.filfox.info/en/message/0x17f5ecd765fdef0078241ec1e5b76d4017c96305f7ee80b347bbd29f50d03ac3), which is real but predates the journal — corroborating history, **not** proof, and it is not cited as agent-authored.

---

## Known limitations

1. **Two of the brief's three responses, and the destructive one ships disarmed.** Top-up executes. `PRUNE_DATASET` decides, records and displays, but only submits with `FILRUNWAY_ENABLE_EVICTION=on`. Value-ranking across data sets is not implemented: delinquency is the only criterion, and among delinquent sets the lowest id is chosen rather than the least valuable.
2. **No partial top-up.** A wallet short of what the rule wants produces `INSUFFICIENT_FUNDS` before anything is submitted, rather than a smaller deposit. An operator has to fund the wallet.
3. **The post-prune re-sizing is a bound, not a measurement.** Filecoin Pay reports one aggregate lockup rate with no per-rail split, so the agent divides pro-rata by rail count, says so in those words, and re-decides against the true figure next reading.
4. **It is an append-only evidence log, not a database.** A read lists the whole prefix and concatenates it. The in-memory ring in front of it is capped at 200 decisions; anything ageing out is folded into server-side `totals` rather than lost. A journal that cannot be written disables itself with a pinned warning and the agent carries on in memory — a storage problem degrades the record rather than stopping the agent.
5. **The spending cap is eventually consistent across Function instances**, not transactionally exact: each instance re-reads the shared journal on a 3-second TTL. Not reachable at one tick every five minutes, exact inside a single instance, and stated here rather than left to be discovered.
6. **No backoff.** A failed deposit is retried next tick at the same amount. The spend cap bounds the money, not the number of attempts. A *failed* deposit consumes no cap.
7. **Hot key in a file.** Confined to two modules and scrubbed from every error message that escapes them, but still a hot key. Testnet only.
8. **The live gauge barely moves on its own.** At ~$0.008/day of real burn, no threshold is fallen through on camera by the passage of time. The visible drain is a mock-mode phenomenon; on live, the crossing comes from the squeeze.
9. **A restored decision card quotes the scale it was taken at**, so a feed holding history from an earlier run at a different scale shows both. Each card is individually correct about the decision it describes.
10. **Not verified against a long-running live deployment.** The tests do not cover sustained multi-hour behaviour, real cron delivery, cross-instance journal convergence under genuine concurrency, RPC flakiness under load, or an armed `terminateService` against a real delinquent data set.

The full-length versions of all of these, with the code that backs each claim, are in [**deep dive §13**](docs/DEEP_DIVE.md#13-known-limitations-in-full).

---

## More

| | |
|---|---|
| [**`docs/DEEP_DIVE.md`**](docs/DEEP_DIVE.md) | The reference companion: the evidence mechanism, architecture, the tick step by step, the policy engine, PDP proof state and eviction, the operator squeeze, the spending cap, the demo timescale, the full environment reference, the Vercel runbook and verification sequence, the test breakdown, the tech stack and the repository map. |
| [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) | Shot-by-shot video script, with fallbacks for every way a live demo can go sideways. |
| [`docs/SHOWCASE.md`](docs/SHOWCASE.md) | Submission blurb and X thread. |
| [`.github/workflows/agent-tick.yml`](.github/workflows/agent-tick.yml) | The scheduler that actually drives the deployed agent. |
| [`.env.example`](.env.example) | Every variable, with the reasoning for each written above it. No values. |

Built on Next.js 16 (App Router, React 19), TypeScript strict, Tailwind v4, `@filoz/synapse-sdk` 1.2.1 — **viem-based, not ethers** — viem 2.56, Vitest 4, and Vercel Blob for the deployed journal. Transport is Server-Sent Events; there is no database.
