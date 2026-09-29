# Declaring what one repository's containers need

The cloud containers build and test the repository and need the names of the variables and secrets it reads. You write the names; the person enters the values in the app. Never read or print a value. Say which files you will read and what you will write, and wait for a yes. An existing file gets verified against the inventory, not rewritten.

## The inventory, in order

1. Start from what builds and tests the repository: the README's setup section, the scripts in `package.json` or its equivalent, and CI's build and test steps. A name none of them reads does not belong in the file.
2. Tie each name to the file it came from: a `.env.example` (never `.env`, which holds live values), a CI secret in a workflow's `env:` block, or a platform binding. A name you cannot tie to a file is a guess; say so instead of listing it.
3. Leave out platform bindings and deploy-only secrets, since containers build and test but never deploy, unless the person says the build needs one.
4. Write the names into `.catalyst/catalyst.toml`, the only file the cloud reads, and open a pull request. Each merged change to it is proposed as a new revision. An owner or admin approves it at Settings → Your projects → the project → Repositories → the repository → Environment → Setup declaration → Approve this revision. The person enters values on that page's Environment variables and Secrets tabs. The direct route is `/settings/projects/$projectId/repositories/$repoId/environment/declaration`; use the project and repository ids from Catalyst instead of guessing them.

## The file's shape

`[project]` with `linear_team` is required; every other section is optional.

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

`linear_team` is the Linear team's key. `run` is an argument list, not a shell string, and `name` is kebab-case; `verify` steps share the shape and carry the test commands. The schema lists the optional tables (`toolchains`, `system_packages`, `services`). After the merge, `catalyst ready` reports `environment_declared` with the next step.
