# The repository's agent setup

Two CLI verbs, both local to a checkout the person names, both writing to the working tree only. Committing, the branch and the pull request are the person's, in the open; nothing here pushes, and nothing here reaches the cloud.

`catalyst capabilities` lists `repo agents-block` and `repo agent-setup` when the installed CLI has them. When it does not, say the CLI is older and skip this page; do not paste the block by hand.

## The Catalyst block in AGENTS.md

`catalyst repo agents-block <path>` reads the checkout's AGENTS.md and says one of: `absent` (no file), `missing` (a file without the block), `stale` (a block whose words differ from this CLI's), or `current`. With `--write` it creates the file holding only the block, appends the block after one blank line, or replaces the marked region in place. A rerun changes nothing. The block is delimited by `<!-- catalyst:start -->` and `<!-- catalyst:end -->`; it says the repository is worked through Catalyst and names the skills an agent loads to learn the process. It carries no process of its own, so it never goes out of date with the pipeline.

**Ask first:** "Shall I add the Catalyst block to AGENTS.md, on a branch, for you to open as a pull request?" On a yes, run `--write`, show the line it printed, and hand the commit and pull request to the person (or do it with the settings-file change, in the same pull request, when that is open). Never write to the default branch.

## What the repository holds for agents, and the portable layout

`catalyst repo agent-setup <path>` reports, file by file: AGENTS.md (present, size, the block's state), CLAUDE.md (present; whether it imports AGENTS.md with a line that is exactly `@AGENTS.md`; how many lines of its own it carries), `.agents/skills` and `.agents/rules` (present or not), `.claude/skills` and `.claude/rules` (absent, a real directory, or a symlink and where it points), and other agent files it noticed (`.codex`, `.cursor`, `GEMINI.md`, and the like, reported only).

Then one verdict:

- **portable**: AGENTS.md is canonical; CLAUDE.md, if present, imports it; each `.claude/skills` and `.claude/rules` is either absent or a relative symlink to its `.agents/` twin. Say so in a sentence and offer only the block if it is missing.
- **convertible**: the report lists the plan, step by step: move CLAUDE.md's own guidance into AGENTS.md and leave CLAUDE.md as the thin importer (`@AGENTS.md` plus Claude-only notes); move `.claude/skills` or `.claude/rules` to `.agents/` and leave a relative symlink. `--apply` performs exactly that plan in the working tree.
- **needs a hand merge**: both a `.claude/` and an `.agents/` directory are real, or a symlink points elsewhere. `--apply` refuses and names each blocker; the person merges by hand, then reruns.

Why portable: one AGENTS.md serves every coding agent, and the Claude files become pointers, so a second harness on the same repository finds the same instructions and the same skills without a copy that drifts.

**Ask first:** read the report to the person in words ("CLAUDE.md holds 40 lines of guidance and no AGENTS.md exists; `.claude/skills` is a real directory"), say what portable would look like, and ask: "Shall I make it portable, on a branch, for you to open as a pull request?" On a yes, run `--apply`, show what it applied and the new report, and hand over the commit and pull request. Never `--apply` without the yes, and never on the default branch.

## The check a customer can keep

`catalyst repo agent-setup <path> --with-check` writes `scripts/agents-md-check.mjs` into the checkout: a dependency-free node script for CI that fails when CLAUDE.md stops importing AGENTS.md, when a `.claude/skills` or `.claude/rules` stops being a relative symlink into `.agents/`, when AGENTS.md outgrows its budget (120 lines and 16 KiB by default; `AGENTS_MD_MAX_LINES` and `AGENTS_MD_MAX_BYTES` change it), or when a repository path AGENTS.md cites in backticks no longer exists. Offer it as a file they add and wire into CI themselves; say what it checks in one sentence. A rerun with `--with-check` leaves an identical file alone.

## Read back

After any write, rerun `catalyst repo agent-setup <path>` and read the verdict line and the block's state. Exit 0 means portable with the block current; exit 1 means something on the list is still open, and the lines say which.
