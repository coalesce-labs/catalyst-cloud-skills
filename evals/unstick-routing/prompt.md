---
schema_version: "1.0"
name: unstick-routing
description: routing — unstick fires on a sentence its description promises
tags: [routing, explicit, unstick]
plugins: ["../.."]
runs: 3
max_turns: 6
timeout_seconds: 300
allowed_tools: [Skill, Read, Glob, Grep]
---

/unstick Can you unpark this ticket? It's been stuck for two days.
