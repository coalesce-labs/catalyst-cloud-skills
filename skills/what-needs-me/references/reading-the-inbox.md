# Reading the inbox

This reference restates invariants: what "waiting on me" means, how declared and inferred asks differ, and how to present the queue. The label that marks an ask, its prefix, and the release label are the contract's `vocabulary`; `node scripts/inbox.mjs` reads them from the CLI and never from prose.

## What waiting-on-me means

The tenant's own Waiting-on-me view lists a ticket for a person when all four hold:

1. it is **assigned** to that person;
2. it has **no delegate** (a ticket delegated to an agent is the agent's, not the human's);
3. it is still **open**;
4. what it **blocks** reaches open work: at least one ticket it holds is itself not done or canceled.

A ticket that carries the ask marker label and is assigned to the person shows even with zero blocks. That is the **declared** ask. The four-part rule above is the **inferred** one, and the view offers both modes: asks only (the default) and everything the person is holding up, minus items an open unblock ask already covers.

So an ask that holds nothing is real, but the person may never see it in their own view. `inbox.mjs` lists such asks last and marked, so you can attach the work they should block.

## What the script reads

`catalyst-skills ask list` reads the open tickets carrying the team's ask label (by the label ids and prefix the contract serves), follows each one's blocking relations to the tickets it holds, drops held tickets that are already terminal, and scores the rest by priority weight: urgent 4, high 3, medium 2, low 1, none 1. It filters to **the connected person** by default: `login` recorded who they are and their Linear user id, and the list keeps only asks assigned to that id. `--anyone` lists the whole tenant. The JSON answer carries a `scope` — `mine` (with the label and Linear id), `anyone`, `unmatched` (the person's Linear identity is not matched yet: an admin does that in Settings → Members, and until then the whole list is shown with a stderr line saying so), or `no-person` (the machine is connected with the tenant's account key, which names nobody: the whole list, with a line saying to log in with a personal key). Read the scope before presenting the list, and say which you got: "what needs me" is the `mine` list, "what needs anyone" is `--anyone`, and an empty `mine` list names the wider count so it never reads as "nothing needs anyone".

## Presenting the queue

- Ranked by score, highest first. Never by age, never by identifier. An ask that holds a project outranks one that holds a chore, whatever their dates.
- One line per ask: rank, identifier, what it holds (identifiers), the question. The human decides from the question and the held work, so both must be on the line.
- Asks that hold nothing come after a break, marked as not visible in Waiting on me until they block something.
- When the list is empty, say "nothing needs you" and stop. Do not pad it with suspected asks.
- A ticket `explain` flagged as `ask_shape_suspected` (its text reads as a decision but it carries no ask label) is mentioned separately with a question mark: it is either an ask the human should label, or a false positive they release with the release label the contract names.

## What the inbox is not

- It is not the dispatch queue. Held tickets are excluded from dispatch by their blocking relation; answering the ask releases them into the ordinary order.
- It is not a place to answer. Nothing in this skill picks an option, closes an ask on the human's behalf, or posts in their voice. When they answer in chat, `references/settling-an-answer.md`.
- It is not a stall detector. A ticket parked by repeated failures, a merge hold, or a coding-account wall is a status question for `whats-happening`, not a decision until someone makes it one by raising an ask.

## Free-text and interpreted replies

A human reply that names no option is recorded by the cloud and interpreted for display, but never auto-applied and never written back to Linear as a decision. Treat it the same way: read it, ask the human to confirm which option it means if that is unclear, and settle only once a comment on the ask states the answer.
