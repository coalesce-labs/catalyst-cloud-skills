# The one-reply shape

This reference restates an invariant of this skill: how a status answer is shaped. The facts inside it come live from `node scripts/snapshot.mjs` and `node scripts/explain.mjs`; the machine-readable schema is `assets/status-reply.json`.

## The rule

The person asked one question and gets one reply. If they would need a second surface, a second message, or a follow-up question from you to know where things stand, the reply is wrong. Every line names a ticket identifier. Nothing in the reply is a guess: a fact you could not read is named as unreadable, with where it lives.

## The five blocks, in this order

1. **In flight.** Tickets a phase is running on right now, or that hold a live lease mid-ladder. Source: the snapshot's `running` block (fleet activity, the agent roster, lease attributions). One line per ticket: identifier, the phase running, how long it has run.
2. **Blocked, and on whom.** Tickets nothing is offered for. Source: the queue's excluded rows, then `explain` on each one the person cares about. Every line carries the reason in the person's words and who releases it: the human (an ask), a role, the cloud itself (a backoff, a park that self-releases), or a clock. "On whom" is never blank; if you cannot tell, say the reason the cloud gave and that the release is unknown to a key.
3. **Waiting on the human.** The open asks, ranked by what each one holds. Source: `waitingOnHuman` in the snapshot. Keep this to identifier, the question, and what it releases; the `what-needs-me` skill owns the detail and the settling.
4. **Closed.** What reached the done slot in the window the person asked about (or since your last reply). Source: `query issues` filtered by the team's done-slot stage name from the contract, or the change feed for a time window. When you did not read a window, say "since my last reply" and mean it.
5. **Next.** What the queue picks up next, in the cloud's order, with the phase each will run. Source: the snapshot's `queue` block. Do not reorder it to what you think should be next; the levers are in `references/reprioritising.md`.

A sixth block, **cannot see**, appears only when it is non-empty: the facts an account key cannot read yet (coding-account status, per-ticket execution history), each with the URL the CLI printed.

## The header line

The reply opens with one clause that says when and from where: the snapshot's `takenAt` and its source line. When the replica was stale or absent, the reply says the numbers came from the API; when it was fresh, it says the cursor. This is not decoration. A stale source that goes unmentioned is the way a wrong status reply happens.

## Writing the lines

- Identifier first, then the stage as the contract spells it for that team, then one clause. `KEY-123 · <stage name> · implement running 14 min`.
- Age in human units (minutes, hours, days), from `updated_at` or the lease's start, never a raw timestamp.
- A reason is the translation from `references/why-is-it-stuck.md`, not the cloud's snake_case token, unless the token is one the table does not know, in which case quote it as the cloud spelled it.
- No adjectives about health. "Stuck" has a definition (`references/reading-the-board.md`); use it only when it applies.

## What the reply never does

- It never restates a stage name, threshold or label from memory. The snapshot's `tenant` block carries the live values; read them there each time.
- It never answers an ask, proposes a default on the human's behalf inside the status reply, or moves anything. Routing a request is `references/routing-work.md`; a decision is the `what-needs-me` skill.
- It never pads a short answer. When one ticket is in flight and nothing is blocked, the reply is three lines.
