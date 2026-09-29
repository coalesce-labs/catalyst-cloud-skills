#!/usr/bin/env node
// lib/cli.mjs — the one way a skill script reaches the Catalyst Cloud SDK and API: by spawning the
// catalyst-skills CLI this bundle installed. It reads customer.json to find that CLI and nothing
// else; it never holds the key itself. This file is a library — run a sibling script with
// --help for usage. Per-skill (skills install one directory at a time, so nothing shared outside the
// skill would ever be installed) — see runCliOffline below for the one way this skill's copy differs.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONNECT_COMMAND, hasCredential } from "./credential.mjs";

export const PACKAGE = "@catalyst-cloud/catalyst-skills";
export const CONNECT_HINT = `this machine is not connected to a tenant yet — run: ${CONNECT_COMMAND}`;

/** ~/.config/catalyst-cloud/customer.json, honouring CATALYST_SKILLS_HOME before HOME. */
export function configPath() {
  const home = process.env.CATALYST_SKILLS_HOME ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
  return join(home, ".config", "catalyst-cloud", "customer.json");
}

/** The customer config, or exit 2 with one line naming the connect command. Never throws. */
export function requireCustomerConfig() {
  const path = configPath();
  if (!existsSync(path)) {
    console.error(CONNECT_HINT);
    process.exit(2);
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`${path} could not be read (${err instanceof Error ? err.message : String(err)}) — ${CONNECT_HINT}`);
    process.exit(2);
  }
  if (!hasCredential(cfg) || typeof cfg.baseUrl !== "string") {
    console.error(`${path} is missing required fields — ${CONNECT_HINT}`);
    process.exit(2);
  }
  return cfg;
}

/**
 * Run one catalyst-skills verb and return {code, stdout, stderr}. Spawns the CLI whose path the
 * connect step recorded in customer.json; falls back to `npx @catalyst-cloud/catalyst-skills` when
 * no path is recorded or it no longer exists. Exits 2 when the machine is not connected.
 */
export function runCli(args, opts = {}) {
  const cfg = requireCustomerConfig();
  return spawnCli(cfg, args, opts);
}

/**
 * Run `catalyst-skills env inventory` / `env check` without requiring a credential at all. Unlike
 * every other verb this launcher can reach, `env inventory` and `env check` are LOCAL and OFFLINE —
 * they never call the cloud — so gating them on `requireCustomerConfig` would break the feature they
 * exist to provide. Still resolves the recorded `cliPath` when a customer.json happens to exist (so
 * an already-connected machine reuses the same installed CLI), and still falls back to
 * `npx @catalyst-cloud/catalyst-skills` otherwise.
 */
export function runCliOffline(args, opts = {}) {
  let cfg = null;
  try {
    const path = configPath();
    if (existsSync(path)) cfg = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    cfg = null;
  }
  return spawnCli(cfg, args, opts);
}

function spawnCli(cfg, args, opts) {
  const recorded = Boolean(cfg) && typeof cfg.cliPath === "string" && existsSync(cfg.cliPath);
  const command = recorded ? process.execPath : process.platform === "win32" ? "npx.cmd" : "npx";
  const argv = recorded ? [cfg.cliPath, ...args] : [PACKAGE, ...args];
  const res = spawnSync(command, argv, {
    encoding: "utf8",
    input: opts.stdin,
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    shell: !recorded && process.platform === "win32",
  });
  if (res.error) {
    console.error(`could not run ${recorded ? cfg.cliPath : `npx ${PACKAGE}`}: ${res.error.message}`);
    process.exit(2);
  }
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * Run a verb that must succeed. On exit 2 (the CLI's "not configured / refused" class) the script
 * exits 2; on any other non-zero exit it exits 1. The CLI's own stderr is forwarded either way so the
 * reason is never lost.
 */
export function runCliOrExit(args, opts = {}) {
  const res = runCli(args, opts);
  if (res.code === 0) return res;
  const why = res.stderr.trim() || res.stdout.trim() || `catalyst-skills ${args.join(" ")} exited ${res.code}`;
  console.error(why);
  process.exit(res.code === 2 ? 2 : 1);
}

/** Parse the CLI's --json stdout; null when it is not JSON (the caller decides what that means). */
export function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log("lib/cli.mjs is a library used by the scripts beside it; run any of those with --help for usage.");
}
