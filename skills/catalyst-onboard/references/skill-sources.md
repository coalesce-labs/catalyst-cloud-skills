# Catalyst skill sources

Catalyst has two supported skill packs. They have separate purposes and versions.

| Pack | Purpose | Default workstation install | Optional Claude Code plugin |
| -- | -- | -- | -- |
| `coalesce-labs/catalyst-cloud-skills` | Tenant setup and operation | `npx skills@latest add coalesce-labs/catalyst-cloud-skills --all -g` | `catalyst@catalyst-cloud` |
| `coalesce-labs/catalyst-dev-skills` | Coding workflows | `npx skills@latest add coalesce-labs/catalyst-dev-skills --all -g` | `catalyst-dev@catalyst-dev-skills` |

Install both packs on a workstation used for coding and tenant operations. Each Claude plugin is an alternative to `npx skills` for that same pack. Do not install a pack through both methods.

The `npx skills add --all` command replaces existing same-named directories and links. Before a first install or refresh on an existing machine, read the active global lock at `$XDG_STATE_HOME/skills/.skill-lock.json` when XDG state is set, or `~/.agents/.skill-lock.json` otherwise; a project install uses its `skills-lock.json`. Inspect every same-named agent destination. Proceed only when each destination is absent or a verified, unmodified copy of the intended pack or its symlink. A lock entry alone does not verify every destination. Keep independent, changed, or uncertain copies in place and resolve the conflict before adding either pack. Do not schedule raw add commands as an unattended refresh.

## Migrate an existing installation

Inventory source and scope before removing anything:

1. Run `claude plugin list` and record whether `catalyst-dev@catalyst` is installed and at which scope.
2. Inspect global and project installs separately. The skills CLI reads the global lock at `$XDG_STATE_HOME/skills/.skill-lock.json` when `XDG_STATE_HOME` is set, or `~/.agents/.skill-lock.json` otherwise. A project install uses its own `skills-lock.json`. Read the recorded source and inspect each same-named agent path, including symlinks. A folder name alone does not prove which repository supplied it.
3. If the old plugin is active, remove only `catalyst-dev@catalyst` through Claude Code's plugin manager. For a copied skill whose lock source names the deprecated Catalyst runtime repository, use `npx skills remove <name> -g -y` only when every existing global agent path is that canonical copy or a symlink to it. Omit `-g` for a proven project install and inspect every same-named project agent path first. The command removes that name across agent directories. Leave independent or uncertain copies in place and report the conflict.
4. Install the replacement pack or packs in the intended scope with the commands above. For the Cloud pack, omit `-g` only when a project-scoped install is intended. Do not use a blanket `npx skills remove --all` during migration.
5. Read back the plugin list, the lock for each changed scope, and the destination skill folders. Start a new agent session after changing Claude plugins.

Do not delete a Catalyst checkout, local project data, or a same-named skill whose source is not known. If the source or scope is ambiguous, stop and report what is unclear before removing anything.
