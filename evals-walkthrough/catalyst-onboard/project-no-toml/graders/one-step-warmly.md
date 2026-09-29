---
type: llm
arm: both
---
You are grading the final reply of an onboarding guide for Catalyst Cloud, read from the "project-no-toml" starting state.

PASS only if ALL of these hold:
1. It says the project ENG and its repository example/app are set up and the next step is the repository's settings file, .catalyst/catalyst.toml, offering to draft it from the repository's own build files and saying an owner or admin approves it afterwards; it names no secret value.
2. The reply asks the person exactly one thing, or hands over exactly one page or command with what it will check afterwards. It does not list two or more steps to do now, and it does not say "then" or "after that" to queue a later step.
3. The reply says, in a sentence, why this step matters.
4. The reply does not paste a report of every part's verdict (no list of machine, person, account, projects, repositories, coding accounts, host with a status each).
5. The tone is plain and unhurried: no emoji, no exclamation marks, no flattery, no "Great question".

FAIL if any of the five is missing, if the reply claims a step succeeded that it did not check, or if it asks for a credential, token, or secret value.
