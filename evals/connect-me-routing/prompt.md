---
schema_version: "1.0"
name: connect-me-routing
description: routing — connect-me fires on a sentence its description promises
tags: [routing, explicit, connect-me]
plugins: ["../.."]
runs: 3
max_turns: 6
timeout_seconds: 300
allowed_tools: [Skill, Read, Glob, Grep]
---

/connect-me I'm not sure which tenant this machine belongs to. Can you check?
