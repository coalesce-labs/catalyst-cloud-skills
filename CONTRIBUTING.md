# Contributing

## Development

```sh
bun install
bun run typecheck
bun run test
```

The skills under `skills/` are the source of truth for the published package. The `files` field in `package.json` ships them verbatim, and the customer's own agent installs them: the Claude Code plugin reads them from `.claude-plugin/plugin.json`, and `npx skills add` copies them. The CLI's `install` verb copies the same directories as a repair path. Edit them here and nowhere else.

## Releases

1. Bump `version` in `package.json`.
2. Add a `CHANGELOG.md` entry under a `## <version>` heading. The CLI prints that entry's first line to customers when they update.
3. Push a tag `skills-bundle-v<version>` whose version matches `package.json` exactly. The `skills-bundle publish` workflow rejects a tag that does not name the version being published.
4. The workflow runs the whole test suite with coverage before `npm publish`. That suite carries the pack-and-install smoke: it packs the real tarball, installs it into a clean directory, and runs the installed `login`, `install`, `status`, `contract`, `ready` and `replica schema` against a fixture `/me` server. A broken publish cannot ship.

Publishing never happens from a laptop; the `skills-bundle publish` workflow is the only publish path. The npm credential is the repository secret `NPM_PUBLISH_TOKEN`, an automation token with publish rights on the `@catalyst-cloud` scope.

A manual `workflow_dispatch` run of the workflow publishes with `--dry-run` by default, so the whole path can be rehearsed without uploading anything.
