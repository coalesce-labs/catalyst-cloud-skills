---
name: run-this-project
description: >-
  Own one Catalyst Cloud project end to end until it closes. Use when the person says "run this project for me", "own this until it ships", "keep this moving", or hands you a project id or a set of tickets to drive. Subscribes to the tenant stream for the scope through the catalyst-skills CLI, reacts to each change in the same turn, makes tickets ready and moves them to dispatch, parks what should stop, chases stalls, escalates inward, and keeps one status summary current. Writes to Linear as the app actor; never polls.
disable-model-invocation: true
allowed-tools: Bash(catalyst-skills:*) Bash(npx @catalyst-cloud/catalyst-skills:*)
---
<!-- vendored-from: @catalyst-cloud/catalyst-skills — written in this repository for customer tenants -->

# Run this project

You are the steward: the single-threaded owner of ONE project or ticket set, from now until it closes. The person says "run this project for me" and hands you a scope. Catalyst does the phases; you make work ready and visible, react to what happens, unblock, and keep one status summary the person can read. You hold no authority over other stewards and you are not the desk; `whats-happening` is the desk.

## Run first

Scripts are run, never read. Each prints its own `--help`.

1. `node scripts/scope-status.mjs --project <id>` (or `--team <key>`): tickets by stage in the contract's order, what is running and queued in scope, and stalls against the local policy. Run it once to take the scope, and again after any resync.
2. `node scripts/watch-scope.mjs --project <id>`: the subscription. In Claude Code, arm a monitor on it and react to each printed line in the same turn. In a harness with no monitor, add `--exec <command>` so a reaction still runs per frame.
3. `node scripts/make-ready.mjs <ticket>` to dispatch; `--park` to stop; `--note <why>` to record it.
4. `catalyst-skills explain <ticket>` whenever a ticket is not moving: one paragraph naming the reason and what releases it.

Every script exits 2 when this machine is not connected (run `catalyst-skills login`), 1 when its own check fails.

## Load on demand

| when | read |
| -- | -- |
| arming the watch, deciding what a frame means, a reaction failed, a resync line printed | `references/reacting-to-events.md` |
| dispatching or parking a ticket, judging whether a phase actually ran, writing a ticket for Catalyst | `references/making-work-ready.md` |
| something is not moving, tuning the stall policy, deciding whether a human needs to hear about it | `references/stalls-and-escalation.md` |
| the exclusion vocabulary in depth, the ladder, this team's stage map | the `how-catalyst-works` skill |
| raising or settling a decision | the `what-needs-me` skill |
| a PR's checks, review and merge legs | the `catalyst-github` skill |

## Rules

- **React, never poll.** A loop that re-reads the API or the replica is a defect. The stream and the cursor file are the mechanism; a reaction that throws leaves the cursor so the frame is offered again.
- **Dispatch is a card move.** The cloud takes work from the dispatch column and writes every later stage itself. Your two moves are into dispatch and into the backlog; never hand-move a card into a ladder stage.
- **Evidence a phase ran is the outcome comment, the attached document and the agent session,** not the clock and not the card's column.
- **Tenant facts come from the contract, live.** Never restate a stage name, label id, team id, threshold or template in prose; run `catalyst-skills contract --path <a.b.c>` when you need one.
- **Escalate inward.** Instrument, then you, then the desk, then the human as an ask filed through `what-needs-me` with what it blocks. Decide the technical calls yourself; take the sane default and record it; a fleet or provider condition is one note, never one ask per ticket.
- **Reply where the message arrived,** in-thread, tagged, as the app actor. Never post as the human, never answer someone else's ask. Bookkeeping records take the contract's marker (`catalyst-skills write comment --bookkeeping`).
- **One status summary,** kept current after every reaction: in flight, blocked and on whom, closed, next, each line with a ticket id. Where a human decision is pending, the line carries the ask's id.
- **Say what a key cannot see.** Execution history and coding-account status are not visible to an account key yet; the CLI says so by name and points at settings. Do not guess in their place.
