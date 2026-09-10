---
name: join
description:
  Bind this machine to the customer's Catalyst Cloud tenant with the account key, cache the tenant contract, and verify. Use when a person is getting started, when their config is missing or broken, when they rotated their key, when a skill script exits 2 saying the machine is not joined, or when they ask which tenant this machine belongs to. One command; the key names the tenant, so nobody types an account id.
disable-model-invocation: true
allowed-tools: Bash(catalyst-skills:*) Bash(npx @catalyst-cloud/catalyst-skills:*)
---
<!-- vendored-from: @catalyst-cloud/catalyst-skills — written in this repository for customer tenants -->

# Join

Joining is one command. It asks the cloud who the key belongs to, writes the config every skill and the CLI read, and caches the tenant contract beside it.

```sh
CATALYST_CLOUD_TOKEN=<account-key> npx @catalyst-cloud/catalyst-skills join
```

`--key <account-key>` is the second form, for a shell where the environment is awkward. With the package installed globally the command is `catalyst-skills join`. A non-default cloud is pinned with `CATALYST_CLOUD_BASE_URL` or `--base-url`.

**What it writes.** `~/.config/catalyst-cloud/customer.json` (mode 0600) holding the key, the tenant it resolved, and the absolute path of this CLI so skill scripts can spawn it; `~/.config/catalyst-cloud/contract.json`, the tenant contract with its ETag. It also copies the skills into the skills directory when they are not already there, and leaves alone any skill directory it did not create.

**The replica is optional and one command away.** Nothing has to be running for reads, writes, asks or explanations; the API is origin-fresh. `catalyst-skills replica start --detach` starts the local replica for cheap repeated reads and ad hoc SQL; `join --start-replica` does the same at the end of join. Every skill checks `catalyst-skills replica status` first and falls back to the API when the replica is absent or stale, saying so.

**One join.** The setup skill Catalyst seeds into your repository ends by pointing at this same command. There is no second join to run anywhere.

## What you do

1. Ask the person for their account key. Their tenant admin mints it in settings; you cannot. A workstation key joins but is refused by the contract and by machine-only reads (a one-line notice, not a failure); tell them an account key is needed for the full set.
2. Run the join command. Its output names the tenant (`Joined <name> (<slug>)`), the config path, the skills copied, and the cached contract version.
3. Verify with `node scripts/verify-join.mjs`: one line each for the tenant, the contract version, and the replica; exit 1 when the machine is not joined.
4. Offer the replica: `catalyst-skills replica start --detach`, then `catalyst-skills replica status`. For keeping it alive across a reboot, load `references/keeping-the-replica-running.md`.
5. If join fails: a `401` means a stale or mistyped key, back to the tenant admin, never a retry loop; a network error names the URL, check `--base-url`. If join succeeds but prints a line naming two contract versions, the tenant serves a contract outside this bundle's range: update the bundle before using the other skills.

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
| the full readiness vector and what each check means | the `am-i-set-up` skill |

## Rules

- **The key is a credential.** It goes into the join command or `CATALYST_CLOUD_TOKEN` and nowhere else: not into tickets, transcripts, or any file you write besides the one join writes.
- **Never guess a tenant.** There is no `--account`; the key is the only tenant selector, on purpose. If the cloud names no tenant for the key, stop and say so.
- **Read the update notice.** After a bundle update, the next command prints one line with the changelog entry and what to run; read it to the person if they are watching.
