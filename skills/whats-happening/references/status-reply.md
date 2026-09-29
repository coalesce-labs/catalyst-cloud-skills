# The one-reply shape

One question gets one reply, complete enough that the person needs no second surface. Every line names a ticket identifier, and a fact you could not read is named as unreadable, with where it lives.

Open with one clause: the snapshot's `takenAt` and its source (a fresh replica's cursor, or the API and why). Then the blocks, in order:

1. **In flight.** From the snapshot's `running` block: identifier, the phase running, how long.
2. **Blocked, and on whom.** The queue's excluded rows, with `explain` on the ones the person cares about. Every line carries the reason in the person's words and who releases it: the person, a role, the cloud itself, or a clock.
3. **Waiting on the human.** `waitingOnHuman` in the snapshot, ranked by what each ask holds: identifier, the question, what it releases. `what-needs-me` owns the detail.
4. **Closed.** What reached the done slot in the window asked about (`query issues` by the done-slot stage name, or the change feed); with no window read, "since my last reply".
5. **Next.** The snapshot's `queue` block in the cloud's order, with each ticket's next phase.
6. **Cannot see**, only when non-empty: PR labels and reactions (not mirrored), each with the URL the CLI printed. A flow number goes here by name: cycle time, throughput, or how long pull requests have been open are not computed by anything a key reads, so say they are not computed rather than counting ticket dates.

## Writing the lines

- Identifier first, then the stage as the contract spells it, then one clause: `KEY-123 · <stage name> · implement running 14 min`.
- Age in human units from `updated_at` or the lease start, judged against the phase's natural duration.
- A reason is its translation from `references/why-is-it-stuck.md`. One ticket in flight and nothing blocked is a three-line reply.

## Reading the board

`node scripts/snapshot.mjs --board` groups open tickets by stage in slot order; read it by slot, never by name. A long dispatch column with nothing in flight is a capacity or eligibility question: `explain` the first row. A card that has not moved is running, retrying in place, or in remediate, which is an interrupt to count separately, never progress. An ask-labelled ticket belongs in the waiting-on-human block; a local-lane ticket is in flight elsewhere. The ticket's comments (`catalyst-linear`) and `catalyst explain --history <ticket>` must agree.

## What counts as stuck

A ticket is **stuck** only when all three hold:

1. Nothing is offered for it: the queue excludes it, or `explain` gives a reason rather than a position.
2. The reason does not release itself (`references/why-is-it-stuck.md` marks which do).
3. No one is acting on the release: no open ask names it, and no human comment or push landed after the failure.

Everything else is **waiting**, and the reply says on what; calling a wait "stuck" sends the human to fix what the cloud is handling.

The reply answers no ask, proposes no default for the human, and moves nothing: requests go to `references/routing-work.md`, decisions to `what-needs-me`.
