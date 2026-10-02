// setup.test.ts — CTC-4625: `catalyst setup` runs the install engine and draws what it reports.
// The engine here is a small stand-in script speaking the same fd 3/4/5 protocol as the served one:
// fd 3 the --json document, fd 4 the events, fd 5 the answers it reads back.
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { setupOnboardStreams } from "../src/setup-prompts.js";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { cmdSetup, type SetupDeps } from "../src/setup.js";
import type { SetupStream } from "../src/setup-render.js";
import { makeCtx, tempHome } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function engine(body: string): { path: string; sha256: string } {
  const dir = mkdtempSync(join(tmpdir(), "setup-engine-"));
  dirs.push(dir);
  const path = join(dir, "engine.sh");
  const text = `#!/bin/sh\nset -u\nev() { printf '%s\\n' "$1" >&4; }\n${body}\n`;
  writeFileSync(path, text);
  chmodSync(path, 0o755);
  return { path, sha256: createHash("sha256").update(text).digest("hex") };
}

function sink(tty = false): SetupStream & { text(): string } {
  const chunks: string[] = [];
  return {
    isTTY: tty,
    columns: 80,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    text: () => chunks.join(""),
  };
}

function run(argv: string[], deps: Partial<SetupDeps> = {}) {
  const out = sink();
  const err = sink();
  const json: string[] = [];
  const ctx = makeCtx(tempHome(), {
    env: { TERM: "xterm-256color", LANG: "C.UTF-8" },
  });
  const done = cmdSetup(argv, ctx, {
    stdout: out,
    stderr: err,
    writeJson: (chunk) => json.push(chunk),
    interactive: false,
    ...deps,
  });
  return { done, out, err, json, ctx };
}

const TAB = "\t";

describe("catalyst setup", () => {
  test("draws the engine's plan and steps as plain text in a pipe, with blank lines between plan steps", async () => {
    const e = engine(
      [
        `ev "line${TAB}Catalyst setup"`,
        `ev "row${TAB}System${TAB}Linux x86_64"`,
        `ev "plan${TAB}1${TAB}Install the catalyst command${TAB}from npm"`,
        `ev "plan${TAB}2${TAB}Add Catalyst skills${TAB}in ~/.agents/skills"`,
        `ev "more${TAB}for Claude Code and Codex"`,
        `ev "heading${TAB}Setting up"`,
        `ev "begin${TAB}1${TAB}Install the catalyst command"`,
        `ev "step${TAB}done${TAB}1${TAB}Catalyst command${TAB}installed 0.15.0"`,
        `ev "detail${TAB}~/.npm-global/bin/catalyst"`,
        "exit 0",
      ].join("\n"),
    );
    const r = run([
      "--engine",
      e.path,
      "--engine-sha256",
      e.sha256,
      "--",
      "--yes",
    ]);
    expect(await r.done).toBe(0);
    const text = r.out.text();
    expect(text).not.toContain("\u001b");
    expect(text).toContain("Catalyst setup\n");
    expect(text).toContain("System             Linux x86_64\n");
    expect(text).toContain(
      "         1 Install the catalyst command    from npm\n\n         2 Add Catalyst skills             in ~/.agents/skills\n       for Claude Code and Codex\n",
    );
    expect(text).toContain("\nThis computer\n");
    expect(text).toContain(
      "[done]   1 Install the catalyst command    installed 0.15.0\n",
    );
    expect(text).not.toContain("~/.npm-global/bin/catalyst");
  });

  test("passes the engine's exit code through", async () => {
    const e = engine("exit 11");
    const r = run(["--engine", e.path, "--engine-sha256", e.sha256]);
    expect(await r.done).toBe(11);
  });

  test("runs the engine in events mode with the arguments as given", async () => {
    const e = engine(
      `ev "line${TAB}ui=$CATALYST_INSTALL_UI interactive=$CATALYST_INSTALL_INTERACTIVE args=$*"`,
    );
    const r = run([
      "--engine",
      e.path,
      "--engine-sha256",
      e.sha256,
      "--",
      "--scope",
      "home",
      "--yes",
    ]);
    expect(await r.done).toBe(0);
    expect(r.out.text()).toContain(
      "ui=events interactive=0 args=--scope home --yes",
    );
  });

  test("refuses an engine whose digest does not match, before running it", async () => {
    const e = engine(`ev "line${TAB}ran"`);
    const r = run(["--engine", e.path, "--engine-sha256", "0".repeat(64)]);
    expect(await r.done).toBe(10);
    expect(r.out.text()).not.toContain("ran");
    expect(r.err.text()).toContain("setup engine");
  });

  test("needs --engine and its digest", async () => {
    const r = run([]);
    expect(await r.done).toBe(10);
    expect(r.err.text()).toContain("--engine");
  });

  test("--json: one document on stdout from fd 3, every human line on stderr", async () => {
    const e = engine(
      [
        `ev "step${TAB}done${TAB}1${TAB}Catalyst command${TAB}installed"`,
        `printf '{\\n  "schema": "catalyst-install-last-run/1",\\n  "state": "finished"\\n}\\n' >&3`,
        "echo stray-stdout",
        "exit 0",
      ].join("\n"),
    );
    const r = run([
      "--engine",
      e.path,
      "--engine-sha256",
      e.sha256,
      "--",
      "--json",
      "--yes",
    ]);
    expect(await r.done).toBe(0);
    expect(r.out.text()).toBe("");
    const doc = r.json.join("");
    expect(JSON.parse(doc)).toEqual({
      schema: "catalyst-install-last-run/1",
      state: "finished",
    });
    expect(r.err.text()).toContain("[done]   1 Install the catalyst command");
    expect(r.err.text()).toContain("stray-stdout");
  });

  test("a question with no terminal takes its stated default and the engine reads it on fd 5", async () => {
    const e = engine(
      [
        `ev "ask${TAB}continue${TAB}Continue?${TAB}y"`,
        "IFS= read -r answer <&5",
        `ev "line${TAB}answer=$answer"`,
      ].join("\n"),
    );
    const r = run(["--engine", e.path, "--engine-sha256", e.sha256]);
    expect(await r.done).toBe(0);
    expect(r.out.text()).toContain("answer=y");
  });

  test("a question on a terminal goes to the prompt and its answer reaches the engine", async () => {
    const e = engine(
      [
        `ev "ask${TAB}continue${TAB}Continue?${TAB}y"`,
        "IFS= read -r answer <&5",
        `ev "line${TAB}answer=$answer"`,
      ].join("\n"),
    );
    const asked: string[] = [];
    const r = run(["--engine", e.path, "--engine-sha256", e.sha256], {
      interactive: true,
      ask: async (event) => {
        asked.push(event.id);
        return "l";
      },
    });
    expect(await r.done).toBe(0);
    expect(asked).toEqual(["continue"]);
    expect(r.out.text()).toContain("answer=l");
  });

  test("sign-in runs in this process and its outcome reaches the engine", async () => {
    const e = engine(
      [
        `ev "begin${TAB}4${TAB}Sign in to Catalyst"`,
        `ev "signin${TAB}600"`,
        "IFS= read -r outcome <&5",
        `ev "line${TAB}outcome=$outcome"`,
      ].join("\n"),
    );
    const timeouts: number[] = [];
    const r = run(["--engine", e.path, "--engine-sha256", e.sha256], {
      signin: async (seconds) => {
        timeouts.push(seconds);
        return "timeout";
      },
    });
    expect(await r.done).toBe(0);
    expect(timeouts).toEqual([600]);
    expect(r.out.text()).toContain("[..]     4 Sign in to Catalyst");
    expect(r.out.text()).toContain("outcome=timeout");
  });

  test("a stop prints the failure block on stderr and keeps the resume: line whole", async () => {
    const resume =
      "curl -fsSL https://staging.catalystcloud.dev/install.sh | sh -s -- --scope home";
    const e = engine(
      [
        `ev "stop${TAB}Stopped at step 2 of 7: Add Catalyst skills.${TAB}no network${TAB}catalyst command.${TAB}reconnect, then rerun${TAB}~/catalyst/logs/install.log${TAB}${resume}"`,
        "exit 10",
      ].join("\n"),
    );
    const r = run(["--engine", e.path, "--engine-sha256", e.sha256]);
    expect(await r.done).toBe(10);
    const text = r.err.text();
    expect(text).toContain("Stopped at step 2 of 7: Add Catalyst skills.");
    expect(text).toContain("What happened: no network\n");
    expect(text).toContain("Already done:  catalyst command.\n");
    expect(text).toContain("To fix:        reconnect, then rerun\n");
    expect(text).toContain("Log:           ~/catalyst/logs/install.log\n");
    expect(text).toContain(`resume: ${resume}\n`);
  });

  test("changes remain hidden unless verbose was selected", async () => {
    const e = engine(
      [
        `ev "change${TAB}Created folder ~/catalyst"`,
        `ev "changes-end"`,
        `ev "changes-end"`,
      ].join("\n"),
    );
    const r = run(["--engine", e.path, "--engine-sha256", e.sha256]);
    expect(await r.done).toBe(0);
    const text = r.out.text();
    expect(text).toBe("");
    const verbose = run([
      "--engine",
      e.path,
      "--engine-sha256",
      e.sha256,
      "--",
      "--verbose",
    ]);
    expect(await verbose.done).toBe(0);
    expect(verbose.out.text()).toContain("Created folder ~/catalyst");
  });

  test("the verdict closes the run, and the engine's own plain lines show as they are", async () => {
    const e = engine(
      [
        `ev "verdict${TAB}ok${TAB}This computer is ready."`,
        `printf '%s\\n' "Next: run catalyst onboard" >&4`,
      ].join("\n"),
    );
    const r = run(["--engine", e.path, "--engine-sha256", e.sha256]);
    expect(await r.done).toBe(0);
    expect(r.out.text()).toContain(
      "\nThis computer is ready.\nNext: run catalyst onboard\n",
    );
  });

  // ── review fixes: interrupts, failures and a vanished engine never leave anything waiting ──

  test("a Ctrl-C before the sign-in does not cancel it: only a Ctrl-C during it does", async () => {
    const e = engine(
      [
        `ev "ask${TAB}continue${TAB}Continue?${TAB}y"`,
        "IFS= read -r answer <&5",
        `ev "signin${TAB}600"`,
        "IFS= read -r outcome <&5",
        `ev "line${TAB}outcome=$outcome"`,
      ].join("\n"),
    );
    const r = run(["--engine", e.path, "--engine-sha256", e.sha256], {
      interactive: true,
      ask: async () => {
        process.emit("SIGINT");
        return "y";
      },
      signin: async (_seconds, _r, interrupted) =>
        interrupted.aborted ? "cancelled" : "done",
    });
    expect(await r.done).toBe(0);
    expect(r.out.text()).toContain("outcome=done");
  });

  test("Ctrl-C during the sign-in cancels it, and the engine hears cancelled", async () => {
    const e = engine(
      [
        `ev "signin${TAB}600"`,
        "IFS= read -r outcome <&5",
        `ev "line${TAB}outcome=$outcome"`,
      ].join("\n"),
    );
    const r = run(["--engine", e.path, "--engine-sha256", e.sha256], {
      signin: (_seconds, _r, interrupted) =>
        new Promise((resolve) => {
          interrupted.addEventListener("abort", () => resolve("cancelled"));
          setTimeout(() => process.emit("SIGINT"), 20);
        }),
    });
    expect(await r.done).toBe(0);
    expect(r.out.text()).toContain("outcome=cancelled");
  });

  test("a question the person cancels interrupts the engine the way Ctrl-C does", async () => {
    const e = engine(
      [
        `trap 'ev "line${TAB}engine interrupted"; exit 10' INT`,
        `ev "ask${TAB}daily${TAB}Update Catalyst daily? [Y/n]:${TAB}y"`,
        "IFS= read -r answer <&5",
        "sleep 1",
        `ev "line${TAB}answer=$answer"`,
      ].join("\n"),
    );
    const r = run(["--engine", e.path, "--engine-sha256", e.sha256], {
      interactive: true,
      ask: async () => null,
    });
    expect(await r.done).toBe(10);
    expect(r.out.text()).toContain("engine interrupted");
    expect(r.out.text()).not.toContain("answer=");
  });

  test("a question that fails to draw takes its default, so the engine never waits forever", async () => {
    const e = engine(
      [
        `ev "ask${TAB}continue${TAB}Continue?${TAB}y"`,
        "IFS= read -r answer <&5",
        `ev "line${TAB}answer=$answer"`,
      ].join("\n"),
    );
    const r = run(["--engine", e.path, "--engine-sha256", e.sha256], {
      interactive: true,
      ask: async () => {
        throw new Error("EIO: /dev/tty went away");
      },
    });
    expect(await r.done).toBe(0);
    expect(r.out.text()).toContain("answer=y");
    expect(r.err.text()).toContain("EIO: /dev/tty went away");
  });

  test("a sign-in that throws answers failed", async () => {
    const e = engine(
      [
        `ev "signin${TAB}600"`,
        "IFS= read -r outcome <&5",
        `ev "line${TAB}outcome=$outcome"`,
      ].join("\n"),
    );
    const r = run(["--engine", e.path, "--engine-sha256", e.sha256], {
      signin: async () => {
        throw new Error("discovery failed");
      },
    });
    expect(await r.done).toBe(0);
    expect(r.out.text()).toContain("outcome=failed");
  });

  test("when the engine exits mid-question or mid-sign-in, both are stopped and setup returns its code", async () => {
    for (const kind of ["ask", "signin"] as const) {
      const e = engine(
        kind === "ask"
          ? `ev "ask${TAB}continue${TAB}Continue?${TAB}y"\nexit 12`
          : `ev "signin${TAB}600"\nexit 12`,
      );
      const waitForAbort = (signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) =>
          signal.addEventListener("abort", () =>
            reject(new Error("engine gone")),
          ),
        );
      const r = run(["--engine", e.path, "--engine-sha256", e.sha256], {
        interactive: true,
        ask: (_event, _r, signal) => waitForAbort(signal),
        signin: (_seconds, _r, interrupted) => waitForAbort(interrupted),
      });
      expect(await r.done, kind).toBe(12);
    }
  });

  test("runs a private copy of the verified engine, never the path it was given, and removes it", async () => {
    const e = engine(`ev "line${TAB}self=$0"`);
    const r = run(["--engine", e.path, "--engine-sha256", e.sha256]);
    expect(await r.done).toBe(0);
    const self = /self=(\S+)/.exec(r.out.text())?.[1] ?? "";
    expect(self).not.toBe(e.path);
    expect(self).toMatch(/engine\.sh$/);
    expect(existsSync(self)).toBe(false);
  });

  test("--json: a stop before the engine runs is still one document", async () => {
    const e = engine(`ev "line${TAB}ran"`);
    const r = run([
      "--engine",
      e.path,
      "--engine-sha256",
      "0".repeat(64),
      "--",
      "--json",
    ]);
    expect(await r.done).toBe(10);
    const doc = JSON.parse(r.json.join("")) as {
      schema: string;
      state: string;
      exitCode: number;
      message: string;
    };
    expect(doc).toMatchObject({
      schema: "catalyst-install-last-run/1",
      state: "stopped",
      exitCode: 10,
    });
    expect(doc.message).toContain("did not match");
  });

  test("an engine killed by a signal exits 128 plus the signal, as a shell reports it", async () => {
    const e = engine("kill -TERM $$");
    const r = run(["--engine", e.path, "--engine-sha256", e.sha256]);
    expect(await r.done).toBe(143);
  });

  test("returns when the engine exits, though a child it left behind still holds its pipes", async () => {
    const e = engine(
      [`ev "line${TAB}before"`, "sleep 30 &", "exit 0"].join("\n"),
    );
    const started = Date.now();
    const r = run(["--engine", e.path, "--engine-sha256", e.sha256]);
    expect(await r.done).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.out.text()).toContain("before");
  });
});

test("continues in process after the machine engine exits, using the same renderer", async () => {
  const e = engine("exit 0");
  const seen: unknown[] = [];
  const r = run(["--engine", e.path, "--engine-sha256", e.sha256], {
    onboard: async (renderer, flags) => {
      seen.push(renderer, flags);
      renderer.heading("Linear");
      return 11;
    },
  });
  expect(await r.done).toBe(11);
  expect(seen).toHaveLength(2);
  expect(r.out.text()).toContain("Linear");
});
test("failed machine checks do not run onboarding", async () => {
  const e = engine("exit 10");
  let started = false;
  const r = run(["--engine", e.path, "--engine-sha256", e.sha256], {
    onboard: async () => {
      started = true;
      return 0;
    },
  });
  expect(await r.done).toBe(10);
  expect(started).toBe(false);
});
test("JSON continuation replaces machine output with exactly one final document", async () => {
  const e = engine(`printf '{"machine":true}\\n' >&3; exit 0`);
  let r: ReturnType<typeof run>;
  r = run(["--engine", e.path, "--engine-sha256", e.sha256, "--", "--json"], {
    onboard: async () => {
      r.json.push('{"verdict":"complete"}\n');
      return 0;
    },
  });
  expect(await r.done).toBe(0);
  expect(JSON.parse(r.json.join(""))).toEqual({ verdict: "complete" });
});

test("old engine plan hides folded local sync and final check plus their detail rows", async () => {
  const e = engine(`ev "plan${TAB}5${TAB}Local sync${TAB}hidden"
ev "more${TAB}hidden-more"
ev "plan${TAB}6${TAB}Daily update${TAB}visible"
ev "plan${TAB}7${TAB}Final check${TAB}hidden-final"
ev "more${TAB}hidden-final-more"`);
  const r = run(["--engine", e.path, "--engine-sha256", e.sha256]);
  expect(await r.done).toBe(0);
  expect(r.out.text()).not.toContain("hidden");
  expect(r.out.text()).toContain("5 Daily update");
});
test("engine help never continues into onboarding", async () => {
  const e = engine("exit 0");
  let started = false;
  const r = run(
    ["--engine", e.path, "--engine-sha256", e.sha256, "--", "--help"],
    {
      onboard: async () => {
        started = true;
        return 0;
      },
    },
  );
  expect(await r.done).toBe(0);
  expect(started).toBe(false);
});
test("an unexpected JSON continuation failure still writes one failed document", async () => {
  const e = engine(`printf '{"machine":true}\\n' >&3; exit 0`);
  const r = run(
    ["--engine", e.path, "--engine-sha256", e.sha256, "--", "--json"],
    {
      onboard: async () => {
        throw new Error("private-stack");
      },
    },
  );
  expect(await r.done).toBe(10);
  expect(JSON.parse(r.json.join(""))).toMatchObject({
    exitCode: 10,
    state: "failed",
  });
  expect(r.out.text()).not.toContain("private-stack");
});

test("onboarding questions use the controlling terminal output even when stdout is redirected", () => {
  const input = new PassThrough(),
    output = new PassThrough();
  const streams = setupOnboardStreams({ input, output });
  expect(streams.input).toBe(input);
  expect(streams.output).toBe(output);
  expect(streams.output).not.toBe(process.stdout);
});
test("cancelling the initial prompt never answers the default yes", async () => {
  const e = engine(`trap '' INT
ev "ask${TAB}continue${TAB}Continue?${TAB}y"
IFS= read -r reply <&5
if [ "$reply" = y ]; then ev "line${TAB}UNSAFE_CHANGE"; exit 0; fi
exit 10`);
  const r = run(["--engine", e.path, "--engine-sha256", e.sha256], {
    interactive: true,
    ask: async () => null,
  });
  expect(await r.done).toBe(10);
  expect(r.out.text()).not.toContain("UNSAFE_CHANGE");
});


test.each([0, 10, 11])("uncontinued machine engine keeps its final repair guidance (exit %s)", async (code) => {
  const e = engine(`ev "line${TAB}Full log: /tmp/catalyst-install.log"
ev "line${TAB}Next: run catalyst onboard"
exit ${code}`);
  let started = false;
  const r = run(["--engine", e.path, "--engine-sha256", e.sha256], {
    onboard: async (renderer) => { started = true; renderer.outro("Next: move a ticket to Todo in Linear."); return 0; },
  });
  expect(await r.done).toBe(code);
  expect(started).toBe(code === 0);
  expect(r.out.text().match(/Next:/g)).toHaveLength(1);
  if (code === 0) expect(r.out.text()).toContain("Next: move a ticket to Todo in Linear.");
  else {
    expect(r.out.text()).toContain("Full log: /tmp/catalyst-install.log");
    expect(r.out.text().trim().split("\n").at(-1)).toBe("Next: run catalyst onboard");
  }
});
