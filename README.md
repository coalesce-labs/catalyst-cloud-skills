# @catalyst-cloud/catalyst-skills

[![skills.sh](https://skills.sh/b/coalesce-labs/catalyst-cloud-skills)](https://skills.sh/coalesce-labs/catalyst-cloud-skills)

## Install

Start by pasting one sentence into the coding agent you already use:

```
Help me understand and set up Catalyst Cloud. Read https://staging.catalystcloud.dev/agent-guide.md first, then walk me through it step by step.
```

Your agent reads the guide, explains Catalyst Cloud in terms of your own repositories and tickets, finds out where it is running and what is already installed, and does the setup below itself — asking once before it writes to your machine. Everything else on this page is the reference it follows.

This repository supplies skills for setting up and operating a Catalyst Cloud tenant. A coding workstation also uses [`coalesce-labs/catalyst-dev-skills`](https://github.com/coalesce-labs/catalyst-dev-skills) for research, planning, implementation, review, and shipping.

Or by hand. One command, for every coding agent on the machine:

On an existing machine, inspect same-named skill paths before running either add command. The
commands replace existing directories and links; the inspection rule is below.

```sh
npx skills@latest add coalesce-labs/catalyst-cloud-skills --all -g
```

It installs every skill in the bundle for each agent it detects (Claude Code, Codex, Cursor, OpenCode and the rest). A coding workstation also installs the development pack:

```sh
npx skills@latest add coalesce-labs/catalyst-dev-skills --all -g
```

The two packs have different jobs and independent versions. Omit `-g` for a project-scoped Cloud skills install. Copied skills do not auto-update. Re-adding the pack also picks up newly added skills; `npx skills update` refreshes only names already in the lock. Before an add or refresh, inspect the active global lock at `$XDG_STATE_HOME/skills/.skill-lock.json` when XDG state is set, or `~/.agents/.skill-lock.json` otherwise. A project install uses its own `skills-lock.json`. Check every same-named agent path, not just the canonical lock entry. Proceed only if each destination is absent or a verified, unmodified copy of the intended pack or its symlink. Leave independent, changed, or uncertain copies in place. Do not schedule raw add commands as an unattended refresh. After that check, re-run the Cloud add command above with `-g` for a workstation or without `-g` inside a project.

<details><summary><strong>Alternative for Claude Code: the plugin marketplace</strong></summary>

The plugin installs this pack's same `skills/` tree as a managed bundle that updates when we ship. It needs a GitHub SSH key, and it does not load into the session you are already in — run `/reload-plugins` or restart afterwards. Pick one rail for this pack; installing both leaves you with every skill twice. The development pack has its own optional Claude plugin, `catalyst-dev@catalyst-dev-skills`.

```
/plugin marketplace add coalesce-labs/catalyst-cloud-skills
/plugin install catalyst@catalyst-cloud
```
</details>

<details><summary><strong>One agent at a time</strong></summary>

Codex:

```sh
npx skills@latest add coalesce-labs/catalyst-cloud-skills -a codex
```

Cursor:

```sh
npx skills@latest add coalesce-labs/catalyst-cloud-skills -a cursor
```

OpenCode, Amp, Windsurf and the rest:

```sh
npx skills@latest add coalesce-labs/catalyst-cloud-skills
```

Without `--all` the installer asks which skills to take and which agents to install them on.
</details>

### Then connect to your tenant

The skills call one CLI, and the CLI holds your credential. Install it once and connect this machine — the keyless way logs you in as yourself, with nothing to mint or paste:

```sh
npm install -g @catalyst-cloud/catalyst-skills
catalyst-skills login
catalyst-skills ready
```

`catalyst-skills login` with no key opens a device-code login: it prints a short code and a URL, you approve it in your browser, and this machine is connected as you. On a machine with no browser (a remote box, a container) the code and URL still work — approve them from your phone. The short-lived session refreshes silently afterwards, so you log in about once a year. `npx @catalyst-cloud/catalyst-skills login` works without the global install, and `bunx` works in place of `npx`. A non-default cloud is set with `CATALYST_CLOUD_BASE_URL` or `--base-url <url>`.

Prefer a key? Pass one instead — mint a **personal key** at Settings → API keys in the Catalyst Cloud app (every member can; no admin needed). The environment form keeps it out of your shell history:

```sh
CATALYST_CLOUD_TOKEN=<your-personal-key> catalyst-skills login
```

`--key <your-personal-key>` is the third form, for a script.

That is the whole setup. Everything below explains what you just installed.

## What this is

A set of skills that let your coding agent run your own Catalyst Cloud tenant (https://staging.catalystcloud.dev) from your seat: what is happening, what needs you, and what to do about it. They read your tenant through the Catalyst Cloud SDK, write to it through the tenant's agent proxy, and never compose a URL or run a tool of their own; every read, write and subscription is a `catalyst-skills` verb with `--help`. Every skill is plain Markdown under `skills/<name>/SKILL.md` in this repository, and your own login — a keyless device-code session, or a personal key — is the only credential. Your agent acts as you: the asks it raises and the comments it posts carry your name, and "what needs me" means you.

## What connecting does

`login` does three things: it calls `GET /api/v1/me` with your credential, which discovers your tenant and who you are from the credential alone; it writes `~/.config/catalyst-cloud/customer.json` with file mode `0600`, holding your credential (a keyless login session, or a personal key), who you are (id, label, role, your Linear user id) and the absolute path of the CLI so every skill script can spawn the same binary; and it fetches the tenant contract (`GET /api/v1/agent/contract`) and caches it at `~/.config/catalyst-cloud/contract.json` with its ETag, so stage names and ids, label ids, the ask template, thresholds and the route table come from your tenant, live, and no skill restates them.

A keyless session's access token is short-lived and rotates on its own: every request refreshes it within a minute of expiry and rewrites the config atomically, so you stay connected for months without logging in again. You only log in again if the session is revoked or you have been away long enough to lapse — then one clear line tells you to run `login`.

`login` does not install skills; the install command above did that. Re-running `login` after a key rotation, or to switch rails, rewrites the config. `catalyst-skills status` prints which tenant this machine is connected to and as whom, `catalyst-skills ready` prints one READY or NOT READY verdict with the fix for each failure and who can apply it, and `catalyst-skills --version` prints the package version and its pinned tenant contract range.

The setup skill Catalyst seeds into your repository ends by pointing at this same command. That served skill lives in the Catalyst Cloud application, not here; this is the only connect step a customer runs. The tenant's **account key** (Settings → Account keys, admin-minted) is a different credential — for a host or daemon that runs unattended — and is not what a person connects their own agent with: it would strip your name from everything your agent writes, and `login` says so if you use one.

## Requirements

- Node 22 or newer. The bundle uses Node's built-in SQLite module for the optional local replica, so there is no native dependency to build; if `better-sqlite3` resolves on the machine it is used instead. `catalyst-skills ready` names the exact reason when an older Node is found.
- Your personal key, minted by you at Settings → API keys. The key is the only tenant selector: you never type a tenant or account id. If your Linear identity is not matched yet, `login` says so; an admin matches it in Settings → Members, and until then "what needs me" shows everyone's asks.
- An agent that discovers skills. Claude Code loads the plugin; Codex, Cursor, OpenCode and the rest read the `skills/<name>/SKILL.md` files the `npx skills` installer writes.
- Bun is optional, only if you prefer `bunx` over `npx`.

## First use

Open a new session and ask about your own tenant. The skills read the config `login` wrote. For example:

- What's happening? Where are we, why is that stuck, what closed, what's next?
- What needs me?
- Run this project for me until it closes.
- Am I set up?

## What has to be running

Nothing, by default. After `login`, every read, write, ask and explanation goes to the cloud's origin-fresh API with the config file and the cached contract on disk. Two optional processes exist for people who want them:

| process | needed for | what it holds on disk | lifetime |
| --- | --- | --- | --- |
| none | every read, write, ask and explain | `customer.json` and `contract.json` | the default after login |
| `catalyst-skills replica start` | local SQL, cheap repeated reads, and local event `tail`, `wait-for`, and `query` | one SQLite file plus a bounded event cache under `$XDG_STATE_HOME/catalyst/events/` (fallback `~/.local/state/catalyst/events/`) | one long-running process; foreground by default, `--detach` writes a pidfile beside the database and returns; `login --start-replica` does the same at the end of login |
| `catalyst-skills watch` | a project owner reacting to its scope | one cursor file (`~/.config/catalyst-cloud/watch-cursor.json`) stamped with the tenant | lives inside the session that armed it; exits with it |

The check every skill runs first is `catalyst-skills replica status`, which needs no network: is the pidfile's process alive, is the writer-lock heartbeat younger than the staleness threshold, and is the cursor non-empty. It exits `0` for fresh, `1` for present but stale, `2` for not connected, `3` for absent, and prints one line either way (`--json` for scripts). A fresh replica is used; anything else falls back to the API and the skill says so in its answer. A skill never refuses to work because the replica is down and never silently reads a stale one. `replica status --probe` compares the local cursor against the cloud's head for the honest "how far behind" number; that is the only form that touches the network. `catalyst-skills replica stop` stops a detached writer.

`catalyst-skills events tail` follows new cached events, `events wait-for --type ... --ticket ... --timeout ...` performs a bounded wait, and `events query` reads retained history. These commands never write the cache or contact the cloud. The replica process is the single writer and reports an event-sync failure without terminating a healthy entity replica. The event cache keeps closed daily segments for at most seven days or 256 MiB per tenant and reports an explicit gap when a requested sequence has retired.

The replica is a Node process, not a service: the supported path is the plain command, and `skills/connect-me/references/keeping-the-replica-running.md` gives launchd and systemd examples for people who want the writer to survive a reboot.

## The skills

| skill | what the person says | what it does | file |
| --- | --- | --- | --- |
| `catalyst-onboard` | "Set me up. Onboard me. I just signed up — what do I do first?" | Walks you from nothing to your first ticket running, one step at a time: connect this machine, connect Linear, map one project, register one repository, then watch a card move. Reads each part of setup with the instrument that owns it and says who can fix anything unfinished and where. Hands over the steps only a browser can do instead of pretending to have done them. | [`SKILL.md`](skills/catalyst-onboard/SKILL.md) |
| `whats-happening` | "What's happening? Where are we? Why is that stuck? What's next?" | The desk for a tenant: reads the contract, what is running and queued, the eligibility explainer and the open asks, and answers in one reply with ticket ids. Routes work to a project owner and decisions to `what-needs-me`. | [`SKILL.md`](skills/whats-happening/SKILL.md) |
| `what-needs-me` | "What needs me? What am I blocking?" | The human's decision inbox, ranked by what each answer releases, and the one way an agent raises a decision on their behalf: files an ask through the cloud's ask route with the tenant's own template and records the answer so the held work releases. | [`SKILL.md`](skills/what-needs-me/SKILL.md) |
| `run-this-project` | "Run this project for me. Own it until it closes." | Single-threaded owner of one project: subscribes to the tenant stream for its scope, reacts to each change in the same turn, makes tickets ready and moves them to dispatch, parks what should stop, chases stalls, escalates inward, and keeps one status summary current. Never polls. | [`SKILL.md`](skills/run-this-project/SKILL.md) |
| `catalyst-setup` | "Am I set up? What is missing?" | Machine readiness plus tenant readiness from the contract's per-team checks, in one verdict: what passes, what is blocked, what is merely waiting, and who can click what. Reports; never repairs. | [`SKILL.md`](skills/catalyst-setup/SKILL.md) |
| `catalyst-linear` | "Show me the ticket, the history, what Catalyst wrote on it." | Reads a ticket with its comments, relations, labels, linked pull requests and agent sessions inline, from the replica when fresh and the API otherwise, always naming the source; writes comments, card moves, labels and new tickets as the app actor; knows what a ticket accumulates as Catalyst works it. | [`SKILL.md`](skills/catalyst-linear/SKILL.md) |
| `catalyst-github` | "Show me the PR, the checks, the review, the queue." | A ticket's pull request with its checks, reviews and review threads; whether it is mergeable under the repository's policy; what a PR accumulates as the ticket moves (the branch, the draft, the rewrite, the force-pushes, the labels, the queue). | [`SKILL.md`](skills/catalyst-github/SKILL.md) |
| `how-catalyst-works` | "How does this work? Why did it do that? How does it prioritise?" | The execution model as references loaded on demand: the eight-phase ladder, the eleven board slots and this team's live stage map, what happens when a phase fails, how the queue is ordered and routed, every exclusion reason, and the coding-account model. Scripts explain one ticket's eligibility in plain English. | [`SKILL.md`](skills/how-catalyst-works/SKILL.md) |
| `unstick` | "Why is this parked? Unpark it. Get things flowing again." | Reads why a ticket is not running and every park or hold on it, decides whether the recorded cause is fixed, previews the release and releases it the right way from your own login — or one failure class across a team — and raises an ask only for what a person has to do. | [`SKILL.md`](skills/unstick/SKILL.md) |
| `connect-me` | "Connect this machine to my tenant." | Connects the machine to the tenant with your own personal key, caches the tenant contract, verifies, and offers to start the replica. | [`SKILL.md`](skills/connect-me/SKILL.md) |
| `what-this-repo-needs` | "What env vars does this repo need? What does catalyst.env.json mean?" | Scans a repository offline — no login, no network — and lists the environment variable names it needs, grouped build/test, deploy-only and bindings, each with where it was found, what uses it, and where a local value would come from. Never reads or prints a value. Also validates a `catalyst.env.json` file with the same rules the cloud applies. | [`SKILL.md`](skills/what-this-repo-needs/SKILL.md) |

Some of these only read; the ones that write anything — or that drive you through writes, as `catalyst-onboard` does — are marked so an agent cannot invoke them on its own, and you ask for them by name. Each skill's own `SKILL.md` says which it is, in its frontmatter; no count lives in this sentence, because a count in a sentence goes wrong the first time the table above gains a row. Every skill declares `allowed-tools` scoped to this package's own binary, so none of them needs a blanket shell grant.

## What a key cannot see yet

Your personal key reads everything the skills need — tickets, pull requests, the eligibility explainer, the dispatch queue, fleet activity, per-ticket execution history (`catalyst-skills explain --history <ticket>`: phase attempts, remediation rounds, park state) and coding-account status (`catalyst-skills accounts`: provider, declared and observed state, window usage, walls, quarantine — never a credential; enrolling or pausing one is `<your cloud>/settings/coding-accounts`). It also releases a parked or held ticket once its cause is fixed: `catalyst-skills release <ticket> --because <what changed>` (the `unstick` skill runs it), recorded against your name and shown in the ticket's history. And it declares what your containers need: `catalyst-skills environment` reads the tenant-wide declaration, `environment propose --file <path> --approve` proposes and approves it in one compare-and-set, and the values behind the names stay in the app where you entered them — reading needs any active seat, proposing and approving need an admin or owner one. That is the account's own declaration — a repository's own `catalyst.env.json`, which `catalyst-setup` already reports on, is a separate thing, and it now has its own local, offline reporter: `catalyst-skills env inventory` lists the names a repository needs — never a value — and `env check` validates a `catalyst.env.json` file, neither needing a login (the `what-this-repo-needs` skill walks through both). One thing it cannot do, and the skills say so by name rather than guess:

- Read pull-request labels or the reviewer's reaction. The mirror does not carry them; GitHub's own page does.

## Versions and origins

The package pins the tenant contract range `1.x`, recorded in `package.json` under `catalystCloud.tenantContractRange`, and reports it in `--version`, `status` and `login`. A tenant whose contract version falls outside that range is refused with one line naming both versions; update the bundle. Every skill carries a `vendored-from:` line naming this package as its origin, and that line now also carries the version it was vendored at; all of them are written in this repository for customer tenants.

## What it writes on your machine

- `~/.config/catalyst-cloud/customer.json`, written with mode `0600`, holding your personal key, who you are, and the CLI path.
- `~/.config/catalyst-cloud/contract.json`, the cached tenant contract.
- `~/.config/catalyst-cloud/published.json`, the cached answer to "what is the newest release" — no credential in it.
- Only if you start them: `~/.config/catalyst-cloud/replica.db` with its `.pid`, `.writer.lock` and `.writer.state` sidecars, `$XDG_STATE_HOME/catalyst/events/<tenant>/backbone/` (or the home-directory fallback) with bounded daily event segments, and `~/.config/catalyst-cloud/watch-cursor.json`.

The skill files themselves are written by whichever install command you ran, in that tool's own location. Your personal key goes into that one config file and nowhere else.

## Updating

A plugin install updates when we ship. Skills copied by `npx skills add` do not. After the source and destination check in Install, re-run the Cloud add command to refresh existing skills and pick up new ones. Update the CLI with `npm install -g @catalyst-cloud/catalyst-skills@latest && catalyst-skills login` — the re-login rewrites the CLI path the skills spawn, so they stop running the old bundle. To run one command against the latest publish without installing, use `npx @catalyst-cloud/catalyst-skills@latest login`. The next `catalyst-skills` run prints a one-line notice:

```
[catalyst-skills] updated 0.1.1 → 0.2.0: <that version's CHANGELOG.md summary> · update with: npm install -g @catalyst-cloud/catalyst-skills@latest && catalyst-skills login
```

A `customer.json` written by an older bundle is still read unchanged; it gains the CLI path and the cached contract the next time you run `catalyst-skills login`.

`catalyst-skills ready` also says when either the installed skills or the CLI is behind the latest publish, naming both versions and the command for each; it is a note, never a failure, and `--offline` (or `CATALYST_SKILLS_OFFLINE=1`) skips the lookup.

## Uninstalling

Remove the skills the way you installed them: `/plugin uninstall catalyst@catalyst-cloud` in Claude Code, or delete the skill directories (`catalyst-github`, `catalyst-linear`, `catalyst-onboard`, `catalyst-setup`, `connect-me`, `how-catalyst-works`, `run-this-project`, `unstick`, `what-needs-me`, `what-this-repo-needs`, `whats-happening`) from wherever `npx skills add` wrote them. Then remove what the CLI wrote:

```sh
catalyst-skills replica stop
rm -f ~/.config/catalyst-cloud/customer.json ~/.config/catalyst-cloud/contract.json ~/.config/catalyst-cloud/published.json ~/.config/catalyst-cloud/watch-cursor.json
rm -f ~/.config/catalyst-cloud/replica.db ~/.config/catalyst-cloud/replica.db.pid ~/.config/catalyst-cloud/replica.db.writer.lock ~/.config/catalyst-cloud/replica.db.writer.state
rm -rf "${XDG_STATE_HOME:-$HOME/.local/state}/catalyst/events"
npm uninstall -g @catalyst-cloud/catalyst-skills
```

## If login fails

- `catalyst-skills: GET /me failed (401): credential not accepted — mint a personal key at Settings → API keys and log in again` — the key is stale, mistyped or revoked. Mint a new one, then run `login` again.
- `catalyst-skills: GET /me failed (403): account-not-operational` — the tenant is suspended. This is an admin conversation on the tenant, not a local fix.
- `catalyst-skills: could not reach <url>: <detail>` — the machine cannot reach the cloud. The URL is named in the message; check `CATALYST_CLOUD_BASE_URL` or `--base-url`.
- A line naming two contract versions after `Connected to` — the tenant serves a contract outside this bundle's `1.x` range. The config is written; update the bundle before using the other skills.
- `[catalyst-skills] GET /api/v1/agent/contract refused (403): this cloud is older than the bundle …` on stderr — the cloud has not yet deployed personal-key access to the contract. Update the cloud, or connect with the tenant's account key until it has.

## License

MIT — see [LICENSE](LICENSE). How to contribute and how releases happen are described in [CONTRIBUTING.md](CONTRIBUTING.md). The install commands above are one canonical block kept in [`.agents/install-block.md`](.agents/install-block.md); change them there first.
