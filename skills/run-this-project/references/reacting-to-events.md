# Reacting to events

This reference restates invariants of the Catalyst Cloud stream and the `watch` verb. Nothing here varies per tenant; the tenant facts a reaction needs (stage ids, label ids, the ask team) come from `catalyst-skills contract` at the moment you need them.

## The mechanism

A steward never polls. It subscribes once to the tenant stream through the SDK's live client and reacts to each change as it arrives. The verb is `catalyst-skills watch`, and this skill's `scripts/watch-scope.mjs` is that verb with the scope checked up front:

```sh
node scripts/watch-scope.mjs --project <id>          # every ticket in the project
node scripts/watch-scope.mjs --team <key>            # every ticket on the team
node scripts/watch-scope.mjs --ticket ENG-41 --ticket ENG-42
```

The stream itself is tenant-wide; scope is filtered on this machine from each frame's entity and row, and a row that only carries a ticket reference (a comment, a session, a pull request) is resolved to its project through the ticket's own record, cached for the life of the watch. The cost of an ignored frame is one JSON parse, so a wide scope is fine.

**In Claude Code**, arm a monitor on the command above. Each line it prints is one applied change inside the scope, delivered into your session as an event. React to it in the same turn: read what changed, decide, act, and only then let the turn end.

**In Codex, OpenCode, or any harness without a monitor**, pass `--exec`:

```sh
node scripts/watch-scope.mjs --project <id> --exec 'node my-reaction.mjs'
```

The command runs once per frame with the frame on stdin. A non-zero exit is a failed reaction (see the cursor rule). Nothing polls in either shape.

## The frame

One JSON object per line, exactly what the SDK delivers:

```json
{"type":"change","accountId":"<tenant>","seq":4182,"entity":"comments","entityId":"<id>","op":"upsert","row":{...}}
```

`seq` is the tenant-wide position. `entity` is one of the mirror's feed tables. `op` is `upsert` or `delete`. `row` is the mirrored row when the op is an upsert; a delete carries the id only. A frame for another tenant is refused by the CLI and never printed.

## Entities that matter to a scope

| entity | what a change means | first reaction |
| -- | -- | -- |
| `issues` | a card moved, was retitled, re-prioritised, assigned, or created | if it moved into a stage the cloud owns, note the advance; if it moved out of the ladder by hand, ask why before touching it |
| `comments` | someone or something wrote on a ticket | a human comment in your scope is answered in-thread by you, tagged; a cloud outcome card (phase complete, phase failed, remediate attempt, board health, merge wait) is your execution signal, read it |
| `issue_labels`, `labels` | a label was added or removed | an ask label means a question, not work; a hold label means the cloud wants a human; the release label means a human cleared a false positive |
| `relations` | a blocks relation appeared or went away | a new blocker on your ticket is a dependency to chase; a blocker closing may make a card dispatchable again |
| `pull_requests`, `pr_events`, `pushes` | the branch and PR state changed | a PR going ready-for-review or merged is a milestone; a force-push after a resolved review thread is worth a look |
| `check_runs`, `check_suites`, `commit_statuses` | CI moved | red on a required check after the queue label wakes an automatic remediation; you watch, you do not re-run it |
| `reviews`, `pr_review_threads`, `pr_review_comments` | the reviewer spoke | unresolved threads block the merge; a clean pass is a reaction or a terse comment, not a review object |
| `agent_sessions`, `agent_activities` | a phase started, wrote an artifact, opened a PR, reported | the plan on the session is the ladder itself; the current phase is the one in progress |
| `fleet_activity`, `fleet_host_liveness` | a runner picked up or dropped a phase | a phase running is not a stall, whatever the clock says |
| `fleet_anomalies` | the cloud raised a fleet-level alert | one alert covers every ticket it touches; never escalate it per ticket |
| `workflow_states`, `team_workflow_mapping` | the tenant's stage map changed | refresh the contract (`catalyst-skills contract --refresh`) before the next state move |
| `projects`, `cycles`, `initiatives` | your scope's container changed | update the status summary |

Entities not listed still arrive when they are in scope; ignore what you do not need.

## The same-turn rule

A frame is reacted to in the turn it arrives, not batched for a later pass. The reaction is whatever the table above says plus anything the situation obviously needs, and it ends with the one status summary for the scope being current. If a reaction needs a human decision, file the ask through `what-needs-me` before proceeding on the default, in that same turn.

## The cursor rule

The cursor file (`~/.config/catalyst-cloud/watch-cursor.json`, stamped with the tenant) advances only after the reaction returns. A reaction that throws, or an `--exec` command that exits non-zero, leaves the cursor at the last good frame; the CLI closes the socket and the SDK's reconnect replays from that cursor, so the failed frame is offered again. Delivery is therefore at-least-once: make reactions safe to repeat (check before you write, prefer idempotent writes such as a label add over a fresh comment).

Two consequences. First, a crash mid-reaction replays, never loses. Second, a reaction that keeps failing keeps the watch pinned on one frame; fix the reaction rather than skipping the frame, or restart with `--from head` and re-read the scope with `scripts/scope-status.mjs` to catch up on what you missed.

## What to do on resync

When the tenant tells the stream it can no longer replay from your cursor, the CLI prints one line on standard error, `[watch] resync: cursor moved to head <n>`, and continues from the head. No rows are copied. Anything that happened between your old cursor and the head is not replayed, so a resync is your cue to run `scripts/scope-status.mjs` once and reconcile the summary against the live state.

## Starting a watch on an existing project

Start with `--from head` when you are picking up a project that has been running without a steward; the backlog of old frames is not worth replaying, and `scope-status.mjs` gives you the present state in one call. Start from the saved cursor (the default) when you are resuming your own watch after a break, so nothing that happened in between is lost.

## The honest limit

The stream carries the mirror's entity changes. It does not carry the relay ledger's phase failures, parks, remediate rounds or backoff timers as first-class frames. Until a tenant-facing execution-history route ships, you learn those from the outcome comments the cloud posts on the ticket, which do arrive as `comments` frames: a phase-failed card names the phase, the attempt and the failure class; a remediate-attempt card names the round; a board-health comment names a stall the cloud itself noticed. For the current verdict on any ticket, ask the explainer: `catalyst-skills explain <ticket>` turns the exclusion reason and the last failure into one paragraph. `catalyst-skills explain --history <ticket>` says, by name, that the history is not visible to an account key yet and where in settings a human can read it.
