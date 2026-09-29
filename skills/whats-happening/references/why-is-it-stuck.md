# Why is it stuck: every reason, and who acts

The pack's one reason table; other skills point here. Match the reason `node scripts/explain.mjs <ticket>` prints to a row. "No one acts" is an honest answer. A reason missing here is printed as the cloud spelled it: report it verbatim and say the bundle does not know it. The mechanism is in `references/when-a-phase-fails.md`.

## Reasons that release themselves

`retry_backoff` (a retry rung, `thresholds.retryBackoffMs`), `lease_held`, `intake_lease_held` and `later_phase_lease_held` (a live container holds this or a later phase), `environment_check_running`, `claim_storm` (claimed too often in the last hour), `repo_at_capacity` (every runner seat busy), `stale_failure_episode` (the round would repair a phase already passed, so it is dropped), and `no_branch_to_remediate` / `branch_missing` (the cloud's budgeted release): each clears on its own, and no one acts.

| reason | what it means, and what clears it | who acts |
| -- | -- | -- |
| `runner_image_breaker` | fleet-wide: the live runner image fails every phase at startup; the image pin moves; one alert per account | an operator |
| `routing_unavailable` | refused at kickoff: no route, no eligible slot, or the provider down (the detail says which); clears on recovery | usually no one acts; if it persists, a workspace owner or admin, in settings, checks coding accounts (`references/coding-accounts.md`) |
| `cooling_down` (with a named callback) | parked on a condition the cloud watches; the callback in `detail` fires | no one acts; if the callback stalls, the person, with their own login, releases it through `unstick` |
| `wip_limit` | the project is at its work-in-progress limit, so no first phase; a ticket in progress finishing clears it | no one acts on this ticket; the in-progress tickets it waits on each have their own row |

## Reasons that need a human

| reason | what it means | who acts and how |
| -- | -- | -- |
| `ask_ticket` | it carries an ask label; a question is never work | the person, with their own login, answers the ask (`what-needs-me`) |
| `ask_shape_suspected` | its text reads as a decision request with no ask label | the person, with their own login, answers it as an ask or applies the contract's release label |
| `blocked` | a live blocking relation holds it | the blocker's owner closes it; for an ask, the person, with their own login |
| `not_at_dispatch_stage` | the card is not in the dispatch column | the person, with their own login, moves it to the dispatch slot |
| `not_at_pr_stage` | merge is next but the card is off the PR column | the person, with their own login, returns it to the pr slot and finds the automation that bounced it |
| `no_change_hold` | a repair round changed nothing | the person, with their own login, comments or pushes; `unstick` can also release it |
| `waiting_on` | a merge-gate failure the cloud cannot repair holds it at PR | the person, with their own login, reads the merge-wait comment: usually a hold label or an owed review (`catalyst-github`) |
| `externally_claimed` | a worker outside the cloud holds it | that worker, or the person, with their own login, removes the local-lane label |
| `environment_check_required` / `environment_check_failed` / `environment_check_expired` / `environment_check_hash_mismatch` | the repository's environment check has not run, failed, aged out, or predates a change | a workspace owner or admin, in settings, runs, fixes or reruns it |
| `repo_paused` | an operator paused the repository | an operator resumes it |
| `scope_overlap` | its declared file scope meets a ticket in flight | the person, with their own login, picks which goes first, or waits |
| `human_owned_pr` | a person's own pull request holds the ticket | the person, with their own login, closes, merges or hands over that pull request, which only they may close. The release command refuses it |
| `review_not_converging` | validate and repair cycles are not converging (review convergence hold) | the person, with their own login, reads the findings (`catalyst-github`) and comments. The release command refuses it; the hold table in `references/when-a-phase-fails.md` says what clears it |
| `round_threshold` | the lifetime repair budget is spent (round-threshold hold) | the person, with their own login, answers the ask the cloud raised or pushes a fix; point at that ask rather than raising another. The release command refuses it; see the hold table |

## Reasons a release clears once the cause is fixed

The desk does not release. Route these to the `unstick` skill, which reads the history, previews `catalyst release <ticket>`, and runs it or names what a person must do first.

| reason | what it means | note | who acts |
| -- | -- | -- | -- |
| `phase_parked` / `cooling_down` (repeated failures, or the round cap spent) | the phase is parked | `explain --history` names the park | the person, with their own login |
| `remediate_parked` | the repair phase itself is parked | as above | the person, with their own login |
| `validate_class_spent` | the validate-budget hold | a push, comment or ask answer also clears it (the hold table) | the person, with their own login |
| `branch_gone` | a branch that existed was deleted | recreate it, or drop the ticket | the person, with their own login |

## Reasons that are not problems

`ticket_terminal`, `pipeline_complete` and `pr_merged` describe finished work; no one acts. Report them as closed.

## When the cloud could not judge

A status of `unknown` with `ordering_never_published`, `ordering_stale`, `workflow_mapping_unknown`, `ticket_unknown`, `dependency_snapshot_unknown`, `blocker_unknown`, `label_snapshot_unknown`, `prior_artifact_unknown`, `scope_unknown`, `scope_occupancy_unknown` or `branch_snapshot_unknown` means "I could not look", never "it is not there": report it as inconclusive; most clear on the next pass. `workflow_mapping_unknown` (and `ordering_never_published` with it) does not clear by itself when the team has no saved mapping: a workspace owner or admin maps it (`catalyst team map <KEY>`). If another persists, read readiness (`catalyst-onboard`).

## The one advisory

`human_addressed_unlabeled_ask_suspect` gates nothing: a human-assigned ticket may be an unlabelled ask. List it under waiting-on-human with a question mark.
