# The ladder: eight phases, what each one produces

This reference restates invariants. The phase order and what each phase leaves behind do not vary per tenant. The only live values are whether intake is switched on for your tenant and which keying the advance table uses; both are on the contract under `ladder` (print them with `node scripts/show-my-map.mjs`).

## The phases, in order

| Phase | What it produces | Notes |
| -- | -- | -- |
| `intake` | nothing projected (a classification pass) | Optional head. Offered only to a ticket that has never entered the ladder, and only when the contract says `ladder.intakeEnabled` is true. |
| `research` | `research.md` | The first ladder phase. Offered when the card sits in the team's dispatch slot. |
| `plan` | `plan.md` | |
| `implement` | `implement.md` | Creates the ticket branch (named exactly the ticket identifier) and opens a draft pull request. |
| `validate` | `validation.md` | Its success moves the card to the team's review stage; verify and review are two slots that both land on that stage. |
| `pr` | `pr.md` | The first line is the pull-request title, then a blank line, then the body. The phase rebases onto the default branch, force-pushes, writes the title and body, and marks the PR ready for review. |
| `remediate` | `remediation.json` | An interrupt, not a step forward. It repairs a phase that failed and never advances the card past the PR slot. |
| `merge` | a receipt, no artifact | Applies the queue-ready label once its evidence gate passes. It writes no board state. |

Every artifact-bearing phase (all but `intake` and `merge`) projects its artifact into Linear as a document attached to the ticket, with a short link comment; `catalyst-linear` describes those shapes.

## What moves the card

An advance table maps a phase outcome to a card move: research done moves the card from the dispatch slot to the research slot, plan done from research to plan, implement done from plan to implement, validate done from implement to review, pr done from review to pr. The table is served on the contract as `ladder.advance` so you can read the exact rows; do not restate them from memory, because the tenant's keying decides whether a stage names the phase that just finished (trailing, the default) or the phase still ahead (leading).

Three rows never move the card:

- A **failed** phase writes no board state. The ticket stays where it was, retryable, and the failure handling in `references/when-a-phase-fails.md` takes over.
- **`remediate` done** writes nothing by itself; the card restores to its exact pre-failure stage once a remediation round succeeds.
- **`merge` done** writes nothing. The receipt only ever meant "the queue-ready label was applied".

## Done is written by the merge, never by a phase

The terminal move to the done slot is keyed to the real pull-request-merged event from GitHub, not to any phase receipt. When the PR merges, the mirror's own ingest path moves the ticket to Done within a few seconds, with no session and no human sweep, and a bounded periodic sweep backstops a dropped webhook. So:

- A ticket still not Done a minute after its PR merged is a finding, not a chore to hand-close.
- Done is not the same as live. A change to something that is deployed separately is inert until that deployment happens; the ticket state says the code merged, nothing more.

## How to read a ticket's position on the ladder

1. The card's stage tells you which phase last finished (under trailing keying) — read the team's map with `node scripts/show-my-map.mjs --team <key>` to translate a stage name into a slot.
2. The phase-outcome comments on the ticket tell you which attempts ran and how they ended; the document attachments are the artifacts themselves.
3. `node scripts/explain-ticket.mjs <ticket>` tells you what the cloud will run next, or why it will not.
