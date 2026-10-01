import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { CustomerConfig, MeIdentity } from "./config.js";

export interface PersonCacheScope {
  schema: 1;
  account: string;
  person: string;
  origin: string;
  role: "owner" | "admin" | "member";
  permissions: readonly string[] | null;
  credential: string;
}
export interface PersonCache {
  directory: string;
  replicaDb: string;
  eventDirectory: string;
  assertBound(): void;
  /** Cheap pinned path/witness check for each SQL/cache mutation; full scan stays at operation boundaries. */
  assertOwnedPaths(): void;
}
const fail = () => new Error("daemon_cache_identity_unverified");
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const own = (s: Stats) =>
  process.getuid === undefined || s.uid === process.getuid();
const sameInode = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const validId = (s: unknown): s is string =>
  typeof s === "string" &&
  s.length > 0 &&
  s.length <= 256 &&
  !Array.from(s).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
function permissions(
  value: readonly string[] | null,
): readonly string[] | null {
  if (value === null) return null;
  if (
    !Array.isArray(value) ||
    value.length > 128 ||
    value.some((v) => !validId(v))
  )
    throw fail();
  return [...new Set(value)].sort();
}
function httpsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw fail();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw fail();
  return url.origin;
}

/** Only call after a fresh authenticated /me read. Config labels and token claims are not proof. */
export function personCacheScope(
  config: CustomerConfig,
  me: MeIdentity,
): PersonCacheScope {
  if (
    !me.user ||
    !config.user ||
    !validId(me.account) ||
    !validId(me.user.id) ||
    me.account !== config.account ||
    me.user.id !== config.user.id ||
    me.user.role !== config.user.role ||
    !["owner", "admin", "member"].includes(me.user.role)
  )
    throw fail();
  // /me does not carry project ACL revision or a personal replica dataset scope.
  // Account-wide warm caches are therefore limited to current owners and admins.
  if (me.user.role === "member")
    throw new Error("daemon_cache_member_scope_unavailable");
  const currentPermissions = permissions(me.permissions);
  if (
    currentPermissions !== null &&
    !currentPermissions.includes("mirror:read")
  )
    throw fail();
  if (
    JSON.stringify(currentPermissions) !==
    JSON.stringify(permissions(config.permissions))
  )
    throw fail();
  if (
    Boolean(config.key) === Boolean(config.auth) ||
    me.principal !== config.principal
  )
    throw fail();
  let credential: string;
  if (config.key) {
    if (
      me.principal !== "service" ||
      !config.key.startsWith("ctc_user_") ||
      config.key.length > 8192
    )
      throw fail();
    credential = "personal-key:" + digest(config.key);
  } else {
    // Device-code JWTs are user-bearing service principals; session denotes browser cookies.
    if (
      me.principal !== "service" ||
      !config.auth ||
      config.auth.kind !== "oauth" ||
      !validId(config.auth.sessionId)
    )
      throw fail();
    credential = "oauth-session:" + digest(config.auth.sessionId);
  }
  return Object.freeze({
    schema: 1,
    account: me.account,
    person: me.user.id,
    origin: httpsOrigin(config.baseUrl),
    role: me.user.role,
    permissions:
      currentPermissions === null ? null : Object.freeze(currentPermissions),
    credential,
  });
}
function canonical(scope: PersonCacheScope): string {
  if (
    scope.schema !== 1 ||
    !validId(scope.account) ||
    !validId(scope.person) ||
    !["owner", "admin", "member"].includes(scope.role) ||
    httpsOrigin(scope.origin) !== scope.origin ||
    !/^(personal-key|oauth-session):[a-f0-9]{64}$/.test(scope.credential)
  )
    throw fail();
  if (scope.role === "member")
    throw new Error("daemon_cache_member_scope_unavailable");
  const granted = permissions(scope.permissions);
  if (granted !== null && !granted.includes("mirror:read")) throw fail();
  return (
    JSON.stringify({
      schema: 1,
      account: scope.account,
      person: scope.person,
      origin: scope.origin,
      role: scope.role,
      permissions: permissions(scope.permissions),
      credential: scope.credential,
    }) + "\n"
  );
}
function stat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}
function checkDirectory(path: string, privateMode: boolean): Stats {
  const s = lstatSync(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    !own(s) ||
    (s.mode & (privateMode ? 0o077 : 0o022)) !== 0
  )
    throw fail();
  return s;
}
function readWitness(path: string): { bytes: string; stat: Stats } {
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !own(before) ||
    before.nlink !== 1 ||
    (before.mode & 0o077) !== 0 ||
    before.size > 65536
  )
    throw fail();
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = fstatSync(fd);
    if (!sameInode(before, opened)) throw fail();
    const buffer = Buffer.alloc(65537);
    let count = 0;
    while (count < buffer.length) {
      const read = readSync(fd, buffer, count, buffer.length - count, null);
      if (read === 0) break;
      count += read;
    }
    if (count > 65536) throw fail();
    const bytes = buffer.subarray(0, count).toString("utf8");
    const after = lstatSync(path),
      ended = fstatSync(fd);
    if (
      !sameInode(opened, after) ||
      !sameInode(opened, ended) ||
      opened.size !== Buffer.byteLength(bytes) ||
      opened.mtimeMs !== after.mtimeMs ||
      opened.mtimeMs !== ended.mtimeMs ||
      opened.ctimeMs !== after.ctimeMs ||
      (after.mode & 0o077) !== 0 ||
      !own(after) ||
      after.nlink !== 1
    )
      throw fail();
    return { bytes, stat: after };
  } finally {
    closeSync(fd);
  }
}
function checkCacheFiles(directory: string, pinned: Map<string, Stats>): void {
  let observed = 0;
  const seen = new Set<string>();
  const visit = (parent: string, depth: number) => {
    if (depth > 16) throw fail();
    for (const name of readdirSync(parent)) {
      if (++observed > 100000) throw fail();
      const path = join(parent, name),
        s = lstatSync(path);
      // The enclosing scope directory is 0700. SDK-default 0644/0755 children are
      // inaccessible to other users; writable aliases, links and special files are refused.
      if (s.isSymbolicLink() || !own(s) || (s.mode & 0o022) !== 0) throw fail();
      if (
        (path === join(directory, "replica.db") && !s.isFile()) ||
        (path === join(directory, "events") && !s.isDirectory())
      )
        throw fail();
      if (
        path === join(directory, "replica.db") ||
        path === join(directory, "events")
      ) {
        const before = pinned.get(path);
        if (before && !sameInode(before, s)) throw fail();
        pinned.set(path, s);
      }
      seen.add(path);
      if (s.isDirectory()) visit(path, depth + 1);
      else if (!s.isFile() || s.nlink !== 1) throw fail();
    }
  };
  visit(directory, 0);
  for (const path of pinned.keys()) if (!seen.has(path)) throw fail();
}

/** SDK 0.13.1 has no IO-settlement acknowledgement. Refuse it before any cache or writer work. */
export function requireAwaitedReplicaShutdown(replicaClass: {
  prototype: object;
}): void {
  if (
    !("closeAndWait" in replicaClass.prototype) ||
    typeof replicaClass.prototype.closeAndWait !== "function"
  )
    throw new Error("daemon_sdk_shutdown_unavailable");
}

/** Creates a new person-scoped cache; never adopts legacy cfg.replicaDb or tenant event paths.
 * assertCurrent must synchronously reject expired or changed authority before every use. These
 * inode checks protect cooperative local use; they do not promise a filesystem CAS. */
export function preparePersonCache(input: {
  home: string;
  scope: PersonCacheScope;
  replicaClass: { prototype: object };
  assertCurrent(): void;
}): PersonCache {
  requireAwaitedReplicaShutdown(input.replicaClass);
  input.assertCurrent();
  const bytes = canonical(input.scope);
  if (!isAbsolute(input.home)) throw fail();
  const home = resolve(input.home);
  const directory = join(
    home,
    ".config",
    "catalyst-cloud",
    "person-cache",
    "v1",
    digest(bytes),
  );
  const privateRoot = join(home, ".config", "catalyst-cloud", "person-cache");
  const paths: string[] = [];
  for (let path = directory; path !== dirname(path); path = dirname(path))
    paths.unshift(path);
  const pinned = new Map<string, Stats>();
  for (const path of paths) {
    input.assertCurrent();
    const withinHome = path === home || path.startsWith(home + sep);
    const privateMode =
      path === privateRoot || path.startsWith(privateRoot + sep);
    if (!stat(path)) {
      if (!withinHome) throw fail();
      mkdirSync(path, { mode: 0o700 });
    }
    // System ancestors may belong to root; they must still be real directories without links.
    if (!withinHome) {
      const s = lstatSync(path);
      const trustedSticky = s.uid === 0 && (s.mode & 0o1000) !== 0;
      if (
        !s.isDirectory() ||
        s.isSymbolicLink() ||
        (!own(s) && s.uid !== 0) ||
        ((s.mode & 0o022) !== 0 && !trustedSticky)
      )
        throw fail();
    } else pinned.set(path, checkDirectory(path, privateMode));
  }
  const witnessPath = join(directory, "identity.json");
  if (!stat(witnessPath)) {
    if (readdirSync(directory).length !== 0) throw fail();
    input.assertCurrent();
    const fd = openSync(
      witnessPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const directoryFd = openSync(
      directory,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  }
  const witness = readWitness(witnessPath);
  if (witness.bytes !== bytes) throw fail();
  const cacheInodes = new Map<string, Stats>();
  const assertWitness = () => {
    input.assertCurrent();
    for (const [path, original] of pinned) {
      const privateMode =
        path === privateRoot || path.startsWith(privateRoot + sep);
      if (!sameInode(original, checkDirectory(path, privateMode))) throw fail();
    }
    const current = readWitness(witnessPath);
    if (!sameInode(witness.stat, current.stat) || current.bytes !== bytes)
      throw fail();
  };
  const assertOwnedPaths = () => {
    assertWitness();
    for (const [path, directoryPath] of [
      [join(directory, "replica.db"), false],
      [join(directory, "events"), true],
    ] as const) {
      let stat: Stats;
      try {
        stat = lstatSync(path);
      } catch (error) {
        if (
          (error as { code?: string }).code === "ENOENT" &&
          !cacheInodes.has(path)
        )
          continue;
        throw fail();
      }
      if (
        stat.isSymbolicLink() ||
        !own(stat) ||
        (stat.mode & 0o022) !== 0 ||
        (directoryPath
          ? !stat.isDirectory()
          : !stat.isFile() || stat.nlink !== 1)
      )
        throw fail();
      const before = cacheInodes.get(path);
      if (before && !sameInode(before, stat)) throw fail();
      cacheInodes.set(path, stat);
    }
    // SQLite owns these transient leaves and may remove/recreate them at checkpoint/close.
    // Reject persistent aliases before the next SQL entry without pinning or deleting them.
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const leaf = stat(join(directory, "replica.db" + suffix));
      if (
        leaf &&
        (!leaf.isFile() ||
          leaf.isSymbolicLink() ||
          !own(leaf) ||
          leaf.nlink !== 1 ||
          (leaf.mode & 0o022) !== 0)
      )
        throw fail();
    }
    input.assertCurrent();
  };
  const assertBound = () => {
    assertWitness();
    checkCacheFiles(directory, cacheInodes);
    input.assertCurrent();
  };
  assertBound();
  return {
    directory,
    replicaDb: join(directory, "replica.db"),
    eventDirectory: join(directory, "events"),
    assertBound,
    assertOwnedPaths,
  };
}
