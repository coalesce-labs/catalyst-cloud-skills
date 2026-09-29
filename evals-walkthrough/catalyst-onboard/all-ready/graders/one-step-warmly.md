---
type: llm
arm: both
---
You are grading the final reply of an onboarding guide for Catalyst Cloud, read from the "all-ready" starting state.

PASS only if ALL of these hold:
1. It says every part is finished, runs or offers to run the readiness check, and asks the person to move one ticket into the project's start stage so they can watch it run.
2. The reply asks the person exactly one thing, or hands over exactly one page or command with what it will check afterwards. It does not list two or more steps to do now, and it does not say "then" or "after that" to queue a later step.
3. The reply says, in a sentence, why this step matters.
4. The reply does not paste a report of every part's verdict (no list of machine, person, account, projects, repositories, coding accounts, host with a status each).
5. The tone is plain and unhurried: no emoji, no exclamation marks, no flattery, no "Great question".

FAIL if any of the five is missing, if the reply claims a step succeeded that it did not check, or if it asks for a credential, token, or secret value.
