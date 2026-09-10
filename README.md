# @catalyst-cloud/catalyst-skills

The customer skill bundle for Catalyst Cloud (https://catalystcloud.dev). One command installs six Claude Code skills — `concierge`, `steward`, `ask`, `linearis`, `join`, and `setup` — into `~/.claude/skills` and joins your machine to your own tenant. It is for catalyst-cloud customers: every skill is plain Markdown you can read in this repository before you install it, the installer is this npm package, and the account key from your tenant admin is the only credential.

## Read the skills first

Every skill is a plain Markdown file under `skills/<name>/SKILL.md` in this repository. Read them before you install anything:

- [`skills/ask/SKILL.md`](skills/ask/SKILL.md)
- [`skills/concierge/SKILL.md`](skills/concierge/SKILL.md)
- [`skills/join/SKILL.md`](skills/join/SKILL.md)
- [`skills/linearis/SKILL.md`](skills/linearis/SKILL.md)
- [`skills/setup/SKILL.md`](skills/setup/SKILL.md)
- [`skills/steward/SKILL.md`](skills/steward/SKILL.md)

## Requirements

- Claude Code 2.0 or newer, which discovers skills in `~/.claude/skills`.
- Node 18.17 or newer (20 or newer recommended), which supplies the `npx` used below.
- Bun 1.0 or newer, optional, only if you prefer `bunx` over `npx`.
- An account key from your tenant admin. The key is the only tenant selector: you never type a tenant or account id.

## Install and join

The recommended form passes the key as an environment variable, because a key typed into a command line lands in your shell history:

```sh
CATALYST_CLOUD_TOKEN=<your-account-key> npx @catalyst-cloud/catalyst-skills join
```

If you accept the shell-history trade-off, the `--key` form is equivalent:

```sh
npx @catalyst-cloud/catalyst-skills join --key <your-account-key>
```

Or install the package globally once and run the command directly:

```sh
npm install -g @catalyst-cloud/catalyst-skills
CATALYST_CLOUD_TOKEN=<your-account-key> catalyst-skills join
```

`bunx @catalyst-cloud/catalyst-skills join` works in place of the `npx` form. A non-default cloud is set with `CATALYST_CLOUD_BASE_URL` or `--base-url <url>`.

`join` does all of this in one run:

1. Installs the six skills into your skills directory, `~/.claude/skills` by default (`--skills-dir <dir>` overrides it).
2. Calls `GET /api/v1/me` on the cloud with your key, which discovers your tenant from the key alone.
3. Writes `~/.config/catalyst-cloud/customer.json` with file mode `0600`; that file holds your key.
4. Prints what it did: the tenant it joined (`Joined <name> (<slug>) — account <account>`), the config path and mode, the skills installed, and the tenant contract range the package pins.

Re-running `join` after a key rotation rewrites the config. `catalyst-skills status` prints which tenant this machine is joined to; `catalyst-skills --version` prints the package version and its pinned tenant contract range.

## First use

Open a new Claude Code session and talk to the concierge about your own tenant — it reads the config `join` wrote. For example:

- Which tenant is this machine joined to, and who am I on it?
- Give me a status summary of my projects this cycle.

## The skills

| skill | purpose | file |
| --- | --- | --- |
| `concierge` | The one agent a human talks to on their tenant: status summaries, routing work to stewards, filing new work, and questions their tenant data answers. | [`SKILL.md`](skills/concierge/SKILL.md) |
| `steward` | The long-running owner of one initiative or project: makes work ready and visible, watches tickets until they close, and never writes product code itself. | [`SKILL.md`](skills/steward/SKILL.md) |
| `ask` | Records a decision request when active work is gated on a decision or action only the human can make. | [`SKILL.md`](skills/ask/SKILL.md) |
| `linearis` | Reads and writes Linear tickets for your tenant through its catalyst-cloud mirror, with freshness-gated reads. | [`SKILL.md`](skills/linearis/SKILL.md) |
| `join` | Joins this machine to your tenant in one step: installs the bundle and discovers the tenant from the account key. | [`SKILL.md`](skills/join/SKILL.md) |
| `setup` | Runs readiness checks before first real use of the bundle, and confirms everything lines up right after `join`. | [`SKILL.md`](skills/setup/SKILL.md) |

## Versions and origins

The package pins the tenant contract range `0.x`, recorded in `package.json` under `catalystCloud.tenantContractRange`, and reports it in `--version`, `status`, and `join`. The four vendored skills (`concierge`, `steward`, `ask`, `linearis`) carry a `vendored-from:` line naming their origin, the catalyst repository's catalyst-dev plugin; `join` and `setup` are written in this repository.

## What it writes on your machine

- Six skill directories under `~/.claude/skills/`: `ask`, `concierge`, `join`, `linearis`, `setup`, `steward`.
- One config file, `~/.config/catalyst-cloud/customer.json`, written with mode `0600`.

Nothing else. Your account key goes into that one config file and nowhere else.

## Updating

Update the package with `npm update -g @catalyst-cloud/catalyst-skills`, or run any command against the latest publish with `npx @catalyst-cloud/catalyst-skills@latest join`. The next `catalyst-skills` run prints a one-line notice:

```
[catalyst-skills] updated 0.1.0 → 0.2.0: <that version's CHANGELOG.md summary> · update with: npm update -g @catalyst-cloud/catalyst-skills (or: npx @catalyst-cloud/catalyst-skills@latest join)
```

The same run refreshes the installed skill copies to the new bundle before it records the new version, so a published skill fix reaches your machine. A skill directory you hand-edited is left alone and named in the output; `catalyst-skills install --force` replaces it. If the refresh fails, the old version stays recorded and the next command tries again and tells you to run `catalyst-skills install`.

## Uninstalling

```sh
rm -rf ~/.claude/skills/ask ~/.claude/skills/concierge ~/.claude/skills/join ~/.claude/skills/linearis ~/.claude/skills/setup ~/.claude/skills/steward
rm ~/.config/catalyst-cloud/customer.json
```

If you joined with `--skills-dir <dir>`, remove the six directories there instead. If you installed the package globally, also run `npm uninstall -g @catalyst-cloud/catalyst-skills`.

## If join fails

- `catalyst-skills: GET /me failed (401): credential not accepted — ask your tenant admin for a valid account key` — the key is stale or mistyped. Ask your tenant admin for a valid account key, then run `join` again.
- `catalyst-skills: GET /me failed (403): account-not-operational` — the tenant is suspended. This is an admin conversation on the tenant, not a local fix.
- `catalyst-skills: could not reach <url>: <detail>` — the machine cannot reach the cloud. The URL is named in the message; check `CATALYST_CLOUD_BASE_URL` or `--base-url`.

## License

MIT — see [LICENSE](LICENSE). How to contribute and how releases happen are described in [CONTRIBUTING.md](CONTRIBUTING.md).
