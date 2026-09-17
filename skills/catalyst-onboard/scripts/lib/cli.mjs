#!/usr/bin/env node
// lib/cli.mjs — the one way a skill script reaches Catalyst Cloud: spawn the catalyst-skills CLI.
// The CLI holds the SDK and the key; this file holds neither. It reads customer.json only to learn
// where the CLI lives. Run any script beside this one with --help; this file is a library.
//
// ⛔ THIS LAUNCHER DOES NOT EXIT ON AN UNCONNECTED MACHINE, and that is deliberate. Every other
// skill runs against a tenant, so "not connected" is a precondition it refuses on. This skill's job
// is to REPORT where setup has got to, and "this machine holds no credential" is one of the states
// it has to be able to report — refusing to run would make the first step of onboarding unreadable.
// So `tryLoadConfig()` returns null instead of exiting, and the caller decides what that means.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONNECT_COMMAND, hasCredential } from "./credential.mjs";

export const PACKAGE = "@catalyst-cloud/catalyst-skills";
export const NOT_CONFIGURED_EXIT = 2;
export const CONNECT_LINE = CONNECT_COMMAND;

export function configPath() {
  const home = process.env.CATALYST_SKILLS_HOME ?? process.env.HOME ?? "/";
  return join(home, ".config", "catalyst-cloud", "customer.json");
}

/** The stored config, or null when it is absent, unreadable, or holds no credential. Never exits. */
export function tryLoadConfig() {
  const path = configPath();
  if (!existsSync(path)) return null;
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    return hasCredential(cfg) ? cfg : null;
  } catch {
    return null;
  }
}

/** Where the CLI is on this machine: the path login recorded when it still exists, else npx. */
export function cliTarget(cfg = tryLoadConfig()) {
  const recorded = cfg !== null && typeof cfg.cliPath === "string" && existsSync(cfg.cliPath);
  return recorded
    ? { command: process.execPath, prefix: [cfg.cliPath], via: `node ${cfg.cliPath}`, recorded: true }
    : { command: "npx", prefix: [PACKAGE], via: `npx ${PACKAGE}`, recorded: false };
}

/**
 * Run one catalyst-skills verb. Returns {code, stdout, stderr, ran} and never exits: a verb that
 * refuses because the machine is not connected is a READING, not a failure of this script.
 * `ran` is false when the CLI could not be started at all.
 */
export function runCli(args) {
  const target = cliTarget();
  const res = spawnSync(target.command, [...target.prefix, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: !target.recorded && process.platform === "win32",
    env: process.env,
  });
  if (res.error) return { code: 1, stdout: "", stderr: `could not run ${target.via}: ${res.error.message}`, ran: false };
  return { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "", ran: true };
}

/** Parse a verb's --json stdout, or null when it did not answer with JSON. Never exits. */
export function tryJson(stdout) {
  try {
    const value = JSON.parse(stdout.trim());
    return value === null || typeof value !== "object" ? null : value;
  } catch {
    return null;
  }
}

/** Minimal flag parsing: --name value, --name=value, --flag. */
export function parseFlags(argv, spec) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true, flags, positionals };
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    let name = a.slice(2);
    let value;
    const eq = name.indexOf("=");
    if (eq !== -1) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    const s = spec[name];
    if (!s) {
      process.stderr.write(`unknown option --${name} (try --help)\n`);
      process.exit(1);
    }
    if (s.value) {
      if (value === undefined) value = argv[++i];
      if (value === undefined || value === "") {
        process.stderr.write(`--${name} needs a value\n`);
        process.exit(1);
      }
      flags[name] = value;
    } else flags[name] = true;
  }
  return { help: false, flags, positionals };
}

export function printHelp(usage, spec, notes = []) {
  const lines = [`Usage: ${usage}`, ""];
  const names = Object.keys(spec);
  if (names.length) {
    lines.push("Options:");
    for (const n of names) lines.push(`  --${n}${spec[n].value ? " <value>" : ""}  ${spec[n].help}`);
    lines.push("");
  }
  lines.push(...notes, "", "Exit codes: 0 every readable part is finished · 1 something is unfinished (the report says what and whose) · 2 the CLI could not be run at all");
  process.stdout.write(lines.join("\n") + "\n");
}
