---
schema_version: "1.0"
name: what-this-repo-needs-routing
description: routing — what-this-repo-needs fires on a sentence its description promises
tags: [routing, implicit, what-this-repo-needs]
plugins: ["../.."]
runs: 3
max_turns: 6
timeout_seconds: 300
allowed_tools: [Skill, Read, Glob, Grep]
---

I am about to fill in catalyst.env.json for this project — what env vars does this repo need, and where does each value come from?
