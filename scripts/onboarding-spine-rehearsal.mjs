#!/usr/bin/env node
// Offline partial C1 controls. This does not exercise live OAuth or prove a milestone.
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = value => createHash("sha256").update(value).digest("hex");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

function argumentsFor(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== "--artifact-dir" && flag !== "--cli") throw Error("use --artifact-dir <absolute path> [--cli <built launcher path>]");
    if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw Error(`missing value for ${flag}`);
    if (options[flag]) throw Error(`duplicate ${flag}`);
    options[flag] = argv[++i];
  }
  if (!options["--artifact-dir"] || !isAbsolute(options["--artifact-dir"])) throw Error("--artifact-dir must be an absolute path");
  return { artifactDir: resolve(options["--artifact-dir"]), cli: resolve(options["--cli"] ?? join(root, "bin/catalyst.js")) };
}

function filesWithin(folder) {
  const rows = [];
  function visit(current) {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stat = lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(path);
      else rows.push(relative(folder, path));
    }
  }
  visit(folder);
  return rows;
}

function safeJson(value) {
  let safe = true;
  function visit(item) {
    if (typeof item === "string" && (/\bBearer\s+\S+|\bctc_(?:user|acct)_\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(item) || /https?:\/\/[^\s/]+@/.test(item))) safe = false;
    if (Array.isArray(item)) item.forEach(visit);
    else if (object(item)) for (const [key, entry] of Object.entries(item)) {
      if (/^(?:token|accessToken|refreshToken|password|secret|apiKey|authorization|cookie|cookies)$/i.test(key)) safe = false;
      visit(entry);
    }
  }
  visit(value);
  return safe;
}

function source() {
  const git = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin" } });
  const status = spawnSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin" } });
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return { version: manifest.version, gitSHA: git.status === 0 && /^[a-f0-9]{40}$/.test(git.stdout.trim()) ? git.stdout.trim() : null,
    dirtyTrackedSource: status.status === 0 ? Boolean(status.stdout.trim()) : null };
}

function writePrivate(path, body) {
  writeFileSync(path, body, { mode: 0o600, flag: "wx" });
}

function runHarness(options) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const runId = randomUUID();
  const runDir = join(options.artifactDir, "runs", runId);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const realHome = realpathSync(userInfo().homedir);
  const dryHome = join(runDir, "dry-home");
  const legacyHome = join(runDir, "legacy-home");
  for (const home of [dryHome, legacyHome]) {
    mkdirSync(home, { mode: 0o700 });
    if (realpathSync(home) === realHome) throw Error("refusing to use the real home as a rehearsal fixture");
  }
  const networkLog = join(runDir, "network-attempts.jsonl");
  const guard = join(runDir, "offline-guard.cjs");
  // Block Node network entrypoints before the built CLI loads; an attempted request fails the run.
  // Record only the transport name, never its URL, arguments or credential headers.
  writePrivate(guard, `
const fs = require("node:fs");
function deny(transport) { fs.appendFileSync(process.env.CATALYST_REHEARSAL_NETWORK_LOG, JSON.stringify({transport}) + "\\n", {mode:0o600}); throw Error("offline rehearsal blocked network"); }
globalThis.fetch = () => deny("fetch");
for (const name of ["http", "https"]) { const m = require("node:" + name); m.request = () => deny(name); m.get = () => deny(name); }
const net = require("node:net"); net.connect = net.createConnection = () => deny("net"); net.Socket.prototype.connect = () => deny("socket");
const tls = require("node:tls"); tls.connect = () => deny("tls");
const { syncBuiltinESMExports } = require("node:module"); syncBuiltinESMExports();
`);
  const results = [];
  function runControl(id, home, args, verify) {
    const checks = [];
    const check = (name, pass) => checks.push({ name, pass: Boolean(pass) });
    const environment = {
      HOME: home, CATALYST_SKILLS_HOME: home,
      XDG_STATE_HOME: join(home, ".local/state"), XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"), CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CATALYST_SKILLS_RUNTIME: "ambient", PATH: [...new Set([dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":"),
      NODE_OPTIONS: `--require=${JSON.stringify(guard)}`, CATALYST_REHEARSAL_NETWORK_LOG: networkLog,
    };
    // Only public cloud selection is copied. No token, config, browser session or agent env is inherited.
    for (const key of ["CATALYST_CLOUD_BASE_URL", "CATALYST_CLOUD_ACCOUNT"]) {
      if (process.env[key]) environment[key] = process.env[key];
    }
    const started = performance.now();
    const child = spawnSync(process.execPath, [options.cli, ...args], {
      cwd: home, env: environment, encoding: "utf8", input: "", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    });
    let parsed = null;
    try { parsed = JSON.parse(child.stdout ?? ""); } catch { /* one valid object is an explicit control */ }
    check("subprocess exit zero", child.status === 0 && !child.error && child.signal === null);
    check("stdout contains exactly one JSON object", object(parsed));
    check("JSON contains no credential fields or recognized credential values", object(parsed) && safeJson(parsed));
    try { verify(parsed, check); } catch { check("control verification completed", false); }
    const stderr = child.stderr ?? "";
    results.push({ id, command: { executable: process.execPath, arguments: [options.cli, ...args] },
      elapsedMs: Math.round(performance.now() - started), exitCode: child.status, signal: child.signal,
      failure: child.error ? (child.error.code === "ETIMEDOUT" ? "timeout" : "subprocess_error") : null,
      stdoutJson: object(parsed) && safeJson(parsed) ? parsed : null,
      // Raw stderr/stdout are deliberately not retained, including on parse or loader failure.
      stdout: { bytes: Buffer.byteLength(child.stdout ?? ""), sha256: hash(child.stdout ?? "") },
      stderr: { bytes: Buffer.byteLength(stderr), sha256: hash(stderr), retained: false }, checks,
      passed: checks.every(row => row.pass), fixtureHome: relative(runDir, home) });
  }

  runControl("fresh_home_dry_run", dryHome, ["onboard", "--dry-run", "--json"], (json, check) => {
    check("dry run is an incomplete plan", json?.schema === 1 && json?.mode === "plan" && json?.complete === false);
    check("dry HOME remains empty", readdirSync(dryHome).length === 0);
    check("no dry-run receipt", !existsSync(join(dryHome, ".local/state/catalyst/install/last-run.json")));
    check("no dry-run lock", !existsSync(join(dryHome, ".local/state/catalyst/install.lock")));
  });

  const fixtureBody = "offline rehearsal legacy fixture; keep this file\n";
  const fixtures = ["Library/LaunchAgents/com.catalyst.agent.plist", ".config/systemd/user/catalyst.service", ".catalyst/fixture-data"];
  for (const path of fixtures) {
    const target = join(legacyHome, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writePrivate(target, fixtureBody);
  }
  runControl("fake_home_legacy_report_only", legacyHome, ["onboard", "--only", "legacy", "--yes", "--json"], (json, check) => {
    check("only scope succeeds without completing onboarding", json?.schema === 1 && json?.scope === "step" && json?.complete === false && json?.exit === 0);
    const legacy = json?.steps?.find(step => step.id === "legacy");
    check("fake HOME legacy cleanup is report only", legacy?.state === "skipped" && legacy?.reason === "fake_home_report_only");
    check("legacy fixtures positively detected", legacy?.evidence?.found > 0);
    check("legacy plist, service and data retained", fixtures.every(path => existsSync(join(legacyHome, path)) && readFileSync(join(legacyHome, path), "utf8") === fixtureBody));
    const receipt = join(legacyHome, ".local/state/catalyst/install/last-run.json");
    check("saved receipt matches stdout object", existsSync(receipt) && JSON.stringify(JSON.parse(readFileSync(receipt, "utf8"))) === JSON.stringify(json));
    check("lock released after scoped run", !existsSync(join(legacyHome, ".local/state/catalyst/install.lock")));
  });
  const networkAttempts = existsSync(networkLog) ? readFileSync(networkLog, "utf8").trim().split("\n").filter(Boolean).length : 0;
  const passed = results.every(result => result.passed) && networkAttempts === 0;
  const report = {
    schema: "catalyst-onboarding-spine-rehearsal/1", runId, scope: "offline-spine", milestoneComplete: false,
    source: { ...source(), cliPath: options.cli, cliLauncherSHA256: existsSync(options.cli) ? hash(readFileSync(options.cli)) : null },
    startedAt,
    finishedAt: new Date().toISOString(), commandsTyped: 1, cliInvocations: results.length,
    browserTabs: 0, consents: 0, questions: 0, durationMs: Math.round(performance.now() - started),
    countsBasis: "One harness command; two automated CLI controls; no live provider steps.",
    networkAttempts, passed, results,
    untested: ["live sign-in and OAuth consents", "bootstrap exec handoff", "interrupted resume", "project setup", "fresh phase.started event"],
  };
  const reportPath = join(options.artifactDir, "runs", `${runId}.json`);
  writePrivate(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ runId, scope: report.scope, milestoneComplete: false, passed, artifact: reportPath })}\n`);
  return passed ? 0 : 1;
}

try {
  process.exitCode = runHarness(argumentsFor(process.argv.slice(2)));
} catch {
  // Error text may include environment values from a loader. Never copy it into an artifact.
  process.stderr.write("Offline spine rehearsal could not run. Check arguments, built CLI and artifact directory.\n");
  process.exitCode = 1;
}
