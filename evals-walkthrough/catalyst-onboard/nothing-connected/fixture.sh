#!/bin/bash
# Stands this run's HOME into the 'nothing-connected' starting state: a stand-in catalyst CLI that
# answers every verb from that state, and the customer config that points the skill's scripts at it.
set -eu
dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
node "$dir/../../scaffold/install-state.mjs" nothing-connected --home "$HOME"
