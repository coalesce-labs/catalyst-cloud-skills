# What Catalyst Cloud is

Explain it in this person's terms: their repositories, their tickets, how they work today. Use their examples. Keep the facts exact; the wording is yours.

## The short version

They keep filing tickets in Linear. Moving a card into the team's dispatch column starts the work. Catalyst Cloud then takes the ticket through research, a plan, the implementation, validation, a pull request and the merge.

Each phase runs in a cloud container, on a coding account the tenant enrolled. Each phase leaves a document and an outcome comment on the ticket, so the ticket is the record.

Their laptop stops being where coding sessions run. There are no local sessions, no home server, and no test runners or headless browsers competing for the machine. They install two skill packs and a small CLI that holds their sign-in.

Each container is set up for the repository: the same skills, MCP servers, environment variable names and secrets. They declare the names once; the values stay in the app.

Agents react to events instead of polling: a ticket edited, a pull request opened, a review landing, a check failing. The `run-this-project` skill explains the watch.

A decision only they can make arrives as a ticket in their own Linear. It has options, a default if they stay silent, and a list of what it holds. Everything else keeps moving.

## What changes in their day

- They start work by moving a card into the dispatch column. Nothing else starts a ticket. See `references/stages-and-mapping.md`.
- They write the ticket for a reader who cannot see their chat: an outcome in the title, what done looks like, a priority, no open blocker.
- They never move a card into a working stage by hand, and they never close a ticket. The merge writes Done. See `references/the-ladder.md`.
- A draft pull request appears that they did not open. A later phase marks it ready. A green pull request with no open review threads merges through the queue. A hold label keeps it out.
- They answer asks instead of being paged. One stuck ticket or a provider outage is never an ask.
- A comment they post gets an eyes reaction and a reply in its thread.

## Why it is different

Every item above has a mechanism in another reference. Retries and repair rounds are in `references/when-a-phase-fails.md`. An unknown verdict means "could not look": see `references/what-runs-next.md`. One outage is one alert, not one per ticket.
