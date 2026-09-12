# The canonical install block

This file is the one copy of the install wording. The README quotes it verbatim, and any web page or
doc that shows a Catalyst skills install command copies it from here rather than writing its own. If
you change a command, change it here first.

**The two rails are exclusive.** The plugin installs the set as a managed bundle that updates when we
ship. `npx skills` copies editable files into your project. A reader who runs both ends up with every
skill twice, so every rendering of this block keeps the exclusivity sentence.

**The credential is separate from the install.** No install command carries a key. The person's own
personal key enters once, through `catalyst-skills login`, and lands in a `0600` config file. Keep the connect step
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
