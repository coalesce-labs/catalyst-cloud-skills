---
name: catalyst-concierge
description: Operate Catalyst Cloud day-to-day the way it's designed to be worked — triage the Waiting-on-me ask queue, read tickets and boards, decide what to delegate to the cloud fleet vs decide yourself, and keep a human-readable status doc. Use when the user asks "what's waiting on me", wants to answer Catalyst asks, check on fleet work, or wants you to act as their Catalyst concierge/coordinator.
---

# Working Catalyst like a concierge

Catalyst's model: **the fleet works; humans decide.** Agents never sit idle waiting for a person —
when work needs a human, the agent files an *ask ticket*, blocks its own ticket on it, releases its
worker slot, and moves on. The human's whole job compresses into a triage queue.

## The ask queue

- The queue lives at **Waiting on me** in the app, and as tickets labeled `catalyst-ask` /
  `ask/decision` in Linear.
- Each ask presents options. Valid answers, in Linear: a bare option letter (`A`), the option text
  verbatim, or `DECIDED: <your answer>`. In the app: tap the option. An unrecognized reply is
  deliberately met with silence (no bot nagging) — so use the exact forms.
- Some decisions (anything that writes into the customer's own Linear as them) can only be
  confirmed in the app, never from a ticket comment — the reply will say so.
- Triage rhythm: batch the queue a few times a day. For each ask: answer it, or explicitly defer
  ("Default if silent" on the ask tells you what inaction does — silence is a valid choice when the
  default is right).

## Delegate vs decide

Send to the fleet (move to Todo): anything with clear acceptance criteria, reversible via PR, and
verifiable by checks. Keep for the human: irreversible actions, taste/priority calls, anything
touching production data or money, external communications.

The go signal is the **Todo** stage — Backlog is invisible to the fleet. To pause a queued chain,
add a blocked-by relation (blockers stop the NEXT claim; they don't kill in-flight work).

## Reading state

- A ticket's truth is its Linear thread: phase moves, artifacts, and asks all land there.
- The team card's readiness checklist answers "why isn't Catalyst working here" — read the named
  failing check before anything else.
- Trust evidence over status labels: a "done" without a merged PR link isn't done; a green deploy
  isn't a served feature until it's observed live.

## The status doc habit

Keep one short, plain-English status document per project, replaced (not appended) each update:
what shipped (with evidence), what's in flight, what needs the human, what's blocked. Write it like
you're briefing an executive — never make them read the raw board. Refresh on a cadence (≤90 min
while things move) and always timestamp it.

## When something looks broken

1. Reproduce or observe it once yourself before theorizing.
2. Check the narrow thing first (the failing check's own message, the ticket thread's last event).
3. Prefer the smallest reversible fix, shipped as a PR through the normal gate — then verify from
   an independent surface before reporting it fixed. Never claim a fix you haven't seen in a diff.
