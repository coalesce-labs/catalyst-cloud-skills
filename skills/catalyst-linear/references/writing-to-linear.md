# Writing to Linear: identity, budget, slots, labels

This reference restates the write mechanism. The live values it depends on — the route table, the daily write budget, the stage map, the label ids — are read by the CLI from the contract (`routes`, `thresholds`, `teams[].stages`, `teams[].labels`) on every write. Nothing here is a literal to copy.

## Every write is one script

| Want | Run |
| -- | -- |
| a comment, threaded or top-level | `node scripts/comment.mjs <ticket> --body <text> [--parent <commentId>] [--bookkeeping]` |
| a card move | `node scripts/move.mjs <ticket> --slot <slot>` or `--state-type backlog` |
| a label on or off | `node scripts/label.mjs <ticket> --add <name> --remove <name>` |
| a new ticket | `node scripts/create-ticket.mjs --team <key> --title <text>` |
| a decision for a human | not here: the `what-needs-me` skill raises an ask with options, a default and what it blocks |

Each script wraps one `catalyst-skills write` verb, which posts to the route the contract names, as the tenant's app actor, with the personal key this machine connected with — so the write carries the person's identity for attribution, and an ask names them. No script composes a URL, and none needs a Linear credential of its own.

## App actor versus personal identity

Every write goes out as the tenant's Catalyst app actor by default. That identity is what the cloud's own comment-wake trigger recognises as "not a human", so an app-actor comment never wakes an agent to reply to it, never needs the bookkeeping marker to be safe, and reads to the human as Catalyst speaking. `--as-user` switches a comment or a new ticket to the personal identity behind the key; use it only when the human asked for that attribution, and then mark any machine record with `--bookkeeping`, because on that path the record is indistinguishable from the human typing it.

Reply where the message arrived: a comment inside a thread is answered with `--parent <commentId>`, in that thread, and never as a new ticket. Never post as the human; you speak as Catalyst, or as yourself by role.

## The daily write budget

Every write route spends one unit of a per-host daily budget the contract publishes as `thresholds.hostDailyWriteBudget`; a label call spends one unit whatever the label count; reads spend none. When the budget is spent, the CLI refuses with exit 2 and a line that names the budget and the retry time. Do not retry in a loop; report it, and batch what you can into fewer writes (one comment, not five).

## State moves are by slot, never by name

`--slot <slot>` names one of the eleven slots; the CLI resolves it to this team's live state id from the contract. It refuses when the slot is unmapped for the team, and when the mapped state no longer exists in Linear (the map needs fixing in tenant settings first). Moving to `dispatch` is how work is dispatched; nothing is offered from any other column. Backlog is not a slot: `--state-type backlog` resolves the team's first backlog-type state from its live workflow states, and moving a card there parks it and stops remediation rounds. A move never fabricates a state id, and a move by stage name is not offered because names are display fields that survive re-imports while ids do not.

## Labels are by contract id

A name the contract lists for the team (the ask marker, the hold label, the release label) resolves to that team's preferred id; when the workspace has no such label the CLI refuses rather than inventing one. Any other value is sent as a label id as given, so a label outside Catalyst's own set needs its id, which the ticket record's `labels[]` shows.

Two labels are a human's, not yours: the release label (which frees a ticket the shape detector held) is applied by a human; the hold labels on a pull request are `catalyst-github`'s subject.

## A new ticket takes the team key

`create-ticket.mjs --team <key>` names the team by the prefix its identifiers carry; the CLI resolves the team id from the contract and the cloud fences the write to your tenant on the team, not only on the credential. Cite the identifier only after the script prints it; a guessed number is usually a real, unrelated ticket. Do not file a question for a human this way: a ticket whose text reads as a decision request is held out of dispatch by shape until someone releases it, and it would never reach the human's inbox with what it blocks.

## What is never offered

Delegation (assigning a ticket to an agent) is an operator action, not a tenant write. Answering an ask on the human's behalf is not a write you make; the human answers, and `what-needs-me` records the acceptance. Editing another actor's comment is not available.
