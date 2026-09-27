// runtime-store.test.ts — CTC-2158, Tier 2. The pinned runtime this CLI downloads, verifies and
// unpacks under its own cache. Fully injected: no network, no real tar, no disk outside a temp home.
import { afterEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installPinnedRuntime,
  pinPath,
  pinnedNodePath,
  readPin,
  runtimesDir,
  shasumFor,
  tarballFor,
  uninstallPinnedRuntime,
} from "../src/runtime-store";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "catalyst-runtime-store-"));
}

describe("tarballFor", () => {
  test("maps every supported platform/arch onto a real nodejs.org .tar.gz name", () => {
    expect(tarballFor("24.21.0", "darwin", "arm64")).toEqual({
      file: "node-v24.21.0-darwin-arm64.tar.gz",
      url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz",
      shasums: "https://nodejs.org/dist/v24.21.0/SHASUMS256.txt",
    });
    expect(tarballFor("24.21.0", "linux", "x64").file).toBe("node-v24.21.0-linux-x64.tar.gz");
    expect(tarballFor("24.21.0", "linux", "arm64").file).toBe("node-v24.21.0-linux-arm64.tar.gz");
    expect(tarballFor("24.21.0", "darwin", "x64").file).toBe("node-v24.21.0-darwin-x64.tar.gz");
  });
  test("never emits a .tar.xz url", () => {
    expect(tarballFor("24.21.0", "darwin", "arm64").url).not.toMatch(/\.tar\.xz$/);
  });
  test("win32 is refused by name, with the supported range in the message", () => {
    expect(() => tarballFor("24.21.0", "win32", "x64")).toThrow(/Windows/);
  });
  test("an unsupported arch on a supported platform is refused by name", () => {
    expect(() => tarballFor("24.21.0", "linux", "ia32")).toThrow(/linux\/ia32/);
  });
});

describe("shasumFor", () => {
  test("picks the line for exactly our file out of a real SHASUMS256.txt body", () => {
    const body = ["aaaa  node-v24.21.0-darwin-arm64.tar.gz", "bbbb  node-v24.21.0-linux-x64.tar.gz", "cccc  node-v24.21.0-linux-x64.tar.xz"].join("\n");
    expect(shasumFor(body, "node-v24.21.0-linux-x64.tar.gz")).toBe("bbbb");
  });
  test("a missing line is a named error, never a skipped verification", () => {
    expect(() => shasumFor("aaaa  something-else.tar.gz", "node-v24.21.0-linux-x64.tar.gz")).toThrow(/SHASUMS256/);
  });
});

describe("installPinnedRuntime", () => {
  test("verifies the checksum before unpacking, and refuses a mismatch without unpacking", async () => {
    const home = tempHome();
    const extract = vi.fn(async () => {});
    await expect(
      installPinnedRuntime({
        home,
        version: "24.21.0",
        platform: "linux",
        arch: "x64",
        fetchText: async () => "deadbeef  node-v24.21.0-linux-x64.tar.gz",
        fetchBytes: async () => new Uint8Array([1, 2, 3]),
        extract,
      }),
    ).rejects.toThrow(/checksum/i);
    expect(extract).not.toHaveBeenCalled();
    expect(readPin(home)).toBeNull();
  });

  test("a verified tarball is unpacked and the pin is recorded, ONLY under the CLI's own cache", async () => {
    const home = tempHome();
    const bytes = new Uint8Array([1, 2, 3]);
    const sum = createHash("sha256").update(bytes).digest("hex");
    const res = await installPinnedRuntime({
      home,
      version: "24.21.0",
      platform: "linux",
      arch: "x64",
      fetchText: async () => `${sum}  node-v24.21.0-linux-x64.tar.gz`,
      fetchBytes: async () => bytes,
      extract: async (_tar, dest) => {
        mkdirSync(join(dest, "bin"), { recursive: true });
        writeFileSync(join(dest, "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
      },
    });
    expect(res.alreadyPresent).toBe(false);
    expect(res.nodePath).toBe(pinnedNodePath(home, "24.21.0", "linux", "x64"));
    expect(existsSync(res.nodePath)).toBe(true);
    expect(res.nodePath.startsWith(runtimesDir(home))).toBe(true);
    expect(readPin(home)).toEqual({ version: "24.21.0", nodePath: res.nodePath });
  });

  test("an install that is already present is reported, not re-downloaded", async () => {
    const home = tempHome();
    const bytes = new Uint8Array([1, 2, 3]);
    const sum = createHash("sha256").update(bytes).digest("hex");
    const opts = {
      home,
      version: "24.21.0",
      platform: "linux",
      arch: "x64",
      fetchText: async () => `${sum}  node-v24.21.0-linux-x64.tar.gz`,
      fetchBytes: async () => bytes,
      extract: async (_tar: string, dest: string) => {
        mkdirSync(join(dest, "bin"), { recursive: true });
        writeFileSync(join(dest, "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
      },
    };
    await installPinnedRuntime(opts);
    const fetchBytes = vi.fn(async () => bytes);
    const second = await installPinnedRuntime({ ...opts, fetchBytes });
    expect(second.alreadyPresent).toBe(true);
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  test("uninstall removes the pin and the tree, and a fresh read then reports no pin", async () => {
    const home = tempHome();
    const bytes = new Uint8Array([1, 2, 3]);
    const sum = createHash("sha256").update(bytes).digest("hex");
    await installPinnedRuntime({
      home,
      version: "24.21.0",
      platform: "linux",
      arch: "x64",
      fetchText: async () => `${sum}  node-v24.21.0-linux-x64.tar.gz`,
      fetchBytes: async () => bytes,
      extract: async (_tar, dest) => {
        mkdirSync(join(dest, "bin"), { recursive: true });
        writeFileSync(join(dest, "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
      },
    });
    expect(uninstallPinnedRuntime(home)).toBe(true);
    expect(readPin(home)).toBeNull();
    expect(existsSync(runtimesDir(home))).toBe(false);
    expect(uninstallPinnedRuntime(home)).toBe(false);
  });
});

describe("the pin file and the paths it names", () => {
  test("a pin file that is not JSON reads as no pin, so a broken cache never claims an install", () => {
    const home = tempHome();
    mkdirSync(runtimesDir(home), { recursive: true });
    writeFileSync(pinPath(home), "{ not json");
    expect(readPin(home)).toBeNull();
    expect(uninstallPinnedRuntime(home)).toBe(false);
  });

  test("the node binary is node.exe on win32 and node everywhere else", () => {
    const home = tempHome();
    expect(pinnedNodePath(home, "24.21.0", "win32", "x64")).toBe(join(runtimesDir(home), "node-v24.21.0-win32-x64", "bin", "node.exe"));
    expect(pinnedNodePath(home, "24.21.0", "darwin", "arm64")).toBe(join(runtimesDir(home), "node-v24.21.0-darwin-arm64", "bin", "node"));
  });
});

describe("installPinnedRuntime's own fetch and tar", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A real node-shaped .tar.gz: one top-level directory holding bin/node, the layout nodejs.org ships. */
  function realTarball(): Uint8Array {
    const src = mkdtempSync(join(tmpdir(), "catalyst-runtime-src-"));
    mkdirSync(join(src, "node-v24.21.0-linux-x64", "bin"), { recursive: true });
    writeFileSync(join(src, "node-v24.21.0-linux-x64", "bin", "node"), "#!/bin/sh\necho placeholder-node\n");
    const out = join(src, "node.tar.gz");
    const res = spawnSync("tar", ["-czf", out, "-C", src, "node-v24.21.0-linux-x64"]);
    expect(res.status).toBe(0);
    return new Uint8Array(readFileSync(out));
  }

  test("with no seams it fetches SHASUMS and the tarball itself, unpacks with tar, and pins the result", async () => {
    const home = tempHome();
    const bytes = realTarball();
    const sum = createHash("sha256").update(bytes).digest("hex");
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      return url.endsWith("SHASUMS256.txt")
        ? new Response(`${sum}  node-v24.21.0-linux-x64.tar.gz\n`)
        : new Response(bytes);
    });
    const res = await installPinnedRuntime({ home, version: "24.21.0", platform: "linux", arch: "x64" });
    expect(fetched).toEqual([
      "https://nodejs.org/dist/v24.21.0/SHASUMS256.txt",
      "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.gz",
    ]);
    expect(res).toEqual({ version: "24.21.0", nodePath: pinnedNodePath(home, "24.21.0", "linux", "x64"), alreadyPresent: false });
    expect(readFileSync(res.nodePath, "utf8")).toContain("placeholder-node");
    expect(readPin(home)).toEqual({ version: "24.21.0", nodePath: res.nodePath });
    expect(readdirSync(join(runtimesDir(home), ".tmp"))).toEqual([]);
  });

  test("a SHASUMS fetch that is not 2xx is a named failure, and nothing is downloaded after it", async () => {
    const home = tempHome();
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => (fetched.push(url), new Response("gone", { status: 404 })));
    await expect(installPinnedRuntime({ home, version: "24.21.0", platform: "linux", arch: "x64" })).rejects.toThrow(
      "GET https://nodejs.org/dist/v24.21.0/SHASUMS256.txt -> 404",
    );
    expect(fetched).toHaveLength(1);
    expect(readPin(home)).toBeNull();
  });

  test("a tarball fetch that is not 2xx is a named failure, and nothing is unpacked", async () => {
    const home = tempHome();
    const extract = vi.fn(async () => {});
    vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
    await expect(
      installPinnedRuntime({ home, version: "24.21.0", platform: "linux", arch: "x64", fetchText: async () => "aaaa  node-v24.21.0-linux-x64.tar.gz", extract }),
    ).rejects.toThrow("GET https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.gz -> 503");
    expect(extract).not.toHaveBeenCalled();
  });

  test("bytes that match their checksum but are not a tarball fail in tar by name, leave no temp file, and pin nothing", async () => {
    const home = tempHome();
    const bytes = new TextEncoder().encode("placeholder: not a gzip stream");
    const sum = createHash("sha256").update(bytes).digest("hex");
    await expect(
      installPinnedRuntime({
        home,
        version: "24.21.0",
        platform: "linux",
        arch: "x64",
        fetchText: async () => `${sum}  node-v24.21.0-linux-x64.tar.gz`,
        fetchBytes: async () => bytes,
      }),
    ).rejects.toThrow(/^tar -xzf .*node-v24\.21\.0-linux-x64\.tar\.gz failed: /);
    expect(readdirSync(join(runtimesDir(home), ".tmp"))).toEqual([]);
    expect(readPin(home)).toBeNull();
  });

  test("a tarball whose layout has no bin/node is refused rather than pinned", async () => {
    const home = tempHome();
    const bytes = new Uint8Array([4, 5, 6]);
    const sum = createHash("sha256").update(bytes).digest("hex");
    await expect(
      installPinnedRuntime({
        home,
        version: "24.21.0",
        platform: "linux",
        arch: "x64",
        fetchText: async () => `${sum}  node-v24.21.0-linux-x64.tar.gz`,
        fetchBytes: async () => bytes,
        extract: async (_tar, dest) => {
          mkdirSync(join(dest, "lib"), { recursive: true });
        },
      }),
    ).rejects.toThrow(/extraction did not produce .*bin\/node — the tarball's layout may have changed/);
    expect(readPin(home)).toBeNull();
  });
});
