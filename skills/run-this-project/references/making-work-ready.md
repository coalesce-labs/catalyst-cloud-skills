# Making work ready

Catalyst takes work by finding a card in the team's dispatch column and offering its next phase to a runner. So the steward's dispatch and stop verbs are both card moves:

```sh
node scripts/make-ready.mjs ENG-41            # into the dispatch column
node scripts/make-ready.mjs ENG-41 --park     # into the team's backlog-type state
node scripts/make-ready.mjs ENG-41 --park --note "waiting on the vendor's API change"
```

Dispatch resolves the team's dispatch slot from the contract; parking resolves the team's first backlog-type state from its live workflow, since the backlog is not a slot. Every other stage on a ticket in the ladder is the cloud's record of what ran: a hand move forward runs nothing, and a hand move back undoes nothing.

## What a dispatchable ticket carries

A phase agent reads the ticket, not your chat. Read it in full, then check it has:

- a title stating the outcome, and a description of what done looks like (behaviour, constraints, files or surfaces, acceptance criteria validate can check);
- the right team (the prefix; its stage map and labels are what the cloud uses) and a priority (unset sorts last);
- no live blocking relation, which excludes it as `blocked`;
- no ask: an ask label, or text that reads as a decision request, excludes it as a question. A human applies the contract's release label to a false positive; you can rewrite the text so it reads as work;
- declared scope when the team enforces it, and no file overlap with a ticket in flight (`scope_overlap`). Serialise two tickets that touch the same files.

It needs no branch, PR or artifact; the ladder makes those, starting at intake when the account has it on, else research.

## After the move

`make-ready.mjs` prints the explainer's verdict. A queue position means a runner will pick it up in order. A stale or unpublished ordering is re-derived within a pass; ask again in a minute with `catalyst explain <ticket>`. Any other reason is in the `whats-happening` skill's `references/why-is-it-stuck.md`.

## Evidence a phase ran

Time passing proves nothing. A phase leaves three kinds of evidence on the ticket:

1. **The outcome comment.** Per phase: the phase, the attempt, and its artifact, or on failure the failure class and any park or hold block. A remediate round posts its own card with the round number. These arrive as comment frames.
2. **The document.** Each artifact-bearing phase attaches a Linear document with a short link comment.
3. **The agent session.** Its plan is the ladder, with the current phase in progress; its activities are the phase start, the gate, the artifacts, the PR, and the report.

The card's stage is the weakest signal: a completed phase moves it, a failed one writes nothing, and Done is written only when the pull request merges. `scope-status.mjs` shows running and leased phases beside each stage for that reason.

## Parking

Parking stops the cloud offering further rounds: the card is excluded at the next offer. A phase already running under a lease finishes and posts its outcome first. Un-parking is the dispatch move again, and counted attempts and rounds carry over. A cloud park (three consecutive failures, or the round cap) is not a card move: once its cause is fixed, the `unstick` skill releases it with `catalyst release <ticket>`, and only a refusal that names a person's action becomes an ask. When you park a ticket the cloud already parked, record why in a bookkeeping note.

Ask labels and the release label are a human's call; leave them as you find them.
