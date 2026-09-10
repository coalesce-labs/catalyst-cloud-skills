---
name: catalyst-setup
description:
  Am I set up? Machine readiness (Node, the tenant connection, the cached contract, the CLI path, the skills, the SDK, the optional replica) plus tenant readiness from the contract's ten per-team checks, in one verdict: what passes, what is blocked, what is merely waiting, and who can click what. Use when someone asks "am I set up", "what is missing", "why does nothing happen", "is the replica running", or right after connecting a new machine. Reports; never repairs.
allowed-tools: Bash(catalyst-skills:*) Bash(npx @catalyst-cloud/catalyst-skills:*)
---
<!-- vendored-from: @catalyst-cloud/catalyst-skills — written in this repository for customer tenants -->

# Am I set up?

You answer one question with one verdict and one list. The verdict is READY or NOT READY. The list is who can click what: the fixes only the person at the keyboard can make, the fixes only a tenant owner or admin can make in settings, and the checks that are simply waiting for the first event. The live check ids, severities, states and the people who can answer come from the contract; the scripts print them, you never restate them.

## Run first

- `node scripts/check.mjs --help` — every machine and tenant check, one line each, the fix and who for each failure, the verdict, then the who-can-click-what list. Exit 1 when NOT READY.
- `node scripts/replica-status.mjs --help` — the optional replica's verdict with no network (add `--probe` for how far behind it is). Exit 0 fresh, 1 stale, 2 not connected, 3 absent.

## Load on demand

| when | read |
| -- | -- |
| any check is red, unknown or waiting and the person asks what it proves, how to fix it, or who can | `references/what-each-check-means.md` |

## Rules

- Report, never repair. No tenant-reachable repair verb exists for an account key yet; the settings page is where a tenant owner or admin fixes a mapping, a connection or a label, and you say which one.
- End every answer with the verdict and the who-can-click-what list, in that order.
- A stale or absent replica is a note, never a failure: every skill reads the API meanwhile and says so. Do not tell the person to start it unless they want local SQL or cheaper repeated reads.
- Not connected (exit 2) means the connect step, not a retry: `CATALYST_CLOUD_TOKEN=<account key> npx @catalyst-cloud/catalyst-skills login`, with the key from their tenant admin. Never guess a tenant; the key is the only selector.
- Waiting is not failing. "No write observed", "no delivery observed" and "no host connected" clear themselves the first time the thing happens; say that instead of raising them.
- Unknown is not a pass. A check the engine could not run is reported as such, never rounded up.
- Never run a check in a loop. If the person wants to know when a waiting check clears, that is the project-running skill's watch.
