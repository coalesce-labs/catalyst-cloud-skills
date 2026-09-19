---
name: what-this-repo-needs
description: >-
  What environment variable names does this repository need, and where does each one come from? Scans the repository offline (no login, no network) and lists the names in three groups — build/test, deploy-only, bindings — each with where it was found, what uses it, and where a local value would come from. Never reads or prints a value. Also validates a catalyst.env.json file the same way the cloud does. Use when someone asks "what does catalyst.env.json mean", "what env vars does this repo need", "why does the container need this", or before reviewing or writing a repository's environment declaration.
allowed-tools: Bash(catalyst-skills:*) Bash(npx @catalyst-cloud/catalyst-skills:*)
---
<!-- vendored-from: @catalyst-cloud/catalyst-skills@0.7.0 — written in this repository for customer tenants -->

# What this repository needs

Say this first, in your own words, before you scan: the fleet builds and tests this repository in a
container that has only what is declared — nothing more, nothing guessed. The names below are what
that container needs; none of them is a value, and this tool never reads or shows one.

## Run first

- `node scripts/inventory.mjs [path] --help` — scans the repository (default: here) and prints the
  names in three groups: build/test, deploy-only, bindings. Each name shows where it was found
  (file:line), what uses it, and where a local value would come from — a `.env` file, your shell, a
  CI secret, or a Cloudflare binding. `--json` gives the same data in machine form.
- `node scripts/check.mjs <file> --help` — validates an existing `catalyst.env.json` offline, with
  the same rules the cloud applies, and never prints a value from it either.

Then ask the person to review the grouped list: for each name, keep it, drop it, or move it to a
different group. Keep your own reasoning short — the list is the point, not your commentary on it.

## Load on demand

| when | read |
| -- | -- |
| the person asks what a group means, or why a wrangler.toml entry is or is not a binding | `references/what-each-group-means.md` |

## Rules

- Report, never repair. This tool never writes `catalyst.env.json` and never proposes anything.
- Never print a value. Not a `.env` value, not a secret, not a committed `wrangler.toml [vars]`
  value — only the name, where it was found, and where a local value would come from.
- A Cloudflare (or other platform) binding is not an environment value; keep the two apart.
- This reads the repository only. It needs no login and makes no network call — unlike the
  account-scope `catalyst-skills environment` verb, which reads your tenant's own declaration.
