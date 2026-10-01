import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveConfig,
  configPathFor,
  type Ctx,
  type CustomerConfig,
  type MeIdentity,
} from "../src/config";
import { readDaemonAuthority } from "../src/daemon-authority";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "daemon-authority-"));
  homes.push(home);
  const me: MeIdentity = {
    account: "account-one",
    slug: "private-slug",
    name: "Private Name",
    permissions: ["mirror:read", "mirror:feed"],
    principal: "service",
    user: {
      id: "person-one",
      role: "owner",
      label: "Private Person",
      email: "private@example.test",
      linearUserId: null,
    },
  };
  const config: CustomerConfig = {
    ...me,
    user: { ...me.user! },
    baseUrl: "https://cloud.example.test",
    joinedAt: "2026-10-01T00:00:00Z",
    lastSkillBundleVersion: "fixture",
    auth: {
      kind: "oauth",
      sessionId: "private-session",
      accessToken: "private-access-one",
      refreshToken: "private-refresh",
      expiresAt: "2099-01-01T00:00:00Z",
    },
  };
  saveConfig(home, config);
  const clock = { ms: Date.now() };
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json(me);
  };
  const ctx: Ctx = {
    home,
    env: {},
    stdout: vi.fn(),
    stderr: vi.fn(),
    now: () => new Date(clock.ms),
    fetch: fetchImpl,
  };
  return { home, me, config, ctx, calls, clock };
}
describe("read-only current daemon authority", () => {
  test("actual device-JWT wire binds both feed scopes, original expiry and no config writes", async () => {
    const f = fixture();
    const before = readFileSync(configPathFor(f.home));
    const parent = new AbortController();
    const proof = await readDaemonAuthority(f.ctx, parent.signal);
    expect(proof.scope.person).toBe("person-one");
    expect(proof.scope.role).toBe("owner");
    expect(proof.expiresAt).toBe(f.clock.ms + 30_000);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe("https://cloud.example.test/api/v1/me");
    expect(f.calls[0].init?.redirect).toBe("error");
    expect(new Headers(f.calls[0].init?.headers).get("authorization")).toBe(
      "Bearer private-access-one",
    );
    expect(await proof.getToken()).toBe("private-access-one");
    expect(readFileSync(configPathFor(f.home))).toEqual(before);
    expect(JSON.stringify(proof)).not.toMatch(
      /private-access|private-refresh|private@example|Private Person/,
    );
    f.clock.ms += 30_000;
    expect(() => proof.assertCurrent()).toThrow("daemon_authority_expired");
  });
  test("same session rotation cannot replace the verified bearer; replacement session refuses", async () => {
    const f = fixture();
    const proof = await readDaemonAuthority(
      f.ctx,
      new AbortController().signal,
    );
    f.config.auth!.accessToken = "private-access-two";
    saveConfig(f.home, f.config);
    expect(await proof.getToken()).toBe("private-access-one");
    f.config.auth!.sessionId = "other-session";
    saveConfig(f.home, f.config);
    expect(() => proof.assertCurrent()).toThrow("daemon_authority_changed");
  });
  test.each(["account", "person", "role", "origin", "permissions"])(
    "actual saved %s mutation refuses old authority",
    async (kind) => {
      const f = fixture();
      const proof = await readDaemonAuthority(
        f.ctx,
        new AbortController().signal,
      );
      if (kind === "account") f.config.account = "other-account";
      if (kind === "person") f.config.user!.id = "other-person";
      if (kind === "role") f.config.user!.role = "admin";
      if (kind === "origin") f.config.baseUrl = "https://other.example.test";
      if (kind === "permissions") f.config.permissions = ["mirror:read"];
      saveConfig(f.home, f.config);
      expect(() => proof.assertCurrent()).toThrow();
    },
  );
  test("token publication rechecks original expiry after saved-config reads", async () => {
    const f = fixture();
    const proof = await readDaemonAuthority(
      f.ctx,
      new AbortController().signal,
    );
    let reads = 0;
    f.ctx.now = () => new Date(f.clock.ms + (reads++ > 0 ? 30_000 : 0));
    await expect(proof.getToken()).rejects.toThrow("daemon_authority_expired");
  });
  test("read-only /me cannot admit feed cache and sends no feed request", async () => {
    const f = fixture();
    f.me.permissions = ["mirror:read"];
    f.config.permissions = ["mirror:read"];
    saveConfig(f.home, f.config);
    await expect(
      readDaemonAuthority(f.ctx, new AbortController().signal),
    ).rejects.toThrow("daemon_feed_permission_required");
    expect(f.calls).toHaveLength(0);
  });
  test.each([
    "http://cloud.example.test",
    "https://user:password@cloud.example.test",
    "https://cloud.example.test/path",
    "https://cloud.example.test/?query=1",
    "https://cloud.example.test/#fragment",
  ])(
    "invalid saved origin %s refuses before bearer disclosure",
    async (baseUrl) => {
      const f = fixture();
      f.config.baseUrl = baseUrl;
      saveConfig(f.home, f.config);
      await expect(
        readDaemonAuthority(f.ctx, new AbortController().signal),
      ).rejects.toThrow("daemon_authority_changed");
      expect(f.calls).toHaveLength(0);
    },
  );
  test("host credential refuses before any /me or writer work", async () => {
    const f = fixture();
    delete f.config.auth;
    f.config.key = "ctc_host_fixture";
    saveConfig(f.home, f.config);
    await expect(
      readDaemonAuthority(f.ctx, new AbortController().signal),
    ).rejects.toThrow("daemon_authority_changed");
    expect(f.calls).toHaveLength(0);
  });
  test("near-expiry saved token refuses without refresh or network", async () => {
    const f = fixture();
    f.config.auth!.expiresAt = new Date(f.clock.ms + 30_000).toISOString();
    saveConfig(f.home, f.config);
    const before = readFileSync(configPathFor(f.home));
    await expect(
      readDaemonAuthority(f.ctx, new AbortController().signal),
    ).rejects.toThrow("daemon_login_refresh_required");
    expect(f.calls).toHaveLength(0);
    expect(readFileSync(configPathFor(f.home))).toEqual(before);
  });
  test("pre-aborted parent preserves null and never enters network", async () => {
    const f = fixture();
    const parent = new AbortController();
    parent.abort(null);
    await expect(readDaemonAuthority(f.ctx, parent.signal)).rejects.toBeNull();
    expect(f.calls).toHaveLength(0);
  });
  test("late successful /me cannot extend original proof lifetime", async () => {
    const f = fixture();
    f.ctx.fetch = async () => {
      f.clock.ms += 30_000;
      return Response.json(f.me);
    };
    await expect(
      readDaemonAuthority(f.ctx, new AbortController().signal),
    ).rejects.toThrow("daemon_authority_expired");
  });
  test("actual held reader cancellation keeps read owned and config unchanged", async () => {
    const f = fixture();
    const readEntered = deferred<void>();
    const cancelEntered = deferred<void>();
    const ack = deferred<void>();
    const parent = new AbortController();
    const reason = new Error("fixture-stop");
    const stream = new ReadableStream<Uint8Array>(
      {
        pull() {
          readEntered.resolve();
          return new Promise<void>(() => {});
        },
        cancel(received) {
          expect(received).toBe(reason);
          cancelEntered.resolve();
          return ack.promise;
        },
      },
      { highWaterMark: 0 },
    );
    f.ctx.fetch = async () =>
      new Response(stream, { headers: { "content-type": "application/json" } });
    const before = readFileSync(configPathFor(f.home));
    let settled = false;
    const read = readDaemonAuthority(f.ctx, parent.signal);
    const outcome = read
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    try {
      await readEntered.promise;
      parent.abort(reason);
      await cancelEntered.promise;
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(readFileSync(configPathFor(f.home))).toEqual(before);
    } finally {
      ack.resolve();
    }
    expect(await outcome).toEqual({ error: reason });
    expect(readFileSync(configPathFor(f.home))).toEqual(before);
  });
});
