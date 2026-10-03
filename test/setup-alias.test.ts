// CTC-4680: `catalyst setup` is the name a person types. Without --engine it runs the same flow as
// `catalyst onboard`; with --engine it stays install.sh's bootstrap. `setup --help` exits 0 so
// install.sh can feature-detect it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { main } from "../src/cli.js";
import { defaultCtx } from "../src/config.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "setup-alias-"));
  homes.push(home);
  const out: string[] = [];
  const err: string[] = [];
  const ctx = {
    ...defaultCtx(),
    home,
    env: {} as NodeJS.ProcessEnv,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
  };
  return { ctx, out, err };
}

test("setup --help exits 0 and names both forms", async () => {
  const f = fixture();
  expect(await main(["setup", "--help"], f.ctx)).toBe(0);
  const help = f.out.join("\n");
  expect(help).toContain("catalyst setup");
  expect(help).toContain("--engine");
});

test("setup with no --engine runs the onboard flow", async () => {
  const setup = fixture();
  const onboard = fixture();
  const setupCode = await main(["setup", "--json", "--dry-run"], setup.ctx);
  const onboardCode = await main(["onboard", "--json", "--dry-run"], onboard.ctx);
  expect(setupCode).toBe(onboardCode);
  expect(setupCode).toBe(0);
  const doc = JSON.parse(setup.out[0] ?? "{}");
  expect(doc).toMatchObject({ schema: 1, mode: "plan" });
  expect(setup.err.join("\n")).not.toContain("--engine and --engine-sha256 are required");
});

test("setup with --engine still takes the install.sh bootstrap path", async () => {
  const f = fixture();
  const code = await main(
    ["setup", "--engine", join(f.ctx.home, "missing.sh"), "--engine-sha256", "0".repeat(64)],
    f.ctx,
  );
  expect(code).toBe(10);
});

test("the setup capability advertises the install.sh handoff", async () => {
  const f = fixture();
  await main(["capabilities", "--json"], f.ctx);
  const doc = JSON.parse(f.out.join("\n")) as {
    capabilities: { verb: string; bootstrapHandoff?: boolean }[];
  };
  expect(doc.capabilities.find((c) => c.verb === "setup")?.bootstrapHandoff).toBe(true);
});
