# Reading ticket facts from the cloud

Cloud reads are the default on every machine. They need no local writer and no local database. Every command below reads the cloud through the `catalyst` CLI.

| question | command |
| -- | -- |
| What stage is the ticket in, who has it, which PRs name it? | `catalyst query issue <KEY-123>`, or `node scripts/read-ticket.mjs <KEY-123>` |
| What did Catalyst and people write on it? | `node scripts/read-ticket.mjs <KEY-123> --comments`; comments and activity come inline with the ticket |
| What was the last phase, and how did it end? | `catalyst history <KEY-123>` |
| How many remediate rounds against the cap? Is it parked, and what releases it? | `catalyst history <KEY-123>` |
| Why is it not running, or what runs next? | `catalyst explain <KEY-123>` |
| What is the PR's state, checks and reviews? | `catalyst query pulls --ticket <KEY-123>`, then `catalyst query pull <node-id>` |
| What changed across the account since a point? | `catalyst query changes --since head`, then the cursor it prints |
| Find a ticket by words | `node scripts/search.mjs <terms>` |

## Reading the answer

The first stderr line names the source: `source: api (...)`. Quote it when freshness matters ("from the API just now").

The ticket read returns the whole record, so a question about one field still downloads comments and activity. That is fine for one ticket. For many tickets, use a list (`catalyst query issues --team <key>`) and read one record only where the list is not enough.

A smaller read is coming: the cloud will answer a ticket or its execution history with only the status fields. No CLI flag selects it yet, so read the full record and pick the fields you need.

## Events

In this release, `catalyst events tail`, `wait-for` and `query` read only the local event cache, which exists only on a machine that opted in to local sync. On any other machine, answer "did this ticket move" from `catalyst history <KEY-123>` and the ticket's `updated_at`. `catalyst query changes` reads the cloud's change feed, which keeps only recent changes.

## The local replica

Only on a machine where `catalyst replica status --json` reports `configured: true`, `references/local-replica.md` adds local SQL. Everywhere else, these cloud reads are the whole answer.
