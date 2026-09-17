// runtime-store.ts — CTC-2158, Tier 2. The pinned runtime this CLI manages itself.
//
// WHY THIS AND NOT A POSTINSTALL. A postinstall download is skipped by `--ignore-scripts` (which is
// how this very container's own install ran: `bun install --frozen-lockfile --ignore-scripts`), is
// skipped entirely by `npx`, and fetches-and-executes a binary the customer never asked for. This is
// one explicit command instead — the command every unsupported-runtime message prints — and it never
// touches the machine's default Node.
//
// The checksum is verified BEFORE anything is unpacked. `.tar.gz`, never `.tar.xz`: `tar -xzf` works
// everywhere including macOS bsdtar, which cannot be assumed to carry liblzma.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { CliError } from "./errors.js";

export interface Tarball {
  file: string;
  url: string;
  shasums: string;
}

const PLATFORM_ARCH: Record<string, readonly string[]> = {
  darwin: ["arm64", "x64"],
  linux: ["x64", "arm64"],
};

/** Map a version/platform/arch onto a real nodejs.org `.tar.gz` name. win32 refuses by name — Windows
 *  needs `.zip` extraction, a separate mechanism this ticket does not build (D7). */
export function tarballFor(version: string, platform: string, arch: string): Tarball {
  if (platform === "win32") {
    throw new CliError(
      "catalyst-skills runtime install does not support Windows yet — supported: darwin (arm64, x64) and linux (x64, arm64). Use whatever Node 22.15+ or bun 1.4+ you already have on Windows.",
      "runtime-unsupported-platform",
    );
  }
  const arches = PLATFORM_ARCH[platform];
  if (!arches || !arches.includes(arch)) {
    throw new CliError(`catalyst-skills runtime install does not support ${platform}/${arch} — supported: darwin (arm64, x64) and linux (x64, arm64)`, "runtime-unsupported-platform");
  }
  const file = `node-v${version}-${platform}-${arch}.tar.gz`;
  return { file, url: `https://nodejs.org/dist/v${version}/${file}`, shasums: `https://nodejs.org/dist/v${version}/SHASUMS256.txt` };
}

/** Pick our file's line out of a real SHASUMS256.txt body. A missing line is a named error — never a
 *  skipped verification. */
export function shasumFor(shasumsBody: string, file: string): string {
  for (const line of shasumsBody.split("\n")) {
    const [sum, name] = line.trim().split(/\s+/);
    if (name === file && sum) return sum;
  }
  throw new CliError(`no line for ${file} in SHASUMS256.txt — refusing to install without a checksum to verify against`, "runtime-checksum-missing");
}

export function runtimesDir(home: string): string {
  return join(home, ".cache", "catalyst-cloud", "catalyst-skills", "runtimes");
}
export function pinPath(home: string): string {
  return join(runtimesDir(home), "pin.json");
}
export function pinnedNodePath(home: string, version: string, platform: string, arch: string): string {
  return join(runtimesDir(home), `node-v${version}-${platform}-${arch}`, "bin", platform === "win32" ? "node.exe" : "node");
}

export interface Pin {
  version: string;
  nodePath: string;
}

export function readPin(home: string): Pin | null {
  const p = pinPath(home);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Pin;
  } catch {
    return null;
  }
}

function writePin(home: string, pin: Pin): void {
  mkdirSync(runtimesDir(home), { recursive: true });
  writeFileSync(pinPath(home), JSON.stringify(pin, null, 2) + "\n", { mode: 0o600 });
}

export interface InstallOptions {
  home: string;
  version: string;
  platform: string;
  arch: string;
  /** Seam: fetch SHASUMS256.txt. Defaults to a real `fetch`. */
  fetchText?: (url: string) => Promise<string>;
  /** Seam: fetch the tarball's bytes. Defaults to a real `fetch`. */
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  /** Seam: unpack the tarball. Defaults to `tar -xzf ... --strip-components=1`. */
  extract?: (tarPath: string, dest: string) => Promise<void>;
}

export interface InstallResult {
  version: string;
  nodePath: string;
  alreadyPresent: boolean;
}

async function defaultFetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new CliError(`GET ${url} -> ${res.status}`, "runtime-fetch-failed");
  return res.text();
}
async function defaultFetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new CliError(`GET ${url} -> ${res.status}`, "runtime-fetch-failed");
  return new Uint8Array(await res.arrayBuffer());
}
async function defaultExtract(tarPath: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true });
  const res = spawnSync("tar", ["-xzf", tarPath, "-C", dest, "--strip-components=1"]);
  if (res.status !== 0) {
    throw new CliError(`tar -xzf ${tarPath} failed: ${res.stderr?.toString().trim() || `exit ${String(res.status)}`}`, "runtime-extract-failed");
  }
}

/** Download the pinned Node, verify it against that release's own SHASUMS256.txt, and unpack it
 *  under the CLI's own cache. Refuses (never unpacks) on a checksum mismatch. Re-installing a
 *  version already present short-circuits without touching the network. */
export async function installPinnedRuntime(o: InstallOptions): Promise<InstallResult> {
  const tb = tarballFor(o.version, o.platform, o.arch);
  const nodePath = pinnedNodePath(o.home, o.version, o.platform, o.arch);
  const existing = readPin(o.home);
  if (existing?.version === o.version && existsSync(nodePath)) {
    return { version: o.version, nodePath, alreadyPresent: true };
  }

  const fetchText = o.fetchText ?? defaultFetchText;
  const fetchBytes = o.fetchBytes ?? defaultFetchBytes;
  const extract = o.extract ?? defaultExtract;

  const shasumsBody = await fetchText(tb.shasums);
  const want = shasumFor(shasumsBody, tb.file);
  const bytes = await fetchBytes(tb.url);
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== want) {
    throw new CliError(`checksum mismatch for ${tb.file}: expected ${want}, got ${got} — refusing to unpack`, "runtime-checksum-mismatch");
  }

  const tmpDir = join(runtimesDir(o.home), ".tmp");
  mkdirSync(tmpDir, { recursive: true });
  const tmpTar = join(tmpDir, tb.file);
  writeFileSync(tmpTar, bytes);
  const dest = join(runtimesDir(o.home), `node-v${o.version}-${o.platform}-${o.arch}`);
  try {
    await extract(tmpTar, dest);
  } finally {
    rmSync(tmpTar, { force: true });
  }

  if (!existsSync(nodePath)) {
    throw new CliError(`extraction did not produce ${nodePath} — the tarball's layout may have changed`, "runtime-extract-failed");
  }
  try {
    chmodSync(nodePath, 0o755);
  } catch {
    // best-effort: platforms without exec bits (e.g. a fake in tests) still count as installed
  }
  writePin(o.home, { version: o.version, nodePath });
  return { version: o.version, nodePath, alreadyPresent: false };
}

export function uninstallPinnedRuntime(home: string): boolean {
  const pin = readPin(home);
  if (!pin) return false;
  rmSync(runtimesDir(home), { recursive: true, force: true });
  return true;
}
