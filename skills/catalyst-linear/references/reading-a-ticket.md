# Reading a ticket: freshness first, then the row

This reference restates invariants about how a read is made and reported. Nothing in it is a tenant value.

## Freshness first

Every `query` verb, and therefore `node scripts/read-ticket.mjs` and `node scripts/search.mjs`, prints one stderr line before the answer:

- `source: replica (cursor N)` — the local replica was fresh (its writer heartbeat is young and its cursor non-empty), so the answer is local and cheap. N is the position it had applied.
- `source: api (replica stale)`, `source: api (replica absent)` or `source: api (replica not configured)` — the answer came from the tenant API, which is origin-fresh: it reflects the mirror's latest ingest, not a cached copy.
- `source: api (<verb> is api-only)` — search, cycles, pull detail and change feeds are never served from the replica.

Read that line every time. A fresh replica is a preference; the API is the fallback and it is never wrong to read it. What is wrong is silently reading a stale replica, and the CLI does not let that happen: a stale replica falls back to the API and says so. Quote the source in your answer when the freshness of a fact matters ("as of the replica at cursor N" or "from the API just now").

`--source replica` or `--source api` forces one. Forcing the replica when it is absent or stale is refused.

## Then the row

One ticket read returns the whole record: the fields, the description, `labels[]`, `relations[]`, `linked_pulls[]`, `comments[]`, `activity[]` and `agent_sessions[]` inline, plus the project, cycle, team, delegate and parent fields. One call answers "what is this ticket, what happened on it, what is it waiting on, which PR is it". There is no second call to make for the comments.

The summary the script prints puts the counts first and the description last; `--comments` prints every comment with its id, author, time and whether the author is a bot. A comment with a `reply-to` marker is threaded under another; reply under the same parent when you answer it.

## Reading Catalyst's own writes

The comment shapes in `references/what-a-ticket-accumulates.md` tell you which comments are the cloud's. To answer "what happened to this ticket":

1. Phase-outcome comments, newest first, give the attempts and their results.
2. Remediate-attempt comments give the failure class each round repaired.
3. The projection-link comments name the documents; open the document (it is attached to the ticket) to read what a phase actually concluded. A fallback comment carries the body inline instead.
4. `linked_pulls[]` names the PR; `catalyst-github` reads it.
5. For "what will it do next", leave this skill: `how-catalyst-works` explains the eligibility row.

## When to read a transcript

A phase's transcript (the full session log) exists in the cloud per ticket, but this bundle has no verb for it yet. Read the artifact document first; it is the phase's own account of what it did. Reach for the transcript only when the document leaves the question open, and say that the bundle cannot fetch it so the human opens it from the ticket's attachments.

## What an account key cannot read

Per-ticket execution history beyond the comments (the attempt ledger, the remediation round count against the cap, park state and what releases it) is not readable with an account key yet; `catalyst-skills explain --history <ticket>` prints that by name and where to read it. Do not reconstruct a round count from comments and present it as the cap's count.

## How to cite

- Cite a ticket by its identifier (`KEY-123`), never by title alone, and only after you read it back from a script's output.
- Cite a comment by its id when you refer to it or reply under it.
- Cite a document by the title the projection comment gave it.
- Never summarise a ticket from its title. Read the description and the thread.

## Searching and listing

`node scripts/search.mjs <terms>` matches ticket identifiers and titles, PR titles, project and initiative names and returns a few of each. It is the only search; a list read with a filter is not a search and will hand back the ordinary first page, which reads as a false "not found". Lists (`catalyst-skills query issues --team <key>`, `query projects`, `query cycles`) are for a board view, not for finding one ticket.
