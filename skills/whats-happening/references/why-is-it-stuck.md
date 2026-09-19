# Why is it stuck

This reference restates an invariant: the vocabulary the cloud's eligibility explainer uses when nothing is offered for a ticket, translated for a person, with what releases each. `node scripts/explain.mjs <ticket>` prints the reason for one ticket; this table turns it into the next action. The `how-catalyst-works` skill carries the mechanism behind each row.

## How to read a reason

`explain` prints one paragraph: the queue position (or none), the status, the reason, a detail or marker when the cloud gave one, the last failure, and any advisories. Match the reason to a row below. "Releases itself" means the cloud clears it with no human action; "who acts" names who does — the person, with their own login; a tenant owner or admin, in settings; an operator; or "no one acts", which is a fourth honest answer, not a gap. When a reason is not in this table, `explain` prints it as the cloud spelled it; report it verbatim and say the bundle does not know it.

## Reasons that release themselves

| reason | what it means | how it clears | who acts |
| -- | -- | -- | -- |
| `retry_backoff` | the failed phase is retrying in place and waiting out its rung | a clock; the rungs are the contract's `thresholds.retryBackoffMs` | no one acts |
| `lease_held` | a live container already holds this phase | the phase finishes | no one acts |
| `intake_lease_held` | a later phase is offered while an intake container still holds the ticket | intake finishes | no one acts |
| `later_phase_lease_held` | an earlier phase is offered while a live container still holds a later phase of this ticket | the later phase finishes | no one acts |
| `environment_check_running` | the repository's environment check is in flight | the check finishes | no one acts |
| `claim_storm` | this unit was claimed too many times in the last hour | it waits the hour out; there is nothing to release | no one acts |
| `repo_at_capacity` | the repository's runner seats are all in use | it starts when a seat frees | no one acts |
| `runner_image_breaker` | fleet-wide: the live runner image fails every phase at startup, so dispatch is held rather than parking tickets | an operator moves the pin; one alert per tenant, no per-ticket action | an operator |
| `routing_unavailable` | claimed, then refused at kickoff: no route, no eligible coding-account slot, or the provider is unavailable | provider recovery or a slot freeing | usually no one acts; if it persists, a tenant owner or admin, in settings, checks coding accounts |
| `cooling_down` (with a named callback) | the phase is parked on a condition the cloud watches | the callback fires; the `detail` names it | no one acts; an operator can release it directly if the callback stalls |
| `no_branch_to_remediate` / `branch_missing` | a branch-dependent phase has no branch yet | the cloud releases these parks on its own budget | no one acts |
| `stale_failure_episode` | the ladder advanced after the recorded failure, so the round would repair a phase already passed | the round is dropped automatically; the reason is informational | no one acts |

## Reasons that need a human

| reason | what it means | who acts and how |
| -- | -- | -- |
| `ask_ticket` | it carries an ask label; a question is never work | the person, with their own login, answers the ask (`what-needs-me`) |
| `ask_shape_suspected` | its own text reads as a decision request though it carries no ask label | the person, with their own login, either answers it as an ask or applies the release label the contract names |
| `blocked` | a live blocking relation holds it | whoever owns the blocker closes it; when the blocker is an ask, that is the person, with their own login |
| `not_at_dispatch_stage` | the card is not in the team's dispatch column | the person, with their own login, moves the card to the dispatch slot (`references/reprioritising.md`) |
| `not_at_pr_stage` | merge is next but the card is not in the PR column | the person, with their own login, returns the card to the pr slot; an automation that bounced it should be found |
| `no_change_hold` | a repair round changed nothing | the person, with their own login, comments on the ticket or pushes to the branch |
| `waiting_on` | a merge-gate failure with no cause the cloud can repair | the person, with their own login, reads the merge-wait comment on the ticket; usually a hold label or a review they must give (`catalyst-github`) |
| `externally_claimed` | a worker outside the cloud holds it | that worker releases it, or the person, with their own login, removes the local-lane label |
| `environment_check_required` | the repository's environment check has not run | a tenant owner or admin, in settings, runs the environment check |
| `environment_check_failed` | the repository's environment check failed | a tenant owner or admin, in settings, fixes and reruns the environment check |
| `environment_check_expired` | the environment check's verdict aged out | a tenant owner or admin, in settings, reruns the environment check |
| `environment_check_hash_mismatch` | the environment changed since its recorded verdict | a tenant owner or admin, in settings, reruns the environment check |
| `repo_paused` | an operator paused the repository | an operator resumes it |
| `scope_overlap` | its declared file scope intersects a ticket already in flight | the person, with their own login, decides which goes first, or waits for the other ticket |

## Reasons a release clears once the cause is fixed

These do not release themselves: once the recorded cause is fixed, the person's own login releases them with `catalyst-skills release <ticket>`. The desk does not release; route the ticket to the `unstick` skill, which reads the history, previews the release and runs it, or names what a person must do first.

| reason | what it means | note | who acts |
| -- | -- | -- | -- |
| `phase_parked` / `cooling_down` (parked after repeated failures, or the round cap was spent) | the phase is parked and does not release itself | `unstick`; `explain --history` names the park and the failure class it recorded | the person, with their own login |
| `remediate_parked` | the repair phase itself is parked, so the failing phase has nowhere to be repaired | as above | the person, with their own login |
| `validate_class_spent` | this validate failure already spent its one repair round in this episode | a push or a comment saying what to change releases it on its own; otherwise `unstick` | the person, with their own login |
| `human_owned_pr` | a person's own pull request holds the ticket | that person closes or merges it; no release clears it | the person, with their own login |
| `review_not_converging` | review and repair kept finding new problems without converging | a person reads the findings and comments on the ticket to resume; raise an ask for that read | the person, with their own login |
| `round_threshold` | the ticket spent its lifetime repair budget | a person answers the ask the cloud raised, or pushes a fix | the person, with their own login |
| `branch_gone` | a branch that existed was deleted | the person, with their own login, decides whether to recreate it or drop the ticket | the person, with their own login |

## Reasons that are not problems

`ticket_terminal` (done or canceled), `pipeline_complete` (every phase ran), and `pr_merged` (the PR merged, nothing left to clone) describe finished work; no one acts. Report them as closed, not blocked.

## When the cloud could not judge

A status of `unknown` with a reason such as `ordering_never_published`, `ordering_stale`, `workflow_mapping_unknown`, `ticket_unknown`, `dependency_snapshot_unknown`, `blocker_unknown`, `label_snapshot_unknown`, `prior_artifact_unknown`, `scope_unknown`, `scope_occupancy_unknown` or `branch_snapshot_unknown` means the evaluator failed closed rather than guessing. Most clear on the cloud's next pass. `workflow_mapping_unknown`, and `ordering_never_published` beside it, does not clear by itself when the team has no saved stage mapping: `explain` then names the missing stages, and a tenant owner or admin maps the team in Settings → Linear teams. If any other one persists for a team, the readiness checks (`catalyst-setup`) are the next read.

## The one advisory

`human_addressed_unlabeled_ask_suspect` gates nothing: the ticket is assigned to a human with no delegate and may be an unlabelled ask. Mention it in the waiting-on-human block with a question mark.
