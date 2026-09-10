# Reprioritising

This reference restates invariants: how Catalyst orders work and which levers a person actually has. The live queue is `catalyst-skills queue [--team K]` (inside `node scripts/snapshot.mjs`); the thresholds behind backoffs and parks are the contract's `thresholds` block, printed in the snapshot's `tenant` section.

## How the cloud orders work

Each team's queue is derived by the cloud itself from the team's own tickets, so there is nothing a session publishes and nothing that goes stale between sessions. The order is:

1. **Priority** ascending, as set on the Linear ticket (urgent first).
2. **Created time** ascending: older tickets first among equals.
3. **Identifier** ascending, as the final tiebreak.

Tickets that are already **mid-ladder** join the same candidate set and sort ahead by how many phases they have completed, so a ticket that is nearly done finishes before a fresh one starts. That is an ordering rule only; it never makes an ineligible ticket eligible.

Within the order, dispatch is bounded per repository (a concurrency cap the tenant admin can set in settings, and a paused repository resolves to zero) and split across teams so one team cannot starve another. Comment-wake work, where the cloud answers a human comment on a ticket, shares the same cap as relay work.

The queue is recomputed on every ingest that touches the team and on each alarm pass, so a change you make shows up within seconds, not on a schedule.

## The three levers a person has

**1. Priority on the ticket.** Change the Linear priority and the queue reorders itself. This is the lever for "do this one first". It does not jump a running phase; it changes what is picked up next.

**2. The dispatch column.** A card is offered only when it sits in the team's dispatch slot (and, for a ticket that has never entered the ladder, the intake slot when intake is enabled). Moving a card into that slot is how work is started; moving it out to a backlog-type state is how work is stopped without cancelling it. The `run-this-project` skill has the script; through this skill you describe the move and let the person or the project owner make it.

**3. Holds.** A PR label from the contract's `merge.prLabels` set keeps an otherwise-mergeable pull request out of the merge queue until a person removes it. A blocking relation from an ask holds every ticket the ask names. Applying the release label the contract names frees a ticket the ask-shape detector flagged by mistake.

Everything else that looks like a lever is not one from a key: unparking a phase, clearing a repair hold, resetting a validate budget and re-pinning a base are operator actions today, and the reply says so and names the settings page rather than promising them.

## What not to promise

- **A running phase is not interrupted** by any of the three levers. It finishes or fails on its own; then the new order applies.
- **A failed phase does not need re-queueing.** A pre-branch failure or an infrastructure failure retries in place after a backoff; a later failure moves the card to the remediate slot and queues a repair round, capped by the contract's `thresholds.remediateRoundCap`; repeated failures park it after `thresholds.parkAfterConsecutiveFailures`. Moving the card by hand during that sequence usually restarts the count rather than shortening it.
- **Priority is not urgency to the human.** An urgent ticket that is blocked on an ask still waits for the ask. The what-needs-me ranking (by what an answer releases) is the right list for the human; the queue is the right list for the fleet.

## Answering "why is that one not next?"

Run `explain` on it. If the answer is a position, it is next in order and the cloud is bounded by capacity: say how many are ahead and whether any run at all (if nothing runs anywhere, the likely cause is coding-account capacity, which a key cannot read yet, so name the settings page). If the answer is a reason, use `references/why-is-it-stuck.md`. If the answer is that the ticket is not in the explainer, it is on another team, terminal, or unknown to the mirror: check the identifier before anything else.
