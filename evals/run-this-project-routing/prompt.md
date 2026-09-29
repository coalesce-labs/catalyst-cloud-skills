---
schema_version: "1.0"
name: run-this-project-routing
description: routing — run-this-project fires on a sentence its description promises
tags: [routing, explicit, run-this-project]
plugins: ["../.."]
runs: 3
max_turns: 6
timeout_seconds: 300
allowed_tools: [Skill, Read, Glob, Grep]
---

/run-this-project Can you run this project for me and keep it moving until it ships?
