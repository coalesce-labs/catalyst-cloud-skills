---
schema_version: "1.0"
name: catalyst-setup-routing
description: routing — catalyst-setup fires on a sentence its description promises
tags: [routing, implicit, catalyst-setup]
plugins: ["../.."]
runs: 3
max_turns: 6
timeout_seconds: 300
allowed_tools: [Skill, Read, Glob, Grep]
---

I just connected this machine — am I set up, or is anything missing?
