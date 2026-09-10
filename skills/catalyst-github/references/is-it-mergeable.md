# Is it mergeable?

The rule is invariant; the policy that applies to a repository is not. The policy names, the default, each repository's resolved policy and its source (repository setting, tenant setting, or the default), the reviewer login and the required check names all come from the contract's `merge` block at run time. `node scripts/is-it-mergeable.mjs <ticket>` reads them and prints one line per leg; the text below explains what those lines mean.

## Prerequisites before any leg counts

A merge queue never takes a PR that is closed, still a draft, or in conflict with its base branch, and neither does the cloud's evaluator. The script reports these first: the pr phase is what marks a draft ready for review; a conflict (GitHub reports the mergeable state as dirty) is repaired by a remediate round that rebases the branch.

## The three legs

Merge evidence has three independent legs. Two are unconditional under every policy; the third is what the policy decides.

| leg | passes when | always required? |
| -- | -- | -- |
| checks | every gating check at the current head completed with a non-failing conclusion (success, neutral or skipped count as non-failing). A pending check, or an empty set, is unknown, never green. The queue's own status check is not evidence about the PR and is excluded. | yes |
| reviewer | the reviewer signal the policy accepts (below) | only under a reviewer-attestation policy |
| threads | zero unresolved review threads, and no resolved thread whose resolving commit has left the head | yes |

Which checks are gating: the names the queue configuration itself requires, plus any extra gating check the cloud names. The contract serves the checks the cloud's own remediation waits on as `cloudRemediateRequiredChecks`; a check that cannot block a merge is informational and never a reason to withhold the label.

## The policies

Three policy names are served on `merge.policies`; the default is `merge.defaultPolicy`; a repository's own is `merge.repositories[].policy` with `policySource` saying where it came from. Read them from the contract; do not assume a repository is on the default.

| policy as served today | reviewer leg passes when |
| -- | -- |
| the default (an attestation policy) | a clean pass at the current head, or findings raised on an earlier head together with green checks and zero unresolved threads. In plain terms: the reviewer found something, the fix landed, every thread it raised is resolved, and the checks are green at the current head. That PR re-earns eligibility on its own; nobody has to ask the reviewer again. |
| the strict variant | a clean pass at the current head, always. Findings on an earlier head keep blocking until the reviewer looks again. |
| checks and threads only | the reviewer requirement is dropped entirely; the two unconditional legs decide. |

A clean pass is a reaction: a thumbs-up from the reviewer login posted at or after the head commit's own timestamp. The comment-shaped clean pass ("no major issues" in place of threads) is honoured only if `cleanPassShapes[]` says so for that kind; the script does not judge it either way.

## What the script can and cannot see

The mirrored PR detail carries checks, legacy commit statuses, review objects with their state, GitHub's mergeable state and the auto-merge flag. It does not carry reactions, PR labels, or the commit each review was submitted against. So:

- checks: judged fully from the detail.
- reviewer: reported as inconclusive unless the policy waives it. The script says whether the reviewer left review objects, but whether a clean-pass reaction followed, and whether those reviews stand at the current head or an earlier one, is not mirrored.
- threads: read from the local replica's review-thread rows when the replica is fresh (resolved flag per thread); inconclusive otherwise, with the command that starts the replica. Thread ancestry against force-pushes is judged by the cloud, not here.

The exit code is 1 only for a proven-red leg or prerequisite. An inconclusive leg leaves exit 0 and a verdict that says "not proven mergeable from this read". The cloud's own evaluator, which holds the reaction and the ancestry, is the authority; a queue-ready label on the PR means it already said yes.

## What happens after the label

Once the cloud's merge phase applies the queue-ready label, four events each wake one bounded remediate round with no operator in the loop: a required check turning red, a fresh conflict with the base branch, a non-clean review, and a dequeue by the queue. The round repairs what it can, pushes, and the PR re-enters the queue itself. A scheduled sweep is the independent backstop for a labelled PR that is not moving. A hand-posted review request is never the required unblock for the ordinary shape.

## The levers a human has

- The hold label keeps an eligible PR out of the queue; removing it lets the PR enter on its own.
- The preview label requests a preview and holds the merge; removing it is the approval.
- Replying on a review thread and re-resolving it re-attests that thread against the current head.
- A comment on the ticket releases a remediate round that changed nothing, and a validate hold.
- A path the queue excludes is merged by hand; the cloud marks such a PR with the hand-steps hold automatically.

## Reading the answer

Lead with the verdict line, then the red legs with what unblocks each, then the inconclusive ones with what would settle them. Name the policy and where it came from. Say which source the read used (the first stderr line). If the person wants to wait for the merge, subscribe through the project-running skill's watch rather than re-running this script in a loop.
