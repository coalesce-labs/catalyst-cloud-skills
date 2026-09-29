# What runs next: order, capacity, routing, and the person's levers

## Queue order

The cloud derives each team's queue from its tickets within seconds of any board change. Cards in the dispatch slot rank by Linear **priority** (urgent first), then **created time**, then **identifier**. Tickets already **mid-ladder** join the same set and sort ahead by phases completed, so a ticket near the end goes first; that count orders, and never makes an ineligible ticket eligible.

## Capacity

- Each repository has a concurrency cap of 20 running phases by default, which an operator raises or lowers; the account's own settings page displays it. A paused repository resolves to zero and keeps the stored value for resuming.
- Dispatch splits slots across teams so none starves, and comment-wake work shares the cap.

## The work-in-progress limit

A project (one Linear team across its repositories) at its limit starts no new ticket: its own setting, else an account-wide value an operator set, else 12. `0` holds every new start. Members read it, its source and the count with `catalyst project wip-limit get --team <KEY>`; an owner or admin runs `set <n>` (or `set default`).

It holds only first phases (`explain` prints `wip_limit`, e.g. "14 tickets in progress, at or above its WIP limit of 12"); a started ticket keeps getting every later phase. In progress counts tickets, not containers: every live ticket past the dispatch column (or granted a first phase), blocked, parked and waiting ones included; never-started, backlog and local-lane tickets are not counted. A fleet idle at the limit means the tickets in progress are all waiting; unstick those (`unstick`, `catalyst-github`, `what-needs-me`).

## Routing

A phase about to start takes the first route that passes, in order: capability match, a configured model, the provider available, an eligible coding-account slot with headroom (when the route needs one), and resolvable parameters. With no survivor, the routing block reads `no_eligible_account_slot` when a candidate was skipped on capacity, else `routing_unavailable`. Stage defaults are global and there is no routing setting yet, so a Codex-first pipeline is not something to promise. Slots are in `references/coding-accounts.md`.

## The person's levers

1. **Priority on the ticket** reorders the queue: the lever for "do this one first".
2. **The dispatch column.** Moving a card there starts work; moving it to a backlog-type state stops work, and further rounds, without cancelling. Describe the move and let the person or the project owner (`run-this-project`) make it.
3. **Holds.** A hold label from the contract's `merge.prLabels` keeps a mergeable pull request out of the queue until removed. An ask's blocking relation holds every ticket it names. The contract's release label frees a ticket the ask-shape detector flagged by mistake.

No lever interrupts a running phase. A failed phase needs no re-queueing, and moving its card by hand usually restarts its count. Priority is the fleet's order, not the person's urgency: an urgent ticket blocked on an ask still waits for the ask.

## "Why is that one not next?"

Run `explain` on it. A position means capacity bounds it: say how many are ahead and whether anything runs at all; if nothing runs anywhere, read the coding accounts first. A reason goes to `references/why-is-it-stuck.md`. A ticket missing from the explainer is on another team, terminal, or unknown; check the identifier.
