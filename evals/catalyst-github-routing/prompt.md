---
schema_version: "1.0"
name: catalyst-github-routing
description: routing — catalyst-github fires on a sentence its description promises
tags: [routing, implicit, catalyst-github]
plugins: ["../.."]
runs: 3
max_turns: 6
timeout_seconds: 300
allowed_tools: [Skill, Read, Glob, Grep]
---

Can you show me the PR for CTC-2012 and say what is red on it?
