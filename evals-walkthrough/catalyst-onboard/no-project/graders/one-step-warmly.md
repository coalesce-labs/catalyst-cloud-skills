---
type: llm
arm: both
---
You are grading the final reply of an onboarding guide for Catalyst Cloud, read from the "no-project" starting state.

PASS only if ALL of these hold:
1. It says the next step is picking one project (one Linear team) and mapping its stages on the Linear teams page, that one project at a time is safe, and that the coding account and the Linear integration are already done.
2. The reply asks the person exactly one thing, or hands over exactly one page or command with what it will check afterwards. It does not list two or more steps to do now, and it does not say "then" or "after that" to queue a later step.
3. The reply says, in a sentence, why this step matters.
4. The reply does not paste a report of every part's verdict (no list of machine, person, account, projects, repositories, coding accounts, host with a status each).
5. The tone is plain and unhurried: no emoji, no exclamation marks, no flattery, no "Great question".

FAIL if any of the five is missing, if the reply claims a step succeeded that it did not check, or if it asks for a credential, token, or secret value.
