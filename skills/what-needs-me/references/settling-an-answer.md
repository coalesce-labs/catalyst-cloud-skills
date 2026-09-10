# Settling an answer

This reference restates invariants: where an answer is posted, how it is recorded, and how held work is released. The routes and the bookkeeping marker are the contract's; `node scripts/settle.mjs` reads them through the CLI.

## The rule

The answer lives on the ask. Wherever it arrived (a comment on the ask, a comment on a held ticket, a chat message, a call), it ends as a comment on the ask ticket, and that comment is recorded as the accepted answer. Question, options, default, answer and who answered are then one record.

## The three steps

**1. Post the answer where it should live.** If the human answered in the ask's thread, nothing to do. If they answered anywhere else, post a comment on the ask that states the answer, as the app actor, never as the human, and attribute it in the text ("the owner answered in chat: option B"). Use the `catalyst-linear` skill's comment script; it returns the comment id. Do not paraphrase into a different option; quote what they said.

**2. Record it.** `node scripts/settle.mjs <ask> --answer <commentId> --role <role>` calls the cloud's ask-accept with the ask, the answering comment and the role doing the recording. The script first checks the comment is really on the ask (an id from a different ticket is refused before anything is written), then records, then reads the ask's blocking relations.

**3. Release the held work.** For every open ticket the ask blocks, the script posts one bookkeeping comment naming the ask, the comment id and the first line of the answer, so the next phase or agent on that ticket reads the decision without opening the ask. The comment carries the contract's bookkeeping prefix, which means the cloud's comment-wake trigger ignores it: a record, not a turn in a conversation. Pass `--no-release-note` to skip this when the held tickets are about to be canceled anyway.

With `--close`, the script also moves the ask to its team's done slot. The blocking relations stay on the record; a done ticket does not block anything, so the held tickets become dispatchable on the cloud's next pass. Close only when the answer is complete; an answer that raises a follow-up question keeps the ask open and the follow-up goes in the same thread.

## Free-text replies

A reply that names no option ("do whichever is cheaper", "ask me again Thursday") is recorded exactly as written. Nothing in the cloud or in this skill turns it into an option. Read it, decide whether it answers the question, and if it does not, reply in the thread with the one clarification needed and leave the ask open. If it does, settle with that comment as the answer and let the release note carry the quoted line.

## Who settles

The role that raised the ask, or the owner of the scope it belongs to. The desk settles asks that have no owner. The human never has to run anything; their part ends when they answer. Never settle another role's ask without saying so in the thread.

## After settling

- Tell the human, in one line, what was recorded and what it released.
- The held tickets need no further action from you: their exclusion reason was the blocking relation, and the queue recomputes on the cloud's next pass. If one stays excluded, `whats-happening` explains why.
- If the answer changes priorities or scope, that is a routing change for the project owner, not a second ask.

## When it cannot be settled

- The comment id is not on the ask: post the answer on the ask first, then settle with the new id.
- The write budget for the day is spent: the CLI names the budget from the contract and exits 2. Say so; the record waits, the human's answer is not lost.
- The ask is on a team the contract does not list: the tenant admin maps the team in settings; the `catalyst-setup` skill reads readiness.
