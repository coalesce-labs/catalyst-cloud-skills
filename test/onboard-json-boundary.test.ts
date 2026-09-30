import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { main } from "../src/cli.js";
import { defaultCtx } from "../src/config.js";
import { onboardLockPath, onboardStatePath } from "../src/onboard.js";

const homes: string[] = [];
const privateFixture = "fixture-private-provider-input-never-echo";
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "onboard-json-boundary-"));
  homes.push(home);
  const output: string[] = [];
  const errors: string[] = [];
  let providerCalls = 0;
  const ctx = {
    ...defaultCtx(), home, env: {} as NodeJS.ProcessEnv,
    stdout: (line: string) => output.push(line), stderr: (line: string) => errors.push(line),
    fetch: (async () => { providerCalls++; throw new Error(privateFixture); }) as typeof fetch,
    now: () => new Date("2026-09-30T16:00:00.000Z"),
  };
  return { home, ctx, output, errors, providerCalls: () => providerCalls };
}
function writeReceipt(home: string, raw: string): string {
  const path = onboardStatePath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, raw);
  return path;
}
async function expectSafeRefusal(f: ReturnType<typeof fixture>) {
  // A valid parsed command reaches the JSON result boundary, even when recovery metadata refuses.
  const code = await main(["onboard", "--yes", "--json"], f.ctx);
  expect(code).toBe(12);
  expect(f.output).toHaveLength(1);
  expect(JSON.parse(f.output[0]!)).toMatchObject({ schema: 1, exit: 12, complete: false });
  expect(f.output.join("\n") + f.errors.join("\n")).not.toContain(privateFixture);
  expect(f.providerCalls()).toBe(0);
  expect(existsSync(onboardLockPath(f.home))).toBe(false);
}
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("onboard JSON refusals at the dispatcher boundary", () => {
  test("a future receipt schema emits one incomplete result and preserves the original", async () => {
    const f = fixture();
    const raw = JSON.stringify({ schema: 999, steps: [], privateProviderBody: privateFixture });
    const path = writeReceipt(f.home, raw);
    await expectSafeRefusal(f);
    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(JSON.parse(f.output[0]!).privateProviderBody).toBeUndefined();
  });

  test("a corrupt receipt emits safe JSON without copying the invalid input or replacing it", async () => {
    const f = fixture();
    const raw = `{"schema":1,"privateProviderBody":"${privateFixture}","steps":`;
    const path = writeReceipt(f.home, raw);
    await expectSafeRefusal(f);
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  test("a symlink receipt emits a refusal and preserves both link and target", async () => {
    const f = fixture();
    const target = join(f.home, "another-install.json");
    const raw = JSON.stringify({ schema: 1, steps: [], privateProviderBody: privateFixture });
    writeFileSync(target, raw);
    const path = onboardStatePath(f.home);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path);
    await expectSafeRefusal(f);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(raw);
  });

  test("a relative bootstrap state root emits safe JSON and never falls back to default state", async () => {
    const f = fixture();
    f.ctx.env.CATALYST_INSTALL_STATE_DIR = "relative-bootstrap-state";
    await expectSafeRefusal(f);
    expect(existsSync(onboardStatePath(f.home))).toBe(false);
    expect(existsSync(join(f.home, "relative-bootstrap-state"))).toBe(false);
  });

  test("a malformed explicit machine-paths file emits a safe refusal and retains its input", async () => {
    const f = fixture();
    const path = join(f.home, "selected-paths.json");
    const raw = `{"version":1,"privateProviderBody":"${privateFixture}","paths":`;
    writeFileSync(path, raw);
    f.ctx.env.CATALYST_PATHS_FILE = path;
    await expectSafeRefusal(f);
    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(existsSync(onboardStatePath(f.home))).toBe(false);
  });
});
