# Keeping the replica running

This reference restates invariants of the local replica the Catalyst Cloud SDK manages. Paths are the CLI's defaults; the replica file can be moved with `--db` and the config records it.

## The supported path is the plain command

```sh
catalyst-skills replica start --detach    # start in the background, write a pidfile, return
catalyst-skills replica status            # 0 fresh, 1 stale, 2 not configured, 3 absent; one line either way
catalyst-skills replica status --probe    # also compare the local cursor with the cloud head
catalyst-skills replica stop              # signal the pidfile's process
catalyst-skills replica start             # foreground, Ctrl-C to stop
```

It is a Node process, not a service. Node 22 or newer with its built-in SQLite module runs it the same on macOS, Linux and Windows, and the bundle never requires a daemon, because a required service is the first thing that breaks on a laptop. The writer is not a prerequisite for any skill; a fresh one is a preference. A skill must never refuse to work because the replica is down, and must never silently read a stale one; `replica status` is the one exit code that settles both.

## What it holds on disk, and why nothing rotates

Under `~/.config/catalyst-cloud/` by default:

| file | what it is |
| -- | -- |
| `replica.db` | one SQLite file: the tenant's mirrored tables, kept current by upserts and deletes from the stream |
| `replica.db.writer.lock` | the writer's lock, with a heartbeat the status check reads |
| `replica.db.pid` | the background writer's process id, written by `--detach` |
| a `sync_meta` row inside the database | the stream cursor, so a restart resumes where it stopped |
| `watch-cursor.json` | the events-only cursor for `catalyst-skills watch`, stamped with the tenant; a few bytes |

The replica is upserts and deletes into one file, so it neither grows without bound nor needs pruning; the cursor is a row. There is no directory of old files to clean and nothing to rotate. If the writer logs, it logs to standard error and the shell decides where that goes; nothing under the config directory is a log.

The first start seeds the file from the cloud's snapshot (one full copy of the tables) and then follows the stream; a restart resumes from the saved cursor. When the cloud can no longer replay from that cursor it tells the writer to re-seed, which the writer does on its own.

## Freshness, as the status check judges it

`replica status` needs no network. It answers fresh when the pidfile's process is alive, the writer lock's heartbeat is younger than the staleness threshold (15 seconds by default; `--stale-ms` overrides), and the cursor row is non-empty. Anything else is stale (exit 1) with the reasons listed, absent (exit 3) when there is no file, or not configured (exit 2) when the machine is not joined. `--probe` adds the one network call, fetching the cloud head to print how far behind the local cursor is. Every read verb prints `source: replica (cursor N)` or `source: api (replica stale|absent|not configured)` on standard error, so the answer always names where it came from.

## Surviving a reboot

Optional. The plain command is the supported path; these are for people who want the writer back after a restart. Each example assumes a global install (`npm install -g @catalyst-cloud/catalyst-skills`); substitute the absolute path `catalyst-skills status` prints as the CLI path if you prefer. Run the writer in the foreground under the supervisor (no `--detach`), so the supervisor owns the process.

### macOS, launchd

Save as `~/Library/LaunchAgents/dev.catalystcloud.replica.plist`, then `launchctl load ~/Library/LaunchAgents/dev.catalystcloud.replica.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.catalystcloud.replica</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/catalyst-skills</string><string>replica</string><string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/catalyst-cloud-replica.err</string>
</dict></plist>
```

Check the path to the binary with `which catalyst-skills`; Homebrew Node installs under `/opt/homebrew/bin`. `launchctl unload` the same file to stop it.

### Linux, systemd user unit

Save as `~/.config/systemd/user/catalyst-cloud-replica.service`, then `systemctl --user daemon-reload && systemctl --user enable --now catalyst-cloud-replica`:

```ini
[Unit]
Description=Catalyst Cloud local replica
After=network-online.target

[Service]
ExecStart=/usr/bin/env catalyst-skills replica start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

For a writer that should run while nobody is logged in, `loginctl enable-linger $USER` once. `journalctl --user -u catalyst-cloud-replica` shows its standard error.

### Windows

There is no service wrapper in the bundle. Task Scheduler runs `catalyst-skills replica start` at logon with "Run whether user is logged on or not" and "If the task fails, restart every 1 minute"; or run `catalyst-skills replica start --detach` from a shell after logging in, which is the plain path and works the same as elsewhere.

## Two things that look like problems and are not

- **Two writers.** The writer lock guards the file, so a second writer on the same file is refused rather than allowed to corrupt it. Stop the first (`replica stop`, or the supervisor) before starting another or moving the file.
- **A stale verdict right after start.** The first start seeds the whole snapshot before it goes live; `status` reads stale until the cursor row appears. Ask again once `replica start` has printed its live line, or watch `status --probe` count the lag down.
