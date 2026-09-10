# Raising a decision

This reference restates invariants: what an ask is, when it is filed, and what it must carry. The body text, the headings, the option format and the cap on options are tenant facts served by the contract's `askTemplate` block and rendered by the cloud itself; `node scripts/raise.mjs` passes fields and never composes a heading.

## What an ask is

An ask is one decision only the human can make, filed as a ticket in the tenant's own Linear so that the question, the options, the default, the answer and who answered are one record the next agent can read. The cloud labels it as an ask, excludes it from dispatch (a question is never work), and holds every ticket it blocks until it is answered. It appears in the human's Waiting-on-me view when it is assigned to them and blocks open work.

## When to file one

File an ask when active work is gated on a product call, a priority call between two things that cannot both go first, an approval, or an action only the human can physically take (a click in settings, a credential, a payment). File it **before** proceeding on the default, never after, and never only as a TODO line, a board row, a handoff note or a chat question. Those may point at the ask's identifier; they never replace it.

Do not file one for brainstorming, a design back-and-forth, a question the human asked first, a retry-or-abandon call a project owner can make, or a system-level failure (a provider down, out of capacity, rate-limited: that is one status line, and the affected tickets retry on their own).

## What it carries

1. **The question**, one sentence, as the title (`--title`).
2. **Context** the human needs to answer without opening anything else (`--context`), short.
3. **Options**, each one line, realistic, at most the number the contract allows (`--option`, repeated). The cloud letters and formats them.
4. **The default if silent** (`--default`): what proceeds and after how long. It must be sane enough to actually run. Note that nothing in the cloud applies the default on a timer; the raising agent applies it, after the ask exists, and records that it did.
5. **What it blocks** (`--blocks`, repeated): every ticket held until the answer lands. The cloud creates the blocking relations atomically with the ticket. An ask that holds nothing is refused unless you say `--nothing-to-block` on purpose, because an ask with no blocking relation never surfaces in Waiting on me and is indistinguishable from ordinary work.

`--ask-key` is an idempotency key: a re-run with the same key does not file a second ask.

## One ask per decision

Run `node scripts/inbox.mjs` first and read the titles. When the same decision is already open, attach the new held tickets to it rather than filing again (the `catalyst-linear` skill adds the relation or a comment naming them). Duplicates split one decision's urgency across several rows and sink it below trivia in the ranking.

## Who raises, and where

- A decision inside a project scope is raised by that project's owner; the desk raises what has no owner.
- The ask is filed on the team the held work belongs to (`--team`), from the contract's team list. An approvals team, when the contract names one, is where an approval with no natural team goes.
- Never raise an ask on someone else's behalf about their own scope, and never answer one for the human.

## After filing

Cite the identifier the script printed, and only that. Proceed on the default if the work allows it, and say so in the ask's thread (a bookkeeping comment) so the record shows the default was taken. When the answer arrives, `references/settling-an-answer.md`.

## Ranking

The human sees asks ranked by how much open work each holds, weighted by that work's priority (urgent counts most), never by age. That is why `--blocks` must be complete: an ask that names one held ticket when it really holds a project sinks below a chore.
