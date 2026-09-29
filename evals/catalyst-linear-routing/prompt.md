---
schema_version: "1.0"
name: catalyst-linear-routing
description: routing — catalyst-linear fires on a sentence its description promises
tags: [routing, explicit, catalyst-linear]
plugins: ["../.."]
runs: 3
max_turns: 6
timeout_seconds: 300
allowed_tools: [Skill, Read, Glob, Grep]
---

/catalyst-linear Can you show me the ticket CTC-2012, with its comments?
