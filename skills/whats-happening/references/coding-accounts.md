# Coding accounts: slots, windows, walls

The person's own rows print with `node scripts/snapshot.mjs --accounts`, with no credential or email. An owner or admin enrols, pauses or removes one at `<their cloud>/settings/coding-accounts`.

## Slots and providers

A slot is one enrolled credential that runs phases; identity is the credential, so one email may hold several. Claude, GLM and Qwen run under the Claude CLI, Codex under Codex, and GLM and Qwen also under OpenCode. The routing rows (`references/what-runs-next.md`), not the harness, name the model.

## State

- **Declared:** `active` or `disabled`, set by the operator.
- **Observed:** `healthy`, `degraded` or `unknown`, set by the poller (every 5 minutes for an active slot, daily for a disabled one).
- **Quarantined:** system-set on a credential conflict or an authentication mismatch. Replace credential on the account's page clears it, and a workspace owner or admin can do that.

## Windows and walls

Subscriptions meter usage over a **5-hour** and a **7-day** window. A **wall** is the limit a session can die at mid-run, so a slot whose remaining headroom cannot fit the phase's projected burn is not offered. A Claude slot serves several phases at once up to a cap; a Codex slot serves one, because its refresh tokens are single-use. Vendor status pages say nothing about the person's own windows.

## "Why is nothing running?"

1. `node scripts/explain.mjs <ticket>`: `routing_unavailable` naming a slot or provider, or `no_eligible_account_slot` in the routing block, points at accounts.
2. `node scripts/snapshot.mjs --accounts`: an empty list means none is enrolled; a wall is the `walled` field, a quarantine `quarantined` with its reason. Read them; silence proves nothing.
3. Report it as one fleet-level cause for every ticket it holds.

