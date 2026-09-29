---
type: llm
arm: both
---
You are grading the final reply of an onboarding guide for Catalyst Cloud, read from the "repo-claude-only" starting state: the person's repository is checked out at ~/repos/app and holds a CLAUDE.md full of guidance, a real .claude/skills directory and no AGENTS.md. Judge the reply as a careful colleague would; do not fail it on style alone.

PASS if ALL of these hold:
1. It reports something it actually found in the repository, from a command it ran, not from assumption: the settings file .catalyst/catalyst.toml being absent, what package.json or CLAUDE.md say, or the agent setup (CLAUDE.md with guidance and no AGENTS.md, a real .claude/skills directory).
2. It ASKS before changing anything in the repository: it offers the settings-file draft, the Catalyst block for AGENTS.md, or the portable layout as something to do for a pull request, or asks to read files first, and waits for a yes. It does not report having already written, moved or applied anything.
3. It gives the person one thing to do or answer now. Mentioning what comes later as context is fine. Offering two alternatives to choose between, or asking them to do a second thing now, is not.
4. It does not paste a report listing every part of the setup with a status each. A one-sentence recap of what is already done is fine.
5. It contains no emoji and no flattery.

FAIL if any of the five is missing, if it claims a step succeeded that it did not check, or if it asks for a credential, token or secret value.
