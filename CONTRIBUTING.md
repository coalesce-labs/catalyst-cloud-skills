# Contributing

## Development

```sh
bun install
bun run typecheck
bun run test
```

Installing from a git ref (`npm install -g github:coalesce-labs/catalyst-cloud-skills#<branch>`) does **not** give you the CLI, and no document offers it as a way in. npm runs `prepare` in the clone with no `node_modules` at all, so there is no compiler to build `dist/` with; the install now fails loudly and leaves nothing on PATH, which is the whole fix — before 0.2.1 it exited 0 and wrote a `catalyst-skills` shim pointing at a file that was never packed. To try an unreleased branch, clone it and `npm install && npm link`. `test/git-install-rail.test.ts` holds this: if npm ever starts giving `prepare` a toolchain, the rail has to work all the way to a runnable shim before the README may advertise it.

The skills under `skills/` are the source of truth for the published package. The `files` field in `package.json` ships them verbatim, and the customer's own agent installs them: the Claude Code plugin reads them from `.claude-plugin/plugin.json`, and `npx skills add` copies them. The CLI's `install` verb copies the same directories as a repair path. Edit them here and nowhere else.

## Releases

1. Bump `version` in `package.json`.
2. Add a `CHANGELOG.md` entry under a `## <version>` heading. The CLI prints that entry's first line to customers when they update.
3. Push a tag `skills-bundle-v<version>` whose version matches `package.json` exactly. The `skills-bundle publish` workflow rejects a tag that does not name the version being published.
4. The workflow runs the whole test suite with coverage before `npm publish`. That suite carries the pack-and-install smoke: it packs the real tarball, installs it into a clean directory, and runs the installed `login`, `install`, `status`, `contract`, `ready` and `replica schema` against a fixture `/me` server. A broken publish cannot ship.

Publishing never happens from a laptop; the `skills-bundle publish` workflow is the only publish path. The npm credential is the repository secret `NPM_PUBLISH_TOKEN`, an automation token with publish rights on the `@catalyst-cloud` scope.

A manual `workflow_dispatch` run of the workflow publishes with `--dry-run` by default, so the whole path can be rehearsed without uploading anything.
