# FilRunway showcase copy

Everything below is drafted for **FilecoinTLDR Builder Challenge Cycle 4**. No em-dashes, per house style. Character counts for the X posts are noted and were measured, not estimated.

---

## X / Twitter

### Single post (standalone, 277 characters)

```
FilRunway: an agent that reads its own Filecoin Pay balance and decides whether it can afford to keep its data alive.

runwayInEpochs comes straight off the contract. The policy fires. It deposits USDFC itself, and you watch it happen.

Calibration + Synapse SDK. @FilecoinTLDR
```

### Thread (7 posts)

**1/7** (273 characters)

```
Built an agent for @FilecoinTLDR Cycle 4 that manages its own storage budget.

It reads its own onchain runway on Filecoin Pay every 15 seconds, and when it drops below threshold it deposits USDFC into its own account. Nobody presses anything.

The decision is the product.
```

**2/7** (261 characters)

```
Runway is not something you compute.

synapse.payments.accountSummary() returns runwayInEpochs as a first class field, straight off the Filecoin Pay contract. Along with availableFunds, debt, lockupRatePerEpoch.

The agent asks the chain, and the chain answers.
```

**3/7** (276 characters)

```
Two edge cases the contract actually returns, both handled:

runwayInEpochs == maxUint256 when lockupRatePerEpoch is 0. Nothing stored, runway unbounded.
runwayInEpochs == 0 when debt > 0. Already underwater.

Neither can be Infinity in JSON, so both map to a finite sentinel.
```

**4/7** (264 characters)

```
The whole decision is one pure function.

evaluate(snapshot, rules) -> Decision

No network, no clock, no side effects. 25 unit tests. src/lib/policy.ts line 130 is the comparison that causes every transaction downstream.

Easy to be suspicious of. Easy to verify.
```

**5/7** (271 characters)

```
HOLD is a decision too, logged with its reasoning:

"Runway 9.4 days (27,116 epochs) is at or above the 7-day top-up threshold. Burn rate 0.00041 USDFC/epoch against 11.12 USDFC available. No deposit required."

An agent that only logs when it spends hides its judgement.
```

**6/7** (268 characters)

```
Real Filecoin throughout, on Calibration:

payments.fund() for the top up, one tx, hash resolves on Filfox
storage.prepare() + storage.upload() through Warm Storage and PDP, 2 copies
That upload creates the cost stream the agent manages

@filoz/synapse-sdk 1.2.1, viem
```

**7/7** (255 characters as written; 267 once X counts the URL as 23)

```
One honest disclosure: 1 MiB on Calibration burns ~$0.008/day, so a real runway is thousands of days and no gauge would move.

So the demo scales the agent's THRESHOLDS by 480. It never touches a number read from chain.

Code and full caveats: [REPO LINK]
```

### Notes for whoever posts this

- Replace `[REPO LINK]` in 7/7. X counts any URL as 23 characters regardless of length, which the count above already allows for.
- Attach the demo video to 1/7, not to the thread tail.
- If you want a still image on 2/7, use the terminal frame from `bootstrap -- status` with the raw `runwayInEpochs` line visible. It is the single most convincing screenshot in the project.
- Do not add hashtags. The thread is technical, and hashtags read as reach-farming next to it.
- If a reply or a judge asks for a concrete hash rather than a generic "resolves on Filfox" claim, cite the journal-backed one: the agent's top-up, https://calibration.filfox.info/en/message/0x06e27a6a7fd532722727953b8d266f14d8109aaaa2c9edc8645bf17a1a2fcf6b (status success, block 4034196, 5 USDFC, to the Filecoin Pay contract), paired with decision `1b2d98ef-4984-482f-b394-498ea99b29a6` (`npm run decisions -- --id 1b2d98ef-4984-482f-b394-498ea99b29a6`). There is a genuine earlier autonomous top-up too, https://calibration.filfox.info/en/message/0x17f5ecd765fdef0078241ec1e5b76d4017c96305f7ee80b347bbd29f50d03ac3 (status success, block 4033951, 5 USDFC) — real, but made before the decision journal existed, so it is not in `data/decisions.jsonl` and cannot be proven agent-authored the way the headline one can; mention it as history, not as evidence. And the earlier operator-run funding transaction, https://calibration.filfox.info/en/message/0x45ee3b49ef5f247860181588b6a6f338fc09befcb3fe57af02de9b4a6608b005 (20 USDFC, `npm run bootstrap -- fund`), which is not agent-authored and must never be presented as such.
- If the follow-up is "how do we know the agent sent that one and you didn't", the answer is `npm run decisions -- --id <id>`, which prints the decision that authored the hash: the reading it was taken from, the rule that fired, the reasoning, and the hash itself, from an append-only log written before the transaction existed. Say plainly that the two are byte-identical on chain and that the log is the only thing that separates them. `data/` is gitignored, so this has to be shown from the machine that ran the agent, not from a fresh clone. Read the hash-and-decision pair off that machine at the time you answer, rather than quoting one from an older journal.
- If the follow-up is "but you also ran it in mock, how do we know those numbers aren't in there", the answer is that the journal is mode-scoped, not just mode-stamped. Live and mock write **different files** by default (`data/decisions.jsonl` and `data/decisions.mock.jsonl`); every read is scoped to the mode the process is running as, and a record with a missing or unrecognised mode reads as MOCK, so an unreadable line can never be promoted into evidence. Every row of `npm run decisions` carries its mode, a `not shown  N MOCK decisions` line appears whenever the scope is hiding records, and the `transactions the agent authored (LIVE, onchain)` section is handed the whole file and hard-filters to live-with-a-hash, so it can be narrowed by `--mode` but never widened. Simulated hashes appear under their own heading, which says in those words that they are MOCK, not onchain and not evidence. On the demo machine that is the difference between the true figure, **5 USDFC across 1 transaction**, and the 80 USDFC / 6 transactions an unscoped read of the same file would have totalled.
- Do not let the thread imply the agent funded the whole account. Of the USDFC deposited into Filecoin Pay, **5 per top-up is agent-initiated and 20 was operator bootstrap**. Volunteer that split before anyone finds it; the claim that survives scrutiny is "it made one real autonomous deposit and there is a record proving which one", not "it funded itself".

---

## Submission blurb (291 words)

FilRunway is an autonomous agent that reads its own onchain balance and runway on Filecoin Pay and acts before it runs dry.

**Autonomous budget decisions (30%).** Every 15 seconds it reads `accountSummary().runwayInEpochs` from the Filecoin Pay contract and evaluates a pure policy function against it. The decision is `src/lib/policy.ts:130`, one comparison, 25 unit tests, no I/O. HOLD is recorded with reasoning too, and so is a rule that fires but cannot be paid for: the agent returns INSUFFICIENT_FUNDS and declines, rather than submitting a deposit it already knows will fail. Every decision is appended to a durable log, so which transactions the agent authored is checkable rather than asserted: `npm run decisions -- --id <id>`.

**Working demo (25%).** A live dashboard: runway gauge, burn rate, chain-read Warm Storage data sets, decision log streamed over SSE. You watch the agent act on a crossed threshold, a decision appear with its reasoning, a transaction hash resolve on Filfox, and the next tick flip to HOLD because of the deposit it just made.

**Meaningful Filecoin use (20%).** Synapse SDK 1.2.1 on Calibration. `payments.fund()` for real deposits, `storage.prepare()` and `storage.upload()` through Warm Storage and PDP for the real cost stream being managed, and PDPVerifier reads via `@filoz/synapse-core` for the data sets behind it.

**Clarity (15%).** README with an explicit "where the decision happens" table, a line-by-line breakdown of which on-screen numbers are raw chain readings and which are client-side interpolation, and an honest real-versus-simulated split. The decision journal is mode-scoped end to end: live and mock write separate files, every read is scoped to the running mode, and the "transactions the agent authored" listing hard-filters to live-with-a-hash at every scope, so a simulated hash cannot be presented as evidence. 239 unit tests across 10 files.

---

## Why this is genuinely autonomous

The obvious suspicion about any agent demo is that a human is quietly driving. Five things in the code make that checkable rather than something you have to take on faith.

First, the loop is a `setInterval` on a fixed 15 second interval (`src/lib/agent.ts:384`), started once and never touched again; in the video the countdown reaches zero and the decision appears with nobody's hands on the keyboard. The `RUN TICK NOW` button exists, but pressing it runs exactly the same `runTick()` and cannot change what the policy decides, only when it is asked. And if a cycle is already running it does not start a second one or quietly re-serve an older decision, it returns `coalesced: true`.

Second, the decision function takes no inputs a human can reach: `evaluate(snapshot, rules)` is pure, its snapshot comes straight from `accountSummary()`, and there is no code path anywhere that lets a request body, a query parameter or an environment variable specify an action.

Third, the failure modes prove it is not scripted. A failed RPC read produces a red `FAILED` decision card carrying the real error text instead of a silently skipped tick, and a deposit that reverts is recorded as `FAILED` and retried on the next tick. Scripted demos do not have failure states that render.

Fourth, the agent can decide not to act. If a rule fires and the wallet cannot cover the deposit it calls for, `evaluate()` does not submit a transaction it already knows will fail. It returns `INSUFFICIENT_FUNDS`, states the shortfall in the reasoning, and `runTick()` returns before `deposit()` is ever called. That is a harder thing to fake than spending money: a script written to always look busy would top up regardless, and the honest failure would only surface later as a reverted transaction. This one checks first, and says so.

Fifth, and the one that actually closes the argument: an autonomous top-up and `npm run bootstrap -- fund 5` are **byte-identical on chain**, so no hash on Filfox can distinguish them in either direction. Every decision is therefore appended to a durable, append-only JSONL log (`src/lib/journal.ts`) before the transaction exists, stamped MOCK or LIVE, with the reading it was taken from, the rule that fired, the reasoning, and afterwards the hash. `npm run decisions -- --id <id>` prints that record with no key, no RPC and no running server. That is what makes "provably autonomous" a defensible phrase here rather than a marketing one. The caveat is that `data/` is gitignored, so the record has to be shown from the machine that ran the agent.

And the stamp is acted on, not merely written, which is what stops the fifth point from quietly undermining itself. A project that demos in mock and runs in live accumulates both kinds of record, and one mixed file would let a simulated top-up inflate the very total offered as proof. So: the two modes write **different files** by default; every read is scoped to the running mode, with an unknown or missing mode reading as MOCK so nothing can be promoted into evidence by being unreadable; the dashboard's deposits tile is scoped and relabels itself `SIMULATED DEPOSITS` in hazard yellow when it is showing mock totals; and the CLI's evidence section is fed the whole file and hard-filters to live-with-a-hash, so `--mode` can narrow it and nothing can widen it. What a scope leaves out is stated rather than silently omitted: the listing prints `not shown  N MOCK decisions` along with the command that shows them, on the principle that an omission a reader cannot see is indistinguishable from a file that never held those records. The dashboard now makes the same disclosure as durable state rather than a log line: it is pinned above the rolling agent trace and re-sent in full on every stream connect, so it is still on screen for a viewer who arrives an hour into a session instead of having scrolled away with the startup logs.

Two things a human does choose, and both are deliberate. The first is the policy: the thresholds and amounts in `DEFAULT_RULES`, plus `FILRUNWAY_DEMO_SCALE`. That is the correct division of labour: an operator sets the risk appetite; the agent decides, from data only it has read, when that appetite has been breached and what to do about it. The second is the account setup: of the USDFC in the agent's Filecoin Pay balance, **5 per top-up is agent-initiated and 20 was operator bootstrap** via the CLI, and the uploads that create the cost stream were operator-run too. The agent made one real autonomous deposit. That is the claim, it is stated before anyone has to go looking for it, and the decision log is what proves the one is the agent's.
