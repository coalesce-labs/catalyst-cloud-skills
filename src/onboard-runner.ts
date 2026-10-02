import { spawn } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { loadConfig, normalizeBaseUrl, packageRoot, type Ctx } from "./config.js";
import { verifyOnboardRoutes } from "./onboard-capabilities.js";
import { liveTeamKey, onboardTeamAdmission } from "./onboard-capacity.js";
import {
  readExistingOnboardJson,
  selectedOnboardTeam,
} from "./onboard-existing.js";
import {
  onboardStateRoot,
  type OnboardAdapter,
  type OnboardJournal,
  type OnboardStep,
  type OnboardStepResult,
} from "./onboard.js";

// "Run Catalyst's work on this machine": the self-hosted host from catalyst-cloud's deploy/self-host
// (a supervisor and a deadline watchdog under Compose), enrolled with the person's own owner or
// admin login. Never the operator token, and setup never runs a registry login: an image the engine
// does not have is pulled with whatever the engine already trusts, or the step stops and names it.

/** The Compose project name the vendored file declares. */
export const RUNNER_PROJECT = "catalyst-host";
export const RUNNER_SESSION_NETWORK = "catalyst-session-v1";
/** Published by catalyst-cloud's supervisor-image workflow from main 0b5495e144 (run 36999325814). A
 * customer cannot list the private packages, so a release carries the pins; the CATALYST_SUPERVISOR_IMAGE
 * and CATALYST_WATCHDOG_IMAGE variables override them. */
export const RUNNER_HOST_IMAGES = {
  supervisor:
    "ghcr.io/coalesce-labs/catalyst-supervisor@sha256:fff1582e3ef763eae6728f195a8e3834383955ee03d39bcfe567f4a7361a8982",
  watchdog:
    "ghcr.io/coalesce-labs/catalyst-deadline-watchdog@sha256:b64e38f9ee34240d1e3d256e954eb8de20e2d3e51ed873019d350aa60be639c1",
} as const;
const IMAGE_REF = /^[a-z0-9][a-z0-9._:/-]{0,255}@sha256:[0-9a-f]{64}$/;
const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const JOIN_TOKEN = /^[A-Za-z0-9._~+/=-]{16,1024}$/;
const ENROLLMENTS = "/api/v1/hosts/enrollments";
const JOIN_TOKENS = "/api/v1/hosts/join-tokens";
const CAPACITY = "/api/v1/me/runner-capacity";
const RUNNER_UID = "10001:10001";
const DIRS = ["slots", "thoughts", "locks"] as const;

export interface RunnerEngineInfo {
  arch: "amd64" | "arm64";
  /** Docker Desktop or OrbStack: the engine runs in a VM, its socket is gid 0 and shared
   * directories keep the container's uid. */
  vm: boolean;
}
type VolumeFile = "CATALYST_ORG_KEY_FILE" | "CATALYST_HOST_CREDENTIAL_FILE";
/** Every Docker call the step makes. Each answers false or null instead of throwing. */
export interface RunnerEngine {
  /** Null when there is no docker command, no reachable Linux engine, or no Compose plugin. */
  info(signal?: AbortSignal): Promise<RunnerEngineInfo | null>;
  /** The architecture of a local image, or null when the engine does not have it. */
  imageArch(ref: string, signal?: AbortSignal): Promise<string | null>;
  pull(ref: string, signal?: AbortSignal): Promise<boolean>;
  network(
    name: string,
    signal?: AbortSignal,
  ): Promise<"ready" | "missing" | "misshaped">;
  createNetwork(name: string, signal?: AbortSignal): Promise<boolean>;
  socketGid(): Promise<number | null>;
  /** Native Linux only: hands the host directories to the runner uid through the supervisor image. */
  claimDirs(dir: string, paths: string[], signal?: AbortSignal): Promise<boolean>;
  hasVolumeFile(
    dir: string,
    variable: VolumeFile,
    signal?: AbortSignal,
  ): Promise<boolean>;
  writeVolumeFile(
    dir: string,
    variable: "CATALYST_ORG_KEY_FILE",
    value: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  composeUp(dir: string, signal?: AbortSignal): Promise<boolean>;
  composeRunning(dir: string, signal?: AbortSignal): Promise<boolean>;
}

export interface RunnerExecOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** Written to stdin: the only way a secret reaches a docker process. */
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export type RunnerExec = (
  args: string[],
  options: RunnerExecOptions,
) => Promise<{ code: number; stdout: string }>;

const spawnDocker: RunnerExec = (args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      env: options.env,
      cwd: options.cwd,
      signal: options.signal,
      timeout: options.timeoutMs ?? 30_000,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 1_000_000) stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
    child.stdin.end(options.input ?? "");
  });

/** The real engine, through the docker CLI. Compose reads `.env` only: the caller's CATALYST_ and
 * DOCKER_SOCKET_ variables are removed, because Compose prefers an exported value over the file. */
export function dockerRunnerEngine(
  deps: { exec?: RunnerExec; env?: NodeJS.ProcessEnv; socketPath?: string } = {},
): RunnerEngine {
  const exec = deps.exec ?? spawnDocker;
  const env = Object.fromEntries(
    Object.entries(deps.env ?? process.env).filter(
      ([key]) => !key.startsWith("CATALYST_") && !key.startsWith("DOCKER_SOCKET_"),
    ),
  );
  const docker = async (
    args: string[],
    options: Omit<RunnerExecOptions, "env"> = {},
  ): Promise<{ code: number; stdout: string }> => {
    try {
      return await exec(args, { env, ...options });
    } catch {
      return { code: 1, stdout: "" };
    }
  };
  const compose = (dir: string) => [
    "compose",
    "--project-name",
    RUNNER_PROJECT,
    "--file",
    join(dir, "compose.yaml"),
    "--env-file",
    join(dir, ".env"),
  ];
  const supervisorShell = (dir: string, script: string) => [
    ...compose(dir),
    "run",
    "--rm",
    "-T",
    "--no-deps",
    "--entrypoint",
    "sh",
    "supervisor",
    "-c",
    script,
  ];
  return {
    async info(signal) {
      const read = await docker(["info", "--format", "{{json .}}"], { signal });
      if (read.code !== 0) return null;
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(read.stdout) as Record<string, unknown>;
      } catch {
        return null;
      }
      const arches: Record<string, RunnerEngineInfo["arch"]> = {
        x86_64: "amd64",
        amd64: "amd64",
        aarch64: "arm64",
        arm64: "arm64",
      };
      const arch = arches[String(body.Architecture)];
      if (body.OSType !== "linux" || !arch) return null;
      if ((await docker(["compose", "version"], { signal })).code !== 0) return null;
      return { arch, vm: /docker desktop|orbstack/i.test(String(body.OperatingSystem)) };
    },
    async imageArch(ref, signal) {
      const read = await docker(
        ["image", "inspect", "--format", "{{.Architecture}}", ref],
        { signal },
      );
      return read.code === 0 ? read.stdout.trim() || null : null;
    },
    async pull(ref, signal) {
      return (
        (await docker(["pull", "--quiet", ref], { signal, timeoutMs: 900_000 })).code === 0
      );
    },
    async network(name, signal) {
      const read = await docker(["network", "inspect", name], { signal });
      if (read.code !== 0) return "missing";
      try {
        const [net] = JSON.parse(read.stdout) as Array<Record<string, unknown>>;
        const options = (net?.Options ?? {}) as Record<string, unknown>;
        const labels = (net?.Labels ?? {}) as Record<string, unknown>;
        return net?.Driver === "bridge" &&
          net.Internal !== true &&
          net.EnableIPv6 !== true &&
          options["com.docker.network.bridge.enable_icc"] === "false" &&
          options["com.docker.network.bridge.name"] === "catalyst-sess0" &&
          labels["dev.catalystcloud.session-network"] === "v1"
          ? "ready"
          : "misshaped";
      } catch {
        return "misshaped";
      }
    },
    async createNetwork(name, signal) {
      const args = [
        "network",
        "create",
        "--driver=bridge",
        "--opt",
        "com.docker.network.bridge.enable_icc=false",
        "--opt",
        "com.docker.network.bridge.name=catalyst-sess0",
        "--label",
        "dev.catalystcloud.session-network=v1",
        name,
      ];
      return (await docker(args, { signal })).code === 0;
    },
    async socketGid() {
      try {
        return statSync(deps.socketPath ?? "/var/run/docker.sock").gid;
      } catch {
        return null;
      }
    },
    async claimDirs(dir, paths, signal) {
      const args = [
        ...compose(dir),
        "run",
        "--rm",
        "-T",
        "--no-deps",
        "--user",
        "0",
        // The service drops every capability; root needs CHOWN back to hand over a folder.
        "--cap-add",
        "CHOWN",
        "--entrypoint",
        "chown",
        "supervisor",
        RUNNER_UID,
        ...paths,
      ];
      return (await docker(args, { cwd: dir, signal, timeoutMs: 120_000 })).code === 0;
    },
    async hasVolumeFile(dir, variable, signal) {
      return (
        (
          await docker(supervisorShell(dir, `test -s "$${variable}"`), {
            cwd: dir,
            signal,
            timeoutMs: 120_000,
          })
        ).code === 0
      );
    },
    async writeVolumeFile(dir, variable, value, signal) {
      if (variable !== "CATALYST_ORG_KEY_FILE") return false;
      const script = `umask 077 && cat > "$${variable}" && test -s "$${variable}"`;
      return (
        (
          await docker(supervisorShell(dir, script), {
            cwd: dir,
            input: `${value}\n`,
            signal,
            timeoutMs: 120_000,
          })
        ).code === 0
      );
    },
    async composeUp(dir, signal) {
      return (
        (await docker([...compose(dir), "up", "--detach"], { cwd: dir, signal, timeoutMs: 600_000 }))
          .code === 0
      );
    },
    async composeRunning(dir, signal) {
      const read = await docker(
        [...compose(dir), "ps", "--status", "running", "--services"],
        { cwd: dir, signal },
      );
      return read.code === 0 && read.stdout.split("\n").some((line) => line.trim() === "supervisor");
    },
  };
}

interface ListedHost {
  hostId: string;
  hostName: string;
  revoked: boolean;
  capacity: number | null;
  failing: string[];
}
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const waiting = (
  reason: string,
  evidence?: OnboardStep["evidence"],
): OnboardStepResult => ({ state: "waiting", reason, ...(evidence ? { evidence } : {}) });

function parseHosts(body: unknown): ListedHost[] | null {
  const hosts = object(body)?.hosts;
  if (!Array.isArray(hosts) || hosts.length > 1_000) return null;
  const parsed: ListedHost[] = [];
  for (const value of hosts) {
    const host = object(value);
    const capability = host?.capability === null ? null : object(host?.capability);
    if (
      !host ||
      typeof host.hostId !== "string" ||
      typeof host.hostName !== "string" ||
      !(host.revokedAtMs === null || typeof host.revokedAtMs === "number") ||
      (host.capability !== null &&
        (!capability ||
          !Number.isSafeInteger(capability.placeableCapacity) ||
          !Array.isArray(capability.failingRequired) ||
          !capability.failingRequired.every((id) => typeof id === "string")))
    )
      return null;
    parsed.push({
      hostId: host.hostId,
      hostName: host.hostName,
      revoked: host.revokedAtMs !== null,
      capacity: capability ? (capability.placeableCapacity as number) : null,
      failing: capability ? (capability.failingRequired as string[]) : [],
    });
  }
  return parsed;
}

/** `KEY=value` lines; a single-quoted value is unquoted. Anything else is ignored. */
function readEnvFile(path: string): Record<string, string> | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const raw = match[2]!;
    values[match[1]!] = /^'[^']*'$/.test(raw) ? raw.slice(1, -1) : raw;
  }
  return values;
}

function renderEnv(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => {
      if (/[\n\r']/.test(value)) throw new Error("runner_env_value_invalid");
      return `${key}=${/^[A-Za-z0-9._:/@+=,-]*$/.test(value) ? value : `'${value}'`}\n`;
    })
    .join("");
}

function writePrivate(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

/** Enrollment is matched by name across the account, so two machines with one hostname must not
 * share it: a random suffix, kept in `.env` from the first write on. */
export function runnerDefaultHostName(): string {
  const suffix = randomBytes(3).toString("hex");
  const base = `catalyst-${hostname().split(".")[0] ?? "host"}`
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .slice(0, 55);
  const name = `${base}-${suffix}`;
  return HOST_NAME.test(name) ? name : `catalyst-host-${suffix}`;
}

export interface OnboardRunnerInput {
  /** `--runner` (true) or `--no-runner` (false); undefined asks, or skips without a terminal. */
  selected?: boolean;
  /** The terminal question; null is a cancelled answer. */
  choose?: () => Promise<boolean | null>;
  engine?: RunnerEngine;
  hostName?: () => string;
  message?: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** How long a check waits for the host to enroll and advertise. */
  waitMs?: number;
  pollMs?: number;
}

interface Prepared {
  account: string;
  baseUrl: string;
  teamKey: string;
  dir: string;
  info: RunnerEngineInfo;
  images: { supervisor: string; watchdog: string; runner: string };
}

export function onboardRunnerAdapter(input: OnboardRunnerInput = {}): OnboardAdapter {
  const engine = input.engine ?? dockerRunnerEngine();
  const sleep =
    input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const waitMs = input.waitMs ?? 120_000;
  const pollMs = input.pollMs ?? 5_000;
  // One question per run: the engine checks again after acting, and the receipt row is "running"
  // in between, so the answer lives here too.
  let decided: boolean | null | undefined;
  // Only `--runner` or a yes in this run starts or repairs the runner. A yes saved by an earlier run
  // only reports on it, so an unattended check never restarts a runner the person stopped.
  let mayAct = false;
  let acted = false;
  const selected = { selected: true };

  async function decide(journal: OnboardJournal): Promise<boolean | null> {
    if (decided !== undefined) return decided;
    if (input.selected !== undefined) {
      mayAct = input.selected;
      return (decided = input.selected);
    }
    const prior = journal.steps.find((step) => step.id === "runner")?.evidence?.selected;
    if (typeof prior === "boolean") return (decided = prior);
    if (input.choose) {
      mayAct = (await input.choose()) === true;
      return (decided = mayAct);
    }
    return (decided = null);
  }

  /** Everything both check and act need, verified before any local change. */
  async function prepare(
    ctx: Ctx,
    journal: OnboardJournal,
    signal?: AbortSignal,
  ): Promise<Prepared | OnboardStepResult> {
    const choice = await decide(journal);
    if (choice !== true)
      return {
        state: "skipped",
        reason: "runner_not_selected",
        ...(choice === false ? { evidence: { selected: false } } : {}),
      };
    const info = await engine.info(signal);
    if (!info) return { state: "skipped", reason: "runner_docker_missing", evidence: selected };
    const cfg = loadConfig(ctx.home);
    const account = journal.account ?? journal.tenant;
    if (
      !cfg?.user ||
      !["owner", "admin"].includes(cfg.user.role) ||
      !account ||
      cfg.account !== account ||
      cfg.user.id !== journal.membershipId ||
      !journal.baseUrl ||
      normalizeBaseUrl(cfg.baseUrl) !== normalizeBaseUrl(journal.baseUrl)
    )
      return waiting("runner_identity_unverified", selected);
    const support = await verifyOnboardRoutes(
      ctx,
      journal,
      [
        { method: "GET", path: ENROLLMENTS },
        { method: "POST", path: JOIN_TOKENS },
        { method: "GET", path: CAPACITY },
      ],
      signal,
    );
    if ("reason" in support) return waiting(support.reason, selected);
    const teamId = selectedOnboardTeam(journal);
    const teamKey = teamId ? await liveTeamKey(ctx, teamId, signal ?? new AbortController().signal) : null;
    if (!teamKey) return waiting("runner_context_unverified", selected);
    let state: string;
    try {
      state = onboardStateRoot(ctx.home, ctx.env);
    } catch {
      return waiting("runner_directory_unavailable", selected);
    }
    const dir = join(state, "runner");
    const saved = readEnvFile(join(dir, ".env"));
    const images = {
      supervisor: ctx.env.CATALYST_SUPERVISOR_IMAGE ?? RUNNER_HOST_IMAGES.supervisor,
      watchdog: ctx.env.CATALYST_WATCHDOG_IMAGE ?? RUNNER_HOST_IMAGES.watchdog,
      runner: ctx.env.CATALYST_RUNNER_IMAGE ?? saved?.CATALYST_RUNNER_IMAGE ?? "",
    };
    if (!Object.values(images).every((ref) => IMAGE_REF.test(ref)))
      return waiting("runner_image_unpinned", selected);
    return { account, baseUrl: normalizeBaseUrl(cfg.baseUrl), teamKey, dir, info, images };
  }

  async function desiredEnv(
    p: Prepared,
    joinToken?: string,
  ): Promise<Record<string, string> | null> {
    const saved = readEnvFile(join(p.dir, ".env")) ?? {};
    const name = saved.CATALYST_HOST_NAME || (input.hostName ?? runnerDefaultHostName)();
    const gid = p.info.vm ? 0 : await engine.socketGid();
    if (!HOST_NAME.test(name) || gid === null) return null;
    return {
      DOCKER_SOCKET_PATH: "/var/run/docker.sock",
      DOCKER_SOCKET_GID: String(gid),
      CATALYST_WATCHDOG_IMAGE: p.images.watchdog,
      CATALYST_SUPERVISOR_IMAGE: p.images.supervisor,
      CATALYST_MIRROR_URL: p.baseUrl,
      CATALYST_HOST_NAME: name,
      CATALYST_HOST_JOIN_TOKEN: joinToken ?? saved.CATALYST_HOST_JOIN_TOKEN ?? "",
      CATALYST_RUNNER_IMAGE: p.images.runner,
      CATALYST_SLOTS_DIR: join(p.dir, "slots"),
      CATALYST_THOUGHTS_DIR: join(p.dir, "thoughts"),
      CATALYST_POOL_LOCK_DIR: join(p.dir, "locks"),
      CATALYST_SESSION_EGRESS_DIR: join(p.dir, "session-egress"),
    };
  }
  /** The step owns its own keys only; a person's tuning (CATALYST_SLOTS and the rest) is kept. */
  const merged = (saved: Record<string, string> | null, want: Record<string, string>) => ({
    ...want,
    ...Object.fromEntries(Object.entries(saved ?? {}).filter(([key]) => !(key in want))),
  });

  async function listHosts(
    ctx: Ctx,
    p: Prepared,
    signal?: AbortSignal,
  ): Promise<ListedHost[] | null> {
    const read = await readExistingOnboardJson(
      ctx,
      `${ENROLLMENTS}?account=${encodeURIComponent(p.account)}`,
      signal,
    );
    return "reason" in read ? null : parseHosts(read.body);
  }

  async function mintJoinToken(
    ctx: Ctx,
    p: Prepared,
    hostName: string,
    signal?: AbortSignal,
  ): Promise<string | OnboardStepResult> {
    const cfg = loadConfig(ctx.home);
    const expiry = cfg?.auth ? Date.parse(cfg.auth.expiresAt) - ctx.now().getTime() : 0;
    const bearer =
      cfg?.key ||
      (cfg?.auth && Number.isFinite(expiry) && expiry > 30_000 ? cfg.auth.accessToken : undefined);
    if (!bearer) return waiting("runner_login_refresh_required", selected);
    try {
      const response = await ctx.fetch(
        `${p.baseUrl}${JOIN_TOKENS}?account=${encodeURIComponent(p.account)}`,
        {
          method: "POST",
          redirect: "error",
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
          headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            version: 1,
            team: p.teamKey,
            enrollmentKind: "self_hosted",
            hostName,
            ttlMs: 3_600_000,
          }),
        },
      );
      const body = object(await response.json().catch(() => null));
      if (body?.refusal === "not_tenant_admin") return waiting("runner_identity_unverified", selected);
      if (response.status !== 201 || body?.ok !== true || typeof body.joinToken !== "string" || !JOIN_TOKEN.test(body.joinToken))
        return waiting("runner_join_token_unavailable", selected);
      return body.joinToken;
    } catch {
      return waiting(signal?.aborted ? "interrupted" : "runner_join_token_unavailable", selected);
    }
  }

  function orgKeyFromFile(ctx: Ctx): string | null | undefined {
    const path = ctx.env.CATALYST_RUNNER_ORG_KEY_FILE;
    if (!path) return undefined;
    try {
      if (!lstatSync(path).isFile()) return null;
      const lines = readFileSync(path, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
      return lines.length === 1 && /^[\x21-\x7e]{16,1024}$/.test(lines[0]!) ? lines[0]! : null;
    } catch {
      return null;
    }
  }

  return {
    check: async (ctx, journal, signal) => {
      // Only the check right after this run's own act waits for the host to appear.
      const afterAct = acted;
      acted = false;
      const p = await prepare(ctx, journal, signal);
      if (!("dir" in p)) return p;
      const saved = readEnvFile(join(p.dir, ".env"));
      const want = await desiredEnv(p);
      if (!want) return waiting("runner_docker_socket_unreadable", selected);
      const name = want.CATALYST_HOST_NAME!;
      const live = (hosts: ListedHost[] | null) =>
        hosts?.find((host) => host.hostName === name && !host.revoked);
      let hosts = await listHosts(ctx, p, signal);
      if (!hosts) return waiting("runner_enrollment_unavailable", selected);
      const running = await engine.composeRunning(p.dir, signal);
      const changed = !saved || Object.entries(want).some(([key, value]) => saved[key] !== value);
      const hostEvidence = { ...selected, hostName: name };
      const pending = (): OnboardStepResult =>
        mayAct ? { state: "pending" } : waiting("runner_needs_runner_flag", hostEvidence);
      if (!running || changed)
        return afterAct ? waiting("runner_compose_not_running", hostEvidence) : pending();
      // The supervisor enrolls on its first start and advertises shortly after.
      for (let attempt = 1; ; attempt++) {
        const host = live(hosts);
        if (host && host.capacity !== null) break;
        if (!host && !afterAct) return pending();
        if (attempt >= Math.max(1, Math.ceil(waitMs / pollMs)) || signal?.aborted)
          return waiting(host ? "runner_capability_pending" : "runner_enrollment_unverified", hostEvidence);
        await sleep(pollMs);
        hosts = await listHosts(ctx, p, signal);
        if (!hosts) return waiting("runner_enrollment_unavailable", hostEvidence);
      }
      const host = live(hosts)!;
      const evidence = { ...hostEvidence, hostId: host.hostId, capacity: host.capacity! };
      if (!(await engine.hasVolumeFile(p.dir, "CATALYST_ORG_KEY_FILE", signal))) {
        const orgKey = orgKeyFromFile(ctx);
        if (orgKey === null) return waiting("runner_org_key_file_invalid", evidence);
        return orgKey && !afterAct ? pending() : waiting("runner_org_key_missing", evidence);
      }
      if (host.capacity === 0 || host.failing.length > 0)
        return waiting("runner_host_not_ready", { ...evidence, failing: host.failing.join(",") });
      const admission = await onboardTeamAdmission(ctx, p.teamKey, signal);
      if (admission !== true)
        return waiting(admission === false ? "runner_admission_operator" : "runner_admission_unverified", evidence);
      input.message?.(
        `This machine runs Catalyst's work as host ${name}, with ${host.capacity} slots free.`,
      );
      return { state: "done", evidence };
    },
    act: async (ctx, journal, signal) => {
      const p = await prepare(ctx, journal, signal);
      if (!("dir" in p)) return p;
      for (const ref of Object.values(p.images)) {
        if (!(await engine.imageArch(ref, signal))) await engine.pull(ref, signal);
        const arch = await engine.imageArch(ref, signal);
        if (!arch) return waiting("runner_images_unavailable", { ...selected, image: ref });
        if (arch !== p.info.arch) return waiting("runner_image_emulated", { ...selected, image: ref });
      }
      const network = await engine.network(RUNNER_SESSION_NETWORK, signal);
      if (network === "misshaped") return waiting("runner_session_network_misshaped", selected);
      if (network === "missing" && !(await engine.createNetwork(RUNNER_SESSION_NETWORK, signal)))
        return { state: "failed", reason: "runner_session_network_failed", evidence: selected };
      try {
        mkdirSync(p.dir, { recursive: true, mode: 0o700 });
        if (lstatSync(p.dir).isSymbolicLink()) throw new Error("runner_directory_unsafe");
        chmodSync(p.dir, 0o700);
        for (const sub of DIRS) {
          mkdirSync(join(p.dir, sub), { recursive: true, mode: 0o700 });
          // On native Linux the runner uid owns these after the first run; leave them alone.
          if (statSync(join(p.dir, sub)).uid === process.getuid?.()) chmodSync(join(p.dir, sub), 0o700);
        }
        // Mounted read-only into the supervisor (uid 10001), which reads the egress attestation.
        mkdirSync(join(p.dir, "session-egress"), { recursive: true, mode: 0o755 });
        const compose = readFileSync(join(packageRoot(), "vendor", "self-host", "compose.yaml"));
        let current: Buffer | null = null;
        try {
          current = readFileSync(join(p.dir, "compose.yaml"));
        } catch {
          /* first run */
        }
        if (!current?.equals(compose)) writeFileSync(join(p.dir, "compose.yaml"), compose, { mode: 0o644 });
      } catch {
        return { state: "failed", reason: "runner_directory_unavailable", evidence: selected };
      }
      let want = await desiredEnv(p);
      if (!want) return waiting("runner_docker_socket_unreadable", selected);
      const writeEnv = (values: Record<string, string>): boolean => {
        try {
          const saved = readEnvFile(join(p.dir, ".env"));
          if (saved && Object.entries(values).every(([key, value]) => saved[key] === value))
            return true;
          writePrivate(join(p.dir, ".env"), renderEnv(merged(saved, values)));
          return true;
        } catch {
          return false;
        }
      };
      if (!writeEnv(want))
        return { state: "failed", reason: "runner_directory_unavailable", evidence: selected };
      if (!p.info.vm && !(await engine.claimDirs(p.dir, DIRS.map((sub) => join(p.dir, sub)), signal)))
        return { state: "failed", reason: "runner_directory_unavailable", evidence: selected };
      const name = want.CATALYST_HOST_NAME!;
      const hosts = await listHosts(ctx, p, signal);
      if (!hosts) return waiting("runner_enrollment_unavailable", selected);
      if (!hosts.some((host) => host.hostName === name && !host.revoked)) {
        // A credential for a revoked enrollment would be used before any new token; replacing it
        // also drops the organization key beside it, so that is the person's call, not this step's.
        if (await engine.hasVolumeFile(p.dir, "CATALYST_HOST_CREDENTIAL_FILE", signal))
          return waiting("runner_enrollment_stale", { ...selected, hostName: name });
        const token = await mintJoinToken(ctx, p, name, signal);
        if (typeof token !== "string") return token;
        want = (await desiredEnv(p, token))!;
        if (!writeEnv(want))
          return { state: "failed", reason: "runner_directory_unavailable", evidence: selected };
      }
      const orgKey = orgKeyFromFile(ctx);
      if (orgKey === null) return waiting("runner_org_key_file_invalid", selected);
      if (orgKey && !(await engine.hasVolumeFile(p.dir, "CATALYST_ORG_KEY_FILE", signal)))
        if (!(await engine.writeVolumeFile(p.dir, "CATALYST_ORG_KEY_FILE", orgKey, signal)))
          return { state: "failed", reason: "runner_org_key_write_failed", evidence: selected };
      if (!(await engine.composeUp(p.dir, signal)))
        return { state: "failed", reason: "runner_compose_failed", evidence: selected };
      acted = true;
      return { state: "done" };
    },
  };
}
