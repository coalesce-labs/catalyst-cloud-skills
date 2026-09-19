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
//
// ⛔ THE PREFLIGHT BELOW RUNS BEFORE dist/cli.js IS IMPORTED (CTC-2158). It answers "can THIS
// runtime run the CLI, and if not, what is the one command?" using the SAME dist/runtime.js verdict
// every other message in the package reads — one voice, not a second copy of the floor logic.
// Importing dist/runtime.js, dist/runtime-store.js and dist/config.js here is safe on every runtime
// measured for this ticket (Node 22.14, Node 26.8.1, bun 1.3.14, bun 1.4.2): none of the three
// imports node:sqlite or the SDK, which are the only two things that used to abort module loading
// before main() ever ran. `runtime` itself is EXEMPT from every refusal below, or the fix command
// could not be run on the broken runtime it exists to fix.
//
// Policy (CATALYST_SKILLS_RUNTIME overrides: auto | pinned | ambient):
//   • a pin is installed (and the policy is not "ambient") -> re-exec into it, always. A customer
//     who ran `runtime install` asked for a runtime independent of the machine's default Node — this
//     is where they get it (Tier 2).
//   • auto (default), ambient supported, no pin -> run in process. ZERO extra process: skill
//     scripts spawn this CLI constantly, and doubling process startup on every call is a real cost.
//   • ambient unsupported, no pin -> print the verdict and the ONE command; exit 1, never a raw
//     module-resolution error.
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const handled = argv[0] === "runtime" ? false : await preflight(argv);
if (!handled) {
  import("../dist/cli.js")
    .then((m) => m.main(process.argv.slice(2)))
    .then((code) => finish(code))
    .catch((err) => {
      console.error(`catalyst-skills: failed to load: ${err instanceof Error ? err.message : String(err)}`);
      finish(1);
    });
}

/** Returns true when it already handled (and exited) the invocation. */
async function preflight(args) {
  const policy = process.env.CATALYST_SKILLS_RUNTIME ?? "auto";
  const home = process.env.CATALYST_SKILLS_HOME ?? process.env.HOME ?? "/";

  let runtimeStore, runtimeMod, config;
  try {
    [runtimeStore, runtimeMod, config] = await Promise.all([import("../dist/runtime-store.js"), import("../dist/runtime.js"), import("../dist/config.js")]);
  } catch {
    // dist/ itself failed to resolve for some other reason — fall through to the normal import
    // below, whose own .catch() will surface that loudly rather than hiding it here.
    return false;
  }

  const pin = policy === "ambient" ? null : runtimeStore.readPin(home);
  if (pin) {
    const { existsSync } = await import("node:fs");
    if (existsSync(pin.nodePath)) {
      const { spawnSync } = await import("node:child_process");
      const res = spawnSync(pin.nodePath, [fileURLToPath(import.meta.url), ...args], {
        stdio: "inherit",
        env: { ...process.env, CATALYST_SKILLS_RUNTIME: "ambient" },
      });
      await finish(res.status ?? 1);
      return true;
    }
  }

  if (policy === "pinned") {
    console.error(`catalyst-skills: CATALYST_SKILLS_RUNTIME=pinned but no pinned runtime is installed. Run: ${runtimeMod.FIX_COMMAND}`);
    await finish(1);
    return true;
  }

  let manifest;
  try {
    manifest = config.readManifest();
  } catch (err) {
    console.error(`catalyst-skills: ${err instanceof Error ? err.message : String(err)}`);
    await finish(1);
    return true;
  }

  // CATALYST_SKILLS_RUNTIME_FACTS is a test-only injection seam: it lets the launcher's own tests
  // drive an unsupported/supported runtime without actually installing one.
  const facts = process.env.CATALYST_SKILLS_RUNTIME_FACTS ? JSON.parse(process.env.CATALYST_SKILLS_RUNTIME_FACTS) : runtimeMod.detectRuntime();
  const verdict = runtimeMod.runtimeVerdict(facts, manifest.enginesNode);
  if (!verdict.supported) {
    console.error(`catalyst-skills: ${verdict.line}`);
    if (verdict.reason) console.error(`  ${verdict.reason}`);
    if (verdict.fix) console.error(`  fix: ${verdict.fix}`);
    await finish(1);
    return true;
  }
  return false;
}

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
