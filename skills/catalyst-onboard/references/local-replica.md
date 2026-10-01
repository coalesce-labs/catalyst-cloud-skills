# Local SQL on an opted-in machine

Load this only when `catalyst replica status --json` reports `configured: true`. On any other machine, setup is complete without a replica: every skill reads from the cloud, and `references/local-sync.md` explains how a person opts in if they ask for local SQL.

`configured: true` means this machine opted in: `CATALYST_REPLICA_DB` is set, or the machine paths file declares `replicaDb`. It does not mean the writer is running. `references/local-sync.md` reads liveness and starts the writer.

## Before any query

Run `catalyst replica status --probe --json`. Trust local rows only when `verdict` is `fresh` and `cursor` equals `head`. A first start seeds the whole snapshot, so a new replica reads stale until its cursor appears.

## Running SQL

- `catalyst replica sql "<one SELECT>" --json` runs one read-only `SELECT` and prints rows. Anything else is refused.
- `catalyst replica schema` prints every table with its columns; `catalyst replica schema <table>` prints one.
- `catalyst query issues --source replica`, `issue`, `pulls` and `projects` read the local copy through the same verbs as the cloud read. Without `--source replica`, they read the cloud.

Timestamps are milliseconds since the epoch. Rows with `removed_at` set were deleted upstream.

## First checks after a start

Is the copy populated?

```sql
select (select count(*) from issues where removed_at is null) as tickets,
       (select count(*) from pull_requests) as pull_requests,
       (select count(*) from projects) as projects
```

Which teams does it hold?

```sql
select team_key, count(*) as tickets from issues
where removed_at is null group by team_key order by team_key
```

Compare these counts with what the person sees in Linear. A team missing here is a scope question for the account, not a replica fault.

## Where the reading recipes live

Ticket recipes are in the `catalyst-linear` skill's local replica reference, and pull request recipes in the `catalyst-github` skill's. Both carry the same gate as this page.
