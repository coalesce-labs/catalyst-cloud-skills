# Coding accounts: slots, windows, walls, and what a key cannot read yet

This reference restates the model, which does not vary per tenant. Your tenant's actual accounts, their usage and their state are NOT readable with an account key today: `node scripts/whats-running.mjs --accounts` prints that by name, with the settings page where the facts live. When a tenant-facing read ships, the same script will print the live rows and this reference stays true.

## What a slot is

A slot is one enrolled coding-account credential: a subscription or token that runs phases. A tenant may enrol several accounts of the same provider under the same email, because identity is the credential, not the email; the email is a display field. A revoked slot leaves the roster.

## Providers and harnesses

| Provider | Harness | Credential |
| -- | -- | -- |
| Claude | the Claude CLI | its own subscription |
| Codex | Codex | its own subscription |
| GLM | the Claude CLI | its own token |
| Qwen | the Claude CLI | its own token |
| GLM via OpenCode | OpenCode | the same GLM enrolment |
| Qwen via OpenCode | OpenCode | the same Qwen enrolment |

The harness is a property of the catalog entry, never a routing input. Which provider a phase runs on is the routing decision in `references/what-runs-next.md`; the routing rows, not the slot, name the model.

## Two state axes

- **Declared**: `active` or `disabled`. The operator sets it.
- **Observed**: `healthy`, `degraded` or `unknown`. The poller sets it from what the provider reports.

Two more lifecycle facts sit beside them: **quarantined** (system-set, on a credential conflict or an authentication mismatch; sticky, only an operator clears it) and **revoked** (operator-set).

## Windows, walls, headroom

- Subscriptions meter usage over a **5-hour** window and a **7-day** window, each with a used percentage and a reset time.
- A **wall** is the window limit a session can die at mid-run. Before a slot is granted, a fit gate projects the phase's expected burn against the remaining headroom with a safety margin; a slot that would hit the wall is not offered.
- **Headroom** per provider is advisory: it counts eligible and degraded slots and the best remaining percentage, and it can never promise what a reservation would refuse because both read the same eligibility predicate.
- Holds: a Claude slot can serve several phases at once up to a per-account cap; a Codex slot serves one at a time because its refresh tokens are single-use.
- Slot choice orders by usage band, then live-hold count, then used percent, then the latest reset, so bursts spread across accounts rather than stacking on one.

A poller refreshes an active slot's usage every 5 minutes and a disabled one daily. Separately, vendor status pages are polled for provider health; that signal says nothing about your own accounts' windows, walls or quarantine.

## What the settings page shows

Your tenant's coding-accounts page lists each slot with a five-value status, first match wins: expired-or-revoked, walled, active, attested (healthy and active, but the provider is unobserved), unobserved. A drilldown shows the windows, the holds and the history.

## What a key cannot read yet, and what to say

Coding-account status (provider, declared and observed state, window percentages and resets, walls, quarantine, live holds) is served only behind the tenant's admin gate. So when a human asks "why is nothing running?":

1. Run `node scripts/explain-ticket.mjs <ticket>` for a stuck ticket. `routing_unavailable` with a detail naming a slot or provider, or `no_eligible_account_slot` in the routing block, points at accounts.
2. Say plainly that the account key cannot read account state, and give the settings link the script prints. Do not guess a wall or a quarantine from silence.
3. Treat it as ONE fleet-level cause for every ticket it holds, never as a per-ticket escalation.

The customer session never holds or mints a coding-account credential; phases run in the cloud on the enrolled accounts, and repository access is a per-phase installation token.
