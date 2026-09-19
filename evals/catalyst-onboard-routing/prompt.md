---
schema_version: "1.0"
name: catalyst-onboard-routing
description: routing — catalyst-onboard fires on a sentence its description promises
tags: [routing, explicit, catalyst-onboard]
plugins: ["../.."]
runs: 3
max_turns: 6
timeout_seconds: 300
allowed_tools: [Skill, Read, Glob, Grep]
---

/catalyst-onboard I just signed up — can you set me up?
