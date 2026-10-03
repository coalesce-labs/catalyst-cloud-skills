// setup-signin-immediate.test.ts — CTC-4625: the sign-in code reaches the person the moment the
// server sends it, through a pipe and under a real terminal.
//
// ⛔ THIS TEST DRIVES THE REAL BINARY. 0.13.9 relayed `catalyst login` through fold, which buffered
// the code until the deadline killed the pipe, and every in-process test still passed because none
// of them had a pipe or a terminal between the code and the reader. Here the reader is a pipe (the
// `curl | sh | tee` shape) or a pseudo-terminal (python3's pty, the shape a person sees), and the
// clock starts when the fixture hands out the device code.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { startMeFixture, type FixtureServer } from "./fixture";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const BIN = join(pkgRoot, "bin", "catalyst.js");
const CODE = "WXYZ-1234";
/** The line that carries the code to type, styled or not. */
const CODE_LINE = new RegExp(`enter (\u001b\\[[0-9;]*m)?${CODE}`);
const IMMEDIATE_MS = 1000;

let server: FixtureServer;
let work: string;
let engine: { path: string; sha256: string };
const children: ChildProcess[] = [];

beforeAll(async () => {
  // The bin loads dist/, so build it here: a stale dist would make this test about old code.
  const built = spawnSync("npm", ["run", "build"], {
    cwd: pkgRoot,
    encoding: "utf8",
  });
  expect(built.status, `build failed:\n${built.stdout}\n${built.stderr}`).toBe(
    0,
  );
  expect(existsSync(join(pkgRoot, "dist", "cli.js"))).toBe(true);
  work = mkdtempSync(join(tmpdir(), "setup-signin-"));
  // A browser opener that is present and fails at once: the test never opens a real browser.
  mkdirSync(join(work, "bin"));
  for (const name of ["open", "xdg-open"]) {
    writeFileSync(join(work, "bin", name), "#!/bin/sh\nexit 1\n");
    chmodSync(join(work, "bin", name), 0o755);
  }
  // The engine's side of step 4: announce it, ask for the sign-in, report the answer.
  const text = [
    "#!/bin/sh",
    "printf 'begin\\t4\\tSign in to Catalyst\\n' >&4",
    "printf 'signin\\t60\\n' >&4",
    "IFS= read -r outcome <&5",
    "printf 'line\\toutcome=%s\\n' \"$outcome\" >&4",
    "",
  ].join("\n");
  engine = {
    path: join(work, "engine.sh"),
    sha256: createHash("sha256").update(text).digest("hex"),
  };
  writeFileSync(engine.path, text);
}, 180_000);

afterEach(() => {
  for (const child of children.splice(0))
    if (child.exitCode === null) child.kill("SIGKILL");
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(work, "home-"));
  return {
    HOME: home,
    PATH: `${join(work, "bin")}:${process.env.PATH ?? ""}`,
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    CATALYST_CLOUD_BASE_URL: server?.url ?? "http://127.0.0.1:9",
    CATALYST_SKILLS_OFFLINE: "1",
  };
}

/** Starts `cmd`, and resolves with how long after the device code was minted the code line was read. */
async function codeDelay(
  cmd: string,
  args: string[],
): Promise<{ delayMs: number; stillWaiting: boolean; output: string }> {
  server = await startMeFixture();
  // Never approve: the login keeps waiting, so a code that only shows at exit cannot pass.
  server.oauth.pendingPolls = 1_000_000;
  const child = spawn(cmd, args, {
    env: env(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  let minted: number | null = null;
  const watch = setInterval(() => {
    if (minted === null && server.oauth.deviceAuthorizeCount > 0)
      minted = Date.now();
  }, 5);
  try {
    return await new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () =>
          reject(new Error(`no code within 20 s; output so far:\n${output}`)),
        20_000,
      );
      const onData = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (CODE_LINE.test(output)) {
          const seen = Date.now();
          clearTimeout(deadline);
          resolve({
            delayMs: seen - (minted ?? seen),
            stillWaiting: child.exitCode === null,
            output,
          });
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("exit", (code) =>
        reject(new Error(`exited ${code} before the code; output:\n${output}`)),
      );
    });
  } finally {
    clearInterval(watch);
    child.kill("SIGTERM");
    await server.close();
  }
}

test("piped: the code is on stdout within a second of the server minting it, while setup still waits", async () => {
  const result = await codeDelay(process.execPath, [
    BIN,
    "setup",
    "--engine",
    engine.path,
    "--engine-sha256",
    engine.sha256,
  ]);
  expect(result.stillWaiting).toBe(true);
  expect(result.delayMs).toBeLessThan(IMMEDIATE_MS);
  expect(result.output).not.toContain("\u001b");
  expect(result.output).toContain("4 Sign in to Catalyst");
  expect(result.output).toContain(`${server.url}/activate?user_code=${CODE}`);
  expect(result.output).toContain(
    `Or open ${server.url}/activate and enter ${CODE}.`,
  );
}, 60_000);

test("under a terminal: the code is on screen within a second of the server minting it, while setup still waits", async () => {
  const probe = spawnSync("python3", ["-c", "import pty"], {
    encoding: "utf8",
  });
  expect(
    probe.status,
    "python3 with the pty module is required for the terminal lane",
  ).toBe(0);
  const result = await codeDelay("python3", [
    "-c",
    "import pty, sys; pty.spawn(sys.argv[1:])",
    process.execPath,
    BIN,
    "setup",
    "--engine",
    engine.path,
    "--engine-sha256",
    engine.sha256,
  ]);
  expect(result.stillWaiting).toBe(true);
  expect(result.delayMs).toBeLessThan(IMMEDIATE_MS);
  // A real terminal gets the styled form; the code itself is never split by an escape.
  expect(result.output).toContain("\u001b[");
}, 60_000);

test("under a terminal with stdin from /dev/null, as install.sh starts it: the spinner path shows the code just as fast", async () => {
  const command = [
    process.execPath,
    BIN,
    "setup",
    "--engine",
    engine.path,
    "--engine-sha256",
    engine.sha256,
  ]
    .map((a) => `'${a.replaceAll("'", "'\\''")}'`)
    .join(" ");
  const result = await codeDelay("python3", [
    "-c",
    "import pty, sys; pty.spawn(sys.argv[1:])",
    "/bin/sh",
    "-c",
    `exec ${command} </dev/null`,
  ]);
  expect(result.stillWaiting).toBe(true);
  expect(result.delayMs).toBeLessThan(IMMEDIATE_MS);
}, 60_000);

test("a terminal that reports no width still draws a question whole, and its answer reaches the engine", () => {
  const text = [
    "#!/bin/sh",
    "printf 'ask\\tcontinue\\tContinue? [Y/n, l for local sync, e to edit]\\ty\\n' >&4",
    "IFS= read -r answer <&5",
    "printf 'line\\tanswer=%s\\n' \"$answer\" >&4",
    "",
  ].join("\n");
  const path = join(work, "ask-engine.sh");
  writeFileSync(path, text);
  const sha = createHash("sha256").update(text).digest("hex");
  // pty.fork opens the terminal with no size (0 columns), as the pre-flight's driver does.
  const driver = [
    "import os, pty, select, sys, time",
    "pid, fd = pty.fork()",
    "if pid == 0:",
    "    os.execvp(sys.argv[1], sys.argv[1:])",
    "buf = b''; t0 = time.time(); sent = False",
    "while time.time() - t0 < 20:",
    "    r, _, _ = select.select([fd], [], [], 0.2)",
    "    if not r: continue",
    "    try: d = os.read(fd, 4096)",
    "    except OSError: break",
    "    if not d: break",
    "    buf += d",
    "    if not sent and b'Start setup?' in buf:",
    "        time.sleep(0.3); os.write(fd, b'\\r'); sent = True",
    "sys.stdout.buffer.write(buf)",
  ].join("\n");
  const r = spawnSync(
    "python3",
    [
      "-c",
      driver,
      process.execPath,
      BIN,
      "setup",
      "--engine",
      path,
      "--engine-sha256",
      sha,
    ],
    {
      env: env(),
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  expect(r.stdout).toContain("Start setup?");
  expect(r.stdout).toContain("answer=y");
}, 60_000);
