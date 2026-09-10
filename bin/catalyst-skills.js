#!/usr/bin/env node
// Thin ESM launcher for @catalyst-cloud/catalyst-skills (CTC-1926). tsc does not carry a shebang
// through emit, so the bin is this two-line wrapper and the program lives in dist/cli.js.
//
// ⛔ NEVER `process.exit(code)` STRAIGHT AFTER A WRITE. When stdout is a PIPE — which is how every
// skill script spawns this CLI — writes are asynchronous, so `process.exit` severs whatever is
// still in flight AND STILL REPORTS THE ORIGINAL EXIT CODE. The caller then reads a truncated body
// with a success code and has no way to tell it from a complete one: `query issues --json` on a
// tenant with ~80+ tickets came back as 65,528 bytes of invalid JSON, exit 0 (0.2.0). Interactive
// use hid it, because a tty gives stdout a synchronous write path.
//
// So: park the code on `process.exitCode`, wait for both streams to drain, and only then exit. The
// explicit exit stays — `fetch`'s keep-alive sockets can hold the event loop open for seconds after
// the work is done, and a CLI that lingers is its own defect — but by then nothing is buffered.
import("../dist/cli.js")
  .then((m) => m.main(process.argv.slice(2)))
  .then((code) => finish(code))
  .catch((err) => {
    console.error(`catalyst-skills: failed to load: ${err instanceof Error ? err.message : String(err)}`);
    finish(1);
  });

/**
 * Resolve once every byte already handed to `stream` has reached the other end. The empty write is
 * ordered behind the real ones, so its callback is the drain signal; a destroyed or errored stream
 * (a reader that hung up) resolves immediately rather than hanging the process forever.
 */
function drained(stream) {
  return new Promise((resolve) => {
    if (!stream || stream.destroyed || stream.writableEnded) return resolve();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    stream.once("error", done);
    try {
      stream.write("", done);
    } catch {
      done();
    }
  });
}

async function finish(code) {
  process.exitCode = code;
  await Promise.all([drained(process.stdout), drained(process.stderr)]);
  process.exit(code);
}
