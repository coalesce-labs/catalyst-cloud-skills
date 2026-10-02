import { afterEach, describe, expect, test, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustomerConfig, MeIdentity } from "../src/config";
import { loadSdk, resetSdkCache } from "../src/sdk";
import {
  personCacheScope,
  preparePersonCache,
  requireAwaitedReplicaShutdown,
  type PersonCacheScope,
} from "../src/daemon-cache";

class AwaitedReplica {
  async closeAndWait(): Promise<void> {}
}
class ReleasedReplica {
  close(): void {}
}
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
function home() {
  // Resolve the OS temporary directory, not a possibly symlinked /tmp alias.
  const value = mkdtempSync(join(realpathSync(tmpdir()), "person-cache-"));
  homes.push(value);
  return value;
}
function fixture(): { config: CustomerConfig; me: MeIdentity } {
  const user = {
    id: "person-one",
    label: "Private Name",
    email: "private@example.test",
    role: "owner" as const,
    linearUserId: null,
  };
  // Actual device JWT bearer wire: cloud auth/open-read.ts:827 returns service + user.
  // The session principal denotes browser-cookie auth and is not this saved bearer rail.
  const me: MeIdentity = {
    account: "account-one",
    slug: "private-slug",
    name: "Private Tenant",
    principal: "service",
    permissions: ["mirror:read", "mirror:feed"],
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
      sessionId: "session-private-one",
      accessToken: "fixture-access-private",
      refreshToken: "fixture-refresh-private",
      expiresAt: "2099-01-01T00:00:00Z",
    },
  };
  return { config, me };
}
function scope() {
  const f = fixture();
  return personCacheScope(f.config, f.me);
}
function prepare(h: string, s = scope(), assertCurrent: () => void = vi.fn()) {
  return preparePersonCache({
    home: h,
    scope: s,
    assertCurrent,
    replicaClass: AwaitedReplica,
  });
}
function expectUntouchedHome(h: string) {
  expect(readdirSync(h)).toEqual([]);
}

describe("fresh personal cache authority", () => {
  test.each(["owner", "admin"] as const)(
    "accepts a fresh %s OAuth identity without storing secrets",
    (role) => {
      const { config, me } = fixture();
      if (!config.user || !me.user) throw new Error("fixture missing user");
      config.user.role = role;
      me.user.role = role;
      const s = personCacheScope(config, me),
        cache = prepare(home(), s);
      const bytes = readFileSync(
        join(cache.directory, "identity.json"),
        "utf8",
      );
      expect(JSON.parse(bytes)).toMatchObject({
        account: "account-one",
        person: "person-one",
        role,
      });
      for (const secret of [
        "session-private-one",
        "fixture-access-private",
        "fixture-refresh-private",
        "Private Name",
        "private@example.test",
        "Private Tenant",
      ])
        expect(bytes + cache.directory).not.toContain(secret);
      expect(lstatSync(cache.directory).mode & 0o777).toBe(0o700);
      expect(
        lstatSync(join(cache.directory, "identity.json")).mode & 0o777,
      ).toBe(0o600);
    },
  );
  test("personal key uses the real service/user rail and never persists raw key bytes", () => {
    const { config, me } = fixture();
    delete config.auth;
    config.key = "ctc_user_private_fixture";
    config.principal = me.principal = "service";
    const cache = prepare(home(), personCacheScope(config, me));
    expect(
      readFileSync(join(cache.directory, "identity.json"), "utf8"),
    ).not.toContain(config.key);
  });
  test.each(["account", "person", "role", "permissions", "principal"] as const)(
    "fresh %s mismatch refuses without creating a cache",
    (field) => {
      const { config, me } = fixture();
      const h = home();
      if (!me.user) throw new Error("fixture missing user");
      if (field === "account") me.account = "foreign";
      if (field === "person") me.user = { ...me.user, id: "foreign" };
      if (field === "role") me.user = { ...me.user, role: "admin" };
      if (field === "permissions") me.permissions = ["mirror:read"];
      if (field === "principal") me.principal = "session";
      expect(() => prepare(h, personCacheScope(config, me))).toThrow(
        "daemon_cache_identity_unverified",
      );
      expectUntouchedHome(h);
    },
  );
  test.each([
    "oauth-cookie-session",
    "key-session",
    "account-key",
    "both-credentials",
    "no-credentials",
  ])("invalid credential rail %s refuses", (kind) => {
    const { config, me } = fixture();
    if (kind === "oauth-cookie-session")
      config.principal = me.principal = "session";
    if (kind === "key-session") {
      delete config.auth;
      config.key = "ctc_user_fixture";
      config.principal = me.principal = "session";
    }
    if (kind === "account-key") {
      delete config.auth;
      config.key = "ctc_account_fixture";
      config.principal = me.principal = "service";
    }
    if (kind === "both-credentials") config.key = "ctc_user_fixture";
    if (kind === "no-credentials") delete config.auth;
    expect(() => personCacheScope(config, me)).toThrow(
      "daemon_cache_identity_unverified",
    );
  });
  test("member refusal also applies to a manually supplied scope before filesystem actions", () => {
    const { config, me } = fixture();
    const h = home();
    if (!config.user || !me.user) throw new Error("fixture missing user");
    config.user.role = me.user.role = "member";
    expect(() => personCacheScope(config, me)).toThrow(
      "daemon_cache_member_scope_unavailable",
    );
    expect(() => prepare(h, { ...scope(), role: "member" })).toThrow(
      "daemon_cache_member_scope_unavailable",
    );
    expectUntouchedHome(h);
  });
  test.each([
    "http://cloud.example.test",
    "https://user:pass@cloud.example.test",
    "https://cloud.example.test/api/v1",
    "https://cloud.example.test?token=secret",
    "https://cloud.example.test#foreign",
  ])("rejects non-HTTPS-origin %s", (baseUrl) => {
    const { config, me } = fixture();
    config.baseUrl = baseUrl;
    expect(() => personCacheScope(config, me)).toThrow(
      "daemon_cache_identity_unverified",
    );
  });
  test.each([
    { name: "empty grant", permissions: [] },
    { name: "feed without read", permissions: ["mirror:feed"] },
    {
      name: "control character",
      permissions: ["mirror:read", "bad\npermission"],
    },
  ])(
    "missing read authority or malformed permissions refuse: $name",
    ({ permissions }) => {
      const { config, me } = fixture();
      config.permissions = me.permissions = permissions;
      expect(() => personCacheScope(config, me)).toThrow(
        "daemon_cache_identity_unverified",
      );
    },
  );
  test("permission order and duplicate entries canonicalize; null stays distinct", () => {
    const { config, me } = fixture();
    config.permissions = ["mirror:feed", "mirror:read", "mirror:read"];
    const original = personCacheScope(config, me),
      h = home();
    const first = prepare(h, original);
    expect(
      prepare(h, { ...original, permissions: ["mirror:read", "mirror:feed"] })
        .directory,
    ).toBe(first.directory);
    config.permissions = me.permissions = null;
    expect(prepare(h, personCacheScope(config, me)).directory).not.toBe(
      first.directory,
    );
  });
  test.each([
    "account",
    "person",
    "origin",
    "role",
    "permissions",
    "credential",
  ] as const)("changed %s cannot reuse previous cache bytes", (field) => {
    const h = home(),
      original = scope(),
      first = prepare(h, original);
    writeFileSync(first.replicaDb, "old private bytes", { mode: 0o600 });
    const next: PersonCacheScope = { ...original };
    if (field === "account") next.account = "account-two";
    if (field === "person") next.person = "person-two";
    if (field === "origin") next.origin = "https://other.example.test";
    if (field === "role") next.role = "admin";
    if (field === "permissions") next.permissions = ["mirror:read"];
    if (field === "credential")
      next.credential = "oauth-session:" + "a".repeat(64);
    const second = prepare(h, next);
    expect(second.directory).not.toBe(first.directory);
    expect(existsSync(second.replicaDb)).toBe(false);
    expect(readFileSync(first.replicaDb, "utf8")).toBe("old private bytes");
  });
  test("same OAuth session token rotation keeps the scope while a new session partitions it", () => {
    const { config, me } = fixture();
    const original = personCacheScope(config, me);
    if (!config.auth) throw new Error("fixture missing auth");
    config.auth = {
      ...config.auth,
      accessToken: "rotated",
      refreshToken: "rotated-refresh",
      expiresAt: "2099-02-01",
    };
    expect(personCacheScope(config, me)).toEqual(original);
    config.auth.sessionId = "session-two";
    expect(personCacheScope(config, me).credential).not.toBe(
      original.credential,
    );
  });
});

describe("optional managed cache filesystem ownership", () => {
  test("actual pinned SDK requires current authority before cache I/O", async () => {
    resetSdkCache();
    try {
      const sdk = await loadSdk();
      const h = home(),
        authority = vi.fn(() => {
          throw new Error("current_authority_changed");
        });
      expect(typeof sdk.CatalystReplica).toBe("function");
      expect(typeof sdk.CatalystReplica.prototype.closeAndWait).toBe("function");
      expect(() =>
        preparePersonCache({
          home: h,
          scope: scope(),
          assertCurrent: authority,
          replicaClass: sdk.CatalystReplica,
        }),
      ).toThrow("current_authority_changed");
      expect(authority).toHaveBeenCalledOnce();
      expectUntouchedHome(h);
    } finally {
      resetSdkCache();
    }
  });
  test("actual pinned SDK admits a private cache with current authority", async () => {
    resetSdkCache();
    try {
      const sdk = await loadSdk();
      const h = home(),
        authority = vi.fn();
      expect(() =>
        requireAwaitedReplicaShutdown(sdk.CatalystReplica),
      ).not.toThrow();
      const cache = preparePersonCache({
        home: h,
        scope: scope(),
        assertCurrent: authority,
        replicaClass: sdk.CatalystReplica,
      });
      expect(authority).toHaveBeenCalled();
      expect(existsSync(cache.directory)).toBe(true);
      expect(lstatSync(cache.directory).mode & 0o777).toBe(0o700);
      expect(existsSync(join(cache.directory, "identity.json"))).toBe(true);
      expect(lstatSync(join(cache.directory, "identity.json")).mode & 0o777).toBe(
        0o600,
      );
      expect(() => cache.assertBound()).not.toThrow();
      expect(() => cache.assertOwnedPaths()).not.toThrow();
      expect(existsSync(cache.replicaDb)).toBe(false);
      expect(existsSync(cache.eventDirectory)).toBe(false);
      const witness = readFileSync(join(cache.directory, "identity.json"), "utf8");
      for (const privateValue of [
        "fixture-access-private",
        "fixture-refresh-private",
        "Private Name",
        "private@example.test",
        "Private Tenant",
      ])
        expect(witness).not.toContain(privateValue);
    } finally {
      resetSdkCache();
    }
  });
  test("legacy SDK and absent current authority refuse before filesystem or authority work", () => {
    const h = home(),
      authority = vi.fn();
    expect(() => requireAwaitedReplicaShutdown(ReleasedReplica)).toThrow(
      "daemon_sdk_shutdown_unavailable",
    );
    expect(() =>
      preparePersonCache({
        home: h,
        scope: scope(),
        assertCurrent: authority,
        replicaClass: ReleasedReplica,
      }),
    ).toThrow("daemon_sdk_shutdown_unavailable");
    expect(authority).not.toHaveBeenCalled();
    expectUntouchedHome(h);
    expect(() =>
      prepare(h, scope(), () => {
        throw new Error("current_authority_changed");
      }),
    ).toThrow("current_authority_changed");
    expectUntouchedHome(h);
  });
  test("normal 0755 config ancestors and legacy bytes remain unchanged", () => {
    const h = home(),
      configDir = join(h, ".config", "catalyst-cloud");
    mkdirSync(configDir, { recursive: true, mode: 0o755 });
    chmodSync(join(h, ".config"), 0o755);
    chmodSync(configDir, 0o755);
    const legacy = join(configDir, "replica.db"),
      events = join(h, "legacy-events");
    writeFileSync(legacy, "legacy tenant database", { mode: 0o600 });
    mkdirSync(events, { mode: 0o700 });
    writeFileSync(join(events, "cursor.json"), "legacy cursor", {
      mode: 0o600,
    });
    const { config, me } = fixture();
    config.replicaDb = legacy;
    const cache = prepare(h, personCacheScope(config, me));
    expect(cache.replicaDb).not.toBe(legacy);
    expect(cache.eventDirectory).not.toBe(events);
    expect(readFileSync(legacy, "utf8")).toBe("legacy tenant database");
    expect(readFileSync(join(events, "cursor.json"), "utf8")).toBe(
      "legacy cursor",
    );
    expect(lstatSync(configDir).mode & 0o777).toBe(0o755);
  });
  test("exact private witness resumes, but nonempty unwitnessed data is never adopted", () => {
    const h = home(),
      cache = prepare(h),
      witness = join(cache.directory, "identity.json");
    writeFileSync(cache.replicaDb, "existing cache", { mode: 0o600 });
    expect(prepare(h).directory).toBe(cache.directory);
    unlinkSync(witness);
    expect(() => prepare(h)).toThrow("daemon_cache_identity_unverified");
    expect(existsSync(witness)).toBe(false);
    expect(readFileSync(cache.replicaDb, "utf8")).toBe("existing cache");
  });
  test.each(["foreign", "oversized", "mode", "symlink", "hardlink"])(
    "refuses %s witness without modifying customer bytes",
    (kind) => {
      const h = home(),
        cache = prepare(h),
        file = join(cache.directory, "identity.json");
      const target = join(h, "customer.txt");
      writeFileSync(target, "customer bytes", { mode: 0o600 });
      if (kind === "foreign")
        writeFileSync(file, "foreign witness", { mode: 0o600 });
      if (kind === "oversized")
        writeFileSync(file, "x".repeat(65537), { mode: 0o600 });
      if (kind === "mode") chmodSync(file, 0o644);
      if (kind === "symlink" || kind === "hardlink") {
        unlinkSync(file);
        if (kind === "symlink") symlinkSync(target, file);
        else linkSync(target, file);
      }
      expect(() => prepare(h)).toThrow("daemon_cache_identity_unverified");
      expect(readFileSync(target, "utf8")).toBe("customer bytes");
      if (kind === "foreign")
        expect(readFileSync(file, "utf8")).toBe("foreign witness");
    },
  );
  test.each(["symlink", "writable"])(
    "unsafe %s config ancestor refuses before cache creation",
    (kind) => {
      const h = home(),
        configDir = join(h, ".config");
      if (kind === "symlink") {
        const target = join(h, "customer-config");
        mkdirSync(target, { mode: 0o700 });
        symlinkSync(target, configDir);
      } else {
        mkdirSync(configDir, { mode: 0o700 });
        chmodSync(configDir, 0o777);
      }
      expect(() => prepare(h)).toThrow("daemon_cache_identity_unverified");
      expect(existsSync(join(configDir, "catalyst-cloud"))).toBe(false);
    },
  );
  test("legitimate SDK 0644 sidecars, 0755 events and temporary removal do not invalidate ownership", () => {
    const cache = prepare(home());
    mkdirSync(cache.eventDirectory, { mode: 0o755 });
    writeFileSync(cache.replicaDb, "database", { mode: 0o600 });
    const lock = cache.replicaDb + ".writer.lock",
      temporary = join(cache.eventDirectory, "cursor.tmp");
    writeFileSync(lock, "owned SDK lock", { mode: 0o644 });
    writeFileSync(temporary, "owned transient", { mode: 0o644 });
    expect(() => cache.assertBound()).not.toThrow();
    unlinkSync(lock);
    unlinkSync(temporary);
    expect(() => cache.assertBound()).not.toThrow();
  });
  test.each([
    "database-replace",
    "database-remove",
    "events-replace",
    "events-remove",
  ])("stable %s is refused while replacement bytes remain intact", (kind) => {
    const cache = prepare(home());
    writeFileSync(cache.replicaDb, "database", { mode: 0o600 });
    mkdirSync(cache.eventDirectory, { mode: 0o700 });
    cache.assertBound();
    const target = kind.startsWith("database")
      ? cache.replicaDb
      : cache.eventDirectory;
    renameSync(target, target + ".retained");
    if (kind.endsWith("replace")) {
      if (kind.startsWith("database"))
        writeFileSync(target, "replacement", { mode: 0o600 });
      else mkdirSync(target, { mode: 0o700 });
    }
    expect(() => cache.assertBound()).toThrow(
      "daemon_cache_identity_unverified",
    );
    expect(existsSync(target + ".retained")).toBe(true);
    if (kind === "database-replace")
      expect(readFileSync(target, "utf8")).toBe("replacement");
  });
  test.each(["database-directory", "events-file"])(
    "wrong stable target type %s is refused",
    (kind) => {
      const h = home(),
        cache = prepare(h);
      if (kind === "database-directory")
        mkdirSync(cache.replicaDb, { mode: 0o700 });
      else
        writeFileSync(cache.eventDirectory, "customer file", { mode: 0o600 });
      expect(() => cache.assertBound()).toThrow(
        "daemon_cache_identity_unverified",
      );
      expect(() => prepare(h)).toThrow("daemon_cache_identity_unverified");
      if (kind === "events-file")
        expect(readFileSync(cache.eventDirectory, "utf8")).toBe(
          "customer file",
        );
    },
  );
  test.each(["symlink", "hardlink", "writable"])(
    "unsafe %s child refuses without deleting it",
    (kind) => {
      const h = home(),
        cache = prepare(h),
        target = join(h, "customer.txt"),
        child = join(cache.directory, "unknown-child");
      writeFileSync(target, "customer bytes", { mode: 0o600 });
      if (kind === "symlink") symlinkSync(target, child);
      else if (kind === "hardlink") linkSync(target, child);
      else {
        writeFileSync(child, "unsafe bytes", { mode: 0o600 });
        chmodSync(child, 0o666);
      }
      expect(() => cache.assertBound()).toThrow(
        "daemon_cache_identity_unverified",
      );
      expect(lstatSync(child)).toBeDefined();
      expect(readFileSync(target, "utf8")).toBe("customer bytes");
    },
  );
  test.each(["witness-replace", "witness-edit", "scope-replace"])(
    "observed %s refuses on reuse",
    (kind) => {
      const cache = prepare(home()),
        witness = join(cache.directory, "identity.json");
      if (kind === "scope-replace") {
        renameSync(cache.directory, cache.directory + ".retained");
        mkdirSync(cache.directory, { mode: 0o700 });
      } else if (kind === "witness-edit")
        writeFileSync(witness, "modified in place", { mode: 0o600 });
      else {
        const bytes = readFileSync(witness);
        renameSync(witness, witness + ".retained");
        writeFileSync(witness, bytes, { mode: 0o600 });
      }
      expect(() => cache.assertBound()).toThrow(
        "daemon_cache_identity_unverified",
      );
    },
  );
  test("changed authority refuses reuse before creating database or event paths", () => {
    let current = true;
    const h = home();
    const cache = prepare(h, scope(), () => {
      if (!current) throw new Error("session_changed");
    });
    const before = readFileSync(join(cache.directory, "identity.json"));
    current = false;
    expect(() => cache.assertBound()).toThrow("session_changed");
    expect(readFileSync(join(cache.directory, "identity.json"))).toEqual(
      before,
    );
    expect(existsSync(cache.replicaDb)).toBe(false);
    expect(existsSync(cache.eventDirectory)).toBe(false);
  });
});

describe("fast personal cache write boundary", () => {
  test("allows absent leaves and pins their first real appearance before a full scan", () => {
    const cache = prepare(home());
    expect(() => cache.assertOwnedPaths()).not.toThrow();
    expect(existsSync(cache.replicaDb)).toBe(false);
    expect(existsSync(cache.eventDirectory)).toBe(false);
    writeFileSync(cache.replicaDb, "first database", { mode: 0o600 });
    mkdirSync(cache.eventDirectory, { mode: 0o755 });
    cache.assertOwnedPaths();
    const original = lstatSync(cache.replicaDb);
    renameSync(cache.replicaDb, cache.replicaDb + ".retained");
    writeFileSync(cache.replicaDb, "foreign replacement", { mode: 0o600 });
    const foreign = lstatSync(cache.replicaDb);
    expect(foreign.ino).not.toBe(original.ino);
    expect(() => cache.assertOwnedPaths()).toThrow(
      "daemon_cache_identity_unverified",
    );
    expect(lstatSync(cache.replicaDb).ino).toBe(foreign.ino);
    expect(readFileSync(cache.replicaDb, "utf8")).toBe("foreign replacement");
    expect(readFileSync(cache.replicaDb + ".retained", "utf8")).toBe(
      "first database",
    );
  });

  test("first event directory is pinned before its next mutation", () => {
    const cache = prepare(home());
    mkdirSync(cache.eventDirectory, { mode: 0o700 });
    cache.assertOwnedPaths();
    const original = lstatSync(cache.eventDirectory);
    renameSync(cache.eventDirectory, cache.eventDirectory + ".retained");
    mkdirSync(cache.eventDirectory, { mode: 0o700 });
    const foreign = lstatSync(cache.eventDirectory);
    expect(foreign.ino).not.toBe(original.ino);
    expect(() => cache.assertOwnedPaths()).toThrow(
      "daemon_cache_identity_unverified",
    );
    expect(lstatSync(cache.eventDirectory).ino).toBe(foreign.ino);
    expect(lstatSync(cache.eventDirectory + ".retained").ino).toBe(
      original.ino,
    );
  });

  test("a once-pinned leaf may not silently disappear", () => {
    for (const kind of ["database", "events"] as const) {
      const cache = prepare(home());
      writeFileSync(cache.replicaDb, "owned database", { mode: 0o600 });
      mkdirSync(cache.eventDirectory, { mode: 0o700 });
      cache.assertOwnedPaths();
      const path = kind === "database" ? cache.replicaDb : cache.eventDirectory;
      renameSync(path, path + ".retained");
      const retained = lstatSync(path + ".retained");
      expect(() => cache.assertOwnedPaths()).toThrow(
        "daemon_cache_identity_unverified",
      );
      expect(existsSync(path)).toBe(false);
      expect(lstatSync(path + ".retained").ino).toBe(retained.ino);
    }
  });

  test("hard-linked database is refused with both customer names and bytes preserved", () => {
    const h = home(),
      cache = prepare(h),
      foreign = join(h, "customer.db");
    writeFileSync(foreign, "customer database", { mode: 0o600 });
    linkSync(foreign, cache.replicaDb);
    const original = lstatSync(foreign);
    expect(original.nlink).toBe(2);
    expect(() => cache.assertOwnedPaths()).toThrow(
      "daemon_cache_identity_unverified",
    );
    expect(lstatSync(cache.replicaDb).ino).toBe(original.ino);
    expect(lstatSync(foreign).nlink).toBe(2);
    expect(readFileSync(foreign, "utf8")).toBe("customer database");
  });

  test("symlinked database and event roots never adopt their customer targets", () => {
    for (const kind of ["database", "events"] as const) {
      const h = home(),
        cache = prepare(h),
        foreign = join(h, "customer-target");
      if (kind === "database")
        writeFileSync(foreign, "customer bytes", { mode: 0o600 });
      else {
        mkdirSync(foreign, { mode: 0o700 });
        writeFileSync(join(foreign, "customer.jsonl"), "customer bytes", {
          mode: 0o600,
        });
      }
      const target =
        kind === "database" ? cache.replicaDb : cache.eventDirectory;
      symlinkSync(foreign, target);
      const original = lstatSync(foreign);
      expect(() => cache.assertOwnedPaths()).toThrow(
        "daemon_cache_identity_unverified",
      );
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      expect(lstatSync(foreign).ino).toBe(original.ino);
      expect(
        readFileSync(
          kind === "database" ? foreign : join(foreign, "customer.jsonl"),
          "utf8",
        ),
      ).toBe("customer bytes");
    }
  });

  test("unsafe leaf modes and swapped leaf types are rejected without repair", () => {
    for (const kind of [
      "database-mode",
      "events-mode",
      "database-directory",
      "events-file",
    ] as const) {
      const cache = prepare(home());
      const target = kind.startsWith("database")
        ? cache.replicaDb
        : cache.eventDirectory;
      if (kind === "database-mode" || kind === "events-file")
        writeFileSync(target, "foreign bytes", { mode: 0o600 });
      else mkdirSync(target, { mode: 0o700 });
      if (kind.endsWith("mode")) chmodSync(target, 0o777);
      const before = lstatSync(target);
      expect(() => cache.assertOwnedPaths()).toThrow(
        "daemon_cache_identity_unverified",
      );
      expect(lstatSync(target).ino).toBe(before.ino);
      expect(lstatSync(target).mode).toBe(before.mode);
    }
  });

  test("pinned parent inode and private mode changes refuse before creating leaves", () => {
    for (const kind of ["replace", "mode"] as const) {
      const cache = prepare(home());
      const retained = cache.directory + ".retained";
      if (kind === "replace") {
        renameSync(cache.directory, retained);
        mkdirSync(cache.directory, { mode: 0o700 });
        writeFileSync(
          join(cache.directory, "identity.json"),
          readFileSync(join(retained, "identity.json")),
          { mode: 0o600 },
        );
      } else chmodSync(cache.directory, 0o755);
      const foreign = lstatSync(cache.directory);
      expect(() => cache.assertOwnedPaths()).toThrow(
        "daemon_cache_identity_unverified",
      );
      expect(lstatSync(cache.directory).ino).toBe(foreign.ino);
      expect(lstatSync(cache.directory).mode).toBe(foreign.mode);
      expect(existsSync(cache.replicaDb)).toBe(false);
      expect(existsSync(cache.eventDirectory)).toBe(false);
    }
  });

  test("fast witness read checks exact inode, bytes, size and private mode", () => {
    for (const kind of ["replace", "bytes", "oversized", "mode"] as const) {
      const cache = prepare(home()),
        witness = join(cache.directory, "identity.json");
      if (kind === "replace") {
        renameSync(witness, witness + ".retained");
        writeFileSync(witness, readFileSync(witness + ".retained"), {
          mode: 0o600,
        });
      } else if (kind === "bytes")
        writeFileSync(witness, "foreign witness", { mode: 0o600 });
      else if (kind === "oversized")
        writeFileSync(witness, "x".repeat(65537), { mode: 0o600 });
      else chmodSync(witness, 0o644);
      const before = lstatSync(witness),
        bytes = readFileSync(witness);
      expect(() => cache.assertOwnedPaths()).toThrow(
        "daemon_cache_identity_unverified",
      );
      expect(lstatSync(witness).ino).toBe(before.ino);
      expect(lstatSync(witness).mode).toBe(before.mode);
      expect(readFileSync(witness)).toEqual(bytes);
    }
  });

  test("current authority is checked at entry and again after real witness and leaf reads", () => {
    let phase: "prepare" | "entry-expired" | "expire-after-entry" = "prepare";
    let boundaryChecks = 0;
    const expired = new Error("actual_authority_expired");
    const cache = prepare(home(), scope(), () => {
      if (phase === "prepare") return;
      boundaryChecks++;
      if (phase === "entry-expired" || boundaryChecks > 1) throw expired;
    });
    const witness = join(cache.directory, "identity.json"),
      before = readFileSync(witness);
    phase = "entry-expired";
    expect(() => cache.assertOwnedPaths()).toThrow(expired);
    expect(boundaryChecks).toBe(1);
    boundaryChecks = 0;
    phase = "expire-after-entry";
    expect(() => cache.assertOwnedPaths()).toThrow(expired);
    expect(boundaryChecks).toBe(2);
    expect(readFileSync(witness)).toEqual(before);
    expect(existsSync(cache.replicaDb)).toBe(false);
    expect(existsSync(cache.eventDirectory)).toBe(false);
  });

  test("full operation boundary refuses nested aliases that a root-only check cannot certify", () => {
    for (const kind of ["symlink", "hardlink"] as const) {
      const h = home(),
        cache = prepare(h),
        foreign = join(h, "customer-events.jsonl");
      mkdirSync(cache.eventDirectory, { mode: 0o700 });
      cache.assertOwnedPaths();
      writeFileSync(foreign, "customer event bytes", { mode: 0o600 });
      const child = join(cache.eventDirectory, "2026-10-01.jsonl");
      if (kind === "symlink") symlinkSync(foreign, child);
      else linkSync(foreign, child);
      const before = lstatSync(child),
        original = lstatSync(foreign);
      // The fast API certifies roots, not arbitrary child leaves. Event append requires
      // a full check or an independently safe opened-leaf check before entering its write.
      expect(() => cache.assertBound()).toThrow(
        "daemon_cache_identity_unverified",
      );
      expect(lstatSync(child).ino).toBe(before.ino);
      expect(lstatSync(foreign).ino).toBe(original.ino);
      expect(readFileSync(foreign, "utf8")).toBe("customer event bytes");
    }
  });
});

describe("fast person-cache optional SQLite sidecars", () => {
  const suffixes = ["-wal", "-shm", "-journal"] as const;

  test.each(suffixes)(
    "refuses a symlinked %s without touching its customer target",
    (suffix) => {
      const h = home(),
        cache = prepare(h),
        customer = join(h, "customer-sidecar");
      writeFileSync(customer, "customer bytes", { mode: 0o600 });
      const leaf = cache.replicaDb + suffix;
      symlinkSync(customer, leaf);
      const original = lstatSync(customer),
        link = lstatSync(leaf);
      expect(() => cache.assertOwnedPaths()).toThrow(
        "daemon_cache_identity_unverified",
      );
      expect(lstatSync(leaf).isSymbolicLink()).toBe(true);
      expect(lstatSync(leaf).ino).toBe(link.ino);
      expect(lstatSync(customer).ino).toBe(original.ino);
      expect(readFileSync(customer, "utf8")).toBe("customer bytes");
    },
  );

  test.each(suffixes)(
    "refuses a hardlinked %s without repairing or writing either alias",
    (suffix) => {
      const h = home(),
        cache = prepare(h),
        customer = join(h, "customer-sidecar");
      writeFileSync(customer, "customer bytes", { mode: 0o600 });
      const leaf = cache.replicaDb + suffix;
      linkSync(customer, leaf);
      const original = lstatSync(customer);
      expect(original.nlink).toBe(2);
      expect(() => cache.assertOwnedPaths()).toThrow(
        "daemon_cache_identity_unverified",
      );
      expect(lstatSync(leaf).ino).toBe(original.ino);
      expect(lstatSync(customer).nlink).toBe(2);
      expect(readFileSync(customer, "utf8")).toBe("customer bytes");
    },
  );

  test.each(suffixes)(
    "refuses a writable %s and preserves its bytes and permissions",
    (suffix) => {
      const cache = prepare(home()),
        leaf = cache.replicaDb + suffix;
      writeFileSync(leaf, "sidecar bytes", { mode: 0o600 });
      chmodSync(leaf, 0o666);
      const original = lstatSync(leaf);
      expect(() => cache.assertOwnedPaths()).toThrow(
        "daemon_cache_identity_unverified",
      );
      expect(lstatSync(leaf).ino).toBe(original.ino);
      expect(lstatSync(leaf).mode).toBe(original.mode);
      expect(readFileSync(leaf, "utf8")).toBe("sidecar bytes");
    },
  );

  test.each(suffixes)(
    "refuses a directory at %s without deleting or adopting it",
    (suffix) => {
      const cache = prepare(home()),
        leaf = cache.replicaDb + suffix;
      mkdirSync(leaf, { mode: 0o700 });
      writeFileSync(join(leaf, "customer"), "retained bytes", { mode: 0o600 });
      const original = lstatSync(leaf);
      expect(() => cache.assertOwnedPaths()).toThrow(
        "daemon_cache_identity_unverified",
      );
      expect(lstatSync(leaf).isDirectory()).toBe(true);
      expect(lstatSync(leaf).ino).toBe(original.ino);
      expect(readFileSync(join(leaf, "customer"), "utf8")).toBe(
        "retained bytes",
      );
    },
  );

  test("all three optional regular sidecars can disappear and be recreated on distinct inodes", () => {
    const cache = prepare(home()),
      witness = readFileSync(join(cache.directory, "identity.json"));
    // These are optional SQLite-owned leaves, not the pinned database/events roots.
    expect(() => cache.assertOwnedPaths()).not.toThrow();
    for (const suffix of suffixes) {
      const leaf = cache.replicaDb + suffix;
      writeFileSync(leaf, "first sidecar", { mode: 0o600 });
      expect(() => cache.assertOwnedPaths()).not.toThrow();
      const first = lstatSync(leaf);
      renameSync(leaf, leaf + ".retained");
      expect(() => cache.assertOwnedPaths()).not.toThrow();
      writeFileSync(leaf, "second sidecar", { mode: 0o644 });
      expect(lstatSync(leaf).ino).not.toBe(first.ino);
      expect(() => cache.assertOwnedPaths()).not.toThrow();
      unlinkSync(leaf);
      expect(() => cache.assertOwnedPaths()).not.toThrow();
    }
    expect(readFileSync(join(cache.directory, "identity.json"))).toEqual(
      witness,
    );
  });

  test("actual native SQLite WAL and SHM creation, close and reopen remain valid", () => {
    const cache = prepare(home()),
      witness = readFileSync(join(cache.directory, "identity.json"));
    const first = new DatabaseSync(cache.replicaDb),
      database = lstatSync(cache.replicaDb);
    try {
      first.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE sidecar_control (value TEXT); INSERT INTO sidecar_control VALUES ('first');",
      );
      expect(first.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe(
        "wal",
      );
      for (const suffix of ["-wal", "-shm"])
        expect(lstatSync(cache.replicaDb + suffix).isFile()).toBe(true);
      expect(() => cache.assertOwnedPaths()).not.toThrow();
    } finally {
      first.close();
    }
    expect(existsSync(cache.replicaDb + "-wal")).toBe(false);
    expect(existsSync(cache.replicaDb + "-shm")).toBe(false);
    expect(() => cache.assertOwnedPaths()).not.toThrow();
    const second = new DatabaseSync(cache.replicaDb);
    try {
      second.exec("INSERT INTO sidecar_control VALUES ('second');");
      for (const suffix of ["-wal", "-shm"])
        expect(lstatSync(cache.replicaDb + suffix).isFile()).toBe(true);
      expect(lstatSync(cache.replicaDb).ino).toBe(database.ino);
      expect(() => cache.assertOwnedPaths()).not.toThrow();
      expect(
        second.prepare("SELECT COUNT(*) AS count FROM sidecar_control").get()
          ?.count,
      ).toBe(2);
    } finally {
      second.close();
    }
    expect(() => cache.assertOwnedPaths()).not.toThrow();
    expect(readFileSync(join(cache.directory, "identity.json"))).toEqual(
      witness,
    );
  });

  test("actual native SQLite rollback journals remain optional across transaction settlement", () => {
    const cache = prepare(home()),
      db = new DatabaseSync(cache.replicaDb);
    try {
      db.exec(
        "PRAGMA journal_mode=DELETE; CREATE TABLE rollback_control (value TEXT);",
      );
      expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe(
        "delete",
      );
      const database = lstatSync(cache.replicaDb);
      for (const settlement of ["ROLLBACK", "COMMIT"] as const) {
        expect(existsSync(cache.replicaDb + "-journal")).toBe(false);
        expect(() => cache.assertOwnedPaths()).not.toThrow();
        db.exec(
          "BEGIN IMMEDIATE; INSERT INTO rollback_control VALUES ('actual');",
        );
        expect(lstatSync(cache.replicaDb + "-journal").isFile()).toBe(true);
        expect(() => cache.assertOwnedPaths()).not.toThrow();
        db.exec(settlement);
        expect(existsSync(cache.replicaDb + "-journal")).toBe(false);
        expect(lstatSync(cache.replicaDb).ino).toBe(database.ino);
        expect(() => cache.assertOwnedPaths()).not.toThrow();
      }
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM rollback_control").get()
          ?.count,
      ).toBe(1);
    } finally {
      db.close();
    }
    expect(() => cache.assertOwnedPaths()).not.toThrow();
  });
});
