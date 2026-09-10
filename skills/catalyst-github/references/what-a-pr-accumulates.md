# What a pull request accumulates as Catalyst moves a ticket

Most of this page restates invariants: how Catalyst names branches, opens and rewrites pull requests, and what it pushes when. The parts that vary per tenant are read live from the contract's `merge` block and never restated here: the reviewer's login (`merge.reviewerLogin`), which clean-pass shapes are honoured (`merge.cleanPassShapes[]`), the four PR label names (`merge.prLabels`), the checks the cloud waits on (`merge.cloudRemediateRequiredChecks`), and the policy per repository (`merge.repositories[]`, else `merge.defaultPolicy`). `catalyst-skills contract --path merge` prints them.

## The branch

The branch is named exactly the ticket identifier, with no prefix: ticket `ABC-123` works on branch `ABC-123`. It is created by the implement phase once that phase has changes to push. A ticket that has never reached implement has no branch, which is why an eligibility explanation can say a branch is missing: nothing is wrong, nothing has run yet.

A separate work-in-progress namespace exists for runner scratch pushes; a pull request is never opened from it.

## The pull request, phase by phase

| phase | what it does to the PR |
| -- | -- |
| implement | pushes the branch and opens a draft PR with a placeholder. The title is Conventional-Commit shaped: `feat(<scopes>): <ticket> — <ticket title>`, scopes derived from the changed top-level app or package directories (at most three), the whole title capped at 110 characters. The body says the description is pending from the pr phase. |
| validate | runs the gate and writes its report; touches the PR only through the checks the push triggers. |
| pr | writes the real title and body from its own artifact (first line the title, then the body), rebases the branch onto the current base, force-pushes, updates the PR, and marks it ready for review. |
| remediate | repairs one failure class (a red check, a conflict, review findings, a dequeue) and pushes with a compare-and-swap force push, so a push that raced it is never overwritten. |
| merge | evaluates the evidence below and, when it is sufficient, applies the queue-ready label. It performs no merge itself. |

No `Closes <ticket>` trailer is inserted. The ticket reaches Done through the merge webhook, not through any phase (see the last section).

## Force-pushes are routine

Three phases rewrite history on the ticket branch: implement pushes fresh with force, pr rebases and force-pushes, remediate force-pushes with a lease. Two consequences a reader must hold:

- A review thread resolved against one commit may stop being evidence once the head moves. Catalyst walks the PR's own force-push timeline: a rebase that carries the same fix forward still counts; a force-push that dropped the fix does not, and the refusal names the thread and both commits. Replying on the thread and re-resolving it re-attests against the current head.
- A check result belongs to a head. After any push, the checks at the new head start from nothing; "no check has reported yet" is unknown, never green.

## The reviewer signal

An automated reviewer (login from the contract) reviews every PR. Its signal is one of four: clean, findings at the current head, findings at an earlier head, no review. A clean pass is a reaction, not a review object: a thumbs-up from the reviewer posted at or after the head commit's own timestamp. A second shape, a terse "no major issues" comment in place of review threads, exists as a documented convention; whether it is honoured is served on `cleanPassShapes[].honoured` and must be read there, never assumed. What counts under each policy is on `references/is-it-mergeable.md`.

## Labels on the PR

Four labels matter, all named on `merge.prLabels`, all matched exactly (a queue's label conditions are exact matches, which is why every hold has its own name):

| contract field | who applies it | meaning |
| -- | -- | -- |
| `queueReady` | the cloud's merge phase, once its own evidence gate passes | an attestation that the evidence was sufficient. It is not a lever: applying it by hand makes nothing merge that would not have merged, and removing it is not a hold. |
| `hold` | a human | the one manual escape hatch. An eligible PR stays out of the queue while it carries this. |
| `handStepsHold` | the cloud, automatically | the PR touches a path the queue configuration excludes (schema or migration paths, typically), so a person has to merge it by hand. |
| `preview` | a human | "deploy me a preview and hold the merge until I have looked". Removing the label is the approval. |

The mirror does not carry PR labels or reactions, so an account key cannot read which holds a PR carries or whether the reviewer reacted; the scripts say so by name. GitHub's own page, or the tenant's settings, is where those live.

## The queue is optional and opt-out

When a repository runs a merge queue, entry is opt-out: a PR against the base branch that is green on its required checks, not a draft, has zero unresolved review threads, carries no hold label, and touches no excluded path enters the queue on its own. Nobody applies a label to make that happen. The terminal signal is the queue's own merge ("merged by" the queue bot), not any return value from a merge command. Without a queue, the queue-ready label is still the cloud's attestation and the merge itself is whatever the repository's own setup does with it.

## After the label

A problem after the attestation does not wait on a person noticing. A red required check, a fresh conflict with the base branch, a non-clean review, or a dequeue by the queue each wakes one bounded remediate round automatically, which repairs what it can, re-pushes, and re-enters the queue itself. An independent scheduled sweep remains as a backstop for a PR that carries the label and is going nowhere. Hand-posting a review request to the reviewer is never the required unblock for the ordinary remediation shape.

## What happens on merge

The ticket moves to Done when the real merge webhook arrives, keyed to the pull request's merged event, with a bounded sweep as the backstop for a dropped webhook. Measured latency is a few seconds. A phase never writes Done; a ticket still not Done a minute after its PR merged is a finding, not a chore. Done is not the same as live: a change to a service deploys on its own pipeline after the merge.

## Reading a PR through this skill

`node scripts/read-pr.mjs <ticket>` follows the ticket's own record to the pull requests that name it, picks the open one (else the merged one, else the newest), and prints the mirrored detail: state, draft and merged flags, branch and base, head commit, the linked ticket and its stage, GitHub's own mergeable state and auto-merge flag, every check with status and conclusion, legacy commit statuses, and every mirrored review with its state. `--all` lists every PR for the ticket; `--json` prints the raw document. The first stderr line names the source, a fresh replica or the API, and the answer should repeat it.
