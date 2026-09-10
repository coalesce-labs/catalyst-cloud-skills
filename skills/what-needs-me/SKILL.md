---
name: what-needs-me
description: >-
  The human's decision inbox on a Catalyst Cloud tenant, and the one way an agent raises a decision on their behalf. Use when the person asks "what needs me?", "what am I blocking?", or when active work is gated on a choice only they can make. Lists open asks ranked by what each answer releases, files an ask through the cloud's ask route with the tenant's own template, and records the answer so the held work releases. Never answers as the human, never duplicates an open ask.
disable-model-invocation: true
allowed-tools: Bash(catalyst-skills:*) Bash(npx @catalyst-cloud/catalyst-skills:*)
---
<!-- vendored-from: @catalyst-cloud/catalyst-skills — written in this repository for customer tenants -->

# What needs me

An ask is one decision only the human can make, filed as a ticket in their own Linear so that question, options, default, answer and who answered are one record. This skill reads that inbox ranked by blast radius, raises a new ask when work is gated, and settles the answer so the held work releases. The cloud renders the ask body from the tenant's template, applies the ask labels and creates the blocking relations; you pass fields, never headings.

## Run first

Scripts are run, never read. Each prints `--help`; exit 2 means this machine is not connected (run the `connect-me` skill), exit 1 means the check itself failed or an argument was missing.

- `node scripts/inbox.mjs --help` — the open asks, ranked by the priority-weighted work each holds; `--json` for the rows.
- `node scripts/raise.mjs --help` — file one decision: `--team`, `--title`, `--option` (repeated), `--default`, and `--blocks` (repeated) or `--nothing-to-block`.
- `node scripts/settle.mjs --help` — record the answering comment on an ask and post a release note on every ticket it held; `--close` moves the ask to the done slot.

## Load on demand

| when | read |
| -- | -- |
| about to file an ask, or unsure whether something is one | `references/raising-a-decision.md` |
| presenting the inbox, or the person asks what "waiting on me" means | `references/reading-the-inbox.md` |
| an answer arrived, anywhere | `references/settling-an-answer.md` |

The `catalyst-linear` skill posts the comment that carries an answer given in chat and reads an ask's thread; `whats-happening` explains a held ticket that stays excluded after the answer.

## Rules

- **File before proceeding on the default.** Work may run on a default only after the ask exists; a default with no ticket behind it is a guess, not a decision.
- **One ask per decision.** Read the inbox first; attach new held tickets to an open ask rather than filing a twin. Duplicates split one decision's urgency across rows.
- **Every ask names what it blocks.** The ranking the human sees is by held work weighted by priority, never by age; an ask that holds nothing does not reach Waiting on me unless you chose `--nothing-to-block` on purpose.
- **Never answer as the human.** You do not pick an option, close an ask on their behalf, or post in their voice. Their answer is quoted into the ask as the app actor and recorded with its comment id.
- **A free-text reply is recorded, never interpreted into an option.** If it does not answer the question, ask the one clarification in the thread and leave the ask open.
- **Escalate inward.** A project owner raises asks for its scope; the desk raises what has no owner; a single stuck ticket or a provider outage is never an ask.
- **Tenant facts come from the contract.** Team keys, label names, the option cap and the template are read live by the CLI; never restate them.
- **Cite an identifier only after the create call returned it.**
