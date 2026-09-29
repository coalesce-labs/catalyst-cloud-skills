# Failures

Quote live show-my-map.mjs thresholds; these are defaults. Failure itself moves no card.

- Pre-branch or infrastructure failures, including 5xx, stream loss, timeout and environment gaps, retry the same phase without repair.
- Retry and kickoff routing refusal back off 2, 5, 15 minutes, thresholds.retryBackoffMs.
- Other failures enter remediate; success restores the exact prior stage. Without a remediate stage, use teams[].labels.hold. thresholds.remediateRoundCap defaults to 3 per episode. Failed rounds queue no further round; repeated validate fingerprints consume one round per episode; no recorded branch means no round.
- thresholds.parkAfterConsecutiveFailures defaults to 3. Repeated-failure and round-cap parks need release after a fix, never a clock; cap release grants one extra round. The cloud's budgeted loop releases missing-branch/rebase-conflict parks.

unstick previews and runs `catalyst release <ticket> --because <change>`. Release clears all governors or none, naming required action. Without visible change, require --retry-unchanged.

| hold | trigger | release |
| -- | -- | -- |
| validate_class_spent | same validate failure after one repair | push, human non-bookkeeping comment, validate pass, ask answer; release after push/comment or --retry-unchanged plus --because; unanswered ask defaults to re-plan after 48 hours |
| round_threshold | lifetime repair budget | non-fleet push or ask answer grants one cycle; unanswered ask defaults to re-plan after 48 hours; comments and release refused |
| review_not_converging | nonconverging validate/repair cycles | human comment resumes validate; catalyst: resume implement resumes implement; push and release refused; no ask or 48-hour default |
| no_change_hold | repair changed nothing | push, human comment or release; never a clock |
| hand fix pending | ask answered human fixes it | commit on branch |
| runner pin | runner change merged before image covers it | image pin moves, then Done |

Only validate-budget/round-threshold asks default after 48 hours; others await answers. Runner image breaker needs three distinct tickets failing the same startup class on the live image; dispatch waits for the pin. Paused repositories need operator resume. Report each fleet cause once. explain --history prints attempts, rounds/cap, holds, release conditions and past releases.
