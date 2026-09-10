# What each check means

This page restates invariants: the ten per-team readiness checks the cloud runs, what each proves, its fix and who can click it; the machine checks the CLI adds; and the four replica verdicts. The live values are never restated: each check's severity and whether it needs a human's answer come from the contract's `readinessChecks[]`, each team's current states from `teams[].readiness`, and the people who can answer from `humans[]`. `node scripts/check.mjs` prints all of it; this page is how to read what it printed.

## How a team's readiness is scored

A team's status is one of `ready`, `degraded`, `blocked` or `unchecked`. The engine always reports all ten checks; a check it could not run is `unknown`, never `pass`. Any failing check the contract marks as blocking makes the team blocked; any unknown, and any failing check marked degrading, makes it degraded. Unchecked means no readiness pass has run for that team yet, which is a note, not a failure. Readiness is stamped with the account-wide mapping revision it was computed against, so a stale verdict is visible as such.

## The ten checks

| check id | proves | when it fails, the fix | who clicks |
| -- | -- | -- | -- |
| `oauth_scope` | Catalyst holds the Linear permissions it needs | re-authorise the Linear connection to grant the missing scope | a tenant owner or admin, in settings |
| `token_live` | the Linear connection is accepted right now | reconnect Linear (expired or revoked), or wait and re-check (Linear unreachable). A distinct reason says Linear was never connected at all | owner or admin |
| `team_visible` | Catalyst can see this team | most often the team was made private: grant Catalyst access in Linear's team settings, then re-check | owner or admin, in Linear |
| `mapped_states_exist` | every stage Catalyst mapped still exists in Linear | re-map the team; nothing in the workspace was changed. A pending-write reason means a mapping was just saved and the read has not caught up: wait, do not re-map | owner or admin, in settings |
| `mapping_total` | every stage Catalyst moves tickets into is mapped | map the missing stages. "Absent" means the team was never mapped; "incomplete" means a few of the load-bearing stages are missing | owner or admin, in settings |
| `types_compatible` | each load-bearing mapped stage is the right kind (dispatch and intake unstarted or backlog, PR started, done completed, canceled canceled) | change the mapping to a stage of the right kind | owner or admin, in settings |
| `labels_present` | the labels Catalyst uses exist in the workspace | none needed by a person: Catalyst creates them the first time it uses them | nobody |
| `writes_land` | Catalyst has written to this team successfully | "no write observed" is waiting, not failing: it clears the first time Catalyst moves a ticket. "Write refused" means Linear rejected the last write: check the connection and the team's permissions | owner or admin when refused; otherwise nobody |
| `webhook_covers_team` | events for this team are arriving | confirmed once a repository is registered and events flow; "no delivery observed" is waiting | owner or admin, by registering the repository |
| `hosts_current` | no connected host runs an older mapping revision | a host that is behind re-loads the mapping on its next connect; a host that did not report its revision is flagged rather than assumed current; "no host connected" is waiting | whoever runs that host |

Three checks are informational by design (labels, event delivery, host currency): they degrade a team but never block it. Which are which is served on `readinessChecks[].severity`; do not memorise the split.

## Reasons that look like failures and are not

- `no_write_observed`, `no_delivery_observed`, `no_host_connected`: nothing has happened yet. Expected on a fresh tenant; they clear on their own.
- `stages_pending_write`: a mapping was saved and the read predates it. Re-check shortly; re-mapping would be a second write for no reason.
- `unknown` on any check: the engine could not look. It is not a pass and not a fail; say so.

## The machine checks the CLI adds

`catalyst-skills ready` prepends checks about this machine before the tenant's:

| id | proves | fix |
| -- | -- | -- |
| `node` | Node 22 or newer, which the SDK's built-in SQLite engine needs | install Node 22+ |
| `config` | this machine is connected: `customer.json` exists and loads | `CATALYST_CLOUD_TOKEN=<account key> npx @catalyst-cloud/catalyst-skills login`; the key comes from the tenant admin |
| `contract` | the tenant contract is cached and its major version is one this bundle accepts | `catalyst-skills contract --refresh`; a version outside the range means update the bundle. A refresh needs an account key, not a workstation key |
| `cliPath` | the CLI path recorded at login still exists, so skill scripts can spawn it | re-run login |
| `skills` | every skill of this bundle is present where the CLI installed them | `catalyst-skills install` |
| `sdk` | the SDK loads, so the replica and the watch are available | run under Node 22.15 or newer; every read still works through the API meanwhile |
| `replica` | the optional replica is fresh | a note, never a failure; see below |

## The replica's four verdicts

`node scripts/replica-status.mjs` needs no network and exits with the verdict:

| exit | verdict | what a skill does with it |
| -- | -- | -- |
| 0 | fresh: a live writer, a heartbeat younger than the staleness threshold, a non-empty cursor | reads the replica and says so |
| 1 | stale: the file exists but the writer is gone, the heartbeat is old, or there is no cursor | reads the API and says so; `catalyst-skills replica start --detach` brings it back |
| 2 | not connected to a tenant | the connect step first |
| 3 | absent: no replica file at all | reads the API; the replica is optional and one command away |

`--probe` adds the one network call: it compares the local cursor with the cloud's head and prints how far behind the replica is, the only honest "how stale" number. A skill must never refuse to work because the replica is down, and must never silently read a stale one; both halves are one exit code away.

## Who can click what

The last block `check.mjs` prints groups every failure by the person it needs. Machine fixes name "you", the person at the keyboard. Tenant fixes name the owner or admin roles the contract lists (as Linear user ids, since that is how the cloud knows them), because the settings page that repairs a mapping, a connection or a label is theirs. A check the contract marks as not needing an answer names nobody: it is informational or self-clearing. This skill reports; it never repairs, because no tenant-reachable repair verb exists for an account key yet.
