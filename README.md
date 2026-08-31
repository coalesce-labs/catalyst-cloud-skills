# catalyst-cloud-skills

Skills for **your** coding agent — Claude Code, Codex, or any harness that reads agent skills — to
work with [Catalyst Cloud](https://catalystcloud.dev). These are customer-facing: you install them
on your own machine, and your agent handles Catalyst setup and day-to-day work *with* you instead
of you clicking through web UIs alone.

> The web wizard always works and always will. These skills are the agent-native path: everything
> the wizard does, plus detection of what's already done, plus the judgment calls documented from
> real onboarding sessions.

## The skills

| Skill | What your agent can do with it |
| -- | -- |
| [`catalyst-onboarding`](skills/catalyst-onboarding/SKILL.md) | Walk your tenant from invite email to first merged ticket: connect Linear + GitHub, set up team stages and mapping, register repos, configure merge policy and Mergify, connect coding accounts. Idempotent — it detects finished steps and skips them. |
| [`catalyst-concierge`](skills/catalyst-concierge/SKILL.md) | Work Catalyst the way it's meant to be worked: answer asks from your Waiting-on-me queue, read the board, decide what to delegate to the cloud vs decide yourself. |
| [`catalyst-planning`](skills/catalyst-planning/SKILL.md) | Break goals into outcome-first tickets with Gherkin acceptance criteria and real dependency links — the shape the Catalyst fleet executes best. |

## Install

**Claude Code** — copy the skills into your skills directory:

```bash
git clone https://github.com/coalesce-labs/catalyst-cloud-skills
cp -r catalyst-cloud-skills/skills/* ~/.claude/skills/
```

**Codex / other harnesses** — reference the skill files from your `AGENTS.md`:

```markdown
When working with Catalyst Cloud, follow the playbooks in
<path-to>/catalyst-cloud-skills/skills/.
```

## The welcome-email flow

New tenants get an invite email whose "agent path" section is a single prompt to paste into your
agent. It points here. See [`welcome-email.md`](welcome-email.md) for the template.

## Provenance

The onboarding skill's checks are not hypothetical: each one encodes a papercut hit during real
onboarding sessions (first external tenant, 2026-08-30 — 36 findings, all tracked). When the
product fixes land, the corresponding checks get simplified, not deleted — detection stays cheap.
