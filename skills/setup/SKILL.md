---
name: setup
description:
  Readiness checks before first real use of the customer skill bundle — placeholders today, growing into a full preflight. Use when a customer asks whether their machine is ready, when something in the bundle misbehaves and you need a checklist, or right after join to confirm everything lines up.
---

<!-- vendored-from: @catalyst-cloud/catalyst-skills — placeholder readiness skill; grows into the real preflight -->

# Setup — is this machine ready?

A placeholder checklist, run by hand or by you, that answers "ready or not" in one pass. Each check is a real command; each failure names the fix.

## Checklist

1. **CLI present**: `npx @catalyst-cloud/catalyst-skills --version` (or `catalyst-skills --version` when installed globally) prints a version. Minimums: Claude Code 2.0+, Node 18.17+ (20+ recommended), Bun 1.0+ if you use `bunx`.
2. **Joined**: `~/.config/catalyst-cloud/customer.json` exists and `catalyst-skills status` names a tenant. Missing → run the `join` skill.
3. **Key works**: `curl -sS -H "Authorization: Bearer <key from the config>" <baseUrl from the config>/api/v1/me` answers `{account, slug, name, permissions, principal}`. `401` → stale key, ask the tenant admin. `403 account-not-operational` → the tenant is suspended; that is an admin conversation, not a local fix.
4. **Skills discovered**: `ls ~/.claude/skills` shows `ask`, `concierge`, `join`, `linearis`, `setup`, `steward`. Missing → `catalyst-skills install`.
5. **Tenant readable**: one read of `/api/v1/issues?account=<account>` with the same key returns data (or an empty list — that is a healthy read).

## Rules

- **One pass, one verdict.** End with `READY` or the short list of what is not ready, each with its fix.
- **No fixes you were not asked for** — this skill reports; the human (or the concierge) decides what to change.
- **Never print the key itself** — reference "the key in the config", not its value.

This skill is deliberately a placeholder: the checks above are the honest minimum today. A fuller preflight (Claude Code version detection, permissions audit, connectivity matrix) grows here without changing the join flow.
