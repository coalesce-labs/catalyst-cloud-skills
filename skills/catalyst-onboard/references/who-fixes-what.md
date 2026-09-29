# Who fixes what

Setup is eight parts. Each has one instrument, and each instrument answers about its own part and nothing else. Read this before you tell a person that something is not ready, and before you tell them to do anything about it. The product's words for what they own are Workspace, Project, Repository, Integration, Connected account and Member; the parts below are the instruments' names for the same things.

## The eight parts, and the instrument that owns each

| part | instrument | what a pass proves | what it does **not** prove | who fixes a failure, and where |
| -- | -- | -- | -- | -- |
| **machine** | `catalyst-skills status`, and the non-team checks of `catalyst-skills ready` | Node is new enough, this machine holds a credential, the CLI is where the config says, the contract is cached, the skills are on disk | anything at all about the tenant | the person at this keyboard, here |
| **person** | `catalyst-skills me`, and `catalyst-skills connections personal <linear|github> status` | the credential resolves to this person, shows their role and Linear identity match, and reports each personal grant's state | that their seat is active, or that they may change tenant settings | the member approves missing or expired personal grants in a browser; an owner or admin handles seat or identity conflicts in Settings → Members |
| **account** | `catalyst-skills contract --path account` | a resolved Linear workspace means the tenant's Linear grant landed | that the GitHub App is installed — the contract does not carry it | a tenant owner or admin, `<their cloud>/settings/connections` |
| **project** | `catalyst-skills team list`, then `team check <KEY>` and the `team:` checks of `ready` for the selected team | the live team list and the selected team's latest readiness verdict | that an unchecked team is ready | a tenant owner or admin, through `catalyst-skills team` or `<their cloud>/settings/linear-teams` |
| **repository** | `catalyst-skills contract --path merge.repositories` | the repository is registered to the account | that it is active, that a project can dispatch into it, or that its environment is declared | a tenant owner or admin, `<their cloud>/settings/repositories` |
| **coding accounts** | `codingAccounts` in `catalyst-skills contract` (`catalyst-skills accounts` on an older cloud) | an account is enrolled and active | that it has headroom left for the next phase | the enroller and page the contract names; see `references/what-a-phase-needs.md` |
| **repository declarations** | the `environment_declared` check in `catalyst-skills contract --path teams`, and its per-repository notes | the project's default repository has a committed `.catalyst/catalyst.toml` in effect: ingested, valid, and its latest revision approved | that the values the names refer to exist; that any other repository is declared, unless its note says so | the person, with you, in the repository for the file; a tenant owner or admin for the approval, at the repository's Environment page under `<their cloud>/settings/repositories` |
| **host** | the `hosts_current` check in `catalyst-skills contract --path teams` | no host is missing or behind, or the tenant runs none | anything before a project has been checked | the owner the contract names for `hosts_current`; see `references/what-a-phase-needs.md` |

`node scripts/where-am-i.mjs` runs all eight, in the order a person can act on them, and labels each finding with its part. Use it rather than composing this by hand.

## The two silences that are not absences

⛔ **An empty contract project list means nothing is mapped yet — it does not mean they have no projects.** The tenant contract carries a project only once someone has saved a stage mapping for it. Read the available team list with `catalyst-skills team list`, choose one, then go to step 4. `team check --all` performs readiness checks and may create asks for every team.

⛔ **A registered repository is not a dispatchable one.** The contract's repository list carries no status and no project attachment, so a paused repository and an active one look identical there, and a repository registered without a project attached looks exactly like a correctly attached one. Registration is all it proves. If a card does not start, `catalyst-skills explain <ticket>` names the real reason; do not conclude anything about the repository from its presence in a list.

⭐ And the general form of both: **an instrument that answers about a part it does not own will answer confidently and wrongly.** When you are unsure which part something belongs to, look it up in the table above rather than guessing from the wording of an error.

## Triaging NOT READY

`catalyst-skills ready` prints one verdict over every check, machine and project together. That single verdict is correct for "can work run?" and useless for "what should I do now?", because it folds two parts into one word. Split it before you act:

1. Run `catalyst-skills ready --json`. Every check has an `id`.
2. A check whose id begins with `team:` is a **project** finding. Everything else is a **machine** finding.
3. Report the two groups separately, in that order, each with its own owner.

- **A machine check failed.** This is the person's, here, now. Each failing check carries its own `fix` line; read it and do it. A missing or partial skill set is `catalyst-skills install`; a stale contract is `catalyst-skills contract --refresh`; a missing CLI path is one more `catalyst-skills login`.
- **A project check failed.** Name the check, the project, and the owner; the `who` field carries the workspace's own owners and admins. An admin or owner can run the check, preview a stage mapping, or adopt the workflow through `catalyst-skills team`; some failures still need provider consent or a browser action, and `<their cloud>/settings/linear-teams` is where those live. Use the check's reason to choose the next action. Re-running `ready` alone does not fix it.
- **A check is a note.** Notes never move the verdict. A stale or absent replica or event cache is optional; an unknown freshness probe means the cloud comparison could not be proved. A check that has never been run is waiting, not failing; a check the engine could not run is unknown, which is not a pass and not a failure. Say which it is. The API-backed skills still work; ask before starting the optional writer.

## When to stop rather than continue

- **They have no account yet.** There is no self-serve sign-up. Coalesce Labs provisions each account, and a person joins one by invitation from its admin. Say so and stop; the next step is theirs.
- **The account is suspended.** Setup cannot proceed and no retry changes that. Say so and name the conversation they need to have.
- **Their seat is not active, or they are not an owner or admin where one is required.** Say who is, and what to ask for. Do not offer a workaround.
- **A page said it worked and the instrument still disagrees.** Refresh the contract once (`catalyst-skills contract --refresh`) and read it again. If it still disagrees, report both facts — what the page said and what the instrument says — and let the person decide. Do not pick one for them.
