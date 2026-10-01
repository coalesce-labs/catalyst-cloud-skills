# Reading pull requests from the local replica (opt-in)

Load this only when `catalyst replica status --json` reports `configured: true`. On any other machine, read from the cloud (`references/reading-from-the-cloud.md`) and do not mention the replica.

The replica is an on-machine SQLite copy of the account. It exists only when the person opted in to local sync. It adds ad hoc SQL over mirrored pull requests and one leg the cloud PR detail lacks: review-thread rows. It is never required.

## Check it is caught up first

Run `catalyst replica status --probe --json` before every local read. Read locally only when `verdict` is `fresh` and `cursor` equals `head`. `stale` or `absent` with `configured: true` means the person opted in and the writer is down. Answer from the cloud and say the local copy is behind.

Quote the cursor with any local answer, for example "from the local replica at cursor 4810".

## Threads: the one leg only the replica adds

`node scripts/is-it-mergeable.mjs <ticket> --local-threads` reads the thread leg from the replica. It does so only after a probe proves the replica is caught up with the cloud head. Without the flag, the thread leg is inconclusive and the cloud's evaluator decides.

Read a pass on this leg narrowly. The thread table is filled only by resolve and unresolve events, and nothing seeds it from GitHub. A thread opened and never touched leaves no row. So zero rows can mean every thread is still open. A local "all resolved" answers only "of the threads seen resolving, which are resolved now". It never replaces the cloud's merge evaluator, which also judges a resolution against force-pushes.

The query the script runs, for one pull request:

```sql
select resolved, count(*) as n from pr_review_threads
where repo_id = 'acme/widgets' and pr_number = 42
group by resolved
```

`resolved` is 1 for resolved, 0 for unresolved, and null when no flag was mirrored.

## Running SQL yourself

`catalyst replica sql "<one SELECT>" --json` runs one read-only `SELECT` and prints rows. `catalyst replica schema <table>` prints a table's columns; read them before querying a table this page does not cover. Timestamps are milliseconds since the epoch.

| table | one row is | key |
| -- | -- | -- |
| `pull_requests` | a pull request: `state`, `draft`, `merged`, `merged_at`, `head_sha`, `head_ref`, `base_ref`, `mergeable`, `mergeable_state`, `auto_merge`, `linear_issue_identifier` | `repo_id`, `number`; also `node_id` |
| `check_runs` | one check at one commit: `name`, `status`, `conclusion` | `repo_id`, `head_sha` |
| `commit_statuses` | a legacy commit status: `context`, `state` | `repo_id`, `sha` |
| `reviews` | a submitted review: `user_id`, `state`, `submitted_at` | `repo_id`, `pr_number` |
| `pr_review_threads` | a review thread seen resolving: `resolved`, `resolved_at` | `repo_id`, `pr_number` |
| `pr_review_comments`, `pr_conversation_comments` | an inline comment, and a PR conversation comment | `repo_id`, `pr_number` |

Replace `acme/widgets`, `42` and `ENG-123` with real values.

Every pull request that names a ticket:

```sql
select repo_id, number, state, draft, merged, head_sha, mergeable_state
from pull_requests where linear_issue_identifier = 'ENG-123'
```

The checks at a pull request's current head:

```sql
select c.name, c.status, c.conclusion
from check_runs c join pull_requests p
  on p.repo_id = c.repo_id and p.head_sha = c.head_sha
where p.repo_id = 'acme/widgets' and p.number = 42
order by c.name
```

The reviews on a pull request, newest first:

```sql
select user_id, state, submitted_at from reviews
where repo_id = 'acme/widgets' and pr_number = 42
order by submitted_at desc
```

Open pull requests that GitHub reports in conflict:

```sql
select repo_id, number, linear_issue_identifier from pull_requests
where state = 'open' and mergeable_state = 'dirty'
```

## What the replica does not answer

Reactions, PR labels and the commit each review was submitted against are not mirrored anywhere a read can reach. The cloud's evaluator holds them. `references/is-it-mergeable.md` explains what that leaves inconclusive.
