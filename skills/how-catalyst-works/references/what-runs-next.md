# What runs next: queue order, concurrency, routing, and every exclusion reason

This reference restates invariants. The live queue is `node scripts/whats-running.mjs --queue [--team <key>]`; one ticket's verdict is `node scripts/explain-ticket.mjs <ticket>`. The reason phrases below match the CLI's own table, so a reason you see printed can be looked up here.

## Queue order

Each team's dispatch queue is derived by the tenant's own store, continuously, from the board:

1. Queued tickets (cards in the dispatch slot) rank by **priority ascending, then created time ascending, then identifier ascending**.
2. Mid-ladder tickets (any ticket with a phase already completed) join the candidate set and order **by completed-phase count descending**, so a ticket close to the end goes before one that just started. That count is an ordering surrogate only; it never decides membership or eligibility.

The queue re-derives within seconds of any board change and at the top of every periodic pass as a backstop. `dispatch_queue.source` reads `self-derived` when the tenant store built it itself, which is the normal case.

## Concurrency

- Each repository has a concurrency cap (default 20 running phases). An operator can raise or lower it; a paused repository resolves to a cap of zero without touching the stored value, so resuming restores it.
- Dispatch buckets by repository and splits slots across teams so no team starves another. A slot that is running, might be running, or is restarting is never free capacity.
- Comment-wake work (an agent answering a human comment) shares the same cap as ladder work.

## The routing decision, in five checks

When a phase is about to start, a route is chosen per candidate, in order, and the first survivor wins:

1. capability match (can this route run this phase);
2. a model is configured;
3. the provider is available;
4. if the candidate needs a coding-account slot: an eligible slot exists and the headroom floor is met;
5. degraded, equivalent or stage-default parameters resolve.

No survivor is `no_eligible_account_slot` when any candidate was skipped on capacity, else `routing_unavailable` (a misconfiguration). See `references/coding-accounts.md` for what a slot is.

## Every exclusion reason, one line each

| Reason | Meaning |
| -- | -- |
| `ticket_terminal` | the ticket is in a done or canceled state |
| `pipeline_complete` | every phase has already completed |
| `not_at_dispatch_stage` | the card is not in the team's dispatch column; move it there to dispatch |
| `not_at_pr_stage` | merge is next but the card is not in the PR column (waived when a tenant automation bounced it off PR and the bounce was recorded) |
| `blocked` | a live blocking relation; the blocker closes first |
| `cooling_down` | the offered phase is parked; an operator or a callback releases it, not a clock |
| `lease_held` | a live container already holds this phase |
| `intake_lease_held` | a later phase is offered while an intake container still holds the ticket |
| `ask_ticket` | it carries an ask label; a question is never work |
| `ask_shape_suspected` | its own text reads as a decision request; a human releases it with the release label from the contract's `vocabulary` |
| `externally_claimed` | a worker outside the cloud claimed it |
| `environment_check_required` | the repository's environment check has not run |
| `environment_check_running` | the environment check is in flight |
| `environment_check_failed` | the environment check failed |
| `environment_check_expired` | the environment verdict aged out |
| `environment_check_hash_mismatch` | the environment changed since the verdict |
| `scope_overlap` | its declared file scope intersects a ticket in flight (implement only; enforced once a team activates a scope policy) |
| `waiting_on` | a merge-gate failure with no remediable cause holds the card at PR |
| `branch_missing` | the ticket branch has never been seen |
| `branch_gone` | the ticket branch was deleted |
| `pr_merged` | its PR merged and no other PR is open |
| `no_change_hold` | a remediate round changed nothing; a human comment or a new push releases it |
| `validate_class_spent` | this validate failure already spent its one repair round |
| `stale_failure_episode` | the ladder advanced after the failure, so the round would repair a phase already passed |
| `runner_image_breaker` | fleet-wide: the live runner image fails every phase at startup; clears when the pin moves |
| `no_branch_to_remediate` | a remediate round is queued on a ticket with no branch |
| `retry_backoff` | retrying in place, waiting out its 2/5/15-minute rung |
| `routing_unavailable` | claimed then refused at kickoff: no route, no eligible slot, or the provider is unavailable; the detail names which |
| `repo_paused` | an operator paused the repository |
| `remediate_parked` | the remediate phase is parked, so the failing phase has nowhere to be repaired |

## The unknowns (the evaluator fails closed)

When the cloud cannot answer, it says so rather than guessing: `ordering_never_published`, `ordering_stale`, `workflow_mapping_unknown`, `ticket_unknown`, `dependency_snapshot_unknown`, `blocker_unknown`, `label_snapshot_unknown`, `prior_artifact_unknown`, `scope_unknown`, `scope_occupancy_unknown`, `branch_snapshot_unknown`. An unknown is "I could not look", never "it is not there"; report it as inconclusive.

One advisory gates nothing: `human_addressed_unlabeled_ask_suspect` (assigned to a human with no delegate; possibly an unlabelled ask).

## The three levers a human has

1. **Priority** on the ticket reorders the queue.
2. **The dispatch column**: moving a card into the dispatch slot dispatches it; moving it to the team's backlog-type state parks it and stops rounds.
3. **Holds**: the hold labels on the pull request (from the contract's `merge.prLabels`) keep a green PR out of the merge queue; a human comment on the ticket clears the validate hold and the no-change hold.
