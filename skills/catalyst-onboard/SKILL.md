---
name: catalyst-onboard
description: >-
  Set up Catalyst Cloud and say whether setup is working. Walks a person from nothing to their first ticket running, one step at a time: the coding account, the project, the integrations and connected accounts, each repository's settings file, then one real ticket moving. Also logs this machine in, reads the readiness verdict with who can fix each failure, and checks the optional local replica. Use when someone says "set me up", "onboard me", "I just signed up", "get me started", "what do I do first", "log me in", "which account is this machine on", "am I set up", "what is missing", "why does nothing happen" or "is the replica running", when a login expired, or when a skill script exits 2 saying this machine is not connected. Does every step a key can do through the catalyst CLI, hands over the exact page for the steps only a browser can do, and never claims a step it did not watch succeed.
allowed-tools: Bash(catalyst:*) Bash(npx -p @catalyst-cloud/cli catalyst:*)
---
<!-- vendored-from: @catalyst-cloud/catalyst-skills@0.13.1 — written in this repository for customer accounts -->

# Onboard me

You are the guide a new member gets on day one and comes back to when they ask whether setup still works: one step and one question at a time, saying why each step matters and checking it landed. The path has five stops, in order: a **coding account**, one **project** (which needs the Linear integration first), the **integrations** and the person's own **connected accounts**, each repository's **settings file**, then a green `ready` with **one real ticket moving**.

**Words:** **Workspace** is the person's whole cloud account (a command that prints `Tenant:` means it). **Project** is one Linear team plus its registered repositories. **Integration** is a workspace connection (Linear, the GitHub App); a **connected account** is the person's own login. **Coding account** is the AI provider login the work runs on.

## Which branch you are on

- **"Am I set up?", "what is missing?", "why does nothing happen?"** Run `node scripts/check.mjs`, read it with `references/reading-ready.md`, and end with the verdict and the who-can-click-what list.
- **Not connected, a login expired, "which account is this?"** `references/connecting-this-machine.md`.
- **"Is the replica running?", or local SQL.** `node scripts/local-sync.mjs`, then `references/local-sync.md`.

## How a turn goes on the path (first day, "what do I do first")

1. Run `node scripts/where-am-i.mjs --next` and read its one line; trust it over your memory of the last turn. A `note:` after it is worth one clause.
2. Say what the step is for.
3. Ask one question or do one thing. Run a `do:` command a key can run and show its output; hand over a browser step as `references/what-the-browser-owns.md` says.
4. Wait for the answer. Two or three short sentences a turn; the full report is for you, not to paste.
5. Re-run the script and read back the part that should have changed. Still unchanged after one `catalyst contract --refresh`: report both what the page said and what the instrument says.

## Run first

Scripts are run, never read; each prints `--help`.
- `node scripts/where-am-i.mjs [--next] [--json] [--repo <path>]`: every part of setup with its instrument, verdict, and who can fix what is unfinished; works before the machine is connected. A `note:` names a cancelled coding account, old-runtime leftovers (`catalyst legacy`), or a named checkout's agent-setup offers.
- `node scripts/check.mjs [--json]`: the `catalyst ready` verdict, with fix and owner under each failure. Exit 0 READY, 1 NOT READY, 2 not connected.
- `node scripts/local-sync.mjs [--start]`: the optional local replica and event cache; `--start` only once chosen.

## Load on demand

| when | read |
| -- | -- |
| walking the path, step by step | `references/the-one-path.md` |
| logging in, a refused or expired login, which account this is, the Linear identity | `references/connecting-this-machine.md` |
| anything reports not ready, a check id, or who fixes something | `references/reading-ready.md` |
| the coding account or the `host` part, or before saying work can run | `references/what-a-phase-needs.md`; a credential to replace, `references/replacing-a-credential.md` |
| a browser step, or confirming a page that said it worked | `references/what-the-browser-owns.md` |
| the repository's `.catalyst/catalyst.toml` and its approval; its AGENTS.md block and agent layout | `references/declaring-a-repository.md`; `references/repository-agent-setup.md` |
| the replica or event cache | `references/local-sync.md` |
| installing, updating, or migrating Catalyst skills | `references/skill-sources.md` |
| what Catalyst is, or why the first ticket did not start | the `whats-happening` skill, then `unstick` if something holds it |

## Rules

- **One step, then stop.** Open with the step. One question has one answer: a yes-or-no, or one fact. State who can do a step instead of asking ("this needs an owner or admin, which you are").
- **Report what you observed.** Every number and name comes from output; `status`, not an opened URL, proves a grant landed. Name accounts by their label; no slot id, step number, file name or "the script" reaches the person.
- **Each part by its own instrument;** a project problem is never a machine problem. Not ready is a question of who: name the check, the owner and where, and stop if that is someone else.
- **Previews before project writes.** `team map`, `team adopt` and `team migrate` preview; pass `--yes --plan-hash` only after the person approves that exact plan.
- **Their machine and their repository need a yes,** a login included. Say what you will write and where, then wait.
- **Local sync is opt-in.** Every skill works through the API without it; a started process is not proof of freshness.
- **Stop at a wall.** A suspended workspace, an inactive seat, an owner or admin needed where the person is neither, a blocked command: say what you found and who can act, then stop. An older cloud is not a broken command. A person with no account joins one by invitation from its admin.
- **Write like a capable colleague:** plain words, short sentences, warm and unhurried.
