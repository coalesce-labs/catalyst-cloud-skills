# Drafting one repository's settings

The assistant prepares `.catalyst/catalyst.toml` from the repository. Never ask the person to write TOML or copy environment names by hand. Never read or print values from `.env`, CI secrets, or other local secret stores.

## Inspect before drafting

1. Check `.catalyst/catalyst.toml` and `catalyst.env.json` in the selected repository. Classify it as missing, legacy-only, valid TOML, or invalid TOML. `catalyst env check --json` checks the TOML environment table; when only the legacy file exists, it reports that the JSON declaration is no longer read.
2. For a legacy file, run `catalyst env migrate [path-to-catalyst.env.json]`. It prints a TOML environment table containing names only; every name is optional, and names identified as secrets are marked `secret = true`. Do not copy JSON values or provenance into the new file.
3. For missing or invalid declarations, inspect the repository's package manager files, README setup instructions, `package.json` scripts or equivalent, build and test workflows, `.env.example`, and source references. Use `catalyst env inventory [repo] --json` as supporting evidence. Do not inspect `.env` values or run repository scripts just to infer settings.
4. Draft `#:schema https://staging.catalystcloud.dev/schemas/catalyst.schema.json`, `[project]` with the mapped project's `linear_team`, the environment variables evidenced by build/test/setup, and setup/verify steps based on the repository's real package manager and build/test commands. Exclude deploy-only variables and platform bindings unless build or tests use them. Mark known secrets with `secret = true`. Set `required = false` on every variable; never make a phase depend on a newly declared value by default.
5. Validate the complete draft against the live schema at the URL in its `#:schema` line, then run `catalyst env check <path>`. The environment check is an additional check; it does not replace full schema validation. If a live-schema validator is unavailable or either check fails, fix the draft or report the exact blocker without claiming it is valid.

## Ask before writing or opening the PR

Show a short preview with the project/team, setup and verify commands, variable names, which are marked secret, and confirmation that every variable is optional. Do not include values. Ask the person to approve this exact draft. Before approval, do not write or replace `.catalyst/catalyst.toml`, remove `catalyst.env.json`, or open a settings PR.

After approval, write the validated file. When converting a legacy-only repository, remove `catalyst.env.json` in the same change. Open the settings PR, then offer to watch it merge. A reviewed merge is the approval. Catalyst approves the exact merged revision, with no second step, when someone other than the PR's author approved the merged head commit, or when a workspace owner or admin merged the PR. Tell the person this before they merge: the approving review is their consent to the setup commands and secret names in the file, so a reviewer should read it like code. A direct push, an unreviewed merge, or an approval left before the last commit leaves the revision proposed. No command approves one repository's revision yet, so only then give an owner or admin a direct link to approve it at Settings → Your projects → the project → Repositories → the repository → Environment → Setup declaration → Approve this revision. The direct route is `/settings/projects/$projectId/repositories/$repoId/environment/declaration`; use the project and repository ids from Catalyst instead of guessing them.

## File shape

`[project]` with `linear_team` is required; other sections are optional. Environment names belong under `[[environment.variables]]`:

```toml
#:schema https://staging.catalystcloud.dev/schemas/catalyst.schema.json

[project]
linear_team = "ENG"

[[environment.variables]]
name = "DATABASE_URL"
required = false

[[environment.variables]]
name = "STRIPE_API_KEY"
required = false
secret = true

[[environment.setup]]
name = "install"
run = ["npm", "ci"]
```

`run` is an argument list, not a shell string. `verify` steps use the same shape and carry the repository's test commands. Secret and variable values belong in Catalyst Cloud, never in this file.
