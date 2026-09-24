# Catalyst skill sources

Catalyst has two supported skill packs. They have separate purposes and versions.

| Pack | Purpose | Default workstation install | Optional Claude Code plugin |
| -- | -- | -- | -- |
| `coalesce-labs/catalyst-cloud-skills` | Tenant setup and operation | `npx skills@latest add coalesce-labs/catalyst-cloud-skills --all -g` | `catalyst@catalyst-cloud` |
| `coalesce-labs/catalyst-dev-skills` | Coding workflows | `npx skills@latest add coalesce-labs/catalyst-dev-skills --all -g` | `catalyst-dev@catalyst-dev-skills` |

Install both packs on a workstation used for coding and tenant operations. Each Claude plugin is an alternative to `npx skills` for that same pack. Do not install a pack through both methods.

## Migrate an existing installation

Inventory source and scope before removing anything:

1. Run `claude plugin list` and record whether `catalyst-dev@catalyst` is installed and at which scope.
2. Inspect the selected agent's home skill directory and the current project's skill directory separately. Read any `skills-lock.json` files and source/provenance markers. A folder name alone does not prove which repository supplied it. Check whether `.claude/skills` is a symlink to another skills directory before changing either path.
3. If the old plugin is active, remove only `catalyst-dev@catalyst` through Claude Code's plugin manager. If old skill copies are present, remove only copies whose recorded source is the deprecated local runtime. Keep unrelated skills and plugin installs.
4. Install the replacement pack or packs in the intended scope with the commands above. For the Cloud pack, omit `-g` only when a project-scoped install is intended. Do not use a blanket `npx skills remove --all` during migration.
5. Read back the plugin list or skill lock and the destination skill folders. Start a new agent session after changing Claude plugins.

Do not delete a Catalyst checkout, local project data, or a same-named skill whose source is not known. If the source or scope is ambiguous, stop and report what is unclear before removing anything.
