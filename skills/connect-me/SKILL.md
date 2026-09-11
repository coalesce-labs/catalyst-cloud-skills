---
name: connect-me
description: >-
  Connect this machine to the person's Catalyst Cloud tenant with their own personal key, cache the tenant contract, and verify. Use when a person is getting started, when their config is missing or broken, when they rotated their key, when a skill script exits 2 saying the machine is not connected, or when they ask which tenant this machine belongs to. The key names the tenant and the person, so nobody types an account id. Installing the skills is not this skill's job; the agent's own install command did that.
disable-model-invocation: true
allowed-tools: Bash(catalyst-skills:*) Bash(npx @catalyst-cloud/catalyst-skills:*)
---
<!-- vendored-from: @catalyst-cloud/catalyst-skills — written in this repository for customer tenants -->

# Connect me

Connecting is one command. It asks the cloud who the key belongs to — which tenant, and which person — writes the config every skill and the CLI read, and caches the tenant contract beside it.

```sh
CATALYST_CLOUD_TOKEN=<your-personal-key> catalyst-skills login
```

With no environment variable and a terminal attached, `catalyst-skills login` prompts for the key without echoing it. `--key <personal-key>` is the third form, for a script. `npx @catalyst-cloud/catalyst-skills login` works when the package is not installed globally. A non-default cloud is pinned with `CATALYST_CLOUD_BASE_URL` or `--base-url`.

**This skill never installs skills.** You are already reading one, so the person's agent installed the set with its own command. Connecting is only about the credential and the contract.

**What it writes.** `~/.config/catalyst-cloud/customer.json` (mode 0600) holding the key, the tenant it resolved, the person it resolved (`user`: id, label, role, Linear user id), and the absolute path of this CLI so skill scripts can spawn it; `~/.config/catalyst-cloud/contract.json`, the tenant contract with its ETag.

**The replica is optional and one command away.** Nothing has to be running for reads, writes, asks or explanations; the API is origin-fresh. `catalyst-skills replica start --detach` starts the local replica for cheap repeated reads and ad hoc SQL; `login --start-replica` does the same at the end. Every skill checks `catalyst-skills replica status` first and falls back to the API when the replica is absent or stale, saying so.

## What you do

1. Ask the person to mint their **personal key** at Settings → API keys in the Catalyst Cloud web app (every active member can; no admin is needed) and hand it to the login command. It is shown once. Never put it in a file, a ticket, or this conversation beyond that one command. Do not ask an admin for the tenant's **account key** (`ctc_acct_`, Settings → Account keys): that is a host credential — runners, daemons, the host replica — and a person connected with it has no name on anything their agent writes, and "what needs me" cannot mean them. If they connect with one anyway, login says so on stderr and still works.
2. Run the login command. Its output names the tenant (`Connected to <name> (<slug>)`), the person (`Connected as <label> (<role>)`), the config path, and the cached contract version. If the person line says their Linear identity is not matched yet, tell them: an admin matches it in Settings → Members, and until then "what needs me" shows everyone's asks.
3. Verify with `node scripts/verify-connection.mjs`: one line each for the tenant, the contract version, and the replica; exit 1 when the machine is not connected.
4. Run `catalyst-skills ready` and read the verdict to them.
5. Offer the replica: `catalyst-skills replica start --detach`, then `catalyst-skills replica status`. For keeping it alive across a reboot, load `references/keeping-the-replica-running.md`.
6. If login fails: a `401` means a stale, mistyped or revoked key — mint a new one at Settings → API keys, never a retry loop; a network error names the URL, check `--base-url`. A `403` on the contract naming an older cloud means the cloud has not yet deployed personal-key access: update the cloud, or connect with the account key until it has. If login succeeds but prints a line naming two contract versions, the tenant serves a contract outside this bundle's range: update the bundle before using the other skills.

## The verbs a session runs first

Every skill session opens with these, in this order, before doing anything else:

1. `catalyst-skills status` to confirm the tenant this machine belongs to and where the config and contract live.
2. `catalyst-skills contract` to load the tenant contract (cached per its own policy; `--refresh` forces a revalidation; `--path teams.0.stages` prints one sub-document).
3. `catalyst-skills replica status` to learn the read source: exit 0 fresh, 1 stale, 2 not configured, 3 absent.
4. `catalyst-skills ready` for the full verdict: Node, config, contract, CLI path, skills, SDK, replica, and the tenant's own readiness checks with who can fix each.

## Load on demand

| when | read |
| -- | -- |
| the person wants the replica writer to survive a reboot, or asks what it stores and whether anything needs cleaning | `references/keeping-the-replica-running.md` |
| the full readiness vector and what each check means | the `catalyst-setup` skill |

## Rules

- **The key is a credential.** It goes into the login command or `CATALYST_CLOUD_TOKEN` and nowhere else: not into tickets, transcripts, or any file you write besides the one login writes.
- **Never guess a tenant.** There is no `--account`; the key is the only tenant selector, on purpose. If the cloud names no tenant for the key, stop and say so.
- **Read the update notice.** After a bundle update, the next command prints one line with the changelog entry and what to run; read it to the person if they are watching.
