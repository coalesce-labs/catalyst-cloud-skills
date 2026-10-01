# Reading a ticket from the local replica (opt-in)

Load this only when `catalyst replica status --json` reports `configured: true`. On any other machine, read from the cloud (`references/reading-from-the-cloud.md`) and do not mention the replica.

The replica is an on-machine SQLite copy of the account. It exists only when the person opted in to local sync. It is for ad hoc SQL and many repeated reads. It is never required, and the cloud read stays the default.

## Check it is caught up first

Run `catalyst replica status --probe --json` before every local read.

- Read locally only when `verdict` is `fresh` and `cursor` equals `head`. That proves the copy is caught up with the cloud at that moment.
- `fresh` without the probe proves a live writer, not a caught-up copy.
- `stale` (exit 1) or `absent` (exit 3) with `configured: true` means the person opted in and the writer is down. Answer from the cloud and say the local copy is behind. `catalyst replica start --detach` restarts it, but only start it when the person asks.

Quote the cursor with any local answer, for example "from the local replica at cursor 4810".

## Two ways to read it

- `catalyst query issue <KEY-123> --source replica` reads the ticket from the local copy. A replica built by an older SDK can lack fields the cloud read has, such as `linked_pulls`. `--source replica` on an absent replica is refused, never silently answered from the API.
- `catalyst replica sql "<one SELECT>" --json` runs one read-only `SELECT` and prints rows. Anything other than a single `SELECT` is refused.

`catalyst replica schema` prints every table with its columns, and `catalyst replica schema <table>` prints one. Read the columns before writing SQL against a table this page does not cover.

## What the tables hold

Timestamps are milliseconds since the epoch. A row with `removed_at` set was deleted upstream, so filter `removed_at is null` for current rows.

| table | one row is | join on |
| -- | -- | -- |
| `issues` | a ticket: `identifier`, `title`, `state`, `state_type`, `assignee`, `delegate_name`, `priority`, `team_key`, `project_id`, `cycle_id`, `parent_identifier`, `updated_at` | `id` |
| `comments` | a comment: `body`, `author_name`, `is_bot`, `parent_id`, `created_at` | `issue_id` = `issues.id` |
| `issue_history` | one change to a ticket: `from_state` / `to_state` and the other `from_*` / `to_*` pairs, `created_at` | `issue_id` = `issues.id` |
| `relations` | a link between tickets: `type`, `issue_identifier`, `related_identifier` | identifiers |
| `labels`, `issue_labels` | a label, and which ticket carries it | `issue_labels.label_id` = `labels.id` |
| `agent_sessions` | an agent session on a ticket: `status`, `created_at` | `issue_id` = `issues.id` |
| `pull_requests` | a pull request that names a ticket in `linear_issue_identifier` | `linear_issue_identifier` = `issues.identifier` |

## Recipes

Replace `ENG-123` and `ENG` with the real identifier and team key.

One ticket's current fields:

```sql
select identifier, title, state, assignee, delegate_name, priority, updated_at
from issues where identifier = 'ENG-123' and removed_at is null
```

The newest comments on a ticket, Catalyst's own first:

```sql
select c.created_at, c.author_name, c.is_bot, substr(c.body, 1, 200) as body
from comments c join issues i on i.id = c.issue_id
where i.identifier = 'ENG-123' and c.removed_at is null
order by c.is_bot desc, c.created_at desc limit 20
```

Every state change on a ticket, oldest first:

```sql
select h.created_at, h.from_state, h.to_state
from issue_history h join issues i on i.id = h.issue_id
where i.identifier = 'ENG-123' and h.to_state is not null
order by h.created_at
```

How many tickets sit in each state on one team:

```sql
select state, count(*) as n from issues
where team_key = 'ENG' and removed_at is null
group by state order by n desc
```

What a ticket blocks and what blocks it:

```sql
select type, issue_identifier, related_identifier from relations
where issue_identifier = 'ENG-123' or related_identifier = 'ENG-123'
```

Pull requests that name a ticket:

```sql
select repo_id, number, state, draft, merged, head_sha
from pull_requests where linear_issue_identifier = 'ENG-123'
```

## What the replica does not answer

Phase attempts, remediate rounds, park state and the live lease are not in the replica. `catalyst history <KEY-123>` reads them from the cloud. So do eligibility (`catalyst explain <KEY-123>`) and search (`node scripts/search.mjs`).
