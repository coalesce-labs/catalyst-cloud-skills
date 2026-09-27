# What a phase needs to run

A person can finish every other step and still see nothing run. A phase needs two more things: an enrolled coding account, and a host check that passes. `node scripts/where-am-i.mjs` reads both, as the `coding accounts` and `host` parts. Read those parts; never assume either.

## Coding accounts

**For:** a phase runs on one of the tenant's own enrolled coding accounts. With none, no phase can start.

**Instrument:** `catalyst-skills accounts`. It lists each enrolled account with its provider and status. It never shows a credential or an email.

**You hand over:** `<their cloud>/settings/coding-accounts`, and say: enrol one coding account. The script prints the exact link.

**Read back:** re-run the script and read the `coding accounts` part. It counts the accounts enrolled and the ones able to take work. An account that is expired, revoked or quarantined does not count. Say which it is.

**Owner:** a tenant owner or admin, in the browser. The person enrols the credential there. Never ask for it, and never handle it. A key cannot enrol one.

If the command says the cloud is older than the bundle, the tenant's cloud cannot report accounts yet. Say so. Do not read that as "no accounts".

## Host

**For:** the contract carries this as the `hosts_current` readiness check on each project. It reads the same on every project, because it is about the whole account.

**Instrument:** the `hosts_current` check in `catalyst-skills contract --path teams`, and its owner in `catalyst-skills contract --path readinessChecks`.

**What each reading means:**

| reading | what it says | what to do |
| -- | -- | -- |
| `pass` | nothing is waiting on a host. A tenant that runs no host of its own reads this too | nothing |
| `unknown`, `no_host_connected` | no Catalyst host is connected | name the owner and stop |
| `unknown`, `hosts_unreported` | a host is connected but has not said which mapping it loaded | name the owner; it clears when the host reconnects |
| `fail`, `hosts_behind` | a connected host runs an older mapping | name the owner |
| the part reads `unreadable` | no project has been checked yet | press Re-check on the projects page, then read it again |

**Owner:** the contract names the host operator. The script prints the owner the contract gives. The contract names no page for connecting a host, so do not invent one. Say who owns it and that they connect it.

⛔ `catalyst-skills ready` treats this check as a note, so it can print READY while no host is connected. READY there is not proof a phase can run. The `host` part is.

## Saying it is ready

Say a phase can run only when the script's last line says nothing is left. While either part is unfinished or unreadable, name that part, its owner, and where, and say plainly that no work will start yet.
