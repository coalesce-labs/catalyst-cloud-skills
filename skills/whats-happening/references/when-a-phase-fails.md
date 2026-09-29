# When a phase fails: retries, repair rounds, parks and holds

Numbers here are fleet defaults; quote the live `thresholds` that `node scripts/show-my-map.mjs` prints. A failed phase writes no board state: the ticket stays at its stage, and four layers decide what happens next.

1. **Retry in place.** A failure that is not the ticket's fault (one before any branch existed, or infrastructure: a vendor 5xx, a dropped stream, a timeout, an environment gap) re-offers the same phase with no repair round.
2. **Backoff.** Each retry in place, and a routing refusal at kickoff, waits out a rung first: 2, 5, then 15 minutes (`thresholds.retryBackoffMs`).
3. **Remediate.** Any other failure moves the card to the remediate stage and queues a repair round; a successful round returns the card to its exact pre-failure stage. A team with no remediate stage gets the hold label (`teams[].labels.hold`) instead. Rounds are capped per failure episode at `thresholds.remediateRoundCap` (default 3); a failed round queues no other, a repeated validate fingerprint spends one round per episode, and a ticket with no recorded branch gets none.
4. **Park.** After `thresholds.parkAfterConsecutiveFailures` consecutive failures (default 3) the phase parks. A repeated-failure park, and a park at the round cap, release through the person's own login once the cause is fixed (`catalyst release`, never a clock; at the cap it buys one more round). A missing-branch or rebase-conflict park is released by the cloud's own budgeted loop.

`catalyst release <ticket> --because <what changed>` releases every governor holding the ticket, or nothing, naming what a person must do; a cause it cannot see change needs `--retry-unchanged`. The `unstick` skill runs it.

## Holds, and what clears each

A hold stops the cloud retrying what would fail the same way. Each kind clears differently; keep them apart.

| hold | created by | cleared by | refused |
| -- | -- | -- | -- |
| **validate budget** (`validate_class_spent`) | the same validate failure returns after its one repair round | a push to the branch; a human comment (a `[bookkeeping]` one does not count); a validate pass; the person's own `catalyst release` after a push or comment since the hold, or with `--retry-unchanged` and a `--because`; an answer to the ask it raised; that ask's default (re-plan) after 48 hours unanswered | nothing a person can do is refused |
| **round threshold** (`round_threshold`) | the ticket's counted repair rounds reach its lifetime budget | each grants one more cycle: a push the fleet did not make, or an answer to its ask; the ask's default (re-plan) applies after 48 hours unanswered | a human comment does not clear it; `catalyst release` is refused |
| **review convergence** (`review_not_converging`) | validate and repair cycles that do not converge | a human comment, which resumes at validate; `catalyst: resume implement` in the comment resumes at implement | a push alone does not clear it; `catalyst release` is refused; it raises no ask and has no 48-hour default |
| **no change** (`no_change_hold`) | a repair round that changed nothing | a push, a human comment, or `catalyst release` | never a clock |
| **hand fix pending** | an ask answered "a human fixes it" | a commit landing on the branch | |
| **runner pin** | a runner change merged before the live runner image covers it | the image pin moving, which moves the ticket to Done | |

The 48-hour default applies only to the asks a validate-budget or round-threshold hold raises; every other ask waits for its answer (`what-needs-me`).

Two holds are fleet-wide, one alert for every ticket they hold: the **runner image breaker** (three distinct tickets failing the same startup class on the live image pauses their dispatch until the image pin moves) and a **paused repository** (an operator resumes it). `catalyst explain --history <ticket>` prints the attempts, rounds against the cap, holds with what releases each, and past releases.
