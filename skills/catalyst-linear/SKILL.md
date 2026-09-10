---
name: catalyst-linear
description:
  Catalyst's view of Linear on the customer's own tenant. Reads a ticket with its comments, relations, labels, linked pull requests and agent sessions inline, from the local replica when it is fresh and the origin-fresh API otherwise, always naming the source; searches tickets, PRs, projects and initiatives; writes comments, card moves, labels and new tickets through the tenant's agent proxy as the app actor, with every route, stage id, label id and marker read from the tenant contract. Knows what a ticket accumulates as Catalyst works it (phase-outcome comments, the document per phase, the agent session, the labels, the single blocks relation, the bookkeeping marker, the eyes acknowledgement). Use when a person says "show me the ticket", "what did Catalyst write on it", "comment on it", "move it", "label it" or "file a ticket". Not for raising a decision for a human (what-needs-me) and not for pull requests (catalyst-github).
allowed-tools: Bash(catalyst-skills:*) Bash(npx @catalyst-cloud/catalyst-skills:*)
disable-model-invocation: true
---
<!-- vendored-from: @catalyst-cloud/catalyst-skills — written in this repository for customer tenants -->

# Catalyst Linear

You read tickets and write to them on the customer's tenant, as Catalyst. Reads come from the replica when it is fresh, else from the API, and every read names its source. Writes go through the tenant's agent proxy as the app actor, with routes, stage ids, label ids and the bookkeeping marker resolved from the tenant contract by the `catalyst-skills` CLI. You never compose a URL, never name a stage by its display name, and never quote a label id or marker from memory.

## Run first

Run each with `--help` first; scripts are executed, never read.

- `node scripts/read-ticket.mjs <ticket> [--comments]` — one ticket, everything inline, source line on stderr.
- `node scripts/search.mjs <terms>` — tickets, PRs, projects, initiatives matching the terms.
- `node scripts/comment.mjs <ticket> --body <text> [--parent <id>] [--bookkeeping]` — a comment as the app actor; a machine record takes `--bookkeeping`.
- `node scripts/move.mjs <ticket> --slot <slot>` — a card move by slot (`--state-type backlog` parks).
- `node scripts/label.mjs <ticket> --add <name> --remove <name>` — labels, resolved through the contract.
- `node scripts/create-ticket.mjs --team <key> --title <text>` — a new ticket; cite its identifier only after it prints.

Exit codes: 0 done, 1 not found or a usage error, 2 this machine is not connected or the write was refused (budget spent, slot unmapped, label absent; the one line printed says which).

## Load on demand

| when | read |
| -- | -- |
| "what did Catalyst write on this ticket?", a comment shape, a label, the marker, the 👀 | `references/what-a-ticket-accumulates.md` |
| before any read you will report on; "is this current?"; citing; searching | `references/reading-a-ticket.md` |
| before any comment, move, label or new ticket; identity, budget, slots, ids | `references/writing-to-linear.md` |

## Rules

- **Read before acting.** Never summarise a ticket from its title; read the description and the thread. Cite identifiers and comment ids only after a script printed them.
- **Name the source.** Quote the source line when freshness matters; a stale replica is never read silently, because the CLI falls back to the API and says so.
- **Reply where it arrived, as Catalyst.** Thread under the comment you answer (`--parent`); never post as the human.
- **Records carry the marker.** A merge note, a state-move log, a chain summary: `--bookkeeping`, so it never reads as a human turn. A real question is not bookkeeping.
- **Move by slot, label by contract.** A stage name is display; the id is the authority, and the CLI resolves both. Moving to `dispatch` dispatches; the backlog-type state parks.
- **A decision is an ask, not a ticket.** Raise it through `what-needs-me` with options, a default and what it blocks; a question filed as a ticket is held out of dispatch by shape.
- **One write per need, no loops.** Writes spend a daily budget the contract names; batch, and report a refusal rather than retrying.
