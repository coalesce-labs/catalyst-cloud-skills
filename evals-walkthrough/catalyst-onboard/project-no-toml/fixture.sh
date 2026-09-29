#!/bin/bash
# Stands this run's HOME into the 'project-no-toml' starting state: a stand-in catalyst-skills CLI that
# answers every verb from that state, and the customer config that points the skill's scripts at it.
set -eu
dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
node "$dir/../../scaffold/install-state.mjs" project-no-toml --home "$HOME"
# The person is standing in their repository, as they would be: a small app with the files the
# inventory reads (a README setup section, package.json scripts, a .env.example, a CI workflow).
mkdir -p .github/workflows src
cat > package.json <<'JSON'
{ "name": "example-app", "private": true, "scripts": { "build": "tsc -p .", "test": "vitest run", "start": "node dist/server.js" }, "devDependencies": { "typescript": "^5.6.0", "vitest": "^2.0.0" } }
JSON
cat > .env.example <<'ENV'
# copy to .env for local development
DATABASE_URL=postgres://localhost:5432/example
STRIPE_API_KEY=
LOG_LEVEL=info
ENV
cat > README.md <<'MD'
# example-app

## Setup

1. `npm ci`
2. Copy `.env.example` to `.env` and fill in `DATABASE_URL` and `STRIPE_API_KEY`.
3. `npm test`
MD
cat > .github/workflows/ci.yml <<'YML'
name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      DATABASE_URL: ${{ secrets.DATABASE_URL }}
      STRIPE_API_KEY: ${{ secrets.STRIPE_API_KEY }}
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
YML
echo "console.log('hello')" > src/server.js
