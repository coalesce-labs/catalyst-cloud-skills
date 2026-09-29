# What a phase needs to run

A person can finish every other step and still see nothing run. A phase needs two more things: an enrolled coding account, and a host check that passes. `node scripts/where-am-i.mjs` reads both, as the `coding accounts` and `host` parts. Read those parts; never assume either.

## Coding accounts

**For:** a phase runs on one of the tenant's own enrolled coding accounts. With none active, no phase can start.

**Instrument:** `codingAccounts` in `catalyst contract`. It carries a `state`, a printable `line`, who enrolls an account (`enrolledByLine`) and the `page`. The script prints all of them. It never shows a credential or an email. When the state is `enrolled`, the script also reads `catalyst accounts` to check each account's credential.

**What each state means:**

| state | what it says | what to do |
| -- | -- | -- |
| `enrolled` | at least one account is active. Another account can still have a dead credential | read the account lines. If one says "<provider> account <slot> needs a new credential", that is the next step: follow `references/replacing-a-credential.md`. If the part reads `unreadable`, the accounts could not be checked in detail; say so and read it again later. Otherwise nothing |
| `none_enrolled` | no account is enrolled | hand over the page; the enroller the contract names enrols one |
| `inactive` | accounts exist, but every one is out of rotation | reactivate one on the page. Never tell them to enrol another |
| `unread` | the cloud could not read the accounts | say it could not be read. It is not "no accounts". Do not tell them to enrol one; read it again later |

**Owner:** the one the contract names. The person does it in the browser. Never ask for the credential, and never handle it. A key cannot enrol one. Which kinds of account exist, what each asks for, and what to do with an ended or cancelled one are in `references/choosing-a-coding-account.md`; it is step 2 of the path, the first thing asked.

**Older cloud:** if the contract has no `codingAccounts`, the script says the cloud is older and reads `catalyst accounts` instead. That list counts the accounts enrolled and the ones able to take work. An expired, revoked or quarantined account does not count. The owner is then a tenant owner or admin, at `<their cloud>/settings/coding-accounts`.

## Host

**For:** the contract carries this as the `hosts_current` readiness check on each project. It reads the same on every project, because it is about the whole account.

**Instrument:** the `hosts_current` check in `catalyst contract --path teams`, and its owner in `catalyst contract --path readinessChecks`.

**What each reading means:**

| reading | what it says | what to do |
| -- | -- | -- |
| `pass` | nothing is waiting on a host. A tenant that runs no host of its own reads this too | nothing |
| `unknown`, `no_host_connected` | no Catalyst host is connected | name the owner and stop |
| `unknown`, `hosts_unreported` | a host is connected but has not said which mapping it loaded | name the owner; it clears when the host reconnects |
| `fail`, `hosts_behind` | a connected host runs an older mapping | name the owner |
| the part reads `unreadable` | no project has been checked yet | run `catalyst team check <KEY>` when the script names it (it does when the CLI has the verb and the person is an owner or admin); otherwise press Re-check on the projects page; then read it again |

**Owner:** the contract names the owner of `hosts_current`, and where they act in its `fixedWhere`. When `fixedWhere` has a page, the script prints it, and the command too when there is one. When it is null, which it is today, the script prints the owner sentence alone. Then there is no page, so do not invent one. Say who owns it and that they connect it.

⛔ `catalyst ready` treats this check as a note, so it can print READY while no host is connected. READY there is not proof a phase can run. The `host` part is.

## Saying it is ready

Say a phase can run only when the script's last line says nothing is left. While either part is unfinished or unreadable, name that part, its owner, and where, and say plainly that no work will start yet.
