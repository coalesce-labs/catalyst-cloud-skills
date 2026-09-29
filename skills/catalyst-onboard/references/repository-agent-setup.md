# The repository's agent setup

Two CLI verbs, both on a checkout the person names, both writing only to its working tree. Nothing here pushes or reaches the cloud; the branch, commit and pull request are the person's, never on the default branch. When `catalyst capabilities` lacks `repo agents-block` and `repo agent-setup`, say the CLI is older and skip this; never paste the block by hand.

Say in one clause what the report found ("CLAUDE.md carries your guidance, there is no AGENTS.md, and `.claude/skills` is a real directory"), then offer each write below after its own yes, in the same pull request as the settings file when that is open.

## The Catalyst block in AGENTS.md

`catalyst repo agents-block <path>` reads AGENTS.md as `absent`, `missing` (no block), `stale` (words differ from this CLI's) or `current`. `--write` creates the file, appends the block, or replaces the region between `<!-- catalyst:start -->` and `<!-- catalyst:end -->`; a rerun changes nothing. The block says the repository is worked through Catalyst and names the skills that explain the process; it carries no process of its own, so it never goes stale with the pipeline.

## The portable layout

`catalyst repo agent-setup <path>` reports AGENTS.md (size, block state), CLAUDE.md (whether a line is exactly `@AGENTS.md`, and its own line count), `.agents/skills|rules` and `.claude/skills|rules` (absent, real directory, or symlink and target), and other agent files it saw (`.codex`, `.cursor`, `GEMINI.md`), then one verdict:

- **portable**: AGENTS.md is canonical, CLAUDE.md imports it, each `.claude/` twin is absent or a relative symlink into `.agents/`. Offer only the block if it is missing.
- **convertible**: the report lists the plan (CLAUDE.md's guidance moves into AGENTS.md and CLAUDE.md becomes `@AGENTS.md` plus Claude-only notes; `.claude/skills|rules` move to `.agents/` behind a relative symlink). `--apply` does exactly that.
- **needs a hand merge**: both directories are real, or a symlink points elsewhere. `--apply` refuses and names each blocker.

Portable means one AGENTS.md serves every coding agent, so a second harness finds the same instructions and skills without a drifting copy.

`--with-check` writes `scripts/agents-md-check.mjs`, a dependency-free CI script that fails when CLAUDE.md stops importing AGENTS.md, a `.claude/` twin stops being a relative symlink into `.agents/`, AGENTS.md outgrows 120 lines or 16 KiB (`AGENTS_MD_MAX_LINES`, `AGENTS_MD_MAX_BYTES`), or a backticked path it cites is gone. The person wires it into CI.

**Read back:** rerun `catalyst repo agent-setup <path>` after any write. Exit 0 is portable with the block current; exit 1 lists what is still open.
