# Declaring what one repository's containers need

The cloud containers build and test the repository. They need the names of the variables and secrets it reads. You write the names; the person enters the values in the app. Never read or print a value.

## The inventory, in order

1. Start from the commands that already build and test the repository: the README's setup section, the scripts in `package.json` or its equivalent, and the build and test steps in CI. Those are what the container runs. A name they never read does not belong in the file.
2. For each name, record the file it came from: a `.env.example` (never `.env`, which holds live values), a CI secret in a workflow's `env:` block, or a platform binding. A name you cannot tie to a file is a guess. Say so instead of listing it.
3. Mark whether the container needs it to build and test, or only to deploy. Containers build and test. They do not deploy.
4. Leave platform bindings and deploy-only CI secrets out by default. The platform supplies a binding at run time, and no build or test reads a deploy-only secret. Include one only when the person says the build needs it, and say why.
5. Write the names into `catalyst.env.json` at the repository root and open a pull request. Use that exact name and place; the cloud reads no other file. It reads the file once the pull request merges to the default branch. A tenant owner or admin then approves it at Settings → Repositories → the repository → Environment, and the person enters the values on that page.

## The file's shape

`"version": 1` plus eight arrays, each present even when empty: `toolchains`, `systemPackages`, `setup`, `verify`, `services`, `environment`, `agentAssets`, `provenance`. The repository's Environment page in the app shows a complete, valid example. Start from it rather than from memory.

- `setup` and `verify` carry this repository's own install and test commands. `command` is an argument list, not a shell string.
- Each name under `environment` says whether it is `required`. Add `"secret": true` beside a secret.
- Each `provenanceIds` entry points at a record under `provenance` that names the file the name came from.

## After the merge

`catalyst-skills ready` reports `environment_declared` for the team's default repository and names the next step: commit the file, fix it, or approve it. The `catalyst-setup` check table has each reason. The account-wide declaration is separate; `catalyst-skills environment` handles it (step 7 of `references/the-one-path.md`).
