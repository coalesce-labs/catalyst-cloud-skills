# Catalyst skill sources

Catalyst has two supported skill packs. They have separate purposes and versions.

The installer the person ran first, at their cloud's `/install.sh` (the app's setup page shows the command), installs both packs in one pass. It stages them with a pinned skills CLI, installs exact commits, and stops on any same-named skill it does not recognise, naming the path. A home install schedules a daily refresh that also picks up new skills. Re-run it to refresh or repair either pack. The commands in the table are the by-hand equivalent.

| Pack | Purpose | By hand | Optional Claude Code plugin |
| -- | -- | -- | -- |
| `coalesce-labs/catalyst-cloud-skills` | Cloud account setup and operation | `npx skills@latest add coalesce-labs/catalyst-cloud-skills --all -g` | `catalyst@catalyst-cloud` |
| `coalesce-labs/catalyst-dev-skills` | Coding workflows | `npx skills@latest add coalesce-labs/catalyst-dev-skills --all -g` | `catalyst-dev@catalyst-dev-skills` |

Install both packs on a workstation used for coding and cloud operations. Each Claude plugin is an alternative to `npx skills` for that same pack. Do not install a pack through both methods.

## Where each install lands

- Global (`-g`): the skills go in `~/.agents/skills/`, and `~/.claude/skills/` holds links into it. Codex, Cursor and OpenCode read `~/.agents/skills/`; nothing fills `~/.codex/skills/` or `~/.cursor/skills/`.
- Project (no `-g`): `.agents/skills/`, `.claude/skills/` and `skills-lock.json` at the project root. Nothing lands in the home directory.
- The global lock is `$XDG_STATE_HOME/skills/.skill-lock.json` when `XDG_STATE_HOME` is set, else `~/.agents/.skill-lock.json`. A project uses its own `skills-lock.json`.
- The installer writes relative links. Resolve each with `readlink -f` before you compare paths.


The `npx skills add --all` command replaces existing same-named directories and links. Before a first install or refresh on an existing machine, read the lock above. Inspect every same-named agent destination. Proceed only when each destination is absent or a verified, unmodified copy of the intended pack or its symlink. A lock entry alone does not verify every destination. Keep independent, changed, or uncertain copies in place and resolve the conflict before adding either pack. Do not schedule raw add commands as an unattended refresh.

## Is each pack there

`catalyst ready` checks the Cloud pack only. Check `catalyst-onboard/SKILL.md` (Cloud pack) and `research-codebase/SKILL.md` (development pack) in the intended directory. If both are there, have the person type `/catalyst-onboard` (`$catalyst-onboard` in Codex).

## Migrate an existing installation

Inventory source and scope before removing anything:

1. Run `claude plugin list` and record whether `catalyst-dev@catalyst` is installed and at which scope.
2. Inspect the selected agent's home skill directory and the current project's skill directory separately. Read any `skills-lock.json` files and source/provenance markers. A folder name alone does not prove which repository supplied it. Check whether `.claude/skills` is a symlink to another skills directory before changing either path.
3. If the old plugin is active, remove only `catalyst-dev@catalyst`: `claude plugin uninstall catalyst-dev@catalyst --scope user --keep-data --yes`. Keep `catalyst-dev@catalyst-dev-skills` and `catalyst@catalyst-cloud`. For a copied skill whose lock source names the deprecated Catalyst runtime repository, use `npx skills remove <name> -g -y` only when every existing global agent path is that canonical copy or a symlink to it. Omit `-g` for a proven project install and inspect every same-named project agent path first. The command removes that name across agent directories. Leave independent or uncertain copies in place and report the conflict.
4. Install the replacement pack or packs in the intended scope with the commands above. For the Cloud pack, omit `-g` only when a project-scoped install is intended. Do not use a blanket `npx skills remove --all` during migration.
5. Read back the plugin list, the lock for each changed scope, and the destination skill folders. Start a new agent session after changing Claude plugins.

Do not delete a Catalyst checkout, local project data, or a same-named skill whose source is not known. If the source or scope is ambiguous, stop and report what is unclear before removing anything.
