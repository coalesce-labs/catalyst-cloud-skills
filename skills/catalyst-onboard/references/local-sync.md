# The optional local replica and event cache

**For:** a person who wants an on-machine event file and a searchable replica, for cheap repeated reads and ad hoc SQL. Every skill works without it: reads, writes, asks and explanations go through the API, which is origin-fresh. Ask before starting a background writer, and start it only when the person wants local data. It is off by default for large projects.

## The replica's exit codes

`catalyst replica status` needs no network and answers with one exit code, stated here once:

| exit | verdict | what a skill does with it |
| -- | -- | -- |
| 0 | fresh: a live writer, a heartbeat younger than the staleness threshold (15 seconds by default; `--stale-ms` overrides), a non-empty cursor | reads the replica and says so |
| 1 | stale: the file exists but the writer is gone, the heartbeat is old, or there is no cursor | reads the API and says so; `catalyst replica start --detach` brings it back |
| 2 | not connected: this machine holds no credential | the connect step first (`references/connecting-this-machine.md`) |
| 3 | absent: no replica file at all | reads the API; the replica is optional |

`--probe` adds the one network call: it compares the local cursor with the cloud head and prints how far behind the replica is. Every read verb prints `source: replica (cursor N)` or `source: api (replica stale|absent|not configured)` on standard error, so each answer names where it came from. A skill never refuses to work because the replica is down, and never reads a stale one silently.

## Checking and starting both

**You run:** `node scripts/local-sync.mjs` to show the current local state. Only if the person opts in, run `node scripts/local-sync.mjs --start`. It uses `catalyst replica start --detach`, whose writer also starts the local event cache, and waits up to 90 seconds; `--wait <seconds>` sets a bounded wait from 0 to 300.

**Read back:** `Local sync current` only when both the replica and the event cache have live writer heartbeats and each cursor equals its own cloud head. A detached process starting, one fresh heartbeat alone, or replica freshness alone does not prove event freshness. `catalyst replica status --probe --json` checks the replica cursor; `catalyst events status --probe --json` checks the separate event cursor. Unknown means the cloud comparison could not be proved, which is not stale. The script's exit code follows the replica's table for the combined verdict (0 current, 1 stale, 3 absent) and uses 2 for both "not connected" and "unknown"; its printed reason says which. Tell the person local data is current only when the combined check says so.

**Owner:** you check and, with the person's opt-in, start. If this machine restarts, check status again before relying on local data.

## First ticket event

Ask before starting the local writer. Before the person moves a card, run `node scripts/local-sync.mjs --start` after they opt in and wait until it reports current. Then run `catalyst events status --probe --json` and record its `cursor` as `<cursor-before-move>`. Move the card only after this baseline is captured. Once the card is moved, run `catalyst events wait-for --ticket <ticket-identifier> --after <cursor-before-move> --timeout 300` with the identifier `explain` printed. Do not guess an event type. The explicit cursor lets `wait-for` find the event if it reached the local cache before the command began.

Exit 0 prints a matching event after the recorded baseline and proves it reached this machine's cache. Exit 1 means no matching cached event arrived within five minutes; recheck `node scripts/local-sync.mjs` and report stale or unknown evidence without inferring a cloud or webhook failure. Exit 3 means the event cache is absent; ask before starting it. Other errors are unknown. `explain` remains the API-backed source for why a ticket can or cannot run.

## The commands

```sh
catalyst replica start --detach    # start in the background, write a pidfile, return
catalyst replica status            # one line and the exit code above
catalyst replica status --probe    # also compare the local cursor with the cloud head
catalyst replica stop              # signal the pidfile's process
catalyst replica start             # foreground, Ctrl-C to stop
```

It is a Node process, not a service. Node 22.15 or newer (or bun 1.4 or newer) with its built-in SQLite module runs it the same on macOS, Linux and Windows.

## What it holds on disk

Under `~/.config/catalyst-cloud/` by default (`--db` moves the replica file, and the config records it):

| file | what it is |
| -- | -- |
| `replica.db` | one SQLite file: the account's mirrored tables, kept current by upserts and deletes from the stream |
| `replica.db.writer.lock` | the writer's lock, with a heartbeat the status check reads |
| `replica.db.pid` | the background writer's process id, written by `--detach` |
| a `sync_meta` row inside the database | the stream cursor, so a restart resumes where it stopped |
| `watch-cursor.json` | the events-only cursor for `catalyst watch`; a few bytes |

The replica neither grows without bound nor needs pruning, and nothing under the config directory is a log. The first start seeds the file from the cloud's snapshot, then follows the stream; a restart resumes from the saved cursor. When the cloud can no longer replay from that cursor, the writer re-seeds on its own.

## The writer stops itself after repeated snapshot failures

`replica start` backs off with jitter after a failed or incomplete snapshot pull, and gives up after five consecutive snapshot failures. A snapshot that completes resets the count. `catalyst replica status` and `catalyst ready` both name the stopped state, the count, the last error, and the command that restarts it. A stopped writer with a database on disk still reads stale (exit 1).

## Surviving a reboot

Optional. Run the writer in the foreground under a supervisor (no `--detach`), so the supervisor owns the process. The examples assume a global install (`npm install -g @catalyst-cloud/cli`); `which catalyst` gives the path, and Homebrew Node installs under `/opt/homebrew/bin`.

**macOS, launchd.** Save as `~/Library/LaunchAgents/dev.catalystcloud.replica.plist`, then `launchctl load` it (`launchctl unload` stops it):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.catalystcloud.replica</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/catalyst</string><string>replica</string><string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/catalyst-cloud-replica.err</string>
</dict></plist>
```

**Linux, systemd user unit.** Save as `~/.config/systemd/user/catalyst-cloud-replica.service`, then `systemctl --user daemon-reload && systemctl --user enable --now catalyst-cloud-replica`:

```ini
[Unit]
Description=Catalyst Cloud local replica
After=network-online.target

[Service]
ExecStart=/usr/bin/env catalyst replica start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

For a writer that runs while nobody is logged in, `loginctl enable-linger $USER` once. `journalctl --user -u catalyst-cloud-replica` shows its standard error.

**Windows.** Task Scheduler runs `catalyst replica start` at logon with "Run whether user is logged on or not" and "If the task fails, restart every 1 minute"; or run `catalyst replica start --detach` from a shell after logging in.

## Two things that look like problems and are not

- **Two writers.** The writer lock refuses a second writer on the same file. Stop the first (`replica stop`, or the supervisor) before starting another or moving the file.
- **A stale verdict right after start.** The first start seeds the whole snapshot before it goes live, so `status` reads stale until the cursor row appears. Ask again once `replica start` has printed its live line, or watch `status --probe` count the lag down.
