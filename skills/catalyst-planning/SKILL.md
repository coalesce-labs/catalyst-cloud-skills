---
name: catalyst-planning
description: Break goals into the ticket shape the Catalyst fleet executes best — outcome-first titles, tiered Gherkin acceptance criteria, and real dependency links that sequence the work. Use when the user wants to plan a feature or project for Catalyst, write or rewrite tickets, break down a PRD, or sequence a batch of work for the fleet.
---

# Planning work for the Catalyst fleet

Tickets are the fleet's program. A well-shaped ticket runs the whole ladder unattended; a vague one
burns a research phase discovering what you already knew. Shape them like this.

## Titles are use cases

`<Actor> should <outcome> [when <condition>] [so that <benefit>]` — bias hard toward short and
scannable (~120 chars). The actor is whoever benefits (a user, an operator, the scheduler — not
always human). **No mechanism, symbol, or file names in the title**: if you can't state the outcome
without naming internals, you don't understand the outcome yet.

Bad → good: "Fix preflight label scope" → "Preflight should pass in workspaces that have no
team-level labels".

## Bodies are tiered Gherkin

- **Features/behavior**: fenced ```gherkin Scenario blocks. Exactly ONE `When` per scenario;
  `Then` asserts something observable; concrete values, never "some user".
- **Bugs**: same, but `Then` states the CORRECT behavior and a `# CURRENTLY:` comment documents
  the break — the scenario goes green when fixed.
- **Chores/refactors**: Context / Motivation / Outcome prose instead — never a hollow scenario
  ("Then the code is cleaner").
- Put file refs, logs, and quotes under `## Technical notes` below the Gherkin — present but not
  leading.

## Dependencies are links, not prose

"Depends on X-123" in a description does nothing. Real prerequisites get **blocked-by relations**
at authoring time — the fleet sequences on them (a blocked ticket is skipped until its blocker is
Done). Two rules: link only true prerequisites (a false blocker stalls real work), and serialize
tickets that touch the same files with a blocked-by chain so parallel lanes don't collide.

## Sizing for the ladder

One ticket = one PR a reviewer can hold in their head. If the plan needs three PRs, write three
tickets and chain them. Anything needing a hand-step (a migration to apply, a dashboard toggle)
must say so loudly in the body — those route around the automated merge path.

## Batch planning

For a project: draft all tickets first, read the set for overlap and ordering, add the chains, and
only then release the first wave to Todo (Backlog is invisible to the fleet; Todo is the go
signal). Release in waves you can actually review — the point of the fleet is throughput you can
still verify.
