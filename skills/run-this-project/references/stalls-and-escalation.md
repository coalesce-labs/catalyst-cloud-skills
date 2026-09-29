# Stalls and escalation

The stall thresholds here are **local judgment**, set once by the person who owns the project and read by `scripts/scope-status.mjs`. The cloud publishes no stall policy and enforces none of these numbers. What the cloud itself does about a failing ticket is on the contract's `thresholds` (the retry backoff, the park threshold, the repair-round cap, the write budget); the `whats-happening` skill's `scripts/show-my-map.mjs` prints them. The chase order and the escalation rule below are invariants.

## The policy file

`assets/stall-policy.json` ships the defaults: minutes a ticket may sit in each slot with no update and nothing running or leased on it before it counts as stalled. To change them, copy that file to `~/.config/catalyst-cloud/stall-policy.json` and edit it there; the script prefers the local copy and prints which file it used. Pass `--stall-policy <file>` to use another.

Two slots deserve thought when tuning. The dispatch slot's threshold is how long a card may wait to be picked up before you ask why nothing took it; on a busy account with a full queue that is capacity, not a stall, and the answer is to wait or re-prioritise. The PR slot's threshold is how long a card may wait for merge evidence; reviews and CI take real time, so set it generously.

## What counts as stuck

A ticket is stuck when all of these hold at once: it is in an active slot (not done, not canceled), nothing is running or leased on it, its last update is older than the slot's threshold, and the eligibility explainer does not name a reason that is simply waiting out a clock. `scope-status.mjs` checks the first three and hands you the fourth as a command to run.

A running phase is never a stall, however long it has run; the cloud's own timeout will fail it and the outcome card will say so. A ticket in retry backoff is waiting out a rung of two, five or fifteen minutes and is not a stall either.

## The chase order

Run `catalyst explain <ticket>` first. Look its reason up in the one reason table, the `whats-happening` skill's `references/why-is-it-stuck.md`: it says what the reason means, what releases it, and who acts. What that means for you as the owner:

- **It releases itself** (a lease, a backoff rung, a capacity wait): not a stall. Wait for the outcome card. Three failed rungs in a row park it, and then it is.
- **The person, with their own login, acts**: do it when the move is yours (re-dispatch with `make-ready.mjs`, comment on the ticket to clear a no-change or validate-budget hold, route a question to `what-needs-me`), and file an ask when it is theirs.
- **A park or a hold a release clears**: once its cause is fixed, the `unstick` skill releases it (`catalyst release <ticket> --because <what changed>`). A round-threshold hold and a review that will not converge refuse that release; the table says what clears each.
- **An owner or admin, in settings**, or **an operator**: one ask per repository or setting, never one per ticket.
- **Finished**: close the loop in the summary. A card not Done a minute after its merge is a finding, not a chore.

When the explainer names a reason the table does not know, it prints the raw reason; quote it as spelled.

## Capacity and fleet conditions are one note, not many asks

When several tickets in scope are offered and nothing picks them up, or the explainer names a routing, slot, provider or image condition, the cause is shared: coding-account headroom, a provider outage, a paused repository, a poisoned runner image. Write one line in the status summary naming the condition and the tickets it holds. Do not file an ask per ticket. `catalyst accounts` reads coding-account status (state, usage windows, walls, quarantine); enrolling, pausing or removing an account is the settings page, not you.

## Escalate inward, never outward

The order is instrument, then you (the steward), then the desk (`whats-happening`), then the human, and the human only ever sees an ask. An instrument or a script that pages a human directly is a defect. So is a stall report that reaches the human as a bare label, a board row, or a chat aside with no ask behind it.

Before anything reaches the human, answer three questions:

1. **Can I decide this myself?** Which approach, retry or abandon, rebase or re-cut, re-order two tickets: yours. Decide, record the decision in a bookkeeping note on the ticket, and move on.
2. **Does this need to block at all?** If a sane default exists, take it, record it, and file the ask anyway so the human can overrule; the work does not wait.
3. **Who else can move this?** Another steward, the desk, a repository owner. Pulling in a peer is preferred over pulling in the human.

Only a genuine product, priority or approval decision, or an action only a human can physically take (close a person's own pull request, read a review that will not converge, resolve a repository setting, apply the release label, answer a merge policy question), survives to become an ask.

## When a stall becomes an ask

File it through `what-needs-me`, never by hand and never as the human. The ask carries the question as its title, the options, the default that fires if silent, and what it blocks, with the stalled ticket named in the blocks list so the human's inbox ranks it by what it holds. Search for an existing ask about the same decision first and attach the new ticket to it rather than filing a second one; two asks for one decision split its urgency and sink both. Once filed, proceed on the default and say so in the ticket.

## Reply where the message arrived

A human comment inside your scope is answered by you, in that thread, tagged, as the app actor. A question only a human can decide becomes an ask; you do not answer it, and you never post as the human. A bookkeeping record (a state move, a decision you took, a chain summary) carries the contract's bookkeeping marker as a prefix so it wakes nothing; the `--bookkeeping` flag on `catalyst write comment` adds it.
