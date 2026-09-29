# What each group means

`node scripts/inventory.mjs` sorts every environment variable name it finds into exactly one of
three groups. This page explains what each one means and why a name lands where it does — it never
restates a value, because the scan itself never reads one.

## build/test

Needed to install, build and run the tests in a container. This is the default group: a name lands
here unless something specific pulls it into `deploy-only` or `bindings`. Examples: a name read by
the repository's own source (`process.env.X`), a name documented in a `.env.example`-shaped file, a
name a non-deploy workflow job uses.

The scan does not read `package.json` scripts. A name that only a script's own shell line mentions
and nothing else refers to is therefore not listed — add it by hand if the container needs it.

A name referenced from **both** a deploy job and a non-deploy job (or build step) still lands here,
not in `deploy-only` — a container that builds and tests the repository needs it too, so the
stricter requirement wins.

## deploy-only

A CI secret used **only** by a job the scan classifies as deploying something: a workflow job that
sets `environment:`, whose id looks like `deploy`, `publish`, `release` or `cd`, or that runs a
recognised deploy command (`wrangler deploy`, `npm publish`, `gh release create`, and similar). If
the same name is referenced anywhere outside a deploy job, it moves to `build/test` instead.

Its local value comes from a CI secret — something a repository or organisation admin sets in the
CI provider, not something a person types into a local `.env` file.

## bindings

A Cloudflare (or other platform) binding: a name bound to a resource — a KV namespace, a D1
database, a Durable Object, an R2 bucket, a queue — declared in `wrangler.toml`. A binding is not an
environment value a process reads from `process.env`; it is wired up by the platform at deploy
time, which is why this scan keeps the two apart even though both are "names the container needs".

A `wrangler.toml` binding table names the binding through one attribute's value — `binding = "NAME"`
for most tables, `name = "NAME"` for `durable_objects.bindings` — never through the table's own key.

## wrangler.toml `[vars]`: build/test, not a binding, and nothing to declare

A `[vars]` (or `[env.<name>.vars]`) table is different from every other wrangler table: its keys ARE
the names, and their values are committed in `wrangler.toml` itself — checked into the repository,
not a secret and not something a person supplies locally. So a `[vars]` name lands in `build/test`
(it is a plain value a build or test step could read, not a resource binding), and the scan marks it
`needsDeclaration: false`: there is nothing for a customer to declare, because the value is already
sitting in the file everyone can already read.

## Where a local value comes from

For every name, "where the local value comes from" is one of:

- **a `.env` file or your shell** — the ordinary case for `build/test`.
- **a CI secret** — for `deploy-only`, and for any `build/test` name whose only non-committed source
  is a workflow's `secrets.X` reference.
- **a Cloudflare binding** — for `bindings`; there is no local value to supply, the platform wires
  it up.
- **value committed in wrangler.toml — nothing to declare** — for a `[vars]` entry.

None of these is the value itself — only where it would come from, so a person reviewing the list
knows what to check without this tool ever showing them what is actually set.

## A `wrangler.jsonc` or `wrangler.json` file

Modern Wrangler configs are often JSONC. This scan does not read them yet — `wrangler.toml` is the
only Cloudflare config format it understands — so a repository configured that way gets a note
saying so, rather than a silent, confidently wrong "no bindings found".
