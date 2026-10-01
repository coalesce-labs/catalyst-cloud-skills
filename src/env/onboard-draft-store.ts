import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import type { FileHandle } from "node:fs/promises";
import { onboardStateRoot } from "../onboard.js";

const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_TOML_BYTES = 1024 * 1024;

export type StoreOnboardDraftResult =
  { state: "stored"; path: string } | { state: "rejected" };

interface CreatedFileIdentity {
  dev: number;
  ino: number;
}

/** Narrow filesystem seam for deterministic cancellation and partial-write tests. */
export interface OnboardDraftStoreFs {
  mkdir: typeof mkdir;
  lstat: typeof lstat;
  open: typeof open;
  unlink: typeof unlink;
}

const defaultFs: OnboardDraftStoreFs = { mkdir, lstat, open, unlink };

/**
 * Persist a private copy of a draft produced and fully validated by the caller. This function
 * checks the storage boundary only; it does not validate settings or inspect TOML values.
 */
export async function storeOnboardDraft(
  input: {
    home: string;
    env?: NodeJS.ProcessEnv;
    runId: string;
    repoId: string;
    toml: string;
    signal?: AbortSignal;
  },
  fsOps: OnboardDraftStoreFs = defaultFs,
): Promise<StoreOnboardDraftResult> {
  const home = input?.home;
  const env = input?.env;
  const runId = input?.runId;
  const repoId = input?.repoId;
  const toml = input?.toml;
  const signal = input?.signal;
  if (
    typeof runId !== "string" ||
    !OPAQUE_ID_RE.test(runId) ||
    typeof repoId !== "string" ||
    !OPAQUE_ID_RE.test(repoId) ||
    typeof home !== "string" ||
    !isAbsolute(home) ||
    typeof toml !== "string" ||
    Buffer.byteLength(toml, "utf8") > MAX_TOML_BYTES ||
    signal?.aborted
  )
    return { state: "rejected" };

  // Snapshot the expected bytes and resolved paths before the first asynchronous operation.
  const expected = Buffer.from(toml, "utf8");
  let stateRoot: string;
  let runDir: string;
  let destination: string;
  try {
    stateRoot = resolve(onboardStateRoot(home, env));
    if (stateRoot === parse(stateRoot).root || stateRoot === resolve(home))
      return { state: "rejected" };
    runDir = join(stateRoot, "install", "drafts", runId);
    destination = join(runDir, `${repoId}.toml`);
  } catch {
    return { state: "rejected" };
  }

  let handle: FileHandle | undefined;
  let created: CreatedFileIdentity | undefined;
  try {
    await ensureDirectoryTree(runDir, stateRoot, signal, fsOps);
    if (aborted(signal)) return { state: "rejected" };

    try {
      handle = await fsOps.open(
        destination,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      return await resumeExisting(
        destination,
        runDir,
        stateRoot,
        expected,
        signal,
        fsOps,
      );
    }

    const opened = await handle.stat();
    created = { dev: opened.dev, ino: opened.ino };
    if (!opened.isFile() || opened.nlink !== 1 || !privateMode(opened.mode))
      throw new Error("unsafe artifact");
    if (aborted(signal)) throw new Error("cancelled");

    await handle.writeFile(expected);
    if (aborted(signal)) throw new Error("cancelled");
    await handle.sync();
    if (aborted(signal)) throw new Error("cancelled");
    await ensureDirectoryTree(runDir, stateRoot, signal, fsOps);
    if (aborted(signal)) throw new Error("cancelled");
    await verifyCreatedPath(destination, created, fsOps);
    if (aborted(signal)) throw new Error("cancelled");
    await handle.close();
    handle = undefined;
    if (aborted(signal)) throw new Error("cancelled");
    await ensureDirectoryTree(runDir, stateRoot, signal, fsOps);
    if (aborted(signal)) throw new Error("cancelled");
    await verifyCreatedPath(destination, created, fsOps);
    if (aborted(signal)) throw new Error("cancelled");
    return { state: "stored", path: destination };
  } catch {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        /* settle close before inode-scoped cleanup */
      }
    }
    if (created !== undefined)
      await removeCreatedFile(destination, created, fsOps);
    return { state: "rejected" };
  }
}

async function resumeExisting(
  path: string,
  runDir: string,
  stateRoot: string,
  expected: Buffer,
  signal: AbortSignal | undefined,
  fsOps: OnboardDraftStoreFs,
): Promise<StoreOnboardDraftResult> {
  let handle: FileHandle | undefined;
  try {
    if (aborted(signal)) return { state: "rejected" };
    await ensureDirectoryTree(runDir, stateRoot, signal, fsOps);
    if (aborted(signal)) return { state: "rejected" };
    handle = await fsOps.open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat();
    const pathBefore = await fsOps.lstat(path);
    if (!sameSafeFile(before, pathBefore) || aborted(signal))
      throw new Error("unsafe resume file");

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      if (aborted(signal)) throw new Error("cancelled");
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_TOML_BYTES) throw new Error("oversized resume file");
      chunks.push(bytes);
    }
    if (aborted(signal)) throw new Error("cancelled");
    const content = Buffer.concat(chunks, total);
    if (!content.equals(expected)) throw new Error("different resume bytes");

    const fdAfter = await handle.stat();
    const pathAfter = await fsOps.lstat(path);
    if (
      !sameIdentity(before, fdAfter) ||
      !sameSafeFile(fdAfter, pathAfter) ||
      aborted(signal)
    )
      throw new Error("resume path changed");
    await ensureDirectoryTree(runDir, stateRoot, signal, fsOps);
    if (aborted(signal)) throw new Error("cancelled");
    await handle.close();
    handle = undefined;
    if (aborted(signal)) throw new Error("cancelled");
    await ensureDirectoryTree(runDir, stateRoot, signal, fsOps);
    if (aborted(signal)) throw new Error("cancelled");
    const finalPath = await fsOps.lstat(path);
    if (!sameSafeFile(before, finalPath) || aborted(signal))
      throw new Error("resume path changed");
    return { state: "stored", path };
  } catch {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        /* resume never owns the existing file */
      }
    }
    return { state: "rejected" };
  }
}

async function ensureDirectoryTree(
  directory: string,
  stateRoot: string,
  signal: AbortSignal | undefined,
  fsOps: OnboardDraftStoreFs,
): Promise<void> {
  const absolute = resolve(directory);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    if (aborted(signal)) throw new Error("cancelled");
    current = join(current, part);
    try {
      await fsOps.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    if (aborted(signal)) throw new Error("cancelled");
    const stat = await fsOps.lstat(current);
    if (aborted(signal)) throw new Error("cancelled");
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("redirected directory");
    if (
      isWithin(stateRoot, current) &&
      ((stat.mode & 0o022) !== 0 ||
        (process.getuid !== undefined && stat.uid !== process.getuid()))
    )
      throw new Error("unsafe storage directory");
  }
}

async function verifyCreatedPath(
  path: string,
  identity: CreatedFileIdentity,
  fsOps: OnboardDraftStoreFs,
): Promise<void> {
  const stat = await fsOps.lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    !privateMode(stat.mode) ||
    !sameIdentity(stat, identity)
  )
    throw new Error("artifact path changed");
}

async function removeCreatedFile(
  path: string,
  identity: CreatedFileIdentity,
  fsOps: OnboardDraftStoreFs,
): Promise<void> {
  try {
    const stat = await fsOps.lstat(path);
    if (stat.isFile() && !stat.isSymbolicLink() && sameIdentity(stat, identity))
      await fsOps.unlink(path);
  } catch {
    /* missing or replaced paths are untouched */
  }
}

function sameSafeFile(fd: Stats, path: Stats): boolean {
  return (
    fd.isFile() &&
    path.isFile() &&
    !path.isSymbolicLink() &&
    fd.nlink === 1 &&
    path.nlink === 1 &&
    privateMode(fd.mode) &&
    privateMode(path.mode) &&
    (process.getuid === undefined || fd.uid === process.getuid()) &&
    sameIdentity(fd, path)
  );
}

function sameIdentity(
  a: { dev: number; ino: number },
  b: { dev: number; ino: number },
): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function privateMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

function isWithin(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}
