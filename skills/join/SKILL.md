---
name: join
description:
  Join this machine to the customer's catalyst-cloud tenant in one step — install the skill bundle and discover the tenant from the account key. Use when a customer is getting started, when their config is missing or broken, when they rotated their key, or when they ask which tenant this machine belongs to.
---

<!-- vendored-from: @catalyst-cloud/catalyst-skills -->

# Join — one command, no second step

Joining is one command. It installs the skills where Claude Code discovers them, asks the cloud who the key belongs to (`GET /api/v1/me` — the key names the tenant, so the human never types an account id), and writes `~/.config/catalyst-cloud/customer.json` (mode 0600, holds the key).

```sh
npx @catalyst-cloud/catalyst-skills join --key <account-key>
```

Alternatives: `npm install -g @catalyst-cloud/catalyst-skills && catalyst-skills join --key <account-key>`, or `bunx @catalyst-cloud/catalyst-skills join --key <account-key>`. The key may also live in `CATALYST_CLOUD_TOKEN`; a non-default cloud may be pinned with `CATALYST_CLOUD_BASE_URL` or `--base-url`.

## What you do

1. Ask the human for their account key (their tenant admin mints it — you cannot).
2. Run the join command. Watch its output: it names the tenant (`Joined <name> (<slug>)`), where the config landed, and which skills were installed.
3. Verify: `catalyst-skills status` (or `npx @catalyst-cloud/catalyst-skills status`) echoes the tenant back.
4. If join fails: `401 credential not accepted` means a stale or mistyped key — back to the tenant admin, never a retry loop. A network error names the URL; check `--base-url`.

## Rules

- **The key is a credential.** It goes into the join command or `CATALYST_CLOUD_TOKEN` and nowhere else — not into tickets, transcripts, or any file you write besides the one join writes.
- **Never guess a tenant.** There is no `--account`; the key is the only tenant selector, on purpose.
- **After an update**, the next command prints a one-line notice with the changelog entry and the update command — read it to the human if they are watching.
