---
paths:
  - "package.json"
  - ".claude-plugin/plugin.json"
  - "packages/catalyst-skills/package.json"
  - "CHANGELOG.md"
  - "scripts/sync-plugin-version.mjs"
  - ".github/workflows/publish.yml"
---

# Release train

This repository releases four members of Catalyst's shared release train: the CLI, the deprecated catalyst-skills forwarder, the skills bundle and the Claude plugin. Before you change a released version, push a `skills-bundle-v*` tag, or edit the publish workflow, load the `release-train` skill (`.agents/skills/release-train/SKILL.md`) and run its `.agents/skills/release-train/scripts/train-status.mjs`.

The short form: every member shares one MAJOR.MINOR. Additive changes are patches. A MINOR moves for every member at once or not at all. When a request would split the train, stop and ask instead of bumping.

Until the coordinated 0.16 release ships, a 0.15.x PATCH of the CLI, forwarder or skills may proceed without stopping (no MINOR move, no SDK change); the skill's "Standing exception until 0.16 ships" has the terms.
