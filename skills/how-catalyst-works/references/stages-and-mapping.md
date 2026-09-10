# Stages and mapping: eleven slots, five that matter, and how to read this team's map

This reference restates invariants (the slot vocabulary, which slots are load-bearing, the allowed state types, the three mapping modes). Everything about YOUR team — which Linear stage each slot maps to, its name, its type, whether it still exists — is live on the contract under `teams[].stages`. Read it with `node scripts/show-my-map.mjs [--team <key>]`; never quote a stage name or id from memory.

## The eleven slots, in pipeline order

`dispatch`, `intake`, `research`, `plan`, `implement`, `remediate`, `verify`, `review`, `pr`, `done`, `canceled`

A slot is Catalyst's name for a position on the board. A stage is the Linear workflow state your team actually has. Mapping is the per-team table that binds each slot to one stage.

## Five slots are load-bearing

| Slot | Why it matters | Allowed Linear state types |
| -- | -- | -- |
| `dispatch` | Moving a card here is how work is dispatched. Nothing is offered from any other column. | `unstarted`, `backlog` |
| `intake` | Where a never-seen ticket lands for the optional intake pass. | `unstarted`, `backlog` (never Linear's reserved triage type) |
| `pr` | Where a card must sit for `merge` to be offered. | `started` |
| `done` | Written by the merge webhook. | `completed` |
| `canceled` | Terminal; a card here is never work. | `canceled` |

An absent or wrongly-typed mapping on one of these five is a distinct silent failure: the ladder simply never moves. The other six slots are informational — a wrong value costs a warning in readiness, not a stall. That asymmetry is why "map my stages" is a five-field decision.

## Three mapping modes

The contract's `teams[].workflowMode` reports which one a team is in:

- **adopted**: Catalyst created its recommended stage set for the team, one stage per slot, with verify and review sharing one validation stage.
- **mapped**: the team kept its existing stages and a human chose which stage fills each slot.
- **mixed**: some slots adopted, some hand-chosen.

`teams[].gitAutomation` is a separate switch, off by default, because enabling it can delete a team's own review automation in Linear; it is never bundled into "adopt recommended".

## The state id is the authority; names are display

Each mapped stage carries a `stateId`, a display `name`, a `type`, `stateStillExists` and a `source` (how the mapping was chosen). Only the id is a lookup key. A Linear-to-Linear import can preserve every human-readable name while re-minting every state id, and then a name-based lookup points at nothing. So:

- Move cards by slot (`catalyst-linear`'s move script does this) and let the CLI resolve the id from the contract. Never move a card "to Todo" by name.
- `stateStillExists: false` means the mapped state is provably gone; the map needs fixing in your tenant settings before that slot can be written to. The CLI refuses such a move rather than guessing.
- The stage names the contract shows come from the mirror's live view of Linear, not from a stored snapshot, so they are current at read time.

## How to read the printed map

`node scripts/show-my-map.mjs` prints, per team, one row per slot: the slot, the stage name (or `(unmapped)`, or `(state gone)`), the state type, whether the state still exists, and the source. Load-bearing slots are starred. Then the team's ask, hold and release labels with `(absent)` where the workspace has no such label, then the ladder (phases, keying, intake on or off) and the live thresholds.

Reading it for a question:

- "Why does nothing dispatch?" — is `dispatch` mapped, does its state still exist, and is the card actually in that stage? `node scripts/explain-ticket.mjs <ticket>` names `not_at_dispatch_stage` when the card is elsewhere.
- "Why is merge not running?" — is the card in the `pr` slot's stage?
- "Why did the card go to Remediate?" — `remediate` is mapped, so a failed phase moved it there (see `references/when-a-phase-fails.md`); if `remediate` is unmapped the same episode shows up as the hold label from `teams[].labels.hold` instead.
- "The team's Backlog is not in the list" — correct. Backlog is not a slot. Parking a card is a move to the team's backlog-type state, which the CLI resolves from the team's live workflow states rather than from the map.

## Readiness over the mapping

The contract carries a ten-check readiness vector per team (`teams[].readiness`), including whether every mapped state exists, whether the mapping is total, whether the types are compatible, whether the labels are present, whether writes land and whether the webhook covers the team. A check the cloud could not run is `unknown`, never `pass`. `am-i-set-up` reads this vector; this skill only points at it.
