// rename-hints.test.ts — CTC-3479 review fixes. Three things the rename must get right on a real
// machine, each pinned with a positive control beside the negative:
// 1. An upgrade hint names the package this machine has. Both packages ship the same two bins, so
//    `npm install -g` of the other one fails with EEXIST.
// 2. A cliPath recorded before the rename (bin/catalyst-skills.js) moves onto the `catalyst`
//    launcher beside it, so skill scripts stop getting the deprecated-name notice.
// 3. `ready` says so when `catalyst` on PATH is a different program (the catalyst-dev router).
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { main } from "../src/cli";
import { LEGACY_PACKAGE_NAME, PACKAGE_NAME, cliPath, configPathFor, installerOwnsSkills, modernCliPath, packageRoot, updatePackageName, upgradeCommand } from "../src/config";
import { catalystCommandCheck } from "../src/ready";
import { installSkills } from "../src/skills";
import { startMeFixture, type FixtureServer } from "./fixture";
import { makeCtx, seedJoined, tempHome } from "./helpers";

const scratch = () => mkdtempSync(join(tmpdir(), "catalyst-rename-"));

function writePkg(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name, version: "0.8.0" })}\n`);
}

describe("upgrade hints name the installed package", () => {
  test("a direct global install of @catalyst-cloud/cli updates @catalyst-cloud/cli", () => {
    const prefix = scratch();
    const cli = join(prefix, "lib", "node_modules", "@catalyst-cloud", "cli");
    writePkg(cli, PACKAGE_NAME);
    expect(updatePackageName(cli)).toBe(PACKAGE_NAME);
    expect(upgradeCommand(cli)).toBe("npm install -g @catalyst-cloud/cli@latest && catalyst login");
  });

  test("the forwarder's global install (the CLI nested under it) updates the forwarder", () => {
    const prefix = scratch();
    const forwarder = join(prefix, "lib", "node_modules", "@catalyst-cloud", "catalyst-skills");
    writePkg(forwarder, LEGACY_PACKAGE_NAME);
    const cli = join(forwarder, "node_modules", "@catalyst-cloud", "cli");
    writePkg(cli, PACKAGE_NAME);
    expect(updatePackageName(cli)).toBe(LEGACY_PACKAGE_NAME);
    expect(upgradeCommand(cli)).toBe("npm install -g @catalyst-cloud/catalyst-skills@latest && catalyst login");
  });

  test("the flat layout npx uses (the forwarder beside the CLI) updates the forwarder", () => {
    const npx = scratch();
    const scope = join(npx, "node_modules", "@catalyst-cloud");
    writePkg(join(scope, "catalyst-skills"), LEGACY_PACKAGE_NAME);
    writePkg(join(scope, "cli"), PACKAGE_NAME);
    expect(updatePackageName(join(scope, "cli"))).toBe(LEGACY_PACKAGE_NAME);
  });

  test("a directory that merely sits where the forwarder would, but is another package, does not count", () => {
    const prefix = scratch();
    const other = join(prefix, "lib", "node_modules", "@catalyst-cloud", "catalyst-skills");
    writePkg(other, "@someone-else/catalyst-skills");
    const cli = join(other, "node_modules", "@catalyst-cloud", "cli");
    writePkg(cli, PACKAGE_NAME);
    expect(updatePackageName(cli)).toBe(PACKAGE_NAME);
  });

  test("this checkout resolves to @catalyst-cloud/cli, which is what every in-process hint test sees", () => {
    expect(updatePackageName(packageRoot())).toBe(PACKAGE_NAME);
    expect(updatePackageName()).toBe(PACKAGE_NAME);
  });
});

describe("a cliPath recorded before the rename moves onto the catalyst launcher", () => {
  test("modernCliPath swaps bin/catalyst-skills.js for the catalyst.js beside it", () => {
    const bin = join(scratch(), "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "catalyst-skills.js"), "");
    expect(modernCliPath(join(bin, "catalyst-skills.js")), "no catalyst.js beside it yet (a 0.7.0 install)").toBeNull();
    writeFileSync(join(bin, "catalyst.js"), "");
    expect(modernCliPath(join(bin, "catalyst-skills.js"))).toBe(join(bin, "catalyst.js"));
    expect(modernCliPath(join(bin, "catalyst.js")), "already the catalyst launcher").toBeNull();
    expect(modernCliPath(undefined)).toBeNull();
  });

  let server: FixtureServer;
  beforeAll(async () => {
    server = await startMeFixture();
  });
  afterAll(async () => {
    await server.close();
  });

  const recordedCliPath = (home: string) => (JSON.parse(readFileSync(configPathFor(home), "utf8")) as { cliPath?: string }).cliPath;

  test("the next run of any verb rewrites customer.json, and leaves the rest of the config alone", async () => {
    const home = tempHome();
    const bin = join(scratch(), "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "catalyst-skills.js"), "");
    writeFileSync(join(bin, "catalyst.js"), "");
    const before = await seedJoined(home, server, { contract: false, config: { cliPath: join(bin, "catalyst-skills.js") } });

    expect(await main(["status"], makeCtx(home))).toBe(0);
    const after = JSON.parse(readFileSync(configPathFor(home), "utf8")) as Record<string, unknown>;
    expect(after.cliPath).toBe(join(bin, "catalyst.js"));
    expect({ ...after, cliPath: before.cliPath }).toEqual(JSON.parse(JSON.stringify(before)));
  });

  test("a legacy cliPath with no catalyst.js beside it is left as it is (the positive control)", async () => {
    const home = tempHome();
    const bin = join(scratch(), "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "catalyst-skills.js"), "");
    await seedJoined(home, server, { contract: false, config: { cliPath: join(bin, "catalyst-skills.js") } });
    expect(await main(["status"], makeCtx(home))).toBe(0);
    expect(recordedCliPath(home)).toBe(join(bin, "catalyst-skills.js"));
  });
  test("a cliPath whose file is gone (the old package was uninstalled) heals to the running launcher", async () => {
    const home = tempHome();
    const gone = join(scratch(), "node_modules", "@catalyst-cloud", "catalyst-skills", "bin", "catalyst.js");
    await seedJoined(home, server, { contract: false, config: { cliPath: gone } });
    expect(await main(["status"], makeCtx(home))).toBe(0);
    expect(recordedCliPath(home)).toBe(cliPath());
  });

  test("a cliPath whose file exists is never replaced (the positive control)", async () => {
    const home = tempHome();
    const bin = join(scratch(), "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "catalyst.js"), "");
    await seedJoined(home, server, { contract: false, config: { cliPath: join(bin, "catalyst.js") } });
    expect(await main(["status"], makeCtx(home))).toBe(0);
    expect(recordedCliPath(home)).toBe(join(bin, "catalyst.js"));
  });
});

describe("the skills refresh leaves the installer's skills alone", () => {
  test("a symlinked skill entry is never written through, and is not reported", () => {
    const target = scratch();
    const elsewhere = join(scratch(), "catalyst-github");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "SKILL.md"), "installer-owned copy\n");
    symlinkSync(elsewhere, join(target, "catalyst-github"));
    const result = installSkills(target, { onlyExisting: false });
    expect(result.installed).not.toContain("catalyst-github");
    expect(result.skipped.map((s) => s.name)).not.toContain("catalyst-github");
    expect(readFileSync(join(elsewhere, "SKILL.md"), "utf8")).toBe("installer-owned copy\n");
    // positive control: a real directory beside it is installed
    expect(result.installed.length).toBeGreaterThan(0);
  });

  test("the installer owns skills when it exports CATALYST_SKILLS_DIR or wrote the machine paths file", () => {
    const home = scratch();
    expect(installerOwnsSkills(home, {})).toBe(false);
    expect(installerOwnsSkills(home, { CATALYST_SKILLS_DIR: "/x/skills" })).toBe(true);
    mkdirSync(join(home, ".config", "catalyst"), { recursive: true });
    writeFileSync(join(home, ".config", "catalyst", "paths.json"), "{}");
    expect(installerOwnsSkills(home, {})).toBe(true);
  });
});

describe("ready names a different program that answers to catalyst", () => {
  function pathWith(entries: string[]): NodeJS.ProcessEnv {
    return { PATH: entries.join(":") };
  }

  test("nothing called catalyst on PATH emits nothing: the old name is still the installed one", () => {
    expect(catalystCommandCheck(pathWith([scratch()]), "darwin")).toBeNull();
    expect(catalystCommandCheck({}, "linux")).toBeNull();
  });

  test("the catalyst-dev router first on PATH is a note that keeps catalyst as the way in", () => {
    const routerBin = scratch();
    writeFileSync(join(routerBin, "catalyst"), "#!/usr/bin/env bash\necho router\n");
    chmodSync(join(routerBin, "catalyst"), 0o755);
    const check = catalystCommandCheck(pathWith([routerBin]), "darwin");
    expect(check).toMatchObject({ id: "command", ok: false, note: true });
    expect(check!.line).toContain(join(routerBin, "catalyst"));
    expect(check!.line).toContain("catalyst-skills");
    expect(check!.line).not.toContain("—");
  });

  test("the npm bin link to this CLI's launcher is ok, and wins only when it comes first", () => {
    // A global install layout: prefix/bin/catalyst → ../lib/node_modules/@catalyst-cloud/cli/bin/catalyst.js
    const prefix = scratch();
    const pkg = join(prefix, "lib", "node_modules", "@catalyst-cloud", "cli");
    writePkg(pkg, PACKAGE_NAME);
    mkdirSync(join(pkg, "bin"));
    writeFileSync(join(pkg, "bin", "catalyst.js"), "#!/usr/bin/env node\n");
    chmodSync(join(pkg, "bin", "catalyst.js"), 0o755);
    mkdirSync(join(prefix, "bin"));
    symlinkSync(join(pkg, "bin", "catalyst.js"), join(prefix, "bin", "catalyst"));

    expect(catalystCommandCheck(pathWith([join(prefix, "bin")]), "linux")).toMatchObject({ id: "command", ok: true });

    const routerBin = scratch();
    writeFileSync(join(routerBin, "catalyst"), "#!/usr/bin/env bash\n");
    chmodSync(join(routerBin, "catalyst"), 0o755);
    expect(catalystCommandCheck(pathWith([routerBin, join(prefix, "bin")]), "linux")).toMatchObject({ ok: false, note: true });
    expect(catalystCommandCheck(pathWith([join(prefix, "bin"), routerBin]), "linux")).toMatchObject({ ok: true });
  });

  test("the forwarder's launcher counts as this CLI too", () => {
    const pkg = join(scratch(), "catalyst-skills");
    writePkg(pkg, LEGACY_PACKAGE_NAME);
    mkdirSync(join(pkg, "bin"));
    writeFileSync(join(pkg, "bin", "catalyst.js"), "#!/usr/bin/env node\n");
    chmodSync(join(pkg, "bin", "catalyst.js"), 0o755);
    const bin = scratch();
    symlinkSync(join(pkg, "bin", "catalyst.js"), join(bin, "catalyst"));
    expect(catalystCommandCheck(pathWith([bin]), "darwin")).toMatchObject({ ok: true });
  });

  test("a non-executable file called catalyst is skipped, as a shell would skip it", () => {
    const dir = scratch();
    writeFileSync(join(dir, "catalyst"), "not a program\n");
    chmodSync(join(dir, "catalyst"), 0o644);
    expect(catalystCommandCheck(pathWith([dir]), "linux")).toBeNull();
  });

  test("Windows is skipped: npm installs .cmd shims there", () => {
    const routerBin = scratch();
    writeFileSync(join(routerBin, "catalyst"), "");
    chmodSync(join(routerBin, "catalyst"), 0o755);
    expect(catalystCommandCheck(pathWith([routerBin]), "win32")).toBeNull();
  });
});
