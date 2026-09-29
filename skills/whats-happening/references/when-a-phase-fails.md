# When a phase fails: retries, repair rounds, parks and holds

This reference restates the mechanism. The numbers quoted are the fleet defaults; the live values are on the contract under `thresholds`, and `node scripts/show-my-map.mjs` prints them. Quote the printed values.

A failed phase writes no board state on its own: the ticket stays at its current stage, retryable. Four stacked layers decide what happens next. The reason `explain` prints for each is in `references/why-is-it-stuck.md`.

## Layer 1: retry in place

Some failures are not the ticket's fault, so the same phase is re-offered and no repair round is minted:

- the phase failed before any branch existed (research, plan or implement on a ticket with no branch);
- an infrastructure failure at any phase: a vendor 5xx, a dropped stream, a refused setup, an environment gap, a phase timeout, an unwritable workspace.

## Layer 2: backoff

Every retry in place, and a routing refusal at kickoff, waits out a rung before the phase is re-offered: 2 minutes, then 5, then 15, clamped at the last rung. The live ladder is `thresholds.retryBackoffMs`.

## Layer 3: move to Remediate

Any other failure moves the card to the team's remediate stage and queues a repair round (`remediate`). When a round succeeds, the card returns to its exact pre-failure stage. A team with no remediate stage gets the hold label from `teams[].labels.hold` instead of a move.

Rounds are capped at `thresholds.remediateRoundCap` (default 3) per failure episode. A round that itself fails never queues another. A validate failure with the same fingerprint spends only one repair round per episode. A round is never offered on a ticket with no recorded branch.

## Layer 4: park

After `thresholds.parkAfterConsecutiveFailures` consecutive failures (default 3) the phase is parked.

| park | released by |
| -- | -- |
| repeated failure | the person's own login once the cause is fixed (`catalyst release`), never a clock |
| repair-round cap reached | the same release, which buys one more round |
| missing branch | the cloud's own budgeted release loop |
| rebase conflict | the cloud's own budgeted release loop |

`catalyst release <ticket> --because <what changed>` releases every governor holding the ticket in one step, or releases nothing and names what a person must do instead. It refuses a cause it cannot see change unless the caller names the change (`--retry-unchanged`). The `unstick` skill runs that loop.

## Holds, and what clears each

A hold is a named reason the cloud skips a ticket's next phase, so it stops retrying something that would fail the same way. Each kind clears differently. Keep them apart.

| hold | created by | cleared by | refused |
| -- | -- | -- | -- |
| **validate budget** (`validate_class_spent`) | the same validate failure comes back after its one repair round | a push to the branch; a human comment on the ticket (a `[bookkeeping]` one does not count); a validate pass; the person's own `catalyst release`, after a push or a comment since the hold, or with `--retry-unchanged` and a `--because`; an answer to the ask it raised; that ask's default (re-plan) after 48 hours unanswered | nothing a person can do is refused |
| **round threshold** (`round_threshold`) | the ticket's counted repair rounds reach its lifetime budget | each of these grants one more cycle: a push the fleet did not make, or an answer to its ask; the ask's default (re-plan) applies after 48 hours unanswered | a human comment does not clear it; `catalyst release` is refused |
| **review convergence** (`review_not_converging`) | validate and repair cycles that do not converge | a human comment on the ticket, which resumes at validate; `catalyst: resume implement` in the comment resumes at implement | a push alone does not clear it; `catalyst release` is refused; it raises no ask and has no 48-hour default |
| **no change** (`no_change_hold`) | a repair round that changed nothing | a push, a human comment, or `catalyst release` | never a clock |
| **hand fix pending** | someone answered an ask with "a human fixes it" | a commit landing on the branch | |
| **runner pin** | a runner change merged before the live runner image covers it | the image pin moving, which moves the ticket to Done | |

The 48-hour default applies only to the asks a validate-budget or round-threshold hold raises. Every other ask waits for its answer; `what-needs-me` covers asks.

## Two fleet-wide holds

- **Runner image breaker** (`runner_image_breaker`): when three distinct tickets fail the same startup class on the live runner image, dispatch pauses for the affected tickets, one alert is raised per account, and dispatch resumes on its own when the image pin moves.
- **A paused repository** (`repo_paused`): an operator paused it and resumes it.

Each is one alert for every ticket it holds, never one escalation per ticket.

## What a human sees on the ticket

Each attempt posts a phase-outcome comment (complete or FAILED, with phase, attempt, artifact, a summary and any park or hold block), and each repair round posts a remediate-attempt comment naming the failure class it repairs. `catalyst-linear` describes the shapes. `catalyst explain --history <ticket>` prints the attempt ledger, the rounds against the cap, the holds with what releases each, and past releases.

## Answering "why is it stuck?"

1. Run `node scripts/explain.mjs <ticket>`; the reason names the layer.
2. `retry_backoff` or `routing_unavailable`: it retries itself. Say when.
3. A park or hold: name what clears it from the table above, and who can do that.
4. A system-level cause (provider down, runner image breaker, repository paused) is one alert, never a per-ticket escalation.
