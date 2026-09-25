#!/usr/bin/env node
// Optional onboarding step. The replica command starts the event cache with the writer;
// only a live heartbeat at the cloud head proves that both were started successfully.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cliTarget } from "./lib/cli.mjs";

const STATUS_COMMAND = ["replica", "status", "--probe", "--json"];
const EVENTS_COMMAND = ["events", "status", "--probe", "--json"];
const START_COMMAND = ["replica", "start", "--detach"];
const RECOVERY_COMMAND = "catalyst-skills replica start --detach";

function defaultRun(args) {
  const target = cliTarget();
  const result = spawnSync(target.command, [...target.prefix, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    shell: !target.recorded && process.platform === "win32",
    env: process.env,
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message,
  };
}

export function assessLocalSync(status, events) {
  if (!status || typeof status !== "object")
    return { verdict: "unknown", current: false, reason: "replica status did not return a document" };
  if (status.verdict === "not-configured")
    return { verdict: "unknown", current: false, reason: "this machine is not connected" };
  if (status.verdict === "absent")
    return { verdict: "absent", current: false, reason: "local replica is absent" };
  if (status.verdict === "unknown" || status.verdict === "unverified" || !["fresh", "stale"].includes(status.verdict))
    return { verdict: "unknown", current: false, reason: `replica freshness is unknown: ${(status.reasons ?? []).join("; ")}` };
  if (status.verdict !== "fresh")
    return {
      verdict: "stale",
      current: false,
      reason: `replica ${status.verdict ?? "unknown"}: ${(status.reasons ?? []).join("; ")}`,
    };
  if (status.writerAlive !== true)
    return { verdict: "stale", current: false, reason: "replica writer heartbeat is absent or stale" };
  if (!Number.isFinite(status.heartbeatAgeMs))
    return { verdict: "unknown", current: false, reason: "replica heartbeat age was not reported" };
  if (status.heartbeatAgeMs >= 15_000)
    return { verdict: "stale", current: false, reason: `replica writer heartbeat is ${status.heartbeatAgeMs}ms old` };
  if (!Number.isSafeInteger(status.cursor) || !Number.isSafeInteger(status.head) || !Number.isSafeInteger(status.lag))
    return { verdict: "unknown", current: false, reason: "replica cursor or cloud head was not reported" };
  if (status.lag !== 0 || status.cursor !== status.head) {
    return {
      verdict: "stale",
      current: false,
      reason: "cloud head and local cursor have not been proved equal",
    };
  }
  if (!events || !["current", "stale", "absent"].includes(events.verdict)) {
    return {
      verdict: "unknown",
      current: false,
      reason: `event freshness is unknown: ${(events?.reasons ?? []).join("; ")}`,
    };
  }
  if (events.verdict === "absent") {
    return { verdict: "absent", current: false, reason: "local event cache is absent" };
  }
  if (events.verdict === "stale")
    return {
      verdict: "stale",
      current: false,
      reason: `event cache is ${events?.verdict ?? "unverified"}: ${(events?.reasons ?? []).join("; ")}`,
    };
  if (events.writerAlive !== true)
    return { verdict: "stale", current: false, reason: "event writer heartbeat is absent or stale" };
  if (!Number.isFinite(events.heartbeatAgeMs))
    return { verdict: "unknown", current: false, reason: "event writer heartbeat age was not reported" };
  if (events.heartbeatAgeMs >= 15_000)
    return { verdict: "stale", current: false, reason: `event writer heartbeat is ${events.heartbeatAgeMs}ms old` };
  if (!Number.isSafeInteger(events.cursor) || !Number.isSafeInteger(events.head))
    return { verdict: "unknown", current: false, reason: "event cursor or cloud head was not reported" };
  if (events.cursor !== events.head)
    return { verdict: "stale", current: false, reason: `event cache cursor ${events.cursor} differs from cloud head ${events.head}` };
  return {
    verdict: "current",
    current: true,
    reason: `replica cursor ${status.cursor} and event cursor ${events.cursor} each match their cloud head; both writer heartbeats are live`,
  };
}

function readStatus(run) {
  const replicaResult = run(STATUS_COMMAND);
  let status, events;
  try {
    status = JSON.parse(replicaResult.stdout);
  } catch {
    return {
      status: null,
      events: null,
      assessment: {
        verdict: "unknown",
        current: false,
        reason: `replica status is unknown: ${replicaResult.error || replicaResult.stderr.trim() || "invalid JSON"}`,
      },
      recovery: replicaResult.code === 2 ? "catalyst-skills login" : "catalyst-skills replica status --probe --json",
    };
  }
  const eventsResult = run(EVENTS_COMMAND);
  try {
    events = JSON.parse(eventsResult.stdout);
  } catch {
    return {
      status,
      events: null,
      assessment: {
        verdict: "unknown",
        current: false,
        reason: `event freshness is unknown: ${eventsResult.error || eventsResult.stderr.trim() || "invalid JSON"}`,
      },
      recovery: "catalyst-skills events status --probe --json",
    };
  }
  return { status, events, assessment: assessLocalSync(status, events) };
}

/** A bounded check. Starting the optional writer requires an explicit opt-in. */
export async function runLocalSync({
  start = false,
  waitSeconds = 90,
  run = defaultRun,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 300)
    throw new Error("--wait must be an integer from 0 to 300 seconds");
  let reading = readStatus(run);
  if (reading.assessment.current || !start)
    return { ...reading, started: false, recovery: reading.recovery ?? RECOVERY_COMMAND };
  if (!reading.status)
    return { ...reading, started: false, recovery: reading.recovery ?? "catalyst-skills replica status --probe --json" };
  if (
    reading.status?.verdict === "not-configured" ||
    reading.status?.dbPath == null
  ) {
    return { ...reading, started: false, recovery: "catalyst-skills login" };
  }
  let started = false;
  if (reading.status.writerAlive !== true && ["absent", "stale"].includes(reading.assessment.verdict)) {
    const result = run(START_COMMAND);
    if (result.code !== 0) {
      return {
        status: reading.status,
        events: reading.events,
        assessment: {
          verdict: "unknown",
          current: false,
          reason: `writer start failed: ${result.error || result.stderr.trim() || result.stdout.trim()}`,
        },
        started: false,
        recovery: RECOVERY_COMMAND,
      };
    }
    started = true;
  }
  const deadline = now() + waitSeconds * 1000;
  do {
    reading = readStatus(run);
    if (reading.assessment.current || now() >= deadline) break;
    await sleep(Math.min(3000, deadline - now()));
  } while (true);
  return {
    ...reading,
    started,
    recovery: reading.assessment.verdict === "unknown"
      ? "node scripts/local-sync.mjs --json"
      : reading.status?.writerAlive
        ? "catalyst-skills replica stop && catalyst-skills replica start --detach"
        : RECOVERY_COMMAND,
  };
}

function parseArgs(argv) {
  const opts = { start: false, waitSeconds: 90, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--start") opts.start = true;
    else if (argv[i] === "--json") opts.json = true;
    else if (argv[i] === "--wait") opts.waitSeconds = Number(argv[++i]);
    else if (argv[i] === "--help") {
      console.log(
        "Usage: node scripts/local-sync.mjs [--start] [--wait 0..300] [--json]\nWithout --start, this only checks status. Local sync is optional.",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return opts;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const result = await runLocalSync(opts);
    if (opts.json) console.log(JSON.stringify(result));
    else {
      const label = result.assessment.verdict === "current" ? "current" : result.assessment.verdict;
      console.log(`Local sync ${label}: ${result.assessment.reason}`);
      if (!result.assessment.current) console.log(`Next: ${result.recovery}`);
    }
    process.exitCode = result.assessment.verdict === "current" ? 0 : result.assessment.verdict === "stale" ? 1 : result.assessment.verdict === "absent" ? 3 : 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
