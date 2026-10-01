import { afterEach, describe, expect, test, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import {
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configPathFor,
  saveConfig,
  type Ctx,
  type CustomerConfig,
  type MeIdentity,
} from "../src/config.js";
import { readDaemonAuthority } from "../src/daemon-authority.js";

const snapshotHook = vi.hoisted(() => {
  const state: { afterRead: (() => void) | undefined } = {
    afterRead: undefined,
  };
  return state;
});
vi.mock("../src/onboard-file-snapshot.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/onboard-file-snapshot.js")>();
  return {
    ...actual,
    onboardFileSnapshot(path: string) {
      const bytes = actual.onboardFileSnapshot(path);
      snapshotHook.afterRead?.();
      return bytes;
    },
  };
});
const homes: string[] = [];
afterEach(() => {
  snapshotHook.afterRead = undefined;
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(
    join(realpathSync(tmpdir()), "daemon-authority-boundary-"),
  );
  homes.push(home);
  const user = {
    id: "person-one",
    role: "owner" as const,
    label: "Fixture Person",
    email: null,
    linearUserId: null,
  };
  const me: MeIdentity = {
    account: "account-one",
    slug: "fixture",
    name: "Fixture",
    permissions: ["mirror:read", "mirror:feed"],
    principal: "service",
    user,
  };
  const config: CustomerConfig = {
    ...me,
    user: { ...user },
    baseUrl: "https://cloud.example.test",
    joinedAt: "2026-10-01T00:00:00Z",
    lastSkillBundleVersion: "fixture",
    auth: {
      kind: "oauth",
      sessionId: "fixture-session",
      accessToken: "fixture-access",
      refreshToken: "fixture-refresh",
      expiresAt: "2099-01-01T00:00:00Z",
    },
  };
  saveConfig(home, config);
  const clock = { ms: Date.now() };
  let calls = 0;
  const ctx: Ctx = {
    home,
    env: {},
    now: () => new Date(clock.ms),
    stdout: vi.fn(),
    stderr: vi.fn(),
    fetch: async () => {
      calls++;
      return Response.json(me);
    },
  };
  return {
    home,
    me,
    config,
    clock,
    ctx,
    calls: () => calls,
    path: configPathFor(home),
  };
}
const read = (ctx: Ctx) =>
  readDaemonAuthority(ctx, new AbortController().signal);
const limit = 1024 * 1024;

describe("daemon authority file, body and publication boundaries", () => {
  test("a symlink config is refused without network and preserves link and target inode/bytes", async () => {
    const f = fixture(),
      saved = `${f.path}.saved`;
    const bytes = readFileSync(f.path),
      inode = lstatSync(f.path).ino;
    renameSync(f.path, saved);
    symlinkSync(saved, f.path);
    const linkInode = lstatSync(f.path).ino;
    await expect(read(f.ctx)).rejects.toThrow("daemon_config_unverified");
    expect(f.calls()).toBe(0);
    expect(readlinkSync(f.path)).toBe(saved);
    expect(lstatSync(f.path).ino).toBe(linkInode);
    expect(lstatSync(saved).ino).toBe(inode);
    expect(readFileSync(saved)).toEqual(bytes);
  });

  test("a hardlinked regular config is read only and neither link is replaced or rewritten", async () => {
    const f = fixture(),
      linked = `${f.path}.linked`;
    linkSync(f.path, linked);
    const bytes = readFileSync(f.path),
      inode = lstatSync(f.path).ino;
    expect(lstatSync(f.path).nlink).toBe(2);
    const proof = await read(f.ctx);
    expect(await proof.getToken()).toBe("fixture-access");
    expect(f.calls()).toBe(1);
    for (const path of [f.path, linked]) {
      expect(lstatSync(path).ino).toBe(inode);
      expect(lstatSync(path).nlink).toBe(2);
      expect(readFileSync(path)).toEqual(bytes);
    }
  });

  test("an oversized actual config refuses before network without rewriting it", async () => {
    const f = fixture();
    const bytes = Buffer.alloc(limit + 1, 120);
    writeFileSync(f.path, bytes, { mode: 0o600 });
    const inode = lstatSync(f.path).ino;
    await expect(read(f.ctx)).rejects.toThrow("daemon_config_unverified");
    expect(f.calls()).toBe(0);
    expect(lstatSync(f.path).ino).toBe(inode);
    expect(readFileSync(f.path)).toEqual(bytes);
  });

  test("a FIFO config is refused by an actual source child with natural exit, no writer and no network", async () => {
    const f = fixture(),
      saved = `${f.path}.saved`;
    const bytes = readFileSync(f.path),
      inode = lstatSync(f.path).ino;
    renameSync(f.path, saved);
    execFileSync("mkfifo", [f.path], { stdio: "pipe" });
    const fifoInode = lstatSync(f.path).ino;
    const source = new URL("../src/daemon-authority.ts", import.meta.url).href;
    const program = `
      const { readDaemonAuthority } = await import(process.argv[1]);
      let calls = 0;
      const ctx = { home: process.argv[2], env: {}, now: () => new Date(), stdout() {}, stderr() {}, fetch: async () => { calls++; throw new Error('unexpected fixture network'); } };
      try { await readDaemonAuthority(ctx, new AbortController().signal); process.exitCode = 3; }
      catch (error) { console.log(JSON.stringify({ reason: error instanceof Error ? error.message : 'non-error', calls })); }
    `;
    // The native gate supplies the real pinned Bun runtime; it resolves production .js imports to TS source.
    const child = spawn("bun", ["--eval", program, source, f.home], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", HOME: f.home },
    });
    let stdout = "",
      stderr = "",
      killed = false;
    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    const closed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const watchdog = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, 5000);
    try {
      const result = await closed;
      expect(killed, stderr).toBe(false);
      expect(result).toEqual({ code: 0, signal: null });
      const record: unknown = JSON.parse(stdout.trim());
      expect(record).toEqual({ reason: "daemon_config_unverified", calls: 0 });
      expect(lstatSync(f.path).isFIFO()).toBe(true);
      expect(lstatSync(f.path).ino).toBe(fifoInode);
      expect(lstatSync(saved).ino).toBe(inode);
      expect(readFileSync(saved)).toEqual(bytes);
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await closed;
      }
    }
  }, 10_000);

  test.each([false, true])(
    "the final actual file read cannot publish a token after the expiry boundary (advance=%s)",
    async (advance) => {
      const f = fixture(),
        proof = await read(f.ctx);
      let actualReads = 0;
      snapshotHook.afterRead = () => {
        if (++actualReads === 3 && advance) f.clock.ms = proof.expiresAt;
      };
      if (advance)
        await expect(proof.getToken()).rejects.toThrow(
          "daemon_authority_expired",
        );
      else expect(await proof.getToken()).toBe("fixture-access");
      expect(actualReads).toBe(3);
      expect(f.calls()).toBe(1);
    },
  );

  test("an exact 1 MiB valid /me response is admitted without changing saved config", async () => {
    const f = fixture(),
      before = readFileSync(f.path);
    const empty = JSON.stringify({ ...f.me, fixturePadding: "" });
    const text = JSON.stringify({
      ...f.me,
      fixturePadding: "x".repeat(limit - Buffer.byteLength(empty)),
    });
    expect(Buffer.byteLength(text)).toBe(limit);
    f.ctx.fetch = async () =>
      new Response(text, { headers: { "content-type": "application/json" } });
    const proof = await read(f.ctx);
    expect(await proof.getToken()).toBe("fixture-access");
    expect(readFileSync(f.path)).toEqual(before);
  });

  test("a streamed oversized /me refuses authority and actually cancels its source", async () => {
    const f = fixture(),
      before = readFileSync(f.path);
    let pulls = 0,
      cancellations = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(
            new Uint8Array(pulls++ === 0 ? limit : 1).fill(120),
          );
        },
        cancel() {
          cancellations++;
        },
      },
      { highWaterMark: 0 },
    );
    f.ctx.fetch = async () => new Response(body);
    await expect(read(f.ctx)).rejects.toThrow("daemon_authority_unavailable");
    expect(cancellations).toBe(1);
    expect(readFileSync(f.path)).toEqual(before);
  });

  test.each(["http", "network", "malformed"])(
    "untrusted %s secret-marker errors have a static public primary reason",
    async (kind) => {
      const f = fixture(),
        before = readFileSync(f.path),
        marker = "upstream-private-token-marker";
      f.ctx.fetch = async () => {
        if (kind === "network") throw new Error(marker);
        return kind === "http"
          ? Response.json({ reason: marker }, { status: 503 })
          : new Response(marker);
      };
      const error: unknown = await read(f.ctx).catch((error: unknown) => error);
      if (!(error instanceof Error))
        throw new Error("missing safe authority failure");
      expect(error.message).toBe("daemon_authority_unavailable");
      expect(error.message).not.toContain(marker);
      expect(readFileSync(f.path)).toEqual(before);
      expect(f.ctx.stdout).not.toHaveBeenCalled();
      expect(f.ctx.stderr).not.toHaveBeenCalled();
    },
  );

  test("a genuine body-limit cancellation failure remains in cleanup evidence under a static public error", async () => {
    const f = fixture(),
      before = readFileSync(f.path);
    const failure = new Error("private-cleanup-token-marker");
    failure.name = "AbortError";
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(new Uint8Array(limit + 1));
        },
        cancel() {
          return Promise.reject(failure);
        },
      },
      { highWaterMark: 0 },
    );
    f.ctx.fetch = async () => new Response(body);
    const error: unknown = await read(f.ctx).catch((error: unknown) => error);
    if (!(error instanceof AggregateError))
      throw new Error("missing real cleanup evidence");
    expect(error.message).toBe("daemon_authority_cleanup_failed");
    expect(error.message).not.toContain(failure.message);
    const cleanup: unknown = error.errors.find(
      (value: unknown) => value instanceof AggregateError,
    );
    if (!(cleanup instanceof AggregateError))
      throw new Error("missing underlying owned cleanup failure");
    expect(cleanup.errors).toContain(failure);
    expect(readFileSync(f.path)).toEqual(before);
  });
});
