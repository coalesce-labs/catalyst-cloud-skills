# Reading from the cloud

Cloud reads are the default everywhere and need no local writer or database. Each command reads the cloud through the CLI.

| question | command |
| -- | -- |
| ticket stage, owner, linked PRs | `catalyst query issue KEY-123` |
| last phase, attempts, rounds, park, lease | `catalyst history KEY-123` |
| why not running, what runs next | `node scripts/explain.mjs KEY-123` |
| running now | `catalyst running` |
| queue order | `catalyst queue` |
| PR state and checks | `catalyst query pulls --ticket KEY-123`, then `catalyst query pull <node-id>` |
| what changed since a point | `catalyst query changes --since head` |

A status-only read of a ticket and of its execution history is coming. No CLI flag selects it yet; read the full record.

Events: `catalyst events tail`, `wait-for` and `query` read only the local event cache in this release. On a machine without local sync, answer movement from `catalyst history` and `updated_at`.

Local SQL: `references/local-replica.md`, only when `configured: true`.
