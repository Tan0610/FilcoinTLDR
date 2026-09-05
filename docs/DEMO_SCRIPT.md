# FilRunway demo video script

Target length: **2:30 to 3:00**. Hard requirement: the autonomous decision moment lands by **1:25 at the latest**, with a transaction hash visible and resolving on Filfox before 1:45.

Recorded in **live mode against Filecoin Calibration**. The mock-mode cutaway at the end is optional and is explicitly labelled on screen as simulated.

---

## Pre-flight checklist

Run this the hour before you record. Everything here is a gate, not a suggestion.

> ### Before you rehearse in LIVE: you have three deposits, not unlimited ones
>
> The agent now enforces a spending cap on itself — by default **at most 3 deposits and 20 USDFC per rolling 24 hours**, and it is enforced in **LIVE mode only**. A fourth top-up inside 24 hours does not fail and does not error: it produces an amber `CAPPED` card and no transaction at all.
>
> Do the arithmetic before you press record. **One rehearsal (1 deposit) plus one take (1 deposit) plus a single retake (1 deposit) is exactly the cap.** The next take produces a `CAPPED` card where you wanted a `TOP UP`, and the window does not reopen until the oldest deposit is 24 hours old. Two 15 USDFC emergency top-ups would hit the 20 USDFC limit even sooner — on the second one.
>
> Pick one of these, deliberately, before the first rehearsal:
>
> - **Rehearse in mock.** Set `FILRUNWAY_MODE=mock` and both scale variables to `1`, walk the whole shot list, then switch back to live for the take. The cap is not enforced in mock, so rehearsals are free. This is the recommended route.
> - **Raise the cap for filming.** Set `FILRUNWAY_MAX_DEPOSITS_24H` (and, if you plan emergency top-ups, `FILRUNWAY_MAX_DEPOSIT_USDFC_24H`) to something that comfortably covers rehearsals plus takes, and put them back afterwards. These are runtime variables: no rebuild is needed locally, but restart `npm run dev` so the process picks them up.
>
> Do **not** discover this at take three. Check what the window already holds with `npm run decisions -- --executed` before you start: every EXECUTED decision inside the last 24 hours counts against it, including the ones from yesterday evening.
>
> The pinned notice above the AGENT TRACE states the limits in force for the whole session, so if you are unsure what the agent thinks its cap is, read it off the dashboard rather than off this document.

### Chain state

| # | Check | Command | Pass condition |
|---|-------|---------|----------------|
| 1 | Key, RPC, balances, approval, summary | `npm run bootstrap -- status` | Exits clean. FIL and USDFC both non-zero. `approved: yes`. |
| 2 | tFIL for gas | same output, WALLET section | At least 1 tFIL. Every tx fails without it. Faucet: https://faucet.calibnet.chainsafe-fil.io |
| 3 | USDFC to deposit | same output, WALLET section | At least 50 USDFC, so a rehearsal plus the take both fit. Faucet: https://faucet.reiers.io. Note that a full wallet is **not** sufficient on its own: the agent's own 24h spending cap will stop it at 3 deposits / 20 USDFC regardless of balance. See the warning above. |
| 4 | Warm Storage approved | same output | `approved: yes`. If not: `npm run bootstrap -- approve` and wait for CONFIRMED. |
| 5 | **Burn rate is non-zero** | `npm run bootstrap -- datasets` | At least one `live` data set with `pieces`. If empty: `npm run bootstrap -- upload --demo`, then wait for the summary to reflect it. |
| 6 | Runway is finite | `bootstrap -- status`, RUNWAY section | Must **not** print `unbounded (burn rate is zero)`. If it does, go back to 5. Nothing is being paid for yet, so there is no budget story to tell. |
| 7 | Decision journal is on | `npm run decisions` | Prints a file path. If it says persistence is off, `FILRUNWAY_DECISION_LOG=off` is set — unset it. Without the journal there is no evidence beat at 2:05, and the record of the take is lost when you stop the server. |
| 7a | Journal is the **LIVE** one | same output, `file` and `showing` rows | `file` must end `data/decisions.jsonl` and `showing` must read `LIVE records only`. That is the unset-`FILRUNWAY_DECISION_LOG` default for `FILRUNWAY_MODE=live`; mock writes to `data/decisions.mock.jsonl` instead. **Leave `FILRUNWAY_DECISION_LOG` unset.** Setting it points both modes at one file — still safe, because reads are mode-scoped, but it re-mixes the two streams. |
| 7b | The evidence line is LIVE-only | same output, bottom section | `transactions the agent authored (LIVE, onchain)` must list your real hash and nothing simulated. A `not shown  N MOCK decisions` line above it is expected and fine if you have rehearsed in mock: it means the scope is hiding them, not that they are gone. Optional tidy-up: `npm run decisions -- --split` (dry run) then `--split --write` copies historical MOCK records out of the LIVE journal into `data/decisions.mock.jsonl`. It never modifies the LIVE file and skips ids already copied, so it is safe to run twice. |
| 7c | **The spending cap has room** | `npm run decisions -- --executed` | Fewer than 3 EXECUTED decisions inside the last 24 hours, totalling under 20 USDFC. If the window is full the take produces an amber `CAPPED` card instead of `TOP UP`. See the warning at the top of this checklist. |
| 7d | Recording the **deployment** rather than localhost? | `vercel env pull .env.local`, then `npm run decisions -- --remote` | Prints `blob:filrunway/journal/` as the source and lists the deployed agent's records. Use `--remote` for the evidence beat at 2:05 in that case: the local `data/decisions.jsonl` holds a different agent's history and must not be shown as the deployment's. |

### Arming the decision

The video depends on the agent starting *below* a threshold so that a top-up genuinely fires.

Be clear with yourself about what this is and is not. The demo timescale multiplies the agent's **policy thresholds**. It does not touch the burn rate, so the runway still falls at about one day per real day. **You are not going to film a runway falling through a threshold** — that would take months of real time. What you are filming is the agent finding itself below a threshold it was already past, acting, and then correctly holding *because its own deposit moved it back above the line*. The second decision is caused by the first. That is a real autonomous arc and it is the one to narrate; do not narrate a countdown that is not happening.

Choosing the scale is arithmetic, not tuning. Take your real runway `R` from `bootstrap -- status` and the ~625 days a 5 USDFC deposit buys. Pick `N` so that the top-up threshold `7 × N` lands **between `R` and `R + 625`**. Then exactly one top-up fires and the following tick holds.

8. Read the `DEMO TIMESCALE` section of `bootstrap -- status`. It prints a suggested `FILRUNWAY_DEMO_SCALE`, but that is only a power-of-ten rounding for readability — advisory, not the number to run with.
9. Put **480** in **both** `FILRUNWAY_DEMO_SCALE` and `NEXT_PUBLIC_FILRUNWAY_DEMO_SCALE`. On the demo machine `.env` is **already at 480 in both**, so this is a check, not a change. Arbitrary non-round scales are fully supported; 480 is the value that satisfies the rule above for the reference account (see step 12). Setting only the server-side variable makes the agent act on scaled thresholds while the gauge draws an unscaled axis — the agent raises a pinned `error` notice at startup if you do, sitting above the rolling AGENT TRACE lines and staying there for the life of the process, so check for it.

    Older mock decision cards restored from the journal may read `×380 DEMO`. That is the scale those decisions were *taken* at, recorded with them, not the current configuration. It is within-mode history, not a misconfiguration, and it cannot appear on a LIVE card taken during your take.
10. **Restart `npm run dev`.** `NEXT_PUBLIC_*` is inlined at build time; editing it without a restart leaves the gauge drawing the old axis.
11. Load the dashboard and watch one tick. The first decision card should read **TOP UP**. If it reads HOLD, your threshold is below your runway and you have picked `N` too low — recompute it from the rule just above against *your* `bootstrap -- status` output, do not just keep raising it until something fires.
12. The expected arc at scale 480, for the reference account:

    | | |
    |---|---|
    | Real runway | ~2,969.9 days (`bootstrap -- status`) |
    | Top-up threshold at ×480 | 7 × 480 = **3,360 days** |
    | First tick | 2,969.9 < 3,360, so **TOP UP**, 5 USDFC |
    | What the deposit buys | ~625 days |
    | Next tick | 2,969.9 + 625 = ~3,595 > 3,360, so **HOLD** |

    That is one decision and its consequence, on camera, roughly 15 seconds apart — or roughly 60 seconds apart if you are recording the Vercel deployment, where a cron job drives the cycle instead of a timer. Budget the extra time in the 0:52 to 1:25 beat. For contrast: at **380** the threshold is 2,660 days, which the 2,969.9-day runway is already above, so the agent holds forever and a judge sees no decision at all. At the tool-suggested **1000** the threshold is 7,000 days, about eight consecutive deposits away, which reads on screen as a stuck loop rather than a judgement. Rehearse once end to end so you know which tick does what, then reset by restarting for the real take.

13. **Note the decision id of the rehearsal top-up** (`npm run decisions -- --executed`). You will want the command ready for the evidence beat at 2:05.

### Recording setup

14. Dev server running, dashboard loaded at least once so `ensureAgentLoop()` has started.
15. Browser at 1920x1080, zoom 100%, bookmarks bar hidden, no extensions visible, no notifications.
16. Second browser tab pre-opened on `https://calibration.filfox.info/en/address/0x48c54EAb7039f43DcAEd14ba44b999E16a9309bD` so the Filfox cut is one keystroke away.
17. Terminal at a font size legible at 1080p, `bootstrap -- status` output already scrolled to the RUNWAY section. A **second terminal** ready for `npm run decisions`.
18. Editor open on `src/lib/policy.ts`, scrolled so lines 119 to 135 are on screen (`evaluate()` through the rule branch).
19. **Do not touch `RUN TICK NOW` during the decision beat.** The point is that nobody pressed anything. Keep the cursor away from that button and let the countdown reach zero on its own.

    If you are recording the **deployment**, there is no such button to avoid: the deployed build shows a dashed `CRON DRIVEN` chip in its place, because `/api/tick` requires a secret the page must never carry. That is worth one sentence of narration rather than passing over it — it is a stronger version of the same claim. Nobody watching the page can make this agent act, and nobody has to be watching for it to act, because the loop does not start on a page view at all.

---

## Shot list

### 0:00 to 0:12 — Cold open

| | |
|---|---|
| **On screen** | Full dashboard. Gauge dominant. `LIVE · CALIBRATION` badge in green. `NEXT TICK` counting down. |
| **Do** | Nothing. Let it breathe for three seconds before speaking. |
| **Say** | "This agent is reading its own bank balance on Filecoin. Not a mock. That is a real Calibration address, and in about ninety seconds it is going to decide, on its own, that its runway is below the line it was given, and pay itself." |

### 0:12 to 0:32 — The meter

| | |
|---|---|
| **On screen** | Slow cursor pass across the four stat tiles: BURN RATE, FILECOIN PAY, WALLET, AUTONOMOUS DEPOSITS. Then down to the STORED DATA · PDP / WARM STORAGE panel under the decision log. Then back to the gauge. |
| **Do** | Hover, do not click. Hovering AUTONOMOUS DEPOSITS shows the journal path it is computed from and the words `MOCK records are excluded`. In live mode the tile reads `AUTONOMOUS DEPOSITS`, `5 USDFC`, with the sub-line `1 transaction · N decisions` — one transaction, not six, because the total is scoped to LIVE. |
| **Say** | "Burn rate, shown compact with an SI prefix, something like micro-USDFC per epoch, with the full-precision reading one hover away in the tooltip. That's the cost stream created by data this agent actually uploaded through Warm Storage. Available funds in Filecoin Pay. What is left in the wallet to deposit from. And a running total of deposits the agent made itself, with no one asking it to — that's the whole recorded history off the decision log on disk, not just what this browser tab has seen. And down here is what the burn rate is actually buying: the Warm Storage data sets, read from the chain — data set id, the provider holding it, the size, and the piece CID under PDP." |

### 0:32 to 0:52 — Proof the numbers come from the chain

| | |
|---|---|
| **On screen** | Cut to the terminal, RUNWAY section of `bootstrap -- status`. The line `runwayInEpochs (raw)` must be readable. |
| **Do** | Highlight the raw value with the mouse. |
| **Say** | "This matters. Runway is not something I calculated. Filecoin Pay returns `runwayInEpochs` as a field on `accountSummary`, straight off the contract. The agent asks the chain how long it has left, and the chain answers. Everything after this is a reaction to that one number." |

### 0:52 to 1:25 — The decision (the beat everything else exists to serve)

| | |
|---|---|
| **On screen** | Back to the dashboard, framed so the `NEXT TICK` countdown and the top of the DECISION LOG are both visible. |
| **Do** | **Nothing. Hands off the keyboard, visibly.** Let the countdown hit `0.0s`. |
| **Say (while it counts down)** | Locally: "Fifteen second tick. Sense, decide, act. Watch the log." From the deployment: "Five minute tick, driven by a scheduled call from outside, not by this page. Sense, decide, act. Watch the log." Read the cadence off the `NEXT TICK` cell rather than from this script — it reports the interval actually in force, so it is right in both builds. |
| **Then** | A new card appears in the decision log: `TOP UP`, amber, with the rule label and the reasoning line. |
| **Say** | Read the reasoning aloud, **verbatim off the card** — do not paraphrase from this script, because the exact figures are whatever the chain returned on the day. At ×480 the card will read close to `Runway 2969.9 days (8,553,196 epochs) is below the 3360-day top-up threshold. Burn rate 0.000002777832968892 USDFC/epoch against 23.76 USDFC available. Depositing 5 USDFC extends runway to ~3594.4 days. Threshold shown is the 7-day rule at the ×480 demo timescale.` You do not have to read the burn rate digit by digit; say "burn rate about two point eight micro-USDFC an epoch" and read the rest as written. Then: "It wrote that itself, from numbers it just read, including the last line, which tells you the threshold is the scaled one." |
| **Then** | AGENT TRACE prints `Submitting deposit of 5 USDFC to Filecoin Pay...`, then `tx submitted`. The card's status pill turns `SUBMITTING`, and the truncated tx hash appears on it. |
| **Say** | "There is the hash. Nobody pressed anything." |

### 1:25 to 1:45 — Filfox

| | |
|---|---|
| **On screen** | Click the tx hash on the decision card. It opens Filfox in a new tab. |
| **Do** | Let the Filfox page load. Show the message: method, from address matching the status strip, value, status. |
| **Say** | "Same hash, on the public explorer. Same address as the one in the header. That is a real message on Calibration, submitted by a process that decided to submit it fifteen seconds ago." Say "a minute ago" instead if you are recording the deployment, where the cycle runs once a minute. |
| **Then** | Back to the dashboard tab. The status pill has moved to `EXECUTED` and the trace reads `Deposit confirmed onchain`. |

### 1:45 to 2:05 — The other half: deciding not to act

| | |
|---|---|
| **On screen** | The next tick lands. A grey `HOLD` card appears above the amber one, visually distinct. |
| **Do** | Point at the two cards side by side. |
| **Say** | "And this is the part people skip. Its own deposit pushed the runway back over the threshold, so the next tick decided to do nothing, and it logged why. That hold is caused by the thing it just did. An agent that only tells you when it spends money is not showing you its judgement. Restraint is a decision, and it is in the audit trail with the numbers behind it." |

### 2:05 to 2:20 — The evidence (do not cut this)

| | |
|---|---|
| **On screen** | Second terminal. Run `npm run decisions -- --executed`, then `npm run decisions -- --id <the id beside the hash>`. |
| **Do** | Let the full record render: the reading, the rule, the reasoning, the outcome, the hash and its Filfox URL. Put the hash on screen beside the Filfox tab from the previous beat if you can frame both. |
| **Say** | "Here is why you should believe that was the agent and not me. A deposit made by the agent and a deposit I make from the CLI are byte-identical on chain — the hash proves money moved, it does not prove who moved it. So every decision gets appended to a log before the transaction exists. This is that record: the balance it read, the rule that fired, the sentence it wrote, and the hash it produced. Same hash as the one on Filfox. No key needed to read this, no server running." |
| **If a `not shown  N MOCK decisions` line is on screen** | Do not skip past it, use it. One extra sentence: "That line is the tool telling me it is only showing me live records and that there are simulated ones it is deliberately not counting. Every row here carries its mode, and the transaction section at the bottom only ever lists live ones — simulated hashes get their own section that says, in those words, not onchain, not evidence." It is a stronger beat than pretending the mock rehearsal never happened. |

### 2:20 to 2:35 — Where the decision lives

| | |
|---|---|
| **On screen** | Editor, `src/lib/policy.ts`, lines 119 to 135. Cursor on line 130. |
| **Do** | Highlight `const rule = selectRule(days, rules);` |
| **Say** | "That is the whole thing. One line. `days` came from `runwayInEpochs` on the contract. `rules` is the policy. It is a pure function: no network, no clock, no side effects, twenty-five unit tests on this file alone and three hundred and thirty-two in the project. The transaction you just watched is a consequence of this comparison, and nothing else." |

### 2:35 to 2:50 — The honest bit

| | |
|---|---|
| **On screen** | Dashboard, zoomed on the gauge header badge: `DEMO TIMESCALE ×480 · READINGS REAL`, then on a decision card's last sentence. |
| **Do** | Point at the badge, then at the `Threshold shown is the 7-day rule at the ×480 demo timescale.` line on the card. Point at the stat tiles, **not** at the gauge numeral. |
| **Say** | "Two disclosures. First: a one megabyte upload at two copies on Calibration burns about eight tenths of a cent a day, so a real runway here is thousands of days and no gauge would ever move. The demo multiplies the agent's *thresholds* by 480 — never a number read from the chain — and every decision card says so in its own last sentence, so a screenshot of one card can't hide it. It does not speed the burn up either: runway still falls a day per day. You are not watching a countdown, you are watching it act on a line it was already past, and then hold because of what it did. Second: the numbers in these tiles and on these cards are raw chain readings. The big number on the gauge is not — it's smoothed between the two-second reads so the needle doesn't stutter, and it snaps back to the real value every time one lands." |
| **Then** | Pan to the top of the AGENT TRACE panel. If you rehearsed in mock, a row tagged `PINNED` sits above the rolling lines: `N MOCK decisions in data/decisions.jsonl are withheld from this LIVE view. Read them with npm run decisions -- --mode mock.` If nothing was withheld the row is absent entirely, so skip this. |
| **Say** | "And one the dashboard makes for itself. That is pinned, not logged: it says a simulated record is being kept out of this live view and gives you the command to go read it. It is standing state, re-sent whole on every stream connect, so it is still there for someone who opens this tab an hour in — an ordinary trace line saying the same thing would have scrolled out of the backlog long before the camera reached it. And it only ever appears when something really was withheld." |

### 2:50 to 3:00 — Close

| | |
|---|---|
| **On screen** | Pull back to the full dashboard. Let one more tick land. |
| **Say** | "FilRunway. It reads its own runway on Filecoin Pay, it decides, and you can watch it decide. Calibration testnet, Synapse SDK, code and setup in the README." |
| **End on** | The dashboard, live, ticking. No logo card, no music sting. |

---

## Optional cutaway: the full drain (adds 20 seconds)

Only include this if the video is running short. It must be clearly labelled, and the UI labels it for you.

Restart with `FILRUNWAY_MODE=mock` **and both scale variables back to `1`**. The mock account opens at 9.6 days of runway, so leaving the demo timescale at 480 would put it thousands of days below the scaled emergency threshold and it would fire an emergency top-up on the first tick instead of drifting down through the bands. Mock mode is the one place the runway genuinely drains, so it does not need the timescale at all.

The status strip grows a yellow hazard stripe and a filled black-on-yellow `MOCK DATA` badge, which is the point: it cannot be mistaken for the live footage. The badge is resolved on the server and is correct on the **first painted frame**, so there is no frame of this cutaway that is not labelled, and no frame of the live footage that is wrongly labelled either — the mode badge has a third, neutral `CONNECTING` state for the moment before it is known, and never defaults to MOCK.

Decisions taken during the cutaway are journalled with `"mode":"MOCK"` on every line **and go to a different file**: with `FILRUNWAY_DECISION_LOG` unset, mock writes `data/decisions.mock.jsonl` and never touches the LIVE `data/decisions.jsonl`. So the cutaway cannot append simulated spend into the file that proves the real transaction, and it cannot later be mistaken for evidence in the decision log.

The deposits tile relabels itself for the cutaway, which is worth one line of narration if you point the cursor at it: it reads **`SIMULATED DEPOSITS`** in the same hazard yellow as the mode badge, with a sub-line beginning `MOCK ·`. Three independent markers — the first word of the label, the colour, and the sub-line prefix — so no crop of the frame can pass it off as the live tile. The number itself is not faked or blanked; it is a true count of simulated activity.

One cosmetic wrinkle to know about before it surprises you on camera: a mock card restored from an earlier mock session shows the demo scale that session ran at, so a card recorded at `×380` still reads `×380 DEMO` next to a fresh one at `×480`. That is the label captured with the decision, and it is history rather than a bug — but do not read the two aloud as if they were the same run.

| | |
|---|---|
| **On screen** | Mock dashboard, gauge visibly counting down. Time-lapse to 4x. |
| **Say** | "This same code against a simulated chain, with time accelerated, so you can see the whole arc: green, amber at seven days, a scheduled top-up, then red under two days and the emergency rule firing fifteen USDFC. The yellow stripe means this half is simulated. Everything before it was not." |

---

## Optional beat: insufficient funds (adds about 15 seconds, not the primary beat)

Worth one card if there is room, because it is a stronger autonomy claim than the TOP_UP beat: the agent recognising a constraint and declining to act, rather than just spending. Keep it secondary — the primary decision beat stays TOP_UP with a real, resolving tx hash — and induce it honestly rather than faking it:

- **Live mode.** Before the tick that is about to fire a top-up rule, fund the wallet with tFIL for gas but deliberately *less* USDFC than that rule's deposit amount (for example, 3 USDFC in the wallet when the 5 USDFC scheduled rule is about to fire). The card reads `INSUFFICIENT_FUNDS`, red and inverted, instead of `TOP_UP`. Top the wallet back up afterward for the primary take.
- **Mock mode.** The mock wallet starts at 250 USDFC and only drops on real top-ups, so a normal mock run never reaches this state — it takes roughly 16 emergency top-ups to drain it. That is not practical to stage live, so use the live-mode approach above if you want this beat at all.

If you show it: one card, one line of narration — "and here it declines; the wallet can't cover this deposit, so it says so instead of trying and failing" — then move on to (or back to) the TOP_UP beat.

**Do not confuse this with the amber `CAPPED` card.** They are two different refusals and the UI colours them apart on purpose. `INSUFFICIENT_FUNDS` is red, pilled `BLOCKED`, and means the agent is stuck until a human funds the wallet. `SAFETY_CAP` is amber, pilled `CAPPED`, and means the agent hit a limit it was given and will resume by itself when the window rolls — no operator needed. If you narrate the amber one as "it ran out of money" you have described the opposite of what happened. See "An amber `CAPPED` card appears instead of `TOP UP`" under Fallbacks.

---

## Fallbacks

### The transaction is slow to confirm

Filecoin blocks are 30 seconds. Confirmation typically lands in 30 to 90 seconds; the adapter's receipt timeout is 180 seconds.

The judged moment is the **decision plus the submitted hash**, not the receipt. If confirmation is slow:

1. Keep talking. Move to the Filfox cut immediately with the hash you already have. A pending message on Filfox is still proof the transaction exists and was submitted by that address.
2. Record the HOLD beat (1:45), the evidence beat (2:05) and the code beat (2:20) while you wait. Confirmation will land underneath you.
3. If it still has not confirmed by the end of the take, cut to the confirmed Filfox page and the `EXECUTED` card as a separate shot, with an on-screen caption saying how long it took, for example `confirmed 71s later`. Do not present the two as continuous footage without the caption.
4. **Never substitute a hash from a different run.** If the take is unusable, re-arm and shoot it again. A judge who catches a spliced hash discounts everything else in the video.

### The wallet can't cover the deposit

(If the card is **amber** and pilled `CAPPED` rather than red and pilled `BLOCKED`, this is not the section you want — see "An amber `CAPPED` card appears instead of `TOP UP`" below. The wallet is fine; the agent stopped itself.)

The agent checks this before it ever calls `deposit()`. If the wallet holds less USDFC than the fired rule wants, the card that appears is a red, inverted `INSUFFICIENT_FUNDS` card, not a `FAILED` one — no transaction is attempted, so there is no hash and nothing to fail on-chain. If this happens on camera, it is a legitimate second decision beat, not a mistake to cut around: say "and that's it declining — it knows this deposit would fail, so it doesn't submit it", top up the wallet from the faucet, and let the next tick re-evaluate. See "Optional beat: insufficient funds" below if you want to show this deliberately instead of stumbling into it.

### An amber `CAPPED` card appears instead of `TOP UP`

The agent hit its own spending cap. This is not a failure and not a bug: in LIVE mode it will make at most 3 deposits, and deposit at most 20 USDFC, in any rolling 24 hours, and it has already used them — most likely on your rehearsals. The card is **amber** with a `CAPPED` pill and a footer reading *"Self-imposed limit — the agent declined to spend and will resume when the window rolls. No operator action required."* Deliberately not the red `BLOCKED` treatment `INSUFFICIENT_FUNDS` gets: that one needs a human, this one needs nobody.

Two ways to respond, and the first is better than it sounds:

1. **Use it.** It is a genuine autonomy beat, and a stronger one than a top-up. Read the reasoning aloud — it names the limit, both amounts, and the exact UTC time the cap next relaxes — and say: "and here it refuses itself. It is not out of money and nothing failed. It was given a limit of three deposits a day, it has used them, and it is telling me when it will be allowed to act again. An agent you can't stop spending is not one you'd deploy." Then continue the shot list; the following ticks will keep producing decisions, they just will not deposit.
2. **Reset and re-arm** if you need the `TOP_UP` beat for this take. Either wait for the oldest deposit to age out of the window (the card tells you when, to the second), or raise `FILRUNWAY_MAX_DEPOSITS_24H` / `FILRUNWAY_MAX_DEPOSIT_USDFC_24H` and restart `npm run dev`. Both are runtime variables locally. **Do not** delete or edit the journal to clear the window — that is the evidence file, and the cap counts from it precisely because it cannot be argued with.

`npm run decisions -- --executed` tells you exactly what the window holds before you decide which route to take.

### The deposit fails on-chain

A submitted transaction can still fail — an RPC hiccup, a gas spike, a reverted call. That is recorded as a `FAILED` decision, rendered as a red failure card carrying the actual error text, and the agent retries the same amount on the next tick. The same is true of a failed *read*: it is recorded as `{action: HOLD, outcome: FAILED}` and still renders as a red failure card with the error, not as a calm grey hold — outcome outranks action in `DecisionFeed`. If it fails on camera, use it: cut to the card and say "and that is what a failure looks like, recorded rather than swallowed", then check gas and RPC health and re-arm. Do not edit the failure out and leave a gap in the tick sequence.

### The first tick decides HOLD instead of TOP UP

Your runway is above the scaled threshold, which means the scale is wrong for your account. Do not fix this by nudging the number upward until the agent finally produces the answer you wanted — that is tuning until it agrees with you, and a judge is entitled to read it that way.

Fix it by arithmetic instead, once. Read the real runway `R` off `bootstrap -- status`. A 5 USDFC deposit buys ~625 days. Set `N` so that `7 × N` falls between `R` and `R + 625`: `N = ceil(R / 7) + 1` is always inside that window, and the reference account's 2,969.9 days is why the recommended value is 480. Put the same `N` in both scale variables, restart `npm run dev`, reload, and check the first card before recording.

If `7 × N` lands *below* `R` the agent holds forever and there is no decision to film. If it lands *above* `R + 625` the agent chains deposits and looks stuck. There is exactly one window, and it is computed, not searched for. Do not try to fix any of this by clicking `RUN TICK NOW`: it changes nothing about the decision and puts a human hand in the footage at exactly the wrong moment.

### The stream drops

The gauge prints `SIGNAL LOST` and the STREAM cell turns red. The `EventSource` reconnects on its own with a 3 second retry. Wait for it rather than reloading, since a reload restarts the page but not the agent, and the backlog replay will refill the log. The pinned rows do not depend on that replay at all: the whole notice set is re-sent as its own `notices` event on every connect.

### The dashboard is blank on load

**Locally**, `ensureAgentLoop()` starts on the first API request. Load the page once, wait one tick interval — read it off the `NEXT TICK` cell rather than assuming; it is 15 seconds locally — and it fills in. If it does not, the chain read is failing, and there will be a `FAILED` decision card carrying the actual error message. Check `npm run bootstrap -- status`.

**On the deployment**, loading the page starts nothing: no route may begin a cycle as a side effect of being read, which is the point. The first decisions appear when the cron job next fires, up to 60 seconds away, and up to about 5 seconds later again in the browser, because the tick and the SSE stream are served by different Function instances and the page reconciles them through the shared journal. So a blank dashboard for the first minute is expected, not broken. If it is still blank after two minutes, the cron job is not firing: check **Settings → Cron Jobs** in the Vercel dashboard, confirm `curl -i https://<deployment>/api/tick` returns **401** and not 503 (503 means `CRON_SECRET` is not configured, so every tick is being refused), and check the pinned notices above the AGENT TRACE — a Blob store that was never connected shows up there as a journal that disabled itself.
