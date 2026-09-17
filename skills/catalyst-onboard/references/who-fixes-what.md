# Who fixes what

Setup is five parts. Each has one instrument, and each instrument answers about its own part and nothing else. Read this before you tell a person that something is not ready, and before you tell them to do anything about it.

## The five parts, and the instrument that owns each

| part | instrument | what a pass proves | what it does **not** prove | who fixes a failure, and where |
| -- | -- | -- | -- | -- |
| **machine** | `catalyst-skills status`, and the non-team checks of `catalyst-skills ready` | Node is new enough, this machine holds a credential, the CLI is where the config says, the contract is cached, the skills are on disk | anything at all about the tenant | the person at this keyboard, here |
| **person** | `catalyst-skills me` | the credential resolves to this person, with a role, and whether their Linear identity is matched | that their seat is active, or that they may change tenant settings | a tenant owner or admin, Settings → Members |
| **account** | `catalyst-skills contract --path account` | a resolved Linear workspace means the tenant's Linear grant landed | that the GitHub App is installed — the contract does not carry it | a tenant owner or admin, `<their cloud>/settings/connections` |
| **project** | `catalyst-skills contract --path teams`, and the `team:` checks of `ready` | for each project **that has been mapped**: its readiness verdict and each failing check by name | that this is every project they have — see below | a tenant owner or admin, `<their cloud>/settings/linear-teams` |
| **repository** | `catalyst-skills contract --path merge.repositories` | the repository is registered to the account | that it is active, that a project can dispatch into it, or that its environment is declared | a tenant owner or admin, `<their cloud>/settings/repositories` |

`node scripts/where-am-i.mjs` runs all five and labels each finding with its part. Use it rather than composing this by hand.

## The two silences that are not absences

⛔ **An empty project list means nothing is mapped yet — it does not mean they have no projects.** The tenant contract carries a project only once someone has saved a stage mapping for it. A brand-new tenant has projects in Linear and an empty list here, and reading that as "you have no projects" sends the person looking for a problem that does not exist. Say: *nothing is mapped yet*, and go to step 4. The list of every project they could map is browser-only today.

⛔ **A registered repository is not a dispatchable one.** The contract's repository list carries no status and no project attachment, so a paused repository and an active one look identical there, and a repository registered without a project attached looks exactly like a correctly attached one. Registration is all it proves. If a card does not start, `catalyst-skills explain <ticket>` names the real reason; do not conclude anything about the repository from its presence in a list.

⭐ And the general form of both: **an instrument that answers about a part it does not own will answer confidently and wrongly.** When you are unsure which part something belongs to, look it up in the table above rather than guessing from the wording of an error.

## Triaging NOT READY

`catalyst-skills ready` prints one verdict over every check, machine and project together. That single verdict is correct for "can work run?" and useless for "what should I do now?", because it folds two parts into one word. Split it before you act:

1. Run `catalyst-skills ready --json`. Every check has an `id`.
2. A check whose id begins with `team:` is a **project** finding. Everything else is a **machine** finding.
3. Report the two groups separately, in that order, each with its own owner.

- **A machine check failed.** This is the person's, here, now. Each failing check carries its own `fix` line; read it and do it. A missing or partial skill set is `catalyst-skills install`; a stale contract is `catalyst-skills contract --refresh`; a missing CLI path is one more `catalyst-skills login`.
- **A project check failed.** ⛔ **Nothing you run on this machine can move it.** Name the check, name the project, and name the owner — the `who` field carries the tenant's own owners and admins. Point at `<their cloud>/settings/linear-teams`. Then stop. Re-running `ready` in a loop is the failure this section exists to prevent: it will keep saying NOT READY for a reason that lives somewhere else entirely.
- **A check is a note.** Notes never move the verdict. A stale or absent replica is optional; a check that has never been run is waiting, not failing; a check the engine could not run is unknown, which is not a pass and not a failure. Say which of the three it is.

## When to stop rather than continue

- **The account is suspended.** Setup cannot proceed and no retry changes that. Say so and name the conversation they need to have.
- **Their seat is not active, or they are not an owner or admin where one is required.** Say who is, and what to ask for. Do not offer a workaround.
- **A page said it worked and the instrument still disagrees.** Refresh the contract once (`catalyst-skills contract --refresh`) and read it again. If it still disagrees, report both facts — what the page said and what the instrument says — and let the person decide. Do not pick one for them.
