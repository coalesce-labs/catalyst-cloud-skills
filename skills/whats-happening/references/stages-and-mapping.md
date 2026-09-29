# Stages and mapping

A **slot** is Catalyst's name for a position on the board; a **stage** is the Linear workflow state a team has; the **mapping** binds each slot to one stage per team. Every team's live map is on the contract under `teams[].stages`; `node scripts/show-my-map.mjs [--team <key>]` prints it with the load-bearing slots starred.

The slots, in pipeline order: `dispatch`, `intake`, `research`, `plan`, `implement`, `remediate`, `verify`, `review`, `pr`, `done`, `canceled`.

## Five slots are load-bearing

| slot | why it matters | allowed state types |
| -- | -- | -- |
| `dispatch` | moving a card here dispatches work; nothing is offered from any other column | `unstarted`, `backlog` |
| `intake` | where a never-seen ticket lands for the optional intake pass | `unstarted`, `backlog`, never Linear's triage type |
| `pr` | a card must sit here for `merge` to be offered | `started` |
| `done` | written by the merge webhook | `completed` |
| `canceled` | terminal; never work | `canceled` |

An absent or wrongly typed mapping on one of these stops the ladder silently (on the others it costs a readiness warning): until dispatch, pr, done and canceled each point at a live stage, Catalyst starts nothing in that team, and `explain` says so. `teams[].gitAutomation` is a stored consent for a feature not built yet; nothing reads it, so its value neither stops nor starts work.

`teams[].workflowMode` is **adopted** (Catalyst created the stages), **mapped** (a human chose each) or **mixed**. Mappings live at `<their cloud>/settings/linear-teams`; `.catalyst/catalyst.toml` has no stage section.

## The state id is the authority

Only a stage's `stateId` is a lookup key, because a Linear import can keep every name while re-minting every id. Move cards by slot (`catalyst-linear` does) and let the CLI resolve the id. `stateStillExists: false` means the team needs re-mapping (`catalyst team map <KEY>`) before that slot can be written; the CLI refuses the move.

Backlog is not a slot: parking a card moves it to the team's backlog-type state, which the CLI resolves from the live workflow. Readiness over the mapping, and who fixes each check, is the `catalyst-onboard` skill.
