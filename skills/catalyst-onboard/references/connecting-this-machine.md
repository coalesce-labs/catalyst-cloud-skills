# Connecting this machine

**For:** giving this machine a credential, so every later read and write is the person's own. The installer usually did this already. You are here when `node scripts/where-am-i.mjs` says the machine is not connected, a skill script exited 2, a login expired, a key was rotated, or the person asks which cloud account this machine is on.

## Which cloud account is this machine on

`catalyst status` prints the account this machine belongs to on its `Tenant:` line, the API it talks to, and where the config and contract live. Say "your cloud account" and its name, never an account number. The credential is the only account selector, on purpose: there is no `--account`. If the cloud names no account for the login, stop and say so.

## Logging in

Keyless is the preferred rail. With no key, `login` runs a browser device-code flow and logs the person in as themselves:

```sh
catalyst login
```

Ask first: "Shall I start the login now?" On a yes, run it. It prints a short code and a URL; the person approves in a browser, or from a phone on a machine with no browser. Do not run it again while a code is outstanding. The short-lived session refreshes silently on every request, so they stay connected for months.

A **personal key** is the fallback for a script or an unattended shell. The person mints it at Settings → API keys (every active member can; no admin is needed). It is shown once. The environment form keeps it out of shell history; `--key <personal-key>` is the other form:

```sh
CATALYST_CLOUD_TOKEN=<your-personal-key> catalyst login
```

`npx -p @catalyst-cloud/cli catalyst login` works when the package is not installed globally. A non-default cloud is pinned with `CATALYST_CLOUD_BASE_URL` or `--base-url`.

Leave the account key (`ctc_acct_`, Settings → Account keys) to hosts and runners. A person connected with it has no name on anything their agent writes, and "what needs me" cannot mean them. If they connect with one anyway, login says so on stderr and still works.

## Reading the login's output

It names the account (`Connected to <name> (<slug>)`), the person (`Connected as <label> (<role>)`), the config path, and the cached contract version. Then run `node scripts/where-am-i.mjs` so the machine part flips, and `node scripts/check.mjs` for the full verdict.

If the person line says their Linear identity is not matched yet, the person matches it themselves: `catalyst identity linear status`, then `catalyst identity linear options`, then they pick their own listed identity and you run `catalyst identity linear set <linearUserId>`. An identity someone else already claimed, and an inactive seat, need an owner or admin at Settings → Members. Connecting Linear personally does not set the identity: the identity and the personal grant are two different stored facts. Until the identity is matched, "what needs me" shows everyone's asks.

## What login writes

`~/.config/catalyst-cloud/customer.json` (mode 0600) holds the credential (a keyless session under `auth`, or a personal key), the account it resolved, the person it resolved (`user`: id, label, role, Linear user id), and the absolute path of this CLI so skill scripts can spawn it. `~/.config/catalyst-cloud/contract.json` is the account's contract with its ETag. A keyless session's token rotates on its own and the file is rewritten atomically each time. `CATALYST_SKILLS_HOME` moves the directory. With no home directory (a container, or `HOME` unset or `/`) the config lands under `/`: stop, confirm this is the person's own machine, and set `CATALYST_SKILLS_HOME` if it is.

Logging in installs no skills. The person's agent installed the pack its own way; `references/skill-sources.md` covers installing and refreshing it.

## When login fails

- **"Your login expired or was revoked."** One fresh `catalyst login`. Routine expiry refreshes silently; this means the session was revoked or lapsed past the inactivity window.
- **A 401 on the key rail.** A stale, mistyped or revoked key: mint a new one at Settings → API keys.
- **A network error.** It names the URL; check `--base-url`.
- **A 403 on the contract naming an older cloud.** The cloud has not deployed personal-key access yet: update the cloud, or connect with the account key until it has.
- **A line naming two contract versions.** The account serves a contract outside this bundle's range: update the bundle (`npm install -g @catalyst-cloud/cli@latest && catalyst login`) before using the other skills.
- **A refusal naming `jwt-no-membership`.** The cloud has not met this person yet; it learns of a person at their first sign-in to the app. Have them sign in once, then run `login` again. If it repeats, their seat is not active, and an owner or admin activates it.

Never retry a failed login in a loop.

## Rules

- **The credential is a secret.** A key goes into the login command or `CATALYST_CLOUD_TOKEN` and nowhere else: never into a ticket, a transcript, or a file you write. Never read back the `auth` block a keyless session stores.
- **Read the update notice.** After a bundle update, the next command prints one line with the changelog entry and what to run; read it to the person if they are watching.
