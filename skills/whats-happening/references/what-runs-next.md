# What runs next: queue order, capacity, routing, and the levers a person has

This reference restates invariants: how Catalyst orders work and which levers a person has. The live queue is `node scripts/snapshot.mjs` (its `queue` block, `--team K` to narrow); one ticket's verdict is `node scripts/explain.mjs <ticket>`. Every reason a ticket is excluded is in `references/why-is-it-stuck.md`; this page does not repeat them.

## Queue order

Each team's queue is derived by the cloud itself from the team's own tickets, continuously, so nothing a session publishes can go stale between sessions:

1. Queued tickets (cards in the dispatch slot) rank by **priority** ascending as set on the Linear ticket (urgent first), then **created time** ascending, then **identifier** ascending.
2. Tickets already **mid-ladder** join the same candidate set and sort ahead by how many phases they have completed, so a ticket close to the end goes before one that just started. That count orders; it never makes an ineligible ticket eligible.

The queue is recomputed within seconds of any board change and on each periodic pass as a backstop. `dispatch_queue.source` reads `self-derived` in the normal case.

## Capacity

- Each repository has a concurrency cap of 20 running phases by default, which an operator raises or lowers; the account's own settings page displays it and does not change it. A paused repository resolves to zero without losing the stored value, so resuming restores it.
- Dispatch buckets by repository and splits slots across teams so no team starves another. A slot that is running, might be running, or is restarting is never free capacity.
- Comment-wake work (an agent answering a human comment) shares the same cap as ladder work.

## The work-in-progress limit

A project (one Linear team, across every repository registered to it) starts no new ticket while its work in progress is at its limit: the project's own setting when there is one, else an account-wide value an operator set, else 12. `0` is a real limit and holds every new start. Any member reads it with `catalyst project wip-limit get --team <KEY>`: the limit, where it comes from, and the work in progress now. A workspace owner or admin sets it with `catalyst project wip-limit set <n> --team <KEY>`, or `set default` to return to the workspace value.

It holds only new starts. A dispatch-column ticket that has never run gets no first phase while the team is at its limit, and `explain` prints `wip_limit` with a detail such as "14 tickets in progress, at or above its WIP limit of 12". A ticket that has already started keeps getting every later phase.

In progress means every live ticket of the team past the dispatch column, or granted a first phase even if its card still sits there, and not done, canceled or a duplicate. Blocked, parked, waiting on the merge queue and waiting on a human all count: the count is tickets, not containers. Triage and backlog states, a dispatch-column ticket that never started, a ticket fenced for a worker outside the cloud (the local-lane label), and a merged ticket held only by the runner-pin gate do not count.

A fleet idle at the limit means the tickets in progress are all waiting: on the merge queue, a hold, a paused repository or a person. Unstick those (`unstick`, `catalyst-github`, `what-needs-me`); the limit is doing its job.

## The routing decision, in five checks

When a phase is about to start, a route is chosen per candidate, in order, and the first survivor wins:

1. capability match (can this route run this phase);
2. a model is configured;
3. the provider is available;
4. if the candidate needs a coding-account slot: an eligible slot exists and the headroom floor is met;
5. degraded, equivalent or stage-default parameters resolve.

No survivor reads `no_eligible_account_slot` in the routing block when any candidate was skipped on capacity, else `routing_unavailable` (a misconfiguration). Stage defaults are global and there is no routing setting yet, so a Codex-first pipeline is not something to promise. `references/coding-accounts.md` explains slots.

## The three levers a person has

**1. Priority on the ticket.** Change the Linear priority and the queue reorders itself. This is the lever for "do this one first". It changes what is picked up next; it does not jump a running phase.

**2. The dispatch column.** A card is offered only when it sits in the team's dispatch slot (and, for a ticket that has never entered the ladder, the intake slot when intake is on). Moving a card there starts work; moving it to a backlog-type state stops work without cancelling it and stops further rounds. The `run-this-project` skill has the script; through this skill you describe the move and let the person or the project owner make it.

**3. Holds.** A hold label from the contract's `merge.prLabels` keeps an otherwise mergeable pull request out of the merge queue until a person removes it. A blocking relation from an ask holds every ticket the ask names. The release label the contract names frees a ticket the ask-shape detector flagged by mistake.

A parked or held ticket has its own release: once the cause is fixed, the person's own login releases it through the `unstick` skill (`catalyst release`). Each hold kind, and what clears it, is in `references/when-a-phase-fails.md`.

## What not to promise

- **A running phase is not interrupted** by any lever. It finishes or fails on its own; then the new order applies.
- **A failed phase does not need re-queueing.** It retries in place after a backoff, or moves to remediate and queues a repair round, up to the contract's `thresholds.remediateRoundCap`; repeated failures park it after `thresholds.parkAfterConsecutiveFailures`. Moving the card by hand during that sequence usually restarts the count rather than shortening it.
- **Priority is not urgency to the person.** An urgent ticket blocked on an ask still waits for the ask. The `what-needs-me` ranking is the right list for the person; the queue is the right list for the fleet.

## Answering "why is that one not next?"

Run `explain` on it. If the answer is a position, it is in order and capacity bounds it: say how many are ahead and whether anything runs at all. If nothing runs anywhere, read the coding accounts (`node scripts/snapshot.mjs --accounts`) before anything else. If the answer is a reason, use `references/why-is-it-stuck.md`. If the ticket is not in the explainer, it is on another team, terminal, or unknown to the mirror: check the identifier first.
