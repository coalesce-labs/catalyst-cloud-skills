#!/usr/bin/env node
// snapshot.mjs — one call that answers "where are we?": the tenant contract (trimmed to what a
// status reply needs), what is running, what is queued, what is waiting on a human, and whether the
// local replica is fresh. Prints ONE JSON document on stdout and the source line on stderr.
import { mustRun, parseFlags, parseJson, printHelp, runCli } from "./lib/cli.mjs";

const SPEC = {
  team: { value: true, help: "limit the queue and the board to this team key" },
  board: { value: false, help: "also include open tickets grouped by stage, in the contract's slot order" },
  limit: { value: true, help: "board: max tickets to read (default 200)" },
  "full-contract": { value: false, help: "include the whole contract instead of the trimmed tenant block" },
};

const { help, flags } = parseFlags(process.argv.slice(2), SPEC);
if (help) {
  printHelp("node scripts/snapshot.mjs [--team K] [--board] [--limit N] [--full-contract] [--help]", SPEC, [
    "Runs, in order: catalyst-skills contract, running, queue, ask list, replica status (and query issues with --board).",
    "Output: one JSON document {takenAt, source, tenant, running, queue, waitingOnHuman, board?, errors?}.",
    "A section the cloud refused is reported under errors and the rest still prints; exit 1 in that case.",
    "Every tenant fact (stage names, thresholds, teams) comes from the contract in this output, never from prose.",
  ]);
  process.exit(0);
}

const errors = {};
const section = (name, args) => {
  const r = runCli(args);
  if (r.code !== 0) {
    errors[name] = (r.stderr || r.stdout || `exit ${r.code}`).trim().split("\n").at(-1);
    return null;
  }
  return parseJson(r.stdout, name);
};

const contract = parseJson(mustRun(["contract", "--json"], { quiet: true }).stdout, "contract");
// `replica status` exits 0 fresh, 1 stale, 3 absent — all three are verdicts with JSON on stdout,
// not failures; only a non-JSON answer is an error.
const replica = (() => {
  const r = runCli(["replica", "status", "--json"]);
  try {
    return JSON.parse(r.stdout.trim());
  } catch {
    errors.replica = (r.stderr || r.stdout || `exit ${r.code}`).trim().split("\n").at(-1);
    return { verdict: "unknown", cursor: null, heartbeatAgeMs: null };
  }
})();
const running = section("running", ["running", "--json"]);
const queue = section("queue", flags.team ? ["queue", "--team", flags.team, "--json"] : ["queue", "--json"]);
const asks = section("waitingOnHuman", ["ask", "list", "--json"]);

const out = {
  takenAt: new Date().toISOString(),
  source: {
    reads: "api",
    replica: replica.verdict,
    replicaCursor: replica.cursor ?? null,
    replicaHeartbeatAgeMs: replica.heartbeatAgeMs ?? null,
  },
  tenant: flags["full-contract"] ? contract : trimContract(contract, flags.team),
  running,
  queue,
  waitingOnHuman: asks,
};

if (flags.board) {
  const args = ["query", "issues", "--limit", String(flags.limit ?? 200), "--json"];
  if (flags.team) args.push("--team", flags.team);
  const r = runCli(args);
  const sourceLine = (r.stderr.match(/^source: .*$/m) ?? [null])[0];
  if (r.code !== 0) errors.board = (r.stderr || `exit ${r.code}`).trim().split("\n").at(-1);
  else {
    const rows = parseJson(r.stdout, "issues");
    out.board = groupByStage(rows, contract, flags.team);
    if (sourceLine) out.source.board = sourceLine.replace(/^source: /, "");
  }
}

if (Object.keys(errors).length) out.errors = errors;
process.stderr.write(`source: api for running/queue/asks; replica ${replica.verdict}${replica.cursor != null ? ` (cursor ${replica.cursor})` : ""}${out.source.board ? `; board from ${out.source.board}` : ""}\n`);
process.stdout.write(JSON.stringify(out, null, 2) + "\n");
process.exit(Object.keys(errors).length ? 1 : 0);

/** The contract facts a status reply needs, and nothing a reply should not paste. */
function trimContract(doc, teamKey) {
  const teams = (doc.teams ?? []).filter((t) => !teamKey || String(t.key ?? "").toUpperCase() === teamKey.toUpperCase());
  return {
    contractVersion: doc.contractVersion,
    account: { slug: doc.account?.slug, name: doc.account?.name },
    slots: doc.slots,
    ladder: { phases: doc.ladder?.phases, intakeEnabled: doc.ladder?.intakeEnabled, keying: doc.ladder?.keying },
    thresholds: doc.thresholds,
    mergeDefaultPolicy: doc.merge?.defaultPolicy,
    teams: teams.map((t) => ({
      key: t.key,
      name: t.name,
      workflowMode: t.workflowMode,
      readiness: t.readiness?.status,
      stages: Object.fromEntries(
        (doc.slots ?? Object.keys(t.stages ?? {}))
          .filter((slot) => t.stages?.[slot])
          .map((slot) => [slot, { name: t.stages[slot].name, type: t.stages[slot].type, stateStillExists: t.stages[slot].stateStillExists }]),
      ),
      labels: {
        ask: (t.labels?.ask ?? []).map((l) => l.name),
        hold: (t.labels?.hold ?? []).map((l) => l.name),
        release: (t.labels?.release ?? []).map((l) => l.name),
      },
    })),
  };
}

/** Open tickets by stage name, ordered by the contract's slot order for the ticket's team; unmapped
 *  state names follow, alphabetically. Terminal-typed states are dropped so the board is work only. */
function groupByStage(rows, doc, teamKey) {
  const order = [];
  const seen = new Set();
  const terminal = new Set();
  for (const t of doc.teams ?? []) {
    if (teamKey && String(t.key ?? "").toUpperCase() !== teamKey.toUpperCase()) continue;
    for (const slot of doc.slots ?? []) {
      const s = t.stages?.[slot];
      if (!s?.name) continue;
      if (slot === "done" || slot === "canceled" || ["completed", "canceled", "cancelled"].includes(String(s.type ?? "").toLowerCase())) terminal.add(s.name);
      else if (!seen.has(s.name)) {
        seen.add(s.name);
        order.push(s.name);
      }
    }
  }
  const byStage = {};
  for (const r of rows) {
    const state = String(r.state ?? "unknown");
    if (terminal.has(state)) continue;
    (byStage[state] ??= []).push({
      identifier: r.identifier,
      title: r.title,
      priority: r.priority ?? null,
      assignee: r.assignee_name ?? r.assignee ?? null,
      updatedAt: r.updated_at ?? null,
      projectId: r.project_id ?? null,
    });
  }
  const extra = Object.keys(byStage).filter((s) => !seen.has(s)).sort();
  return { stageOrder: [...order, ...extra], byStage, terminalStagesDropped: [...terminal] };
}
