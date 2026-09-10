# The canonical install block

This file is the one copy of the install wording. The README quotes it verbatim, and any web page or
doc that shows a Catalyst skills install command copies it from here rather than writing its own. If
you change a command, change it here first.

**The two rails are exclusive.** The plugin installs the set as a managed bundle that updates when we
ship. `npx skills` copies editable files into your project. A reader who runs both ends up with every
skill twice, so every rendering of this block keeps the exclusivity sentence.

**The credential is separate from the install.** No install command carries a key. The account key
enters once, through `catalyst-skills login`, and lands in a `0600` config file. Keep the connect step
beside the install commands, never inside them.

---

## Install

Two ways in. The plugin installs the set as a managed bundle that updates when we ship. `npx skills`
copies editable files into your project. Pick one; installing both leaves you with every skill twice.

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

The installer asks which skills to take and which agents to install them on. Add `-g` to install into
your home directory instead of the project. Skills installed this way do not auto-update; run
`npx skills update -y` to refresh them.

## Connect to your tenant

```sh
npm install -g @catalyst-cloud/catalyst-skills
CATALYST_CLOUD_TOKEN=<your-account-key> catalyst-skills login
catalyst-skills ready
```

`npx @catalyst-cloud/catalyst-skills login` works without the global install. Passing the key as an
environment variable keeps it out of your shell history; `catalyst-skills login` with no key and a
terminal attached prompts for it without echoing it.
