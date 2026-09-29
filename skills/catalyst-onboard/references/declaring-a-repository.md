# Declaring what one repository's containers need

The cloud containers build and test the repository. They need the names of the variables and secrets it reads. You write the names; the person enters the values in the app. Never read or print a value.

This is step 8 of `references/the-one-path.md`. Offer to draft the file from the repository's own build files, say which files you will read and what you will write, and wait for a yes before you write anything. If the repository already has one, verify it against the inventory below instead of rewriting it.

## The inventory, in order

1. Start from the commands that already build and test the repository: the README's setup section, the scripts in `package.json` or its equivalent, and the build and test steps in CI. Those are what the container runs. A name they never read does not belong in the file. Read these files directly; the inventory needs no git command.
2. For each name, record the file it came from: a `.env.example` (never `.env`, which holds live values), a CI secret in a workflow's `env:` block, or a platform binding. A name you cannot tie to a file is a guess. Say so instead of listing it.
3. Mark whether the container needs it to build and test, or only to deploy. Containers build and test. They do not deploy.
4. Leave platform bindings and deploy-only CI secrets out by default. The platform supplies a binding at run time, and no build or test reads a deploy-only secret. Include one only when the person says the build needs it, and say why.
5. Write the names into `.catalyst/catalyst.toml` and open a pull request. Use that exact path. The cloud reads no other file, and an older `catalyst.env.json` is ignored. Once the pull request merges, each push to the default branch that touches the file makes the cloud read it and propose it as a new revision. A tenant owner or admin opens Settings → Repositories → the repository → Environment → Setup declaration and clicks Approve this revision. The person enters the values on the same page's Environment variables and Secrets tabs.

## The file's shape

`[project]` with `linear_team` is required. Every other section is optional. The names a build needs go under `[environment]`:

```toml
#:schema https://staging.catalystcloud.dev/schemas/catalyst.schema.json

[project]
linear_team = "ENG"

[[environment.variables]]
name = "DATABASE_URL"
required = true

[[environment.variables]]
name = "STRIPE_API_KEY"
required = true
secret = true

[[environment.setup]]
name = "install"
run = ["npm", "ci"]
```

- `linear_team` is the key of the Linear team this repository's work belongs to.
- Each `[[environment.variables]]` entry names one variable and says whether it is `required`. Add `secret = true` for a secret. Names only: a value never goes in this file.
- `[[environment.setup]]` steps carry this repository's own install commands. `run` is an argument list, not a shell string, and `name` is kebab-case. `verify` steps have the same shape and carry the test commands. `toolchains`, `system_packages`, `services` and the other `[environment]` tables are optional; the schema lists their fields.
- The `#:schema` line lets an editor check the file as you type.

## After the merge

`catalyst ready` reports `environment_declared` for the team's default repository and names the next step: commit the file, fix it, or approve it. The `catalyst-setup` check table has each reason. The workspace-wide declaration is separate; `catalyst environment` handles it (also step 8 of `references/the-one-path.md`).
