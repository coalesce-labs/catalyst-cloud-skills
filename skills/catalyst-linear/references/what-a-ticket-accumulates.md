# What a ticket accumulates as Catalyst works it

This reference restates invariants: the shapes of what the cloud writes onto a ticket. The one live value it needs — the bookkeeping marker and the label names — is on the contract under `vocabulary` and `teams[].labels`; print them with `catalyst-skills contract --path vocabulary` and `catalyst-skills contract --path teams`. Never quote a marker or a label id from memory.

## Comments the cloud posts

| Kind | When | How it opens |
| -- | -- | -- |
| Phase outcome | every phase attempt ends | `✅ **Phase complete**` or `🛑 **Phase FAILED**`, then `**Phase**`, an optional `**Attempt**`, `**Artifact**`, a quoted summary, and a park, hold or failure block when there is one; a footer names the event that produced it |
| Remediate attempt | every remediation round ends | `🔧 **Remediate attempt N — SUCCEEDED**` or `FAILED`, then `**Class**` (the failure class being repaired) and optionally `**Repairing**` and `**Artifact**` |
| Projection link | an artifact document was created in Linear | `**<phase>** · attempt N — [<title>](<document url>)`, then the storage key and the thoughts-repository path |
| Projection fallback | Linear refused a document | `> ⚠️ **Fallback comment.** Linear refused a document for this artifact: <reason>` followed by the artifact body fenced inline |
| Board health | a ticket sat in an active stage with no sign of life | `**Catalyst Cloud · board health**`, what stalled, and "Action taken" |
| Merge wait | a hold at PR or merge named a cause | says what the merge is waiting on |
| Ask reply | a human answered an ask | a threaded reply under the answer |

Every one of these is posted by the app actor and is skipped by the comment-wake trigger; none of them wakes an agent.

## One document per phase, attached

Each artifact-bearing phase (research, plan, implement, validate, pr, remediate) projects its artifact into Linear as a document at a deterministic id, titled `<TICKET> · <phase> · attempt <n> · <YYYY-MM-DD>`, attached to the ticket, and announced by the projection-link comment above. Research and plan documents on a ticket that belongs to a project are also linked from the project. The same body is committed into the tenant's thoughts repository when one is configured. Reading the document is how you read what a phase concluded; the phase-outcome comment only summarises it.

## The agent session

A ticket being worked grows a Linear agent session whose **plan** is the ladder itself: phases before the current one completed, the current one in progress, later ones pending. A remediation round is an interrupt with no ladder position and anchors on the phase it interrupted. Activities record a phase starting, the gate running, an artifact being written, a PR being opened, and a terminal report. A session in a pending, active or awaiting-input status is reused; a stale, complete or errored one is replaced by a fresh session. Emission is best-effort: a failure to narrate never blocks a phase.

## Labels

| Role (contract name) | Who applies it | Meaning |
| -- | -- | -- |
| ask marker (`vocabulary.askMarkerLabel`, listed under `teams[].labels.ask`) | the cloud, atomically when it files an ask; or a human filing one by hand | this ticket is a question for a human, never work |
| ask kind family (`vocabulary.askLabelPrefix`, and per-phase `vocabulary.askPhaseLabelPrefix`) | the cloud, or a human | what kind of ask, and which phase raised it |
| release (`vocabulary.releaseLabel`, listed under `teams[].labels.release`) | **a human only** | releases a ticket the shape detector flagged as an ask; a human-applied ask-kind label outranks it |
| hold (listed under `teams[].labels.hold`) | the cloud | the marker a team gets instead of a Remediate state move when it has no remediate stage mapped |
| a local-lane marker | the cloud | a worker outside the cloud holds this ticket; removed at that lane's terminal step |

`(absent)` beside a label in `teams[].labels` means the workspace has no such label yet; the CLI refuses to apply a name it cannot resolve.

## Relations

`blocks` is the only relation Catalyst creates. It is written when an ask is raised, so the ask blocks every ticket waiting on the answer, and it is the signal that ranks the human's inbox: an ask with nothing to block is refused unless the caller declares nothing is blocked, because such an ask would never surface. No other relation type is written by the cloud.

## The bookkeeping marker

A comment that is a machine RECORD (a merge note, a state-move log, a chain summary) rather than a turn in a conversation must begin with the bookkeeping marker from `vocabulary.bookkeeping.marker`. Rules the contract states alongside it: it is a prefix only, never a substring; ASCII case-insensitive; leading whitespace is trimmed first. A marked comment never wakes an agent and never counts as "something happened" for the no-change and validate holds.

It matters on the human-attributed path: a record posted with a personal identity is wire-identical to the human typing it and would wake an agent to reply to its own writeup. A comment posted as the app actor already carries a bot actor and is already skipped; `--bookkeeping` on the comment script is still correct there, and harmless.

A real question that merely mentions the word is not bookkeeping and still wakes, deliberately.

## The eyes acknowledgement

When a genuine human comment lands (not a bot, not agent-authored, not an automation signature, not bookkeeping), the cloud reacts with 👀 and records a durable wake; the record is written even if the reaction fails. When a bot or agent reply observed at ingest is threaded under that comment, the 👀 is removed and the wake resolves. No live session is required for either half. So: reply in-thread, under the comment you are answering, or the acknowledgement never clears.
