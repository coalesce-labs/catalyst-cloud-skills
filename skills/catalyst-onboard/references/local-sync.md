# Optional local events and replica

**For:** a person who wants an on-machine event file and searchable replica. The normal API-backed skills work without this, so ask before starting a background writer.

**You run:** `node scripts/local-sync.mjs` to show the current local state. Only if the person opts in, run `node scripts/local-sync.mjs --start`. The script uses `catalyst-skills replica start --detach`, whose writer also starts the local event cache. It waits up to 90 seconds; `--wait <seconds>` sets a bounded wait from 0 to 300.

**Read back:** `Local sync current` only when both the replica and event cache have live writer heartbeats and each cursor equals its own cloud head. A detached process starting, one fresh heartbeat alone, or replica freshness alone does not prove event freshness. `catalyst-skills replica status --probe --json` checks the replica cursor; `catalyst-skills events status --probe --json` checks the separate event cursor. Either command can report stale or unknown; unknown means the cloud comparison could not be proved, not that the cache is stale. Exit 0 means current, 1 stale, 2 unknown or not connected, and 3 absent. Do not tell the person local data is current unless the combined check says so.

**Owner:** you check and, with the person's opt-in, start. The local writer is optional. A reboot recovery service is separate work; if this machine restarts, recheck status before relying on local data.

## First ticket event

Ask before starting the local writer. Before the person moves a card, run `node scripts/local-sync.mjs --start` after they opt in and wait until it reports current. Then run `catalyst-skills events status --probe --json` and record its `cursor` as `<cursor-before-move>`. Move the card only after this baseline is captured. Once the card is moved, run `catalyst-skills events wait-for --ticket <ticket-identifier> --after <cursor-before-move> --timeout 300` with the identifier `explain` printed. Do not guess an event type. The explicit cursor lets `wait-for` find the event if it reached the local cache before the command began.

Exit 0 prints a matching event after the recorded baseline and proves it reached this machine's cache. Exit 1 means no matching cached event arrived within five minutes; recheck `node scripts/local-sync.mjs` and report stale or unknown evidence without inferring a cloud or webhook failure. Exit 3 means the event cache is absent; ask before starting it. Other errors are unknown. `explain` remains the API-backed source for why a ticket can or cannot run.
