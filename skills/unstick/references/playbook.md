# The unstick playbook

This reference restates how a person's release of a stuck ticket works and the order you follow. The cloud does the deciding: it reads every governor holding the ticket and either releases all of them or releases nothing and names, for each one it refuses, the action that does fix it. Your job is to read, judge whether the cause is fixed, and say so honestly.

## The order

1. **Why is nothing running?** `catalyst-skills explain <ticket>`. If the reason is not a park or a hold (for example `blocked`, `not_at_dispatch_stage`, an ask, a missing environment check, `scope_overlap`), there is nothing to release: follow the `whats-happening` skill's why-is-it-stuck reference instead and stop here.
2. **What holds it, and has it been released before?** `catalyst-skills explain <ticket> --history`. Read three things: the "Held by" lines (each governor and what releases it), the last failure (its class and summary), and the "Releases" lines (who released it before, why, and what happened).
3. **Is the cause fixed?** Decide from evidence, in this order:
   - a push to the ticket's branch, a comment on the ticket that says what to change, or main moving on since the park: the cloud can see these, and a release goes through;
   - a change the cloud cannot see (a provider outage that ended, a rotated secret, a re-enrolled coding account, a fixed tenant setting): release with `--retry-unchanged`, and the reason you give names that change;
   - nothing changed: do not release. Tell the person what failed and what would have to change.
   If a previous release in the history named the same failure and nothing has changed since, the next release will fail the same way. Do not release again; raise an ask.
4. **Preview.** `catalyst-skills release <ticket> --dry-run`. It prints what a release would clear and what it would refuse, and changes nothing.
5. **Release.** `catalyst-skills release <ticket> --because "<the change>"`. Report what it released, verbatim, with the ticket id. A warning line (for example, that a released repair round runs again at the escalated tier and a second cap parks it again) goes in your reply too.
6. **Act on each refusal.** A refusal is terminal for that attempt: nothing was released. Each names its fix; the table below says who does it.

## What a refusal means and who fixes it

| refusal | what it means | who acts |
| -- | -- | -- |
| `cause_unchanged` | nothing the cloud can see changed since it was held | you, if you can name a change it cannot see (`--retry-unchanged` with that `--because`); otherwise nobody should release it yet |
| `lease_held` | a phase is running on the ticket right now | nobody; wait for the phase's outcome comment, then look again |
| `branch_still_missing` | the ticket's branch was never pushed | it releases itself when the branch appears; check the earlier phases through `catalyst-linear` |
| `human_owned_pr` | a person opened the pull request this ticket would work on | that person closes or merges it, or hands it to Catalyst; never close a person's pull request yourself |
| `review_not_converging` | review and repair kept finding new problems | a person reads the findings (`catalyst-github`) and comments on the ticket to resume; raise an ask for that read |
| `round_threshold` | the ticket spent its lifetime repair budget | a person answers the ask the cloud already raised, or pushes a fix; point at that ask, do not raise a second one |
| `base_revision_lost` | the ticket's base commit is gone | whoever administers the tenant re-pins it; raise one ask |
| `remediate_cap` | this tenant keeps the repair-round cap for an administrator | whoever administers the tenant; raise one ask |
| `unknown_park` | a park this bundle does not know | raise one ask with the ticket id and the park name, verbatim |
| `held_beyond_class` | a class release reached a ticket held by more than that class | release that ticket on its own, from step 1 |
| `team_changed` (the ticket moved teams during the check) | the release was checked for one team and the ticket is now on another | run the release again |

Raise an ask only through `what-needs-me`, with the stuck ticket in what it blocks, and attach to an existing ask for the same decision rather than filing a second one.

## Several tickets, one cause

When several tickets on one team are parked for the same failure class (the explanation and the history show the same class, typically an outage or a runner problem that has since ended):

1. `catalyst-skills release --class <failure-class> --team <key> --dry-run` to see which tickets it reaches.
2. `catalyst-skills release --class <failure-class> --team <key> --because "<the change>" --retry-unchanged` when the change is one the cloud cannot see.
3. Report one line: how many released, which were refused and why, and whether more remain (run it again for the next batch).

A ticket the class release refuses is listed and left alone; take it through the single-ticket order above.

## What a release does not do

- It does not skip a phase or accept work as done; a released phase runs again.
- It does not reset a lifetime budget. A released repair round still counts toward the ticket's lifetime threshold, and the cloud stops a loop that claims the same unit too often in an hour.
- It does not move the card. The ticket stays where it is and runs when the cloud next offers it.
- It is recorded: who released, with which login, why, what it cleared and what it refused. `explain --history` shows it to everyone who reads the ticket.
