# Making work ready

This reference restates invariants of how Catalyst takes work. The tenant's own values (which Linear state is the dispatch column, which state is the backlog, the ask and release label ids, the round cap and the park threshold) are read live from `catalyst-skills contract`; the scripts here never name a stage.

## The steward's two moves

Catalyst does not take work by being asked. It takes work by finding a card in the team's dispatch column and offering that card's next phase to a runner. So the steward's dispatch verb is a card move, and its stop verb is a card move:

```sh
node scripts/make-ready.mjs ENG-41            # move into the dispatch column; the cloud offers the next phase
node scripts/make-ready.mjs ENG-41 --park     # move into the team's backlog-type state; nothing further is offered
node scripts/make-ready.mjs ENG-41 --park --note "waiting on the vendor's API change"
```

Dispatch resolves the dispatch slot on the ticket's team from the contract. Parking resolves the team's first backlog-type state from its live workflow states, because the backlog is deliberately not one of the eleven slots. Those are the only two state moves you make. Every other stage move on a ticket in the ladder is the cloud's, written when a phase completes; moving a card forward by hand does not run a phase, it only confuses the advance table, and moving it backwards by hand does not undo one.

## What a dispatchable ticket carries

Before the move, the ticket needs, in the record itself:

- A title that states the outcome. A phase agent reads the ticket, not your chat.
- A description that says what done looks like: the behaviour, the constraints, the files or surfaces if you know them, acceptance criteria a validate phase can check.
- The right team. The team key is the ticket prefix, and the team's stage map and labels are what the cloud will use.
- A priority. Queue order inside a team is priority first, then creation time, then identifier, so an unset priority sorts last.
- No live blocking relation. A ticket with an open blocker is excluded as `blocked` until the blocker closes.
- No ask on it. A ticket that carries the ask label, or whose own text reads as a decision request (an ask-shaped title, lettered options, a "default if silent" line), is excluded as a question rather than work. If a real ticket trips the shape detector, a human applies the release label named in the contract's vocabulary; you can also rewrite the text so it reads as work.
- Declared scope when the team enforces it: a ticket whose declared files overlap a ticket already in flight is held as `scope_overlap` for the implement phase.

A ticket does not need a branch, a PR, or any artifact to be dispatched: the ladder creates those. A ticket that has never entered the ladder starts at intake when the tenant enables it, otherwise at research.

## After the move

`make-ready.mjs` asks the eligibility explainer as soon as the move lands and prints the verdict. Read it as follows:

- `offered` or `eligible` with a queue position: done; a runner will pick it up in the next dispatch pass, ordered by priority, then age, then identifier, with tickets already mid-ladder ahead of fresh ones.
- An ordering that is stale or never published: the cloud re-derives the team's queue within a pass of the move; ask again in a minute with `catalyst-skills explain <ticket>`.
- Any other exclusion reason: the paragraph names it and what releases it. The reasons and what unblocks each are in `how-catalyst-works` and in `whats-happening`'s "why is it stuck" reference.

## Evidence a phase ran

Do not infer progress from time passing. A phase leaves three kinds of evidence on the ticket, and a card move alone is not one of them:

1. **The outcome comment.** The cloud posts a card per phase: a completed phase names the phase, the attempt, and its artifact; a failed phase names the phase, the attempt, and the failure class, and may carry a park or hold block. A remediate round posts its own attempt card with the round number and the class it is repairing. These arrive as comment frames on the watch.
2. **The attachment and document.** Each artifact-bearing phase (research, plan, implement, validate, pr, remediate) is projected to a Linear document titled with the ticket, the phase, the attempt and the date, attached to the ticket, with a short link comment. Research and plan on a ticket with a project also appear as a project link.
3. **The agent session.** The ticket's agent session carries the ladder as its plan, with the phases before the current one completed, the current one in progress, and the rest pending; its activities are the phase start, the gate, artifacts written, the PR opened, and the report.

The card's stage is the fourth, weakest signal: a completed phase moves the card to the stage the advance table names, a failed phase writes no stage at all, and Done is written only when the pull request actually merges, by the merge webhook, never by a phase. A card sitting in a stage tells you which phase last finished, not whether the next one is running; `scripts/scope-status.mjs` shows running and leased phases beside the stage for exactly that reason.

## Parking, and what it does not do

Parking is the lever that stops the cloud offering more rounds on a ticket: moved out of the dispatch column and the ladder's stages, the ticket is excluded at the next offer. It does not kill a phase that is already running under a lease; that container finishes its phase, posts its outcome, and the next offer finds the card parked. If you park a ticket the cloud has itself parked (three consecutive failures, or the remediate round cap), record why in a bookkeeping note; releasing a cloud park is an operator action, not a card move, so that is an ask for a human with the ticket named as what it blocks.

Un-parking is the same dispatch move again. The counted attempts and rounds do not reset when a card comes back; the contract's thresholds say how many remain.

## What you never do to make work ready

- Never move a card into a research, plan, implement, validate, PR, done or canceled stage by hand to "skip ahead". The cloud reads those stages as the record of what ran.
- Never remove an ask label or apply the release label yourself; a human decides whether a ticket is a question.
- Never dispatch two tickets that touch the same files at once; serialise them or let the second one wait as `scope_overlap`.
- Never dispatch a ticket you have not read in full.
