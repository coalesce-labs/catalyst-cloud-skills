# Reading `catalyst ready`: what each check proves and who fixes it

This is the one guide to reading readiness. `catalyst ready` prints one verdict, READY or NOT READY, over the machine checks and every project's checks. `node scripts/check.mjs` prints the same report with the fix and owner under each failure, then a "who can click what" list. `node scripts/where-am-i.mjs` reads every part of setup with its own instrument. Read this page before you tell a person something is not ready, and before you tell them to do anything about it.

## The parts, and the instrument that owns each

Each instrument answers about its own part and nothing else.

| part | instrument | what a pass proves | what it does not prove | who fixes a failure, and where |
| -- | -- | -- | -- | -- |
| **machine** | `catalyst status`, and the machine checks of `catalyst ready` | Node is new enough, this machine holds a credential, the CLI is where the config says, the contract is cached, the skills are on disk | anything about the cloud account | the person at this keyboard, here |
| **person** | `catalyst me`, and `catalyst connections personal <linear|github> status` | the credential resolves to this person, with their role, their Linear identity match, and each personal grant | that their seat is active, or that they may change account settings | the person approves a personal grant in a browser and matches their own Linear identity (`catalyst identity linear set`); an owner or admin handles a seat or a claimed identity in Settings → Members |
| **account** | `catalyst contract --path account` | a resolved Linear workspace: the account's Linear grant landed | that the GitHub App is installed; the contract does not carry it | a workspace owner or admin, `<their cloud>/settings/connections` |
| **project** | `catalyst team list`, then `team check <KEY>` and the `team:` checks of `ready` | the live team list and the selected team's latest verdict | that an unchecked team is ready | a workspace owner or admin, through `catalyst team` or `<their cloud>/settings/linear-teams` |
| **repository** | `catalyst contract --path merge.repositories` | the repository is registered to the account | that it is active, attached to a project, or declared | a workspace owner or admin, `<their cloud>/settings/repositories` |
| **coding accounts** | `codingAccounts` in `catalyst contract` (`catalyst accounts` on an older cloud) | an account is enrolled and active | that it has headroom for the next phase | the enroller and page the contract names; see `references/what-a-phase-needs.md` |
| **repository declarations** | the `environment_declared` check in `catalyst contract --path teams` | the project's default repository has a committed `.catalyst/catalyst.toml` in effect | that the values behind the names exist, or that another repository is declared | the person, with you, for the file; an owner or admin approves it on the repository's Environment page |
| **host** | the `hosts_current` check in `catalyst contract --path teams` | no host is missing or behind, or the account runs none | anything before a project has been checked | the owner the contract names; see `references/what-a-phase-needs.md` |

⛔ **An empty contract project list means nothing is mapped yet.** The contract carries a project only once its stages are saved. Read the team list with `catalyst team list` and pick one. `team check --all` checks every team and may file an ask for each.

⛔ **A registered repository is not a dispatchable one.** The contract's repository list carries no status and no project attachment. If a card does not start, `catalyst explain <ticket>` names the real reason.

An instrument that answers about a part it does not own answers confidently and wrongly. When unsure which part something belongs to, look it up in the table above.

## Triaging NOT READY

The single verdict answers "can work run?". It does not say what to do next, because it folds the machine and the projects into one word. Split it first:

1. Run `catalyst ready --json`. Every check has an `id`.
2. A check whose id begins with `team:` is a **project** finding. Everything else is a **machine** finding.
3. Report the two groups separately, machine first, each with its own owner. Say how many are `pass`, `fail` and `unknown`, and when each team verdict was computed (`teams[].readiness.checkedAt`, null when no pass has run).

- **A machine check failed.** It is the person's, here, now. Each failing check carries its own `fix` line; read it and do it.
- **A project check failed.** Name the check, the project, and the owner; the `who` field names the account's own owners and admins. An owner or admin repairs a mapping from the terminal with `catalyst team check`, `team map` and `team adopt` (each previews, then applies with `--yes --plan-hash`). A Linear connection, a Linear permission and Linear's own team settings are fixed in a browser. Re-running `ready` alone fixes nothing.
- **A check is a note.** Notes never move the verdict. Waiting is not failing, and unknown is not a pass. Say which it is.

End every readiness answer with the verdict and the who-can-click-what list, in that order. Never run a check in a loop; waiting for a check to clear is the project owner's watch (`run-this-project`).

## The checks

The contract's `readinessChecks[]` is the list of record, with each check's severity and whether it needs a person's answer; `teams[].readiness` holds each team's current states; `humans[]` holds who can answer. A check that appears there and not here is newer than this page: `node scripts/check.mjs` still prints it with its own severity, fix and owner, so read the printed line and say you did.

A team's status is `ready`, `degraded`, `blocked` or `unchecked`. A failing check marked blocking makes it blocked. Any unknown, and any failing check marked degrading, makes it degraded. Unchecked means no readiness pass has run yet, which is a note. Readiness is stamped with the mapping revision it was computed against, so a stale verdict shows as stale.

| check id | proves | when it fails, the fix | who clicks |
| -- | -- | -- | -- |
| `oauth_scope` | Catalyst holds the Linear permissions it needs | re-authorise the Linear connection to grant the missing scope | an owner or admin, in settings |
| `token_live` | the Linear connection is accepted right now | reconnect Linear (expired or revoked), or wait and re-check (Linear unreachable). A distinct reason says Linear was never connected | owner or admin |
| `team_visible` | Catalyst can see this team | usually the team was made private: grant Catalyst access in Linear's team settings, then re-check | owner or admin, in Linear |
| `mapped_states_exist` | every stage Catalyst mapped still exists in Linear | re-map the team (`catalyst team map <KEY>`). A pending-write reason means a mapping was just saved and the read has not caught up: wait | owner or admin |
| `mapping_total` | every stage Catalyst moves tickets into is mapped | map the missing stages. "Absent" means the team was never mapped; "incomplete" means a few load-bearing stages are missing | owner or admin |
| `types_compatible` | each load-bearing stage is the right kind (dispatch and intake unstarted or backlog, PR started, done completed, canceled canceled) | map a stage of the right kind | owner or admin |
| `labels_present` | the labels Catalyst uses exist in the workspace | none: Catalyst creates them the first time it uses them | nobody |
| `writes_land` | Catalyst has written to this team successfully | "no write observed" is waiting and clears on the first move. "Write refused" means Linear rejected the last write: check the connection and the team's permissions | owner or admin when refused; otherwise nobody |
| `webhook_covers_team` | events for this team are arriving | confirmed once a repository is registered and events flow; "no delivery observed" is waiting | owner or admin, by registering the repository |
| `hosts_current` | no connected host runs an older mapping revision | a host that is behind reloads on its next connect; one that did not report is flagged; "no host connected" is waiting | whoever runs that host |
| `environment_declared` | the default repository's `.catalyst/catalyst.toml` was ingested, is valid, and its latest proposal is approved | `no_team_repo_default`: register a repository and make it the team's default; `no_environment_declaration`: commit the file; `declaration_invalid` / `declaration_read_failed`: fix the file; `declaration_awaiting_approval`: Settings → Repositories → the repository → Environment → Setup declaration → Approve this revision | owner or admin, except committing the file, which is whoever can push |
| `tools_resolvable` | every MCP server and CLI the approved declaration names resolves for that repository | `tool_reference_unresolved`: add the named vault secret or correct the declaration; `toolchain_cli_missing`: the CLI is not in the runner image, which is not self-service; `tool_declarations_unread` reads as `unknown` and clears itself | owner or admin, in the declaration or Settings → Environment |
| `reviewer_required` | the repository can merge under its own merge policy with the reviewers configured | fails only under a strict policy with no reviewer: configure one at Settings → Repositories → Code reviews, or change the policy; work still runs, only the merge waits | owner or admin, in settings |
| `reviewer_configured` | a code reviewer is configured at all, whatever the policy requires | a failing one never blocks or degrades a team; configure one at Settings → Repositories → Code reviews. An `unknown` one (`merge_reviewer_unread`) still degrades the team | owner or admin, in settings; nobody is required when it fails |

Some checks degrade a team without ever blocking it, and some are informational: a *fail* never moves the verdict, and an unknown still degrades. Which is which is served on `readinessChecks[].severity`; read it there.

Reasons that look like failures and are not: `no_write_observed`, `no_delivery_observed` and `no_host_connected` clear on their own the first time the thing happens. `stages_pending_write` means a mapping was saved and the read predates it; re-mapping would be a second write for nothing. `unknown` on any check means the engine could not look.

## The machine checks the CLI adds

| id | proves | fix |
| -- | -- | -- |
| `runtime` | this runtime can run the CLI: Node 22.15+ (where `node:module.registerHooks` arrives, which the SDK's TypeScript dependencies need) or bun 1.4+ (where `node:sqlite` arrives, which the replica needs) | `npx -y -p @catalyst-cloud/cli catalyst runtime install` installs a pinned Node under the CLI's own cache and uses it from then on; your default Node is unchanged |
| `config` | this machine is connected: `customer.json` exists and loads | `npx -p @catalyst-cloud/cli catalyst login` (keyless: the person approves in a browser); see `references/connecting-this-machine.md` |
| `contract` | the account's contract is cached and its major version is one this bundle accepts | `catalyst contract --refresh`; a version outside the range means update the bundle. A 403 naming an older cloud means the cloud has not yet deployed personal-key access |
| `bundle` | the installed CLI is at least the version the account requires | `npm install -g @catalyst-cloud/cli@latest && catalyst login`; a note, never a failure |
| `cliPath` | the CLI path recorded at login still exists, so skill scripts can spawn it | run `catalyst login` again |
| `skills` | the Cloud pack's skills this CLI copied are all present; the coding-workflow pack is not covered | a partial copy: `catalyst install`, the fix the check prints. A pack installed another way reads as a note. To install or refresh the pack itself, `references/skill-sources.md` |
| `cliRelease` | the installed CLI is not behind the newest published release | the same upgrade command as `bundle`; a note |
| `skillsRelease` | the installed skill files are not behind the newest published bundle | re-run the installer, or the by-hand command in `references/skill-sources.md` after checking every same-named copy. "Could not run" means the registry was unreachable |
| `sdk` | the SDK loads, so the replica and the watch are available | `npx -y -p @catalyst-cloud/cli catalyst runtime install`; every read works through the API meanwhile |
| `replica` | the optional replica is fresh | a note, never a failure; `references/local-sync.md` |

## Setting up one team at a time

A team receives work only once its stages are saved, one team at a time. No other team's stages or tickets change; only the labels Adopt creates are shared across the workspace. Once saved, the tickets in the team's dispatch stage start, so pilot on a low-stakes team and move anything in its dispatch stage that should not start back to Backlog first. `gitAutomation` in the contract plays no part: nothing reads it.

Each action exists in the terminal and on Settings → Linear teams. Explain one before you recommend it:

- **Check** (`catalyst team check <KEY>`, the Re-check button) reads the team's Linear setup and saves the verdict. It changes no ticket and no mapping. If something is missing, it files one setup ticket in that team for an admin.
- **Map** (`catalyst team map <KEY>`, Map my stages) saves a mapping from the team's existing stages onto Catalyst's slots. It needs no write access to Linear and creates nothing.
- **Adopt** (`catalyst team adopt <KEY>`, Adopt the Catalyst workflow) creates the stages the team lacks, plus Catalyst's standard labels, with that admin's own Linear authorisation. It also creates the hold label a failed phase uses when the team has no remediate stage (`teams[].labels.hold`); the label on its own means nothing failed.

Map when the team's stages already cover the work, Adopt when they do not. Say which and why. The terminal commands preview first; apply with `--yes --plan-hash <hash>` only after the person approves that exact plan.

## When to stop rather than continue

- **They have no account yet.** Coalesce Labs provisions each account; a person joins one by invitation from its admin.
- **The account is suspended.** No retry changes that. Name the conversation they need to have.
- **Their seat is not active, or an owner or admin is required and they are neither.** Say who is and what to ask for.
- **A page said it worked and the instrument still disagrees.** Refresh once (`catalyst contract --refresh`) and read again. If it still disagrees, report both and let the person decide.
