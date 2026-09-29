---
schema_version: "1.0"
name: what-needs-me-routing
description: routing — what-needs-me fires on a sentence its description promises
tags: [routing, implicit, what-needs-me]
plugins: ["../.."]
runs: 3
max_turns: 6
timeout_seconds: 300
allowed_tools: [Skill, Read, Glob, Grep]
---

Quick check — what needs me? Anything blocking?
