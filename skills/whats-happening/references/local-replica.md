# Local replica (opt-in)

Load this only when `catalyst replica status --json` reports `configured: true`. Otherwise answer from the cloud (`references/reading-from-the-cloud.md`) and never mention the replica.

The replica is an on-machine SQLite copy of the account, present only after the person opted in to local sync. It adds ad hoc SQL over the board. It never holds running work, the queue, asks, eligibility or phase history; those stay cloud reads.

## Freshness

`catalyst replica status --probe --json` first. Use local rows only when `verdict` is `fresh` and `cursor` equals `head`, and quote the cursor. `stale` or `absent` with `configured: true` means the opted-in writer is down: answer from the cloud and say so in the source clause. Start it only when asked (`catalyst replica start --detach`).

The snapshot's replica verdict line belongs in the status reply's source clause only on an opted-in machine.

## SQL

`catalyst replica sql "<one SELECT>" --json` runs one read-only `SELECT`. `catalyst replica schema <table>` prints columns. Timestamps are milliseconds since the epoch; filter `removed_at is null` for current rows. Replace `<team key>` and `KEY-123` with real values from the contract.

Cards per stage on one team:

```sql
select state, count(*) as n from issues
where team_key = '<team key>' and removed_at is null
group by state order by n desc
```

What closed in the last day:

```sql
select identifier, title, completed_at from issues
where completed_at > (strftime('%s', 'now') - 86400) * 1000 and removed_at is null
order by completed_at desc
```

Stage moves in the last day, newest first:

```sql
select i.identifier, h.from_state, h.to_state, h.created_at
from issue_history h join issues i on i.id = h.issue_id
where h.to_state is not null and h.created_at > (strftime('%s', 'now') - 86400) * 1000
order by h.created_at desc limit 50
```

Cards unmoved for three days in a stage, oldest first:

```sql
select identifier, state, updated_at from issues
where team_key = '<team key>' and state = '<stage name>' and removed_at is null
  and updated_at < (strftime('%s', 'now') - 3 * 86400) * 1000
order by updated_at
```

An unmoved card may still be running, retrying or remediating. Check `catalyst history KEY-123` before calling it stuck.
