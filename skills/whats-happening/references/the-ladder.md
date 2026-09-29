# Phases

Explain using their tickets/repos. Dispatch starts repository-configured cloud containers on enrolled accounts, never laptop coding sessions. Agents react to events; documents/outcome comments stay on the ticket.

Tickets need outcome title, acceptance criteria, priority, no open blocker and no assumed chat context. Catalyst owns working stages/Done. Draft PRs become ready; green, thread-free PRs queue-merge unless held. Linear asks carry options/default/blocked work. Human comments get eyes and threaded replies.

| phase | output or effect |
| -- | -- |
| intake | optional classification, no artifact; ladder.intakeEnabled |
| research | research.md, offered from dispatch |
| plan | plan.md |
| implement | implement.md; ticket-id branch and draft PR |
| validate | validation.md; success enters the shared verify/review stage |
| pr | pr.md, title first then body; rebase, force-push, mark ready |
| remediate | remediation.json; failure interrupt, never advances beyond PR |
| merge | receipt; evidence gate then queue-ready label |

Read ladder.advance and keying: trailing stages name the completed phase, leading stages the next. Failure, remediate and merge do not advance the card; see when-a-phase-fails.md. show-my-map.mjs translates stages; explain names the next phase.

Done means merged. The webhook writes it within seconds; a sweep recovers losses. Missing Done after one minute is a finding; never hand-close. Live requires deployment.
