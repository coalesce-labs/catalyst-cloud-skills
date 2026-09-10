---
name: linearis
description:
  Read and write Linear tickets for the customer's own tenant through its catalyst-cloud mirror — freshness-gated reads from the tenant API, writes through their existing Linear tooling. Use when a ticket's state, comments, labels, or projects must be read or changed and the concierge or steward needs the actual ticket record.
---

<!-- vendored-from: @catalyst-cloud/catalyst-skills — adapted from the catalyst repository's catalyst-dev plugin (plugins/dev/skills/linearis) for customer tenants -->

# Linearis — tickets through the tenant mirror

The customer's tenant mirrors their Linear and GitHub state. Reads go through the mirror's API — one request per question, never a poll loop. Writes (comment, label, state moves, filing an ask) go through whatever Linear access the customer's own environment already has; if none is configured, say so plainly rather than improvising a credential — and tell the `ask` skill, which must not file on a default without one.

`baseUrl`, `key`, and `account` come from `~/.config/catalyst-cloud/customer.json` (written by `catalyst-skills join`). Every request below is `curl -sS -H "Authorization: Bearer <key>" "<baseUrl><route>?account=<account>&…"`.

## Reading a ticket — freshness first, then the row

A stored row is only as current as the mirror's last successful pass, and the row itself does not say when that was. So a ticket read is **two requests**: the freshness probe, then the row.

1. **Gate on the freshness probe** — `GET /api/v1/freshness?account=<account>`. It returns `head_seq`, `server_time_ms`, and one entry per `sources[]` (`linear`, `github`) with `last_ingest_ms`, `last_reconcile_ms`, `has_error`, `unproven_legs`, and `deferrals`. Read the `linear` entry and classify before trusting anything:
   - **fresh**: `server_time_ms - last_reconcile_ms` under 15 minutes, `has_error` is `false`, `unproven_legs` is `[]`.
   - **stale**: `last_reconcile_ms` older than 15 minutes, or `has_error` is `true`, or `unproven_legs` is non-empty.
   - **inconclusive**: `last_reconcile_ms` is `null`, or `has_error` / `unproven_legs` is `null` — the mirror could not answer, which is not the same as healthy.
2. **Then read the row** — `GET /api/v1/issues/<id>?account=<account>` (the Linear identifier, e.g. `ABC-123`, or the id).

Report the verdict with the answer: a stale or inconclusive read is delivered **as** stale or inconclusive ("as of <last_reconcile_ms>, the mirror's Linear pass is N minutes old / errored"), never as current. Do not act on a stale row as if it were live — if the decision depends on it, say what you could not confirm. Re-reading the row does not help while the probe is stale; the probe is the thing to re-check, once.

## Listing and searching

- **Search** — `GET /api/v1/search?q=<terms>&account=<account>` (2–100 characters). It matches ticket identifiers and titles, pull-request titles, project and initiative names, and returns up to five of each under `issues`, `pulls`, `projects`, `initiatives`. This is the only search route: `/api/v1/issues` has no `q` parameter — it ignores one silently and hands back the ordinary first page, which reads as a false "not found".
- **List** — `GET /api/v1/issues?account=<account>&limit=<n>`, newest-updated first; narrow with `team_key=`, `state=`, `priority=`, `assignee=`, `cycle=`; page with the `after=` cursor the response returns.
- Projects: `/api/v1/projects`; cycles: `/api/v1/cycles`; initiatives: `/api/v1/initiatives`; pull requests: `/api/v1/pulls`. Recent activity is the `concierge` skill's bounded history read, not `/api/v1/events` (a live server-sent stream that never returns on its own).

## Rules

- **Read the ticket before acting on it.** Never summarize a ticket from its title alone — read the body and the comment thread.
- **Freshness over faith**: the mirror is near-live, not live, and only the freshness probe says how near. One probe per read; do not loop.
- **One request per question.** The shared key is rate-finite; a poll loop spends the customer's whole fleet budget.
- **Thread replies where they arrived** — a comment on a ticket is answered on that ticket, in-thread, never as a new top-level ticket.
- **Bookkeeping comments are marked**: anything you post that is a machine record (a merge note, a state-move log) starts its body with `[bookkeeping]`.
- **Never invent ticket ids.** Cite an identifier only after you read it back from the API.
