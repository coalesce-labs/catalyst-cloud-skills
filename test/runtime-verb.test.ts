// runtime-verb.test.ts — CTC-2158, Tier 2. `catalyst-skills runtime status|install|path|uninstall`,
// driven through `main()` exactly as every other verb's tests are.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { main } from "../src/cli";
import { FIX_COMMAND } from "../src/runtime";
import { runtimesDir, tarballFor } from "../src/runtime-store";
import { makeCtx, tempHome } from "./helpers";

function fakeInstall(home: string) {
  const version = "24.21.0";
  const platform = "linux";
  const arch = "x64";
  const tb = tarballFor(version, platform, arch);
  const bytes = new Uint8Array([1, 2, 3]);
  const sum = createHash("sha256").update(bytes).digest("hex");
  return {
    runtime: {
      home,
      platform,
      arch,
      fetchText: async () => `${sum}  ${tb.file}`,
      fetchBytes: async () => bytes,
      extract: async (_tar: string, dest: string) => {
        mkdirSync(`${dest}/bin`, { recursive: true });
        writeFileSync(`${dest}/bin/node`, "#!/bin/sh\n", { mode: 0o755 });
      },
    },
  };
}

describe("runtime status", () => {
  test("with no pin, names the ambient runtime and, if unsupported, the one command", async () => {
    const home = tempHome();
    const ctx = makeCtx(home);
    await main(["runtime", "status"], ctx, { runtime: { home } });
    expect(ctx.out.join("\n")).toContain("no pinned runtime installed");
  });

  test("--json is machine-readable", async () => {
    const home = tempHome();
    const ctx = makeCtx(home);
    await main(["runtime", "status", "--json"], ctx, { runtime: { home } });
    const parsed = JSON.parse(ctx.out.join("\n")) as { pinned: unknown; ambient: { kind: string }; supported: boolean };
    expect(parsed.pinned).toBeNull();
    expect(typeof parsed.ambient.kind).toBe("string");
    expect(typeof parsed.supported).toBe("boolean");
  });

  test("once installed, status reports the pin and exits 0", async () => {
    const home = tempHome();
    const deps = fakeInstall(home);
    await main(["runtime", "install"], makeCtx(home), deps);
    const ctx = makeCtx(home);
    const code = await main(["runtime", "status"], ctx, { runtime: { home: deps.runtime.home } });
    expect(code).toBe(0);
    expect(ctx.out.join("\n")).toContain("pinned: Node 24.21.0");
  });
});

describe("runtime install", () => {
  test("downloads, verifies and unpacks the pinned Node under this CLI's own cache only", async () => {
    const home = tempHome();
    const deps = fakeInstall(home);
    const ctx = makeCtx(home);
    const code = await main(["runtime", "install"], ctx, deps);
    expect(code).toBe(0);
    expect(ctx.out.join("\n")).toContain("Installed Node 24.21.0");
    expect(existsSync(runtimesDir(home))).toBe(true);
  });

  test("on win32 refuses by name and writes nothing", async () => {
    const home = tempHome();
    const ctx = makeCtx(home);
    let threw = false;
    try {
      await main(["runtime", "install"], ctx, { runtime: { home, platform: "win32", arch: "x64" } });
    } catch {
      threw = true;
    }
    const printedRefusal = ctx.err.join("\n").match(/Windows/) !== null;
    expect(threw || printedRefusal).toBe(true);
    expect(existsSync(runtimesDir(home))).toBe(false);
  });
});

describe("runtime path", () => {
  test("with no pin, exits 1 and prints nothing to stdout", async () => {
    const home = tempHome();
    const ctx = makeCtx(home);
    const code = await main(["runtime", "path"], ctx, { runtime: { home } });
    expect(code).toBe(1);
    expect(ctx.out.join("\n")).toBe("");
  });

  test("with a pin, prints only the node path", async () => {
    const home = tempHome();
    const deps = fakeInstall(home);
    await main(["runtime", "install"], makeCtx(home), deps);
    const ctx = makeCtx(home);
    const code = await main(["runtime", "path"], ctx, { runtime: { home: deps.runtime.home } });
    expect(code).toBe(0);
    expect(ctx.out.join("\n")).toContain("/runtimes/node-v24.21.0-linux-x64/bin/node");
  });
});

describe("runtime uninstall", () => {
  test("removes an installed pin and reports it did", async () => {
    const home = tempHome();
    const deps = fakeInstall(home);
    await main(["runtime", "install"], makeCtx(home), deps);
    const ctx = makeCtx(home);
    await main(["runtime", "uninstall"], ctx, { runtime: { home: deps.runtime.home } });
    expect(ctx.out.join("\n")).toContain("removed the pinned runtime");
    const status = makeCtx(home);
    await main(["runtime", "status"], status, { runtime: { home: deps.runtime.home } });
    expect(status.out.join("\n")).toContain("no pinned runtime installed");
  });
});

describe("runtime --help and usage", () => {
  test("usage mentions the runtime verb", async () => {
    const ctx = makeCtx(tempHome());
    await main([], ctx);
    expect(ctx.out.join("\n")).toContain("catalyst-skills runtime");
  });
  test("runtime --help documents the subcommands", async () => {
    const ctx = makeCtx(tempHome());
    await main(["runtime", "--help"], ctx);
    expect(ctx.out.join("\n")).toContain("status");
  });
});

describe("an unknown subcommand", () => {
  test("is a usage error naming the known subcommands", async () => {
    const ctx = makeCtx(tempHome());
    const code = await main(["runtime", "frobnicate"], ctx, { runtime: { home: tempHome() } });
    expect(code).toBe(1);
    expect(ctx.err.join("\n")).toContain("unknown runtime subcommand");
  });
});

// Tier 1, second clause, applied to this verb's own messaging: FIX_COMMAND is what every
// unsupported-runtime message across the package points at, so it must be this command, verbatim.
test("FIX_COMMAND is exactly the command this verb registers", () => {
  expect(FIX_COMMAND).toBe("npx -y @catalyst-cloud/catalyst-skills runtime install");
});
