#!/usr/bin/env node
// lib/cli.mjs — the one way a skill script reaches Catalyst Cloud: it spawns the catalyst-skills CLI
// this machine connected with (the path recorded in customer.json, else npx) and hands back its
// output. Scripts import it; a person runs it with --help to see what it does. No dependencies.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const PACKAGE = "@catalyst-cloud/catalyst-skills";
export const CONNECT_HINT = `CATALYST_CLOUD_TOKEN=<account key> npx ${PACKAGE} login`;

/** ~/.config/catalyst-cloud/customer.json, honouring CATALYST_SKILLS_HOME (used by tests) over HOME. */
export function configPath() {
  const home = process.env.CATALYST_SKILLS_HOME ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
  return join(home, ".config", "catalyst-cloud", "customer.json");
}

/** The config, or a one-line reason it could not be read. Never throws. */
export function loadConfig() {
  const path = configPath();
  if (!existsSync(path)) return { ok: false, reason: `no config at ${path}` };
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    if (!cfg || typeof cfg.key !== "string" || typeof cfg.account !== "string") {
      return { ok: false, reason: `${path} is missing the key or account` };
    }
    return { ok: true, cfg, path };
  } catch (err) {
    return { ok: false, reason: `${path} is unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Exit 2 with the one line every script prints when this machine is not connected to a tenant. */
export function notConfigured(reason) {
  console.error(`not connected to a Catalyst Cloud tenant (${reason}) — run: ${CONNECT_HINT}`);
  process.exit(2);
}

/**
 * Run one catalyst-skills verb. Returns { code, stdout, stderr }. The CLI is `node <cliPath>` when
 * the config recorded one that still exists, else `npx @catalyst-cloud/catalyst-skills`.
 * Exits 2 (not configured) before spawning anything when the config is absent or unreadable.
 */
export function runCli(args, { stdin } = {}) {
  const loaded = loadConfig();
  if (!loaded.ok) notConfigured(loaded.reason);
  const { cfg } = loaded;
  let cmd;
  let argv;
  let shell = false;
  if (typeof cfg.cliPath === "string" && existsSync(cfg.cliPath)) {
    cmd = process.execPath;
    argv = [cfg.cliPath, ...args];
  } else {
    cmd = process.platform === "win32" ? "npx.cmd" : "npx";
    argv = [PACKAGE, ...args];
    shell = process.platform === "win32";
  }
  const r = spawnSync(cmd, argv, {
    encoding: "utf8",
    input: stdin,
    env: process.env,
    shell,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) {
    console.error(`could not run ${cmd}: ${r.error.message} — re-run ${CONNECT_HINT} to record the CLI path`);
    process.exit(2);
  }
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Print the CLI's stderr (the source line, the contract line, any refusal) on our stderr. */
export function relayStderr(r) {
  const text = r.stderr.trimEnd();
  if (text) console.error(text);
}

/** A non-zero CLI result ends the script with the same code, its stdout shown so nothing is lost. */
export function exitOnFailure(r) {
  if (r.code === 0) return;
  relayStderr(r);
  const out = r.stdout.trimEnd();
  if (out) console.log(out);
  process.exit(r.code);
}

export function parseJson(text) {
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}

/**
 * A small flag parser: `spec.value` names flags that take a value, `spec.bool` boolean flags,
 * `spec.repeat` value flags that may repeat (collected into arrays). Unknown flags are a usage error.
 */
export function parseFlags(argv, spec = {}) {
  const value = new Set(spec.value ?? []);
  const bool = new Set(spec.bool ?? []);
  const repeat = new Set(spec.repeat ?? []);
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    let name = a.slice(2);
    let inline;
    const eq = name.indexOf("=");
    if (eq !== -1) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (bool.has(name)) {
      flags[name] = true;
    } else if (value.has(name) || repeat.has(name)) {
      const v = inline ?? argv[++i];
      if (v === undefined || v === "") usage(`--${name} needs a value`);
      if (repeat.has(name)) (flags[name] ??= []).push(v);
      else flags[name] = v;
    } else {
      usage(`unknown option --${name}`);
    }
  }
  return { flags, positionals };
}

export function usage(message) {
  console.error(message);
  process.exit(1);
}

export function wantsHelp(argv) {
  return argv.includes("--help") || argv.includes("-h");
}

const runDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (runDirectly) {
  if (wantsHelp(process.argv.slice(2)) || process.argv.length <= 2) {
    console.log(
      [
        "lib/cli.mjs — shared helper for this skill's scripts (not a command of its own)",
        "",
        "Reads ~/.config/catalyst-cloud/customer.json and runs the catalyst-skills CLI recorded there",
        `(or npx ${PACKAGE} when no path is recorded). Exit 2 when the machine is not connected.`,
        "",
        `Connect first with: ${CONNECT_HINT}`,
        `Config in use: ${configPath()}`,
      ].join("\n"),
    );
    process.exit(0);
  }
}
