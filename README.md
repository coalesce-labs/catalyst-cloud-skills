# @catalyst-cloud/catalyst-skills

The customer skill bundle for Catalyst Cloud (https://catalystcloud.dev). One command joins your machine to your own tenant and installs eight skills named from your seat: `whats-happening`, `what-needs-me`, `run-this-project`, `am-i-set-up`, `catalyst-linear`, `catalyst-github`, `how-catalyst-works` and `join`. The skills read your tenant through the Catalyst Cloud SDK, write to it through the tenant's agent proxy, and never compose a URL or run a tool of their own: every read, write and subscription is a `catalyst-skills` verb with `--help`. Every skill is plain Markdown under `skills/<name>/SKILL.md` in this repository, and the account key from your tenant admin is the only credential.

## Requirements

- Claude Code 2.0 or newer, which discovers skills in `~/.claude/skills`. Codex and OpenCode read the same `skills/<name>/SKILL.md` files.
- Node 22.15 or newer. The bundle uses Node's built-in SQLite module for the optional local replica, so there is no native dependency to build; if `better-sqlite3` resolves on the machine it is used instead. `catalyst-skills ready` names the exact reason when an older Node is found.
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

`catalyst-skills login` is the same verb under the name the skills print when a machine is not joined yet. `bunx @catalyst-cloud/catalyst-skills join` works in place of the `npx` form. A non-default cloud is set with `CATALYST_CLOUD_BASE_URL` or `--base-url <url>`.

`join` does all of this in one run:

1. Calls `GET /api/v1/me` on the cloud with your account key, which discovers your tenant from the key alone.
2. Writes `~/.config/catalyst-cloud/customer.json` with file mode `0600`. That file holds your key and the absolute path of this CLI, so every skill script can spawn the same binary you installed.
3. Fetches the tenant contract (`GET /api/v1/agent/contract`) and caches it at `~/.config/catalyst-cloud/contract.json` with its ETag. Stage names and ids, label ids, the ask template, thresholds and the route table come from there, live; no skill restates them.
4. Installs the eight skills into your skills directory, `~/.claude/skills` by default (`--skills-dir <dir>` overrides it).
5. Prints what it did: the tenant it joined (`Joined <name> (<slug>) — account <account>`), the config path and mode, the skills installed, the contract version cached, and the tenant contract range the package pins.

Re-running `join` after a key rotation rewrites the config. `catalyst-skills status` prints which tenant this machine is joined to; `catalyst-skills ready` prints one READY or NOT READY verdict with the fix for each failure and who can apply it; `catalyst-skills --version` prints the package version and its pinned tenant contract range.

### One join

The setup skill Catalyst seeds into your repository ends by pointing at this same command. That served skill lives in the Catalyst Cloud repository, not here; this bundle's `join` is the only join a customer runs, and the credential is called the account key everywhere, in both places.

## First use

Open a new Claude Code session and ask about your own tenant. The skills read the config `join` wrote. For example:

- What's happening? Where are we, why is that stuck, what closed, what's next?
- What needs me?
- Run this project for me until it closes.
- Am I set up?

## The skills

| skill | what the person says | what it does | file |
| --- | --- | --- | --- |
| `whats-happening` | "What's happening? Where are we? Why is that stuck? What's next?" | The desk for a tenant: reads the contract, what is running and queued, the eligibility explainer and the open asks, and answers in one reply with ticket ids. Routes work to a project owner and decisions to `what-needs-me`. | [`SKILL.md`](skills/whats-happening/SKILL.md) |
| `what-needs-me` | "What needs me? What am I blocking?" | The human's decision inbox, ranked by what each answer releases, and the one way an agent raises a decision on their behalf: files an ask through the cloud's ask route with the tenant's own template and records the answer so the held work releases. | [`SKILL.md`](skills/what-needs-me/SKILL.md) |
| `run-this-project` | "Run this project for me. Own it until it closes." | Single-threaded owner of one project: subscribes to the tenant stream for its scope, reacts to each change in the same turn, makes tickets ready and moves them to dispatch, parks what should stop, chases stalls, escalates inward, and keeps one status summary current. Never polls. | [`SKILL.md`](skills/run-this-project/SKILL.md) |
| `am-i-set-up` | "Am I set up? What is missing?" | Machine readiness plus tenant readiness from the contract's per-team checks, in one verdict: what passes, what is blocked, what is merely waiting, and who can click what. Reports; never repairs. | [`SKILL.md`](skills/am-i-set-up/SKILL.md) |
| `catalyst-linear` | "Show me the ticket, the history, what Catalyst wrote on it." | Reads a ticket with its comments, relations, labels, linked pull requests and agent sessions inline, from the replica when fresh and the API otherwise, always naming the source; writes comments, card moves, labels and new tickets as the app actor; knows what a ticket accumulates as Catalyst works it. | [`SKILL.md`](skills/catalyst-linear/SKILL.md) |
| `catalyst-github` | "Show me the PR, the checks, the review, the queue." | A ticket's pull request with its checks, reviews and review threads; whether it is mergeable under the repository's policy; what a PR accumulates as the ticket moves (the branch, the draft, the rewrite, the force-pushes, the labels, the queue). | [`SKILL.md`](skills/catalyst-github/SKILL.md) |
| `how-catalyst-works` | "How does this work? Why did it do that? How does it prioritise?" | The execution model as references loaded on demand: the eight-phase ladder, the eleven board slots and this team's live stage map, what happens when a phase fails, how the queue is ordered and routed, every exclusion reason, and the coding-account model. Scripts explain one ticket's eligibility in plain English. | [`SKILL.md`](skills/how-catalyst-works/SKILL.md) |
| `join` | "Join this machine to my tenant." | Binds the machine to the tenant with the account key, caches the tenant contract, verifies, and offers to start the replica. | [`SKILL.md`](skills/join/SKILL.md) |

Four skills only read (`whats-happening`, `am-i-set-up`, `catalyst-github`, `how-catalyst-works`). The four that write anything (`catalyst-linear`, `what-needs-me`, `run-this-project`, `join`) are marked so an agent cannot invoke them on its own; the person asks for them.

## What has to be running

Nothing, by default. After `join`, every read, write, ask and explanation goes to the cloud's origin-fresh API with the config file and the cached contract on disk. Two optional processes exist for people who want them:

| process | needed for | what it holds on disk | lifetime |
| --- | --- | --- | --- |
| none | every read, write, ask and explain | `customer.json` and `contract.json` | the default after join |
| `catalyst-skills replica start` | local SQL, cheap repeated reads, `replica sql` and `replica schema` | one SQLite file (`~/.config/catalyst-cloud/replica.db`), a writer lock with a heartbeat beside it, and a cursor row inside the database | long-running; foreground by default, `--detach` writes a pidfile beside the database and returns; `join --start-replica` does the same at the end of join |
| `catalyst-skills watch` | a project owner reacting to its scope | one cursor file (`~/.config/catalyst-cloud/watch-cursor.json`) stamped with the tenant | lives inside the session that armed it; exits with it |

The check every skill runs first is `catalyst-skills replica status`, which needs no network: is the pidfile's process alive, is the writer-lock heartbeat younger than the staleness threshold, and is the cursor non-empty. It exits `0` for fresh, `1` for present but stale, `2` for not joined, `3` for absent, and prints one line either way (`--json` for scripts). A fresh replica is used; anything else falls back to the API and the skill says so in its answer. A skill never refuses to work because the replica is down and never silently reads a stale one. `replica status --probe` compares the local cursor against the cloud's head for the honest "how far behind" number; that is the only form that touches the network. `catalyst-skills replica stop` stops a detached writer.

Nothing rotates. The replica is upserts and deletes into one file, the cursor is a row, and the watch cursor is a few bytes; there is no directory of old files to clean. It is a Node process, not a service: the supported path is the plain command, and `skills/join/references/keeping-the-replica-running.md` gives launchd and systemd examples for people who want the writer to survive a reboot.

## What a key cannot see yet

Two facts have no tenant-facing route today, and the skills say so by name rather than guess:

- Coding-account status (provider, declared and observed state, window usage, walls, quarantine). `catalyst-skills accounts` prints "not visible to an account key yet" and points at `<your cloud>/settings/coding-accounts`, where the tenant's settings page shows it.
- Per-ticket execution history (phase attempts, remediation rounds, park state). `catalyst-skills explain --history <ticket>` prints the same kind of line and points at `<your cloud>/settings`. What a key can see is the eligibility explainer, the dispatch queue, fleet activity, agent sessions and lease attributions, which is what `explain`, `running` and `queue` read.

## Versions and origins

The package pins the tenant contract range `1.x`, recorded in `package.json` under `catalystCloud.tenantContractRange`, and reports it in `--version`, `status` and `join`. A tenant whose contract version falls outside that range is refused with one line naming both versions; update the bundle. Every skill carries a `vendored-from:` line naming this package as its origin; all eight are written in this repository for customer tenants.

## What it writes on your machine

- Eight skill directories under `~/.claude/skills/`: `am-i-set-up`, `catalyst-github`, `catalyst-linear`, `how-catalyst-works`, `join`, `run-this-project`, `what-needs-me`, `whats-happening`.
- `~/.config/catalyst-cloud/customer.json`, written with mode `0600`, holding your account key and the CLI path.
- `~/.config/catalyst-cloud/contract.json`, the cached tenant contract.
- Only if you start them: `~/.config/catalyst-cloud/replica.db` with its `.pid` and `.writer.lock` sidecars, and `~/.config/catalyst-cloud/watch-cursor.json`.

Your account key goes into that one config file and nowhere else.

## Updating

Update the package with `npm update -g @catalyst-cloud/catalyst-skills`, or run any command against the latest publish with `npx @catalyst-cloud/catalyst-skills@latest join`. The next `catalyst-skills` run prints a one-line notice:

```
[catalyst-skills] updated 0.1.1 → 0.2.0: <that version's CHANGELOG.md summary> · update with: npm update -g @catalyst-cloud/catalyst-skills (or: npx @catalyst-cloud/catalyst-skills@latest join)
```

The same run refreshes the installed skill copies to the new bundle before it records the new version, so a published skill fix reaches your machine. A skill directory you hand-edited is left alone and named in the output; `catalyst-skills install --force` replaces it. If the refresh fails, the old version stays recorded and the next command tries again and tells you to run `catalyst-skills install`. A `customer.json` written by an older bundle is still read unchanged; it gains the CLI path and the cached contract the next time you run `join`.

## Uninstalling

```sh
rm -rf ~/.claude/skills/am-i-set-up ~/.claude/skills/catalyst-github ~/.claude/skills/catalyst-linear ~/.claude/skills/how-catalyst-works ~/.claude/skills/join ~/.claude/skills/run-this-project ~/.claude/skills/what-needs-me ~/.claude/skills/whats-happening
catalyst-skills replica stop
rm -f ~/.config/catalyst-cloud/customer.json ~/.config/catalyst-cloud/contract.json ~/.config/catalyst-cloud/watch-cursor.json
rm -f ~/.config/catalyst-cloud/replica.db ~/.config/catalyst-cloud/replica.db.pid ~/.config/catalyst-cloud/replica.db.writer.lock
```

If you joined with `--skills-dir <dir>`, remove the eight directories there instead. If you installed the package globally, also run `npm uninstall -g @catalyst-cloud/catalyst-skills`.

## If join fails

- `catalyst-skills: GET /me failed (401): credential not accepted — ask your tenant admin for a valid account key` — the key is stale or mistyped. Ask your tenant admin for a valid account key, then run `join` again.
- `catalyst-skills: GET /me failed (403): account-not-operational` — the tenant is suspended. This is an admin conversation on the tenant, not a local fix.
- `catalyst-skills: could not reach <url>: <detail>` — the machine cannot reach the cloud. The URL is named in the message; check `CATALYST_CLOUD_BASE_URL` or `--base-url`.
- A line naming two contract versions after `Joined` — the tenant serves a contract outside this bundle's `1.x` range. The config is written; update the bundle before using the other skills.
- `[catalyst-skills] GET /api/v1/agent/contract refused (403): the contract needs an account key` on stderr — the key is a workstation key, which joins but cannot read the contract or the machine-only routes. Ask your tenant admin for an account key for the full set.

## License

MIT — see [LICENSE](LICENSE). How to contribute and how releases happen are described in [CONTRIBUTING.md](CONTRIBUTING.md).
