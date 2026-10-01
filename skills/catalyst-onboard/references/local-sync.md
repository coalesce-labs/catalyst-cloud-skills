# The optional local replica and event cache

The replica is an on-machine SQLite copy of the account for cheap repeated reads and ad hoc SQL; the event cache holds recent events. Every skill works without them through the API, which is origin-fresh. Start a background writer only when the person asks for local data.

## The replica's exit codes

`catalyst replica status` needs no network. Exit 0 is fresh (a live writer, a heartbeat under 15 seconds, a cursor), exit 1 is stale and 3 is absent. Skills use cloud reads by default; a fresh replica is used only with explicit `--source replica`. `catalyst replica start --detach` restarts a stale writer after local sync is selected. Exit 2 is not connected (`references/connecting-this-machine.md`). `--probe` adds one network call comparing the local cursor with the cloud head. Every read verb names its source on standard error.

Local sync is opt-in. `catalyst replica status --json` carries `configured`, which is true only when this machine opted in: `CATALYST_REPLICA_DB` is set, or the machine paths file declares `replicaDb`. A machine that never opted in prints `replica: not configured (cloud reads; local sync is opt-in)` and reads the cloud. A machine with `configured: true` and exit 1 or 3 opted in and its writer is down.

## Checking and starting both

`node scripts/local-sync.mjs` shows the local state. Only after the person opts in, `--start` starts the replica and event cache writers and waits up to 90 seconds (`--wait <seconds>`, 0 to 300).

Say `Local sync current` only when both writers have live heartbeats and each cursor equals its cloud head. A detached process starting, one fresh heartbeat, or replica freshness alone does not prove event freshness. `catalyst replica status --probe --json` checks the replica cursor; `catalyst events status --from-cache --probe --json` checks the separate event cursor. Unknown means the comparison could not be proved, which is not stale. The script exits 0 current, 1 stale, 3 absent, and 2 for "not connected" or "unknown", with a printed reason. After a restart, check again before relying on local data.

## First ticket event

The default wait reads the cloud and needs no local sync. Before the person moves a card, run `catalyst events status --json` and record its `head` as `<cursor-before-move>`. Move the card only after this baseline is captured. Then run `catalyst events wait-for --ticket <ticket-identifier> --after <cursor-before-move> --timeout 300` with the identifier `explain` printed, and no guessed event type. The explicit cursor finds an event that happened before the command began.

Exit 0 prints a matching event after the baseline. Exit 1 means no matching event arrived within five minutes; check `catalyst explain <ticket-identifier>` before inferring a cloud or webhook failure. Exit 4 means the cloud event service was unreachable: an outage, not a timeout. Other errors are unknown. `explain` stays the API-backed answer to why a ticket can or cannot run.

On a machine that opted in to local sync, the same wait can also prove the event reached this machine's cache. Run `node scripts/local-sync.mjs --start` and wait until it reports current. Then run `catalyst events status --from-cache --probe --json` and record its `cursor` as `<cursor-before-move>`. Move the card only after this baseline is captured. Then run `catalyst events wait-for --from-cache --ticket <ticket-identifier> --after <cursor-before-move> --timeout 300`. Exit 1 means no matching cached event arrived within five minutes; recheck `node scripts/local-sync.mjs` and report stale or unknown evidence without inferring a cloud or webhook failure. Exit 3 means the event cache is absent; ask before starting it.

## The writer

`catalyst replica --help` lists `start`, `stop`, `sql` and `schema`. It needs Node 22.15 or newer, or bun 1.4 or newer, and its files stay bounded under `~/.config/catalyst-cloud/`. The first start seeds the whole snapshot before going live, so `status` reads stale until the cursor appears; ask again after the live line, or watch `status --probe` count down. The lock refuses a second writer on the same file.

The writer backs off after a failed snapshot pull and gives up after five consecutive snapshot failures; `catalyst replica status` and `catalyst ready` then name the stopped state, the last error and the restart command, and the file reads stale (exit 1).

To survive a reboot, run `catalyst replica start` without `--detach` under the platform's supervisor: a launchd agent with `KeepAlive` on macOS, a systemd user unit with `Restart=on-failure` on Linux (plus `loginctl enable-linger $USER` to run while logged out), or a Task Scheduler task at logon on Windows.
