# What Catalyst is, and the ladder

## In the person's terms

Use their repositories and tickets as examples. Moving a card into the team's dispatch column starts the work, and nothing else does. Each phase runs in a cloud container set up for the repository, on a coding account their workspace enrolled, and leaves a document and an outcome comment on the ticket, so the ticket is the record. Their laptop runs no coding sessions, and agents react to events rather than polling.

What changes in their day: they write each ticket for a reader who cannot see their chat (an outcome title, what done looks like, a priority, no open blocker). They leave working stages and Done to Catalyst. A draft pull request appears that a later phase marks ready, and a green one with no open threads merges through the queue unless a hold label keeps it out. A decision only they can make arrives as an ask in their own Linear, with options, a silent default and what it holds. A comment they post gets an eyes reaction and a threaded reply.

## The phases

The contract's `ladder` block (`node scripts/show-my-map.mjs`) says whether intake is on and which keying applies.

| phase | produces | notes |
| -- | -- | -- |
| `intake` | nothing (a classification pass) | optional, for a new ticket, when `ladder.intakeEnabled` |
| `research` | `research.md` | offered from the dispatch slot |
| `plan` | `plan.md` | |
| `implement` | `implement.md` | creates the branch, named exactly the ticket identifier, and opens a draft pull request |
| `validate` | `validation.md` | success moves the card to the review stage (verify and review share it) |
| `pr` | `pr.md` | first line is the PR title, then the body; rebases, force-pushes, marks the PR ready |
| `remediate` | `remediation.json` | an interrupt that repairs a failed phase; never advances past the PR slot |
| `merge` | a receipt | applies the queue-ready label once its evidence gate passes |

## What moves the card

The contract's `ladder.advance` maps each completed phase to a card move; its keying decides whether a stage names the phase just finished (trailing, the default) or the one ahead (leading). A failed phase, `remediate` and `merge` move nothing (`references/when-a-phase-fails.md`).

**Done is written by the merge.** GitHub's merged event moves the ticket to Done within seconds, with a sweep behind a dropped webhook, so a ticket not Done a minute after its PR merged is a finding, not a chore to hand-close. Done means merged; a separately deployed change is live only once deployed.

To place a ticket, its stage says which phase last finished (`node scripts/show-my-map.mjs --team <key>` translates it) and `explain` says what runs next.
