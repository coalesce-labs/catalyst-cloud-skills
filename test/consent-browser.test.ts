import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createConsentBrowserOpener } from "../src/consent-browser.js";

const consentUrl = "https://example.test/consent";
const caseTimeoutMs = 30_000;
const owned: Array<{
  child: ChildProcess;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  isClosed: () => boolean;
}> = [];
const directories: string[] = [];

function nodeChild(program: string, args: readonly string[] = []) {
  const child = spawn(process.execPath, ["-e", program, ...args], {
    stdio: "ignore",
  });
  let closed = false;
  const close = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (code, signal) => {
      closed = true;
      resolve({ code, signal });
    });
  });
  // The opener owns the error outcome. This listener only keeps a spawn failure from
  // becoming an unhandled EventEmitter error during test teardown.
  child.on("error", () => {});
  const witness = { child, closed: close, isClosed: () => closed };
  owned.push(witness);
  return witness;
}

function launchProgram(program: string, args: readonly string[] = []) {
  let witness: ReturnType<typeof nodeChild> | undefined;
  return {
    launch: (_command: string, _arguments: readonly string[]) => {
      witness = nodeChild(program, args);
      return witness.child;
    },
    witness: () => {
      if (!witness) throw new Error("child was not launched");
      return witness;
    },
  };
}

async function waitForFile(path: string) {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("child did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function readyChild(ignoreTerm = false) {
  const directory = mkdtempSync(join(tmpdir(), "consent-browser-test-"));
  directories.push(directory);
  const marker = join(directory, "ready");
  const program = [
    "const fs = require('node:fs');",
    ignoreTerm ? "process.on('SIGTERM', () => {});" : "",
    "fs.writeFileSync(process.argv[1], 'ready');",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  return { marker, ...launchProgram(program, [marker]) };
}

afterEach(async () => {
  for (const item of owned) if (!item.isClosed()) item.child.kill("SIGKILL");
  await Promise.all(owned.splice(0).map((item) => item.closed));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("consent browser opener with real child processes", () => {
  test("resolves only after a zero-exit child closes", async () => {
    const fixture = launchProgram("setTimeout(() => process.exit(0), 300);");
    const open = createConsentBrowserOpener({ launch: fixture.launch });
    await open(consentUrl);
    expect(fixture.witness().isClosed()).toBe(true);
    expect(await fixture.witness().closed).toEqual({ code: 0, signal: null });
  }, caseTimeoutMs);

  test("rejects a nonzero child exit without revealing the URL", async () => {
    const fixture = launchProgram("process.exit(7);");
    const open = createConsentBrowserOpener({ launch: fixture.launch });
    const error = await open(consentUrl).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/browser.*(?:unavailable|could not open)/i);
    expect(String(error)).not.toContain(consentUrl);
    expect(fixture.witness().isClosed()).toBe(true);
    expect(await fixture.witness().closed).toEqual({ code: 7, signal: null });
  }, caseTimeoutMs);

  test("joins close after an asynchronous missing-executable error", async () => {
    const directory = mkdtempSync(join(tmpdir(), "consent-browser-missing-"));
    directories.push(directory);
    let witness: ReturnType<typeof nodeChild> | undefined;
    const open = createConsentBrowserOpener({
      launch: () => {
        const child = spawn(join(directory, "missing-command"), [], {
          stdio: "ignore",
        });
        let closed = false;
        const close = new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((resolve) => {
          child.once("close", (code, signal) => {
            closed = true;
            resolve({ code, signal });
          });
        });
        child.on("error", () => {});
        witness = { child, closed: close, isClosed: () => closed };
        owned.push(witness);
        return child;
      },
    });
    const error = await open(consentUrl).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/browser.*(?:unavailable|could not open)/i);
    expect(String(error)).not.toContain(consentUrl);
    expect(witness?.isClosed()).toBe(true);
  }, caseTimeoutMs);

  test("a deadline sends SIGTERM and waits for child close", async () => {
    const fixture = readyChild();
    const open = createConsentBrowserOpener({
      launch: fixture.launch,
      timeoutMs: 1_000,
      killGraceMs: 100,
    });
    const result = open(consentUrl).catch((reason: unknown) => reason);
    await waitForFile(fixture.marker);
    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(consentUrl);
    expect(fixture.witness().isClosed()).toBe(true);
    expect((await fixture.witness().closed).signal).toBe("SIGTERM");
  }, caseTimeoutMs);

  test("an already-aborted signal launches no child", async () => {
    const controller = new AbortController();
    controller.abort();
    let launches = 0;
    const open = createConsentBrowserOpener({
      launch: () => {
        launches++;
        return nodeChild("process.exit(0);").child;
      },
    });
    await expect(open(consentUrl, controller.signal)).rejects.toBeInstanceOf(Error);
    expect(launches).toBe(0);
  }, caseTimeoutMs);

  test("abort of an active child waits for its close", async () => {
    const fixture = readyChild();
    const controller = new AbortController();
    const open = createConsentBrowserOpener({
      launch: fixture.launch,
      timeoutMs: 5_000,
      killGraceMs: 100,
    });
    const result = open(consentUrl, controller.signal).catch((reason: unknown) => reason);
    await waitForFile(fixture.marker);
    controller.abort();
    expect(await result).toBeInstanceOf(Error);
    expect(fixture.witness().isClosed()).toBe(true);
    expect((await fixture.witness().closed).signal).toBe("SIGTERM");
  }, caseTimeoutMs);

  test("a child ignoring SIGTERM is killed and joined after the grace period", async () => {
    const fixture = readyChild(true);
    const open = createConsentBrowserOpener({
      launch: fixture.launch,
      timeoutMs: 1_000,
      killGraceMs: 100,
    });
    const result = open(consentUrl).catch((reason: unknown) => reason);
    await waitForFile(fixture.marker);
    expect(await result).toBeInstanceOf(Error);
    expect(fixture.witness().isClosed()).toBe(true);
    expect((await fixture.witness().closed).signal).toBe("SIGKILL");
  }, caseTimeoutMs);
});
