# Why is it stuck

This reference restates an invariant: the vocabulary the cloud's eligibility explainer uses when nothing is offered for a ticket, translated for a person, with what releases each. `node scripts/explain.mjs <ticket>` prints the reason for one ticket; this table turns it into the next action. The `how-catalyst-works` skill carries the mechanism behind each row.

## How to read a reason

`explain` prints one paragraph: the queue position (or none), the status, the reason, a detail or marker when the cloud gave one, the last failure, and any advisories. Match the reason to a row below. "Releases itself" means the cloud clears it with no human action; "needs" names who acts. When a reason is not in this table, `explain` prints it as the cloud spelled it; report it verbatim and say the bundle does not know it.

## Reasons that release themselves

| reason | what it means | how it clears |
| -- | -- | -- |
| `retry_backoff` | the failed phase is retrying in place and waiting out its rung | a clock; the rungs are the contract's `thresholds.retryBackoffMs` |
| `lease_held` | a live container already holds this phase | the phase finishes |
| `intake_lease_held` | a later phase is offered while an intake container still holds the ticket | intake finishes |
| `environment_check_running` | the repository's environment check is in flight | the check finishes |
| `runner_image_breaker` | fleet-wide: the live runner image fails every phase at startup, so dispatch is held rather than parking tickets | the cloud moves the pin; one alert per tenant, no per-ticket action |
| `routing_unavailable` | claimed, then refused at kickoff: no route, no eligible coding-account slot, or the provider is unavailable | provider recovery or a slot freeing; if it persists, the tenant admin checks coding accounts in settings |
| `cooling_down` (with a named callback) | the phase is parked on a condition the cloud watches | the callback fires; the `detail` names it |

## Reasons that need a human

| reason | what it means | who acts and how |
| -- | -- | -- |
| `ask_ticket` | it carries an ask label; a question is never work | the human answers the ask (`what-needs-me`) |
| `ask_shape_suspected` | its own text reads as a decision request though it carries no ask label | the human either answers it as an ask or applies the release label the contract names |
| `blocked` | a live blocking relation holds it | whoever owns the blocker closes it; if the blocker is an ask, that is the human |
| `not_at_dispatch_stage` | the card is not in the team's dispatch column | someone moves the card to the dispatch slot (`references/reprioritising.md`) |
| `not_at_pr_stage` | merge is next but the card is not in the PR column | the card returns to the pr slot; an automation that bounced it should be found |
| `no_change_hold` | a repair round changed nothing | a human comment on the ticket, or a new push to the branch |
| `waiting_on` | a merge-gate failure with no cause the cloud can repair | read the merge-wait comment on the ticket; usually a hold label or a review a person must give (`catalyst-github`) |
| `externally_claimed` | a worker outside the cloud holds it | that worker, or the human removes the local-lane label |
| `environment_check_required` / `_failed` / `_expired` / `_hash_mismatch` | the repository's environment gate has not passed | the tenant admin runs or fixes the environment check in settings |
| `repo_paused` | an operator paused the repository | the operator resumes it |
| `scope_overlap` | its declared file scope intersects a ticket already in flight | wait for the other ticket, or the human decides which goes first |

## Reasons that need an operator, and what a key cannot do

| reason | what it means | note |
| -- | -- | -- |
| `cooling_down` (parked after repeated failures, or the round cap was spent) | the phase is parked and does not release itself | an operator unparks it; an account key has no unpark verb yet, so the reply names the park and the settings page |
| `remediate_parked` | the repair phase itself is parked, so the failing phase has nowhere to be repaired | as above |
| `validate_class_spent` | this validate failure already spent its one repair round in this episode | as above; a human comment may release the hold |
| `no_branch_to_remediate` / `branch_missing` / `branch_gone` | a branch-dependent phase has no branch to clone | the cloud releases missing-branch parks on its own budget; a deleted branch needs a human to decide |
| `stale_failure_episode` | the ladder advanced after the recorded failure | informational; the round is dropped |

## Reasons that are not problems

`ticket_terminal` (done or canceled), `pipeline_complete` (every phase ran), and `pr_merged` (the PR merged, nothing left to clone) describe finished work. Report them as closed, not blocked.

## When the cloud could not judge

A status of `unknown` with a reason such as `ordering_never_published`, `ordering_stale`, `workflow_mapping_unknown`, `ticket_unknown`, `dependency_snapshot_unknown`, `blocker_unknown`, `label_snapshot_unknown`, `prior_artifact_unknown`, `scope_unknown`, `scope_occupancy_unknown` or `branch_snapshot_unknown` means the evaluator failed closed rather than guessing. Most clear on the cloud's next pass. If one persists for a team, the readiness checks (`catalyst-setup`) are the next read.

## The one advisory

`human_addressed_unlabeled_ask_suspect` gates nothing: the ticket is assigned to a human with no delegate and may be an unlabelled ask. Mention it in the waiting-on-human block with a question mark.
