# The canonical install block

This file is the one copy of the install wording. The README quotes it verbatim, and any web page or
doc that shows a Catalyst skills install command copies it from here rather than writing its own. If
you change a command, change it here first.

**The two rails are exclusive.** `npx skills` is the normal install for this pack. The Claude plugin
installs the same `skills/` tree as a managed bundle. Installing both leaves you with every skill twice,
so every rendering of this block keeps the exclusivity sentence.

**The packs have separate jobs.** This repository contains tenant setup and operation skills. A coding
workstation also installs `coalesce-labs/catalyst-dev-skills` for research, planning, implementation and
shipping. Neither pack comes from the deprecated `coalesce-labs/catalyst` local runtime.

**The credential is separate from the install.** No install command carries a key. The person's own
personal key enters once, through `catalyst-skills login`, and lands in a `0600` config file. Keep the connect step
beside the install commands, never inside them.

---

## Install

Install the Catalyst Cloud skills globally on a workstation:

On an existing machine, inspect same-named skill paths before running either add command. The
commands replace existing directories and links; the inspection rule is below.

```sh
npx skills@latest add coalesce-labs/catalyst-cloud-skills --all -g
```

For a coding workstation, also install the development skills from their own repository:

```sh
npx skills@latest add coalesce-labs/catalyst-dev-skills --all -g
```

The two commands install different skill sets. A project-scoped Cloud skills install is also supported:
omit `-g` when you want this repository's skills only in the current project.

**Claude Code alternative for this pack.** Pick the `npx skills` rail or the Claude plugin for this
pack; using both leaves each Cloud skill twice.

**Claude Code**

```
/plugin marketplace add coalesce-labs/catalyst-cloud-skills
/plugin install catalyst@catalyst-cloud
```

**Codex**

```sh
npx skills@latest add coalesce-labs/catalyst-cloud-skills -a codex
```

**Cursor**

```sh
npx skills@latest add coalesce-labs/catalyst-cloud-skills -a cursor
```

**OpenCode, Amp, Windsurf and the rest**

```sh
npx skills@latest add coalesce-labs/catalyst-cloud-skills
```

The installer asks which skills to take and which agents to install them on. Copied skills do not
auto-update. Re-adding the pack refreshes existing skills and picks up new ones; `npx skills update`
refreshes only names already in the lock. Before an add or refresh, inspect the active global lock
at `$XDG_STATE_HOME/skills/.skill-lock.json` when XDG state is set, or `~/.agents/.skill-lock.json`
otherwise. A project install uses its own `skills-lock.json`. Check every same-named agent path, not
just the canonical lock entry. Proceed only if each destination is absent or a verified, unmodified
copy of the intended pack or its symlink. Leave independent, changed, or uncertain copies in place.
Do not schedule raw add commands as an unattended refresh. After that check, re-run the Cloud add
command above with `-g` for a workstation or without `-g` inside a project.

### Then connect to your tenant

The skills call one CLI, and the CLI holds your credential. Install it once and connect this machine
— the keyless way logs you in as yourself, with nothing to mint or paste:

```sh
npm install -g @catalyst-cloud/catalyst-skills
catalyst-skills login
catalyst-skills ready
```

`catalyst-skills login` with no key opens a device-code login: it prints a short code and a URL, you
approve in your browser (or from your phone on a machine with no browser), and this machine connects
as you. The short-lived session refreshes silently afterwards. `npx @catalyst-cloud/catalyst-skills login`
works without the global install.

Prefer a key? Mint a **personal key** at Settings → API keys (every member can; no admin needed) and
pass it — the environment form keeps it out of your shell history:

```sh
CATALYST_CLOUD_TOKEN=<your-personal-key> catalyst-skills login
```

`--key <your-personal-key>` is the third form, for a script.

The connect step is a `###` under `## Install`, never its own top-level section. It has to sit
beside the install commands, in the same block a reader copies, or half of them stop at the install
and never connect.
