# Reading the board

This reference restates invariants: what the stages are, what order they come in, and what "stuck" means. The names your team uses for each stage, and which state ids they map to, are tenant facts read live from the contract; `node scripts/snapshot.mjs --board` prints the board already grouped and ordered by them.

## Stages are slots, names are display

Catalyst thinks in eleven **slots** in pipeline order: dispatch, intake, research, plan, implement, remediate, verify, review, pr, done, canceled. Each of your teams maps some or all of those slots onto its own Linear workflow states. The contract carries, per team and per slot, the state id (the authority), the live state name and type (display), and whether the state still exists in Linear. A team may have adopted Catalyst's recommended states, mapped its existing ones, or mixed the two; the contract's `workflowMode` says which.

Five slots are load-bearing and a missing one is a distinct silent failure: **dispatch** (where a card goes to be picked up), **intake** (an optional first pass for tickets that have never entered the ladder), **pr** (where a card sits while its pull request is reviewed and merged), **done** and **canceled**. The other six are informational: a wrong mapping there costs a warning, not a stall.

Read a board by slot, never by name. Two teams can call the same slot different things, and a state renamed in Linear keeps its id and its slot.

## Work in progress by stage

The snapshot's `board` block groups open tickets by state name in slot order, drops terminal states, and lists any state name that maps to no slot at the end. Read it top to bottom:

- **dispatch** holds what is ready and waiting for a container. A long dispatch column with nothing in flight is a capacity or eligibility question, not a work question: run `explain` on the first row.
- **intake** through **pr** are the ladder. A card advances one slot when the matching phase completes; a failed phase writes no board state, so a card that has not moved is either still running, retrying in place, or moved sideways to remediate.
- **remediate** is an interrupt, not a step. A card there was moved by a failure and returns to its exact previous stage when a repair round succeeds. Count remediate cards separately; they are not progress.
- Backlog-type states are not slots. A ticket there is parked or not yet chosen; nothing is offered for it and nothing is wrong with it.

## Aging

Age is time since `updated_at`, or since the lease started for a ticket in flight. Report it in human units. Compare it to the phase, not to a fixed number: a research phase and a merge wait have different natural durations, and the cloud's own retry backoff (the contract's `thresholds.retryBackoffMs`) explains many short waits.

## What counts as stuck

A ticket is **stuck** only when all three hold:

1. Nothing is offered for it: the queue lists it excluded, or `explain` gives a reason rather than a position.
2. The reason does not release itself. Backoffs, cooldowns that name a callback, and fleet-wide holds that clear when the cloud repins are waits, not stalls. The table in `references/why-is-it-stuck.md` marks which is which.
3. No one is acting on the release: no open ask names it, no human comment landed after the failure, no push arrived.

Everything else is **waiting**, and the reply says what it is waiting on. Calling a wait "stuck" sends the human to fix something the cloud is already handling.

## The signals the cloud posts on the ticket itself

Before declaring anything, read the ticket's comments (`catalyst-skills query issue <id>`; the `catalyst-linear` skill explains each shape). The cloud posts a phase-outcome card on every completion and failure, a remediate-attempt card per repair round, a board-health note when it detects a stall itself, and a merge-wait note when a merge is held. Those comments are the narrative; the per-ticket ledger behind them — attempts, rounds against the cap, park state — is `catalyst-skills explain --history <ticket>`, and the two must agree.

## Two things that look like work and are not

- A ticket carrying the ask marker label, or whose text reads as a decision request, is a question. It is excluded from dispatch by design and belongs in the waiting-on-human block.
- A ticket claimed by a worker outside the cloud (the local-lane label) is being worked, but not by Catalyst; report it as in flight elsewhere and do not chase the cloud for it.
