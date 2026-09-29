---
schema_version: "1.0"
name: whats-happening-routing
description: routing — whats-happening fires on a sentence its description promises
tags: [routing, implicit, whats-happening]
plugins: ["../.."]
runs: 3
max_turns: 6
timeout_seconds: 300
allowed_tools: [Skill, Read, Glob, Grep]
---

Hey — what's happening? Give me the rundown.
