---
name: ask
description:
  Record a decision request to the human on the customer's catalyst-cloud tenant. Use when active work is gated on a decision only the human can make — a product/priority/approval call or an action only they can take. The ask carries the question, concrete options, a default that fires if they are silent, and what it blocks. Never use for brainstorming or questions the human asked first.
---

<!-- vendored-from: @catalyst-cloud/catalyst-skills — adapted from the catalyst repository's catalyst-dev plugin (plugins/dev/skills/ask) for customer tenants -->

# Ask — one decision, one record

An ask is a decision request with a deadline-shaped default. It exists so that a question the human must answer is **one record they can find**, not a TODO line, a chat message, or a hope.

## Shape of an ask

An ask always carries, verbatim:

1. **The question** — one sentence, as its title.
2. **Options** — the realistic choices, each one line.
3. **Default if silent** — what proceeds, and after how long. The default must be sane enough to actually run.
4. **Blocks** — what work is held until it is answered, named by ticket or scope.

## Where an ask lives

An ask is a **ticket in the tenant's own Linear**, labelled `catalyst-ask`, written through the same Linear write access the `linearis` skill uses (the customer's own Linear tooling and credential — never a credential you improvised). The tenant's mirror recognises that label and holds the ticket out of the dispatchable pool, so a question is never mistaken for work. Cite the ask's identifier only after the create call returned it.

## Rules

- **File the ask BEFORE proceeding on the default.** Work may continue on the default only after the ask ticket exists; it may never run gated on an unasked question, and it may never run on a default that has no ticket behind it.
- **One ask per decision.** Search for an existing ask first (`/api/v1/search?q=<terms>` through the `linearis` skill) — a duplicate splits one decision's urgency across two records.
- **The human answers in the ask**, and when the answer arrives elsewhere (chat), post it back to the ask so question, options, default, answer, and who answered are one record.
- **Never answer another role's ask**, and never answer as the human.
- **Not everything is an ask.** Brainstorming, design back-and-forth, and questions the human asked first need no ticket. Operational retries, provider outages, and anything another agent can decide are never asks.
- **Rank by blast radius**, not age: an ask that blocks a whole project outranks one that blocks a chore.

## When no ticket can be filed

If the tenant has no Linear write access wired up (the `linearis` skill reports none), the ask **cannot be filed, so the default does not fire**. Stop the gated work, and say so in your reply to the human with all four fields spelled out and the one action that unblocks everything: wire the Linear write path (or file the ask ticket by hand and tell you its identifier). Do not record the ask in a status summary, a TODO, or a handoff as a substitute — those are pointers to an ask, never the ask — and do not proceed on the default while no ticket exists.
