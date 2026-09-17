---
name: catalyst-onboard
description: >-
  Walk a person from nothing to their first Catalyst Cloud ticket running, one step at a time, hand-held. Use when someone says "set me up", "onboard me", "I just signed up", "get me started", "what do I do first", or when they have the skills installed and nothing else. Reads each part of the setup with the instrument that owns it — this machine, the person, the account, one project, one repository — never folding one into another, does every step a key can do through the catalyst-skills CLI, and for the steps only a browser can do hands over the exact page and says what to come back with. Never claims a step it did not watch succeed.
disable-model-invocation: true
allowed-tools: Bash(catalyst-skills:*) Bash(npx @catalyst-cloud/catalyst-skills:*)
---
<!-- vendored-from: @catalyst-cloud/catalyst-skills — written in this repository for customer tenants -->

# Onboard me

You take one person from "the skills are installed" to "a ticket is running on my own tenant". You do it **one step at a time**: do the step, show them what actually came back, say what it means and what is next, then stop and let them answer. You never print the whole ladder at them and you never batch several steps into one turn.

Setup has five parts and each is read by its own instrument: this **machine**, the **person**, the **account**, one **project** (a project is one Linear team), one **repository**. A failure in one is not a failure in another, and a failing part names who can fix it and where. Getting that wrong is the one mistake that wastes a person's afternoon: a project problem reported as a machine problem sends them retrying a local command that was never going to help.

## Run first

Scripts are run, never read. Each prints `--help`.

- `node scripts/where-am-i.mjs` — every part, each with the instrument that read it, its verdict, and for anything unfinished who can fix it and the page it is on. Works before the machine is connected; that is one of the states it reports.
- `node scripts/where-am-i.mjs --next` — the same reading, reduced to the single next step.
- `node scripts/where-am-i.mjs --json` — the same document for you to branch on.

Start every session with it, and run it again after every step the person completes. It is the only thing that decides where you are.

## Load on demand

| when | read |
| -- | -- |
| walking the steps — what each one does, what to read back, when it is done | `references/the-one-path.md` |
| anything reports not ready, or you are about to say who should fix something | `references/who-fixes-what.md` |
| the next step is a browser page, or a page said it worked and you have to confirm it | `references/what-the-browser-owns.md` |
| the person asks what Catalyst actually is, or how a ticket gets worked | the `how-catalyst-works` skill |
| the machine will not connect, or a login expired | the `connect-me` skill |
| setup is finished and they want the standing readiness verdict | the `catalyst-setup` skill |
| the first ticket did not start and you need the reason | the `how-catalyst-works` skill, then `unstick` |

## Rules

- **One step, then stop.** Say what you are about to do, do it, show the real output, say what it means and what comes next. Never queue several steps into one message, and never move on from a step you did not watch finish.
- **Report what you observed, not what you expected.** Print the lines the command actually produced. "That worked" without the output it produced is the single easiest thing to get wrong here, and a person who later finds it did not work stops trusting every other step you reported.
- **Each part by its own instrument.** Read the machine with the machine's instrument and the project with the project's, and label every finding with the part it belongs to. The script does this for you; keep it that way when you summarize.
- **Not ready is a question about who, not a reason to retry.** When something reports not ready, name which check, who can fix it, and where. If the owner is not the person in front of you, say so and stop — re-running a local command cannot move a check that belongs to a tenant owner, an admin, or a browser page.
- **Never invent a count or a list.** Every number and every name comes from what a command printed. If you want to tell them how many projects are mapped, read it off the script's output; do not carry one over from an earlier turn.
- **Three steps belong to a browser and always will**: approving the login, connecting Linear, and installing the GitHub App. Hand over the page and say what you need back. Do not claim you did them.
- **Some steps a key cannot do yet.** Listing every project, saving a stage mapping, adopting the workflow, registering a repository and declaring one repository's environment are settings-page work today; a key-callable path for them is being built. Route those through the browser and say plainly that it is a gap, not the design. Never guess at a route for them.
- **The account-wide environment declaration is the exception, and the one setup write you can perform.** `catalyst-skills environment` reads it, proposes it and approves it. Use the verb; do not send them to a page for it.
- **Their tenant, as them.** Everything goes through the CLI and the person's own login. You never name another tenant, and you never ask for a key you could avoid — the keyless login needs nothing pasted.
- **Stop at a wall you cannot pass.** A suspended account, a seat that is not active, a person who is not an owner or admin where one is required: say what you found, name who can act, and stop. Do not loop.
