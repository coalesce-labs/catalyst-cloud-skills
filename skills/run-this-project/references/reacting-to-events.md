# Reacting to events

A steward subscribes once to the account's event stream and reacts to each change as it arrives. The verb is `catalyst watch`; `scripts/watch-scope.mjs` is that verb with the scope checked up front:

```sh
node scripts/watch-scope.mjs --project <id>
node scripts/watch-scope.mjs --team <key>
node scripts/watch-scope.mjs --ticket ENG-41 --ticket ENG-42
node scripts/watch-scope.mjs --project <id> --exec 'node my-reaction.mjs'   # a harness with no monitor
```

The stream is account-wide and scope is filtered on this machine, resolving comments, sessions and pull requests to their ticket's project; an ignored frame costs one JSON parse, so a wide scope is fine. In Claude Code, a monitor on the command delivers each printed line into your session. With `--exec`, the command runs once per frame with the frame on stdin, and a non-zero exit is a failed reaction.

## The frame

One JSON object per line, as the SDK delivers it:

```json
{"type":"change","accountId":"<account>","seq":4182,"entity":"comments","entityId":"<id>","op":"upsert","row":{...}}
```

`seq` is the account-wide position, `entity` a feed table, `op` is `upsert` (with the row) or `delete` (the id only).

## Entities that matter to a scope

| entity | what a change means | first reaction |
| -- | -- | -- |
| `issues` | a card moved, was edited, re-prioritised, assigned or created | a move into a cloud-owned stage is an advance; a hand move out of the ladder, ask why before touching it |
| `comments` | someone or something wrote on a ticket | answer a human comment in-thread, tagged; read a cloud outcome card (phase complete or failed, remediate attempt, board health, merge wait) as your execution signal |
| `issue_labels`, `labels` | a label changed | an ask label means a question; a hold label means the cloud wants a human; the release label means a human cleared a false positive |
| `relations` | a blocker appeared or went away | chase a new blocker; a closed one may make a card dispatchable |
| `pull_requests`, `pr_events`, `pushes` | the branch or PR changed | ready-for-review and merged are milestones; a force-push after a resolved thread is worth a look |
| `check_runs`, `check_suites`, `commit_statuses` | CI moved | a red required check after the queue label wakes an automatic remediation; watch it |
| `reviews`, `pr_review_threads`, `pr_review_comments` | the reviewer spoke | unresolved threads block the merge; a clean pass is a reaction or a terse comment |
| `agent_sessions`, `agent_activities` | a phase started, wrote, opened a PR, reported | the session's plan is the ladder |
| `fleet_activity`, `fleet_host_liveness` | a runner picked up or dropped a phase | a running phase is not a stall |
| `fleet_anomalies` | a fleet-level alert | one alert covers every ticket it touches |
| `workflow_states`, `team_workflow_mapping` | the stage map changed | `catalyst contract --refresh` before the next move |
| `projects`, `cycles`, `initiatives` | the scope's container changed | update the summary |

## The same-turn rule

React to a frame in the turn it arrives, and end the turn with the status summary current. A reaction that needs a human decision files the ask through `what-needs-me` in that same turn, before proceeding on the default.

## The cursor

The cursor file (`~/.config/catalyst-cloud/watch-cursor.json`) advances only after a reaction returns. A reaction that throws, or an `--exec` that exits non-zero, leaves it at the last good frame, and the reconnect replays from there. Delivery is at-least-once, so make reactions safe to repeat: check before writing, and prefer idempotent writes such as a label add. A reaction that keeps failing pins the watch on one frame; fix the reaction, or restart with `--from head` and re-read the scope with `scripts/scope-status.mjs`.

A resync prints `[watch] resync: cursor moved to head <n>` on standard error and continues from the head without replaying the gap: run `scripts/scope-status.mjs` once and reconcile. Start with `--from head` when taking over a project that ran without a steward; resume from the saved cursor (the default) after your own break.

## The honest limit

The stream carries the mirror's entity changes, not the relay ledger's failures, parks, rounds or backoff timers as frames. Those arrive as the cloud's outcome comments, and `catalyst explain <ticket>` gives the current verdict; `--history` adds the attempts, rounds against the cap, and any park with what releases it.
