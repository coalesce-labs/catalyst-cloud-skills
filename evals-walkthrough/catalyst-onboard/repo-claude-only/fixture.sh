#!/bin/bash
# Stands this run's HOME into the 'repo-claude-only' starting state: a stand-in catalyst CLI that answers
# every verb from that state (repo verbs go to the real CLI), the customer config that points the skill's
# scripts at it, and a checkout at ~/repos/app with a CLAUDE.md-only layout.
set -eu
dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
node "$dir/../../scaffold/install-state.mjs" repo-claude-only --home "$HOME"
