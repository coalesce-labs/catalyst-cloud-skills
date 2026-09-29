# Coding accounts

snapshot.mjs --accounts omits credentials/emails. An owner/admin enrols, pauses, removes or replaces credentials at `<their cloud>/settings/coding-accounts`.

Slots identify credentials, not emails. Claude/GLM/Qwen use Claude CLI, Codex uses Codex; GLM/Qwen also use OpenCode. Routing names the model.

Declared state is operator-set active/disabled. Observed health is healthy/degraded/unknown, polled every five minutes for active slots and daily for disabled ones. Credential conflicts/auth mismatches quarantine; Replace credential on the account's page clears it.

Subscriptions have 5-hour and 7-day windows. Walls kill sessions; phase burn must fit headroom. Claude slots allow concurrent phases up to a cap; Codex permits one because refresh tokens are single-use. Vendor status does not reveal account windows.

When idle, explain. routing_unavailable or no_eligible_account_slot points here. Read --accounts: empty means no enrolment; inspect walled, quarantined and reason. Silence proves nothing.
