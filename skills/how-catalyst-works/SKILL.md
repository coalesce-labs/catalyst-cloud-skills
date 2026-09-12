---
name: how-catalyst-works
description: >-
  How Catalyst Cloud runs a ticket on the customer's own tenant, as facts an agent loads on demand: the eight-phase ladder and what each phase produces, the eleven board slots and this team's live stage map, what happens when a phase fails (retry, backoff, Remediate, park), how the queue is ordered and routed and every reason a ticket is excluded, and the coding-account model. Use when a person asks "how does this work?", "why did it do that?", "why is this stuck?", "what runs next?" or "how does it prioritise?". Read-only; its scripts explain one ticket's eligibility in plain English, show what is running and queued, and print the tenant's stage map and thresholds straight from the contract.
allowed-tools: Bash(catalyst-skills:*) Bash(npx @catalyst-cloud/catalyst-skills:*)
---
<!-- vendored-from: @catalyst-cloud/catalyst-skills — written in this repository for customer tenants -->

# How Catalyst works

You explain the machine. A person asks why Catalyst did something, what it will do next, or how it decides; you answer from the tenant's live contract and eligibility explainer, and from the invariants in the references below. You never guess a stage name, a label, a threshold or a route: the scripts print the live values.

Every tenant-specific fact (stage names and ids, label ids, the ladder keying, the thresholds, the merge policy) comes from `GET /api/v1/agent/contract`, cached per session by the `catalyst-skills` CLI. The references restate only what does not vary per tenant.

## Run first

Run each with `--help` before reading anything else; the scripts are black boxes, not reading material.

- `node scripts/explain-ticket.mjs <ticket>` — why one ticket is or is not about to run, as one paragraph plus the raw eligibility row.
- `node scripts/whats-running.mjs [--queue] [--accounts] [--team <key>]` — fleet activity, the agent roster and lease attributions; with `--queue` the dispatch order; with `--accounts` the coding-account line.
- `node scripts/show-my-map.mjs [--team <key>]` — this tenant's slot-to-stage map, ladder and live thresholds.

Exit codes: 0 answered, 1 not found or a usage error, 2 this machine is not connected or the cloud refused (the one line printed says which; connect first if it names the login).

## Load on demand

| when | read |
| -- | -- |
| "what are the phases, what does each produce, when is a ticket Done?" | `references/the-ladder.md` |
| "which column is which, why does nothing dispatch, what is a slot?" | `references/stages-and-mapping.md` |
| a phase FAILED, a card went to Remediate, a ticket is parked or on hold | `references/when-a-phase-fails.md` |
| "what runs next, why not this one, what does this exclusion reason mean?" | `references/what-runs-next.md` |
| "why is nothing running", walls, quarantine, which provider ran a phase | `references/coding-accounts.md` |

## Rules

- **Print, never recall.** A stage name, label, threshold or route in your answer must have come from a script's output in this session.
- **A reason is a layer.** Translate an exclusion reason through `references/what-runs-next.md`; name what releases it and who can do that (a clock, a comment, a push, an operator).
- **Unknown is not absent.** An `unknown` verdict from the explainer means the cloud could not look; report it as inconclusive.
- **System causes are one alert.** A provider outage, the runner image breaker or a paused repository holds many tickets for one reason; never escalate it ticket by ticket.
- **Say what a key cannot see.** A few PR facts are not mirrored (labels, the reviewer's reaction) and a park is released only by an operator; the scripts say so and name the settings page. Do not fill the gap with a guess.
- **Depth lives elsewhere.** What a ticket accumulates in Linear is `catalyst-linear`; what a PR accumulates and whether it is mergeable is `catalyst-github`; raising a decision is `what-needs-me`.
