#!/usr/bin/env node
// lib/cli.mjs — the one way a skill script reaches Catalyst Cloud: by spawning the catalyst-skills
// CLI. The CLI holds the SDK and the account key; this file holds neither. It reads
// ~/.config/catalyst-cloud/customer.json (under CATALYST_SKILLS_HOME when set, else HOME) for the
// CLI path that join recorded and falls back to `npx @catalyst-cloud/catalyst-skills`.
//
// Exit codes every script built on this file shares: 2 = this machine is not joined, 1 = the
// script's own check failed, 0 = fine.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "@catalyst-cloud/catalyst-skills";
export const NOT_CONFIGURED_EXIT = 2;
export const CHECK_FAILED_EXIT = 1;

export function homeDir() {
  return process.env.CATALYST_SKILLS_HOME ?? process.env.HOME ?? process.env.USERPROFILE ?? "/";
}

export function configDir() {
  return join(homeDir(), ".config", "catalyst-cloud");
}

export function configPath() {
  return join(configDir(), "customer.json");
}

/** The joined config, or null when the file is absent or unreadable. Never throws. */
export function loadCustomerConfig() {
  const path = configPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.key !== "string" || typeof parsed.account !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Print the one not-joined line and exit 2. */
export function requireConfigured() {
  const cfg = loadCustomerConfig();
  if (cfg) return cfg;
  console.error(`not joined: ${configPath()} is missing or unreadable — run: CATALYST_CLOUD_TOKEN=<account key> npx ${PACKAGE_NAME} join`);
  process.exit(NOT_CONFIGURED_EXIT);
}

/** The command and argument prefix that reaches the CLI on this machine. */
export function cliCommand(cfg = loadCustomerConfig()) {
  if (cfg && typeof cfg.cliPath === "string" && existsSync(cfg.cliPath)) {
    return { command: process.execPath, prefix: [cfg.cliPath], via: `node ${cfg.cliPath}` };
  }
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  return { command: npx, prefix: [PACKAGE_NAME], via: `npx ${PACKAGE_NAME}` };
}

/**
 * Run one CLI verb and capture its output. Resolves `{code, stdout, stderr, notConfigured}`;
 * `notConfigured` is true when the CLI itself said the machine is not joined.
 */
export function runCli(args, { stdin } = {}) {
  const { command, prefix } = cliCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, ...args], {
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: process.env,
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr, notConfigured: /not joined/i.test(stderr) || /not joined/i.test(stdout) });
    });
    if (stdin !== undefined) child.stdin.end(stdin);
  });
}

/**
 * Run one CLI verb with the terminal attached, so a long-running verb such as `watch` streams
 * straight through. Resolves with the exit code; SIGINT and SIGTERM are forwarded to the child.
 */
export function execCli(args) {
  const { command, prefix } = cliCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, ...args], { stdio: "inherit", env: process.env, shell: process.platform === "win32" });
    const forward = (sig) => () => {
      try {
        child.kill(sig);
      } catch {
        // already gone
      }
    };
    const onInt = forward("SIGINT");
    const onTerm = forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    child.on("error", reject);
    child.on("close", (code) => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      resolve(code ?? 1);
    });
  });
}

/** Parse the CLI's --json output; a parse failure names the first line of what came back. */
export function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`the CLI did not answer with JSON: ${stdout.split("\n")[0] ?? "(empty)"}`);
  }
}

/** Exit 2 with the CLI's own not-joined line when a call reports it; otherwise return the result. */
export function guard(result) {
  if (result.notConfigured) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(NOT_CONFIGURED_EXIT);
  }
  return result;
}

/** A tiny flag parser: `--name value`, `--name=value`, `--flag`, repeatable names collected as arrays. */
export function parseFlags(argv, { values = [], repeat = [], booleans = [] } = {}) {
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
    let value;
    const eq = name.indexOf("=");
    if (eq !== -1) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (booleans.includes(name)) {
      flags[name] = true;
      continue;
    }
    if (!values.includes(name) && !repeat.includes(name)) {
      console.error(`unknown option: --${name} (try --help)`);
      process.exit(CHECK_FAILED_EXIT);
    }
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) {
        console.error(`--${name} needs a value`);
        process.exit(CHECK_FAILED_EXIT);
      }
    }
    if (repeat.includes(name)) flags[name] = [...(flags[name] ?? []), value];
    else flags[name] = value;
  }
  return { flags, positionals };
}

export function wantsHelp(argv) {
  return argv.includes("--help") || argv.includes("-h");
}

const HELP = `lib/cli.mjs — shared helper; not a command.

Resolves the catalyst-skills CLI (the path join recorded in ${configPath()}, else npx ${PACKAGE_NAME})
and runs one verb for the script that imports it. Run any sibling script with --help instead.`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(HELP);
  process.exit(0);
}
