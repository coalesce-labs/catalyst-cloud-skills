# @catalyst-cloud/catalyst-skills

The customer skill bundle for **catalyst-cloud**: install the concierge, steward, ask, linearis, join and setup skills from npm and join your tenant in one documented step. Customer zero needs no Coalesce Labs repository — everything the customer touches is this package and their tenant's cloud.

## Requirements

| piece | minimum |
| -- | -- |
| Claude Code | 2.0 (skills are discovered from `~/.claude/skills`) |
| Node | 18.17 (20+ recommended; ships the `npx` used below) |
| Bun | 1.0 — optional, only if you prefer `bunx` over `npx` |

You also need an **account key** from your tenant admin. The key is the only credential and the only tenant selector — you never type a tenant or account id.

## Install and join — one step

```sh
npx @catalyst-cloud/catalyst-skills join --key <your-account-key>
```

That single command does everything:

1. **Installs the skills** where Claude Code discovers them (`~/.claude/skills/`): `concierge`, `steward`, `ask`, `linearis`, `join`, `setup`.
2. **Discovers your tenant from the key** — it calls `GET /api/v1/me` on the cloud, which answers `{account, slug, name, permissions, principal}` for exactly whoever the key already proves you to be. No tenant is ever typed, guessed, or defaulted.
3. **Writes config** to `~/.config/catalyst-cloud/customer.json` (mode `0600` — it holds your key; nothing else ever reads or copies it).
4. Prints the tenant it joined (`Joined <name> (<slug>)`), so you can see you landed in the right place.

Open a new Claude Code session and just talk to the concierge — it answers about **your own tenant**, reading it with the config the join wrote.

### Plain global-install form

```sh
npm install -g @catalyst-cloud/catalyst-skills
catalyst-skills join --key <your-account-key>
```

`bunx @catalyst-cloud/catalyst-skills join --key …` works identically. The key may also be provided via `CATALYST_CLOUD_TOKEN`; a non-default cloud via `CATALYST_CLOUD_BASE_URL` or `--base-url`. Re-running join after a key rotation rewrites the config; `catalyst-skills status` shows which tenant this machine belongs to.

### If join fails

- `401 credential not accepted` — stale or mistyped key; ask your tenant admin. Never retry in a loop.
- `403 account-not-operational` — the tenant is suspended; an admin conversation, not a local fix.
- Network error — the URL is named in the message; check `--base-url`.

## What comes from where

This package is **self-contained: nothing in it is a hard dependency on any Coalesce Labs repository**, and you never need to read one to find a second step.

- **`concierge`, `steward`, `ask`, `linearis`** are vendored, customer-adapted editions of skills that originate in the **catalyst repository's `catalyst-dev` Claude Code plugin** (`coalesce-labs/catalyst`, `plugins/dev/skills/…`). That repository is private and its plugin marketplace (`/plugin marketplace add coalesce-labs/catalyst`) is **not installable by customers today**, so the bundle vendors the four skills at publish time instead of depending on the marketplace. Each vendored `SKILL.md` carries a `vendored-from:` provenance line. Upstream, CTL-2299 and CTL-2300 are removing the fleet-owner defaults from those skills; until they land, this package's copies carry the customer adaptation.
- **`join` and `setup`** are written here, against the public cloud API surface (`GET /api/v1/me`).

## Version contract

This package is versioned against the **tenant contract** route. That route is still in flight (CTC-1924), so until it lands the package pins a **placeholder contract range `0.x`** — recorded in `package.json` under `catalystCloud.tenantContractRange` and echoed by `catalyst-skills --version` and `join`. When CTC-1924 lands, the placeholder is replaced with the real range and a mismatch becomes a loud, actionable error rather than a silent guess.

## Updates (one-line notice)

After you update the package (`npm update -g @catalyst-cloud/catalyst-skills`, or just run any `npx @catalyst-cloud/catalyst-skills@latest …` command), the **next session** — the next `catalyst-skills` command or skill that runs — prints exactly one line:

```
[catalyst-skills] updated 0.1.0 → 0.2.0: <that version's changelog entry> · update with: npm update -g @catalyst-cloud/catalyst-skills (or: npx @catalyst-cloud/catalyst-skills@latest join)
```

and never prints it again for that version. `catalyst-skills notice` is the skill-facing entry point for that line.

The same run also **refreshes the copied skills** under your skills directory (the one `join` recorded in `customer.json`, `~/.claude/skills` by default) to the new bundle before the new version is recorded — `npm update -g` replaces the package, not the copies `join` made, so without this step a published skill fix would never reach an existing install. A skill directory you wrote yourself is left alone and named in the output (`catalyst-skills install --force` replaces it). If the refresh fails, the old version stays recorded and the next command tries again, telling you to run `catalyst-skills install`.

## For the package maintainers

Published **only** by the `skills-bundle publish` GitHub Actions workflow on a `skills-bundle-v*` tag — never from a laptop. The workflow runs this package's smoke test (pack the tarball, install it into a clean directory, run `join` against a fixture `/me` server) before `npm publish`, so a broken publish cannot ship. The npm credential is the repository secret **`NPM_PUBLISH_TOKEN`** — an automation-token grant on the `@catalyst-cloud` scope.
