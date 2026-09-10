#!/usr/bin/env node
// Thin ESM launcher for @catalyst-cloud/catalyst-skills (CTC-1926). tsc does not carry a shebang
// through emit, so the bin is this two-line wrapper and the program lives in dist/cli.js.
import("../dist/cli.js")
  .then((m) => m.main(process.argv.slice(2)))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`catalyst-skills: failed to load: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
