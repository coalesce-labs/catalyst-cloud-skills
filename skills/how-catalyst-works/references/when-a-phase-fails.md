# When a phase fails: four layers, in order

This reference restates the mechanism, which does not vary per tenant. The numbers quoted are the fleet defaults; the live values are served on the contract under `thresholds` and `node scripts/show-my-map.mjs` prints them. Quote the printed values, not these.

A failed phase writes no board state on its own: the ticket stays at its current stage, retryable. What happens next is decided by four stacked layers.

## Layer 1: retry in place

Some failures are not the ticket's fault, so the SAME phase is simply re-offered and no remediation round is minted:

- the phase failed before any branch existed (research, plan or implement on a ticket whose own record shows no branch);
- an infrastructure failure at any phase: a vendor 5xx, a dropped stream, a refused setup, an environment gap, a phase timeout, an unwritable workspace.

Nothing is written for the retry; the ordinary dispatch path re-offers the phase. A remediation round on a branchless ticket could only fail to find the branch while spending a counted attempt, which is why this layer exists.

## Layer 2: backoff

Every retry-in-place, and a routing refusal at kickoff, waits out a rung of a backoff ladder before the phase is re-offered: 2 minutes, then 5, then 15, indexed by the consecutive-failure count and clamped at the last rung. While waiting, the eligibility explainer shows `retry_backoff` (or `routing_unavailable` with a kickoff detail). `node scripts/explain-ticket.mjs <ticket>` prints it. The live ladder is `thresholds.retryBackoffMs`.

## Layer 3: move to Remediate

Any failure that is not retry-in-place moves the card to the team's remediate stage and queues a remediation round. The round is an interrupt phase (`remediate`) that repairs what failed; when a round succeeds, the card restores to its exact pre-failure stage. A team with no remediate stage mapped gets the hold label from `teams[].labels.hold` instead of a state move.

Rounds are capped: after `thresholds.remediateRoundCap` rounds (default 3) in one failure episode, no further round is queued. A remediation round that itself fails never queues another round. A round that changes nothing puts the ticket on a no-change hold, released by a human comment on the ticket or a new push, never by a clock. A validate failure with the same fingerprint spends only one repair round per episode.

Two structural cases the round machinery refuses: a `remediate` round is never offered on a ticket with no recorded branch (`no_branch_to_remediate`), and one dispatched anyway is cancelled at the clone.

## Layer 4: park

After `thresholds.parkAfterConsecutiveFailures` consecutive failures (default 3) the phase is parked. A parked phase shows as `cooling_down` in the explainer; the ticket's `remediate` phase being parked shows as `remediate_parked`.

Which parks release themselves:

| Park | Releases by |
| -- | -- |
| repeated failure | an operator, not a clock |
| remediate round cap reached | an operator, not a clock |
| missing branch | its own budgeted release loop |
| rebase conflict | its own budgeted release loop |

An account key cannot release a park today; the repair verbs are operator-only. When a ticket is parked, say so, name the failure class the explainer shows, and hand the release to whoever administers the tenant.

## Two holds that are not failures

- **Validate budget hold**: a validate failure that has spent its repair round holds the card; a human comment on the ticket clears it.
- **Runner image breaker**: fleet-wide, not per ticket. When three distinct tickets fail the same startup class on the live runner image, dispatch pauses for the affected tickets, one anomaly alert is raised per tenant, and dispatch resumes automatically when the image pin moves. The explainer shows `runner_image_breaker`. Never escalate this one ticket at a time.

## What a human sees on the ticket

Each attempt posts a phase-outcome comment (complete or FAILED, with phase, attempt, artifact, a summary and any park or hold block) and each remediation round posts a remediate-attempt comment naming the failure class it is repairing. `catalyst-linear` describes the shapes. The round count of the cap and the park history are not readable with an account key yet; `catalyst-skills explain --history <ticket>` says so and names where to read them.

## Rule of thumb for answering "why is it stuck?"

1. Run `node scripts/explain-ticket.mjs <ticket>`; the reason names the layer.
2. `retry_backoff` or `routing_unavailable`: wait; it retries itself. Say when.
3. `cooling_down`, `remediate_parked`, `no_change_hold`, `validate_class_spent`: name what releases it (an operator, a comment, a push) and who can do that.
4. A system-level cause (provider down, runner image breaker, repo paused) is ONE alert, never a per-ticket escalation.
