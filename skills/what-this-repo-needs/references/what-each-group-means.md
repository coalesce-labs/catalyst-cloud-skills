# What each group means

`node scripts/inventory.mjs` sorts every environment variable name it finds into exactly one of three groups. This page explains why a name lands where it does; the scan never reads a value.

## build/test

Needed to install, build and run the tests in a container. This is the default group: a name lands here unless something specific pulls it into `deploy-only` or `bindings`. Examples: a name the source reads (`process.env.X`), a name in a `.env.example`-shaped file, a name a non-deploy workflow job uses.

The scan does not read `package.json` scripts. A name only a script's shell line mentions is therefore not listed; add it by hand if the container needs it.

A name referenced from **both** a deploy job and a non-deploy job (or build step) lands here, because a container that builds and tests the repository needs it too.

## deploy-only

A CI secret used **only** by a job the scan classifies as deploying: a workflow job that sets `environment:`, whose id looks like `deploy`, `publish`, `release` or `cd`, or that runs a recognised deploy command (`wrangler deploy`, `npm publish`, `gh release create`, and similar). A reference anywhere outside a deploy job moves the name to `build/test`. Its local value is a CI secret a repository or organisation admin sets in the CI provider.

## bindings

A Cloudflare (or other platform) binding: a name bound to a resource (a KV namespace, a D1 database, a Durable Object, an R2 bucket, a queue) declared in `wrangler.toml`. The platform wires it up at deploy time, so it is not a `process.env` value, and the scan keeps the two apart. A binding table names the binding through one attribute's value (`binding = "NAME"` for most tables, `name = "NAME"` for `durable_objects.bindings`), never through the table's own key.

## wrangler.toml `[vars]`: build/test, not a binding, and nothing to declare

A `[vars]` (or `[env.<name>.vars]`) table's keys ARE the names, and their values are committed in `wrangler.toml` itself, readable by everyone. So a `[vars]` name lands in `build/test` as a plain value a step could read, marked `needsDeclaration: false`: there is nothing to declare.

## Where a local value comes from

For every name, one of:

- **a `.env` file or your shell:** the ordinary case for `build/test`.
- **a CI secret:** for `deploy-only`, and for a `build/test` name whose only non-committed source is a workflow's `secrets.X` reference.
- **a Cloudflare binding:** for `bindings`; the platform wires it, so there is no local value.
- `value committed in wrangler.toml — nothing to declare`: for a `[vars]` entry.

Each says where a value would come from, never the value, so a reviewer knows what to check without seeing what is set.

## A `wrangler.jsonc` or `wrangler.json` file

The scan reads only `wrangler.toml`, so a repository configured with JSONC gets a note saying so rather than a confident "no bindings found".
