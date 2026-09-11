# Stalls and escalation

The stall thresholds here are **local policy**, set once by the human who owns the tenant and read by `scripts/scope-status.mjs`. They are not cloud values and the cloud does not enforce them; the cloud's own enforcement numbers (retry backoff, the park threshold, the remediate round cap, the write budget) are on the contract and printed by `how-catalyst-works`. The chase order and the escalation rule below are invariants.

## The policy file

`assets/stall-policy.json` ships the defaults: minutes a ticket may sit in each slot with no update and nothing running or leased on it before it counts as stalled. To change them, copy that file to `~/.config/catalyst-cloud/stall-policy.json` and edit it there; the script prefers the local copy and prints which file it used. Pass `--stall-policy <file>` to use another.

Two slots deserve thought when tuning. The dispatch slot's threshold is how long a card may wait to be picked up before you ask why nothing took it; on a busy tenant with a full queue that is capacity, not a stall, and the answer is to wait or re-prioritise. The PR slot's threshold is how long a card may wait for merge evidence; reviews and CI take real time, so set it generously.

## What counts as stuck

A ticket is stuck when all of these hold at once: it is in an active slot (not done, not canceled), nothing is running or leased on it, its last update is older than the slot's threshold, and the eligibility explainer does not name a reason that is simply waiting out a clock. `scope-status.mjs` checks the first three and hands you the fourth as a command to run.

A running phase is never a stall, however long it has run; the cloud's own timeout will fail it and the outcome card will say so. A ticket in retry backoff is waiting out a rung of two, five or fifteen minutes and is not a stall either.

## The chase order

Run `catalyst-skills explain <ticket>` first, and let its reason pick the row:

| the explainer says | what it means | your move |
| -- | -- | -- |
| offered, with a position | the queue has it; a runner is the bottleneck | wait; if every ticket waits, it is capacity, see below |
| lease held, intake lease held | a container has it | not a stall; wait for the outcome card |
| retry backoff | a pre-branch or infrastructure failure is retrying in place | wait out the rung; three in a row parks it, and then it is a real stall |
| blocked | a live blocks relation | chase the blocker: is it dispatchable, is it an ask nobody answered, is it done but still open |
| ask ticket, ask shape suspected | the ticket is a question | route it to `what-needs-me`; if it is really work, a human applies the release label |
| not at dispatch stage | somebody moved the card, or it never entered | read the card's history; re-dispatch with `make-ready.mjs` if it should run |
| cooling down, remediate parked | the cloud parked it after repeated failure or the round cap | read the last outcome card for the class; if the fix is a decision, file an ask; releasing the park is an operator action |
| no change hold | a remediate round changed nothing | a human comment on the ticket, or a new push to the branch, releases it; say what should change |
| validate class spent, stale failure episode | the repair budget for this failure is used, or the ladder moved on | read the outcome cards; usually a decision about the approach, so an ask |
| waiting on | a merge-gate failure with no automatic repair | read the merge-wait comment and the PR's three legs through `catalyst-github` |
| branch missing, branch gone, no branch to remediate | the branch the phase needs does not exist | a hand-deleted branch is a human question; a never-created one means implement has not run, so check the earlier phases |
| environment check required, running, failed, expired, hash mismatch | the repository's environment gate | a repository setting; the tenant admin resolves it in settings, one ask for the repository, not per ticket |
| scope overlap | another in-flight ticket owns the files | wait for it, or re-order by priority |
| routing unavailable, no eligible slot, runner image breaker, repo paused | a fleet or provider condition | one fleet note, never per ticket; see below |
| pr merged, pipeline complete, ticket terminal | it is finished | close the loop in the summary; if the card is not Done a minute after the merge, that is a finding, not a chore |

Where the explainer names a reason not in this table, it prints the raw reason; read it as spelled and consult `how-catalyst-works`.

## Capacity and fleet conditions are one note, not many asks

When several tickets in scope are offered and nothing picks them up, or the explainer names a routing, slot, provider or image condition, the cause is shared: coding-account headroom, a provider outage, a paused repository, a poisoned runner image. Write one line in the status summary naming the condition and the tickets it holds. Do not file an ask per ticket. `catalyst-skills accounts` reads coding-account status (state, usage windows, walls, quarantine); enrolling, pausing or removing an account is the settings page, not you.

## Escalate inward, never outward

The order is instrument, then you (the steward), then the desk (`whats-happening`), then the human, and the human only ever sees an ask. An instrument or a script that pages a human directly is a defect. So is a stall report that reaches the human as a bare label, a board row, or a chat aside with no ask behind it.

Before anything reaches the human, answer three questions:

1. **Can I decide this myself?** Which approach, retry or abandon, rebase or re-cut, re-order two tickets: yours. Decide, record the decision in a bookkeeping note on the ticket, and move on.
2. **Does this need to block at all?** If a sane default exists, take it, record it, and file the ask anyway so the human can overrule; the work does not wait.
3. **Who else can move this?** Another steward, the desk, a repository owner. Pulling in a peer is preferred over pulling in the human.

Only a genuine product, priority or approval decision, or an action only a human can physically take (release a cloud park, resolve a repository setting, apply the release label, answer a merge policy question), survives to become an ask.

## When a stall becomes an ask

File it through `what-needs-me`, never by hand and never as the human. The ask carries the question as its title, the options, the default that fires if silent, and what it blocks, with the stalled ticket named in the blocks list so the human's inbox ranks it by what it holds. Search for an existing ask about the same decision first and attach the new ticket to it rather than filing a second one; two asks for one decision split its urgency and sink both. Once filed, proceed on the default and say so in the ticket.

## Reply where the message arrived

A human comment inside your scope is answered by you, in that thread, tagged, as the app actor. A question only a human can decide becomes an ask; you do not answer it, and you never post as the human. A bookkeeping record (a state move, a decision you took, a chain summary) carries the contract's bookkeeping marker as a prefix so it wakes nothing; the `--bookkeeping` flag on `catalyst-skills write comment` adds it.
