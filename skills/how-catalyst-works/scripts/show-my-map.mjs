#!/usr/bin/env node
// show-my-map.mjs — this tenant's stage map, ladder and thresholds, straight from the contract:
// per team, every slot with the Linear stage it maps to, its type, whether that state still exists
// and how the mapping was chosen; then the ladder and the live failure thresholds.
import { exitOnFailure, parseFlags, parseJson, relayStderr, runCli, wantsHelp } from "./lib/cli.mjs";

const HELP = `Usage: node scripts/show-my-map.mjs [--team <key>] [--json]

Prints the tenant contract's stage map, ladder and thresholds. Nothing here is guessed: every value is
read from the contract Catalyst Cloud serves for your tenant. Wraps: catalyst-skills contract --path.

  --team <key>   only this team
  --json         one JSON document: { slots, teams, ladder, thresholds }
  --help         this text

A slot marked * is load-bearing: dispatch, intake, pr, done and canceled must be mapped for the
ladder to move at all; the others are informational. "(unmapped)" means the team has no stage for
that slot; "(state gone)" means the mapped Linear state no longer exists and needs re-mapping in
settings.

Exit 0, 1 on a usage error or an unknown team, 2 when this machine is not connected to a tenant or
the contract could not be read (the line says which).`;

const LOAD_BEARING = new Set(["dispatch", "intake", "pr", "done", "canceled"]);

const argv = process.argv.slice(2);
if (wantsHelp(argv)) {
  console.log(HELP);
  process.exit(0);
}
const { flags } = parseFlags(argv, { bool: ["json"], value: ["team"] });

function contractPath(path) {
  const r = runCli(["contract", "--path", path, "--json"]);
  exitOnFailure(r);
  const v = parseJson(r.stdout);
  if (v === null || v === undefined) {
    relayStderr(r);
    console.error(`contract --path ${path} returned nothing readable`);
    process.exit(1);
  }
  return { value: v, stderr: r.stderr };
}

const slotsRead = contractPath("slots");
if (slotsRead.stderr.trim()) console.error(slotsRead.stderr.trimEnd());
const slots = slotsRead.value;
let teams = contractPath("teams").value;
const ladder = contractPath("ladder").value;
const thresholds = contractPath("thresholds").value;

if (flags.team) {
  const want = flags.team.toUpperCase();
  teams = teams.filter((t) => String(t.key ?? "").toUpperCase() === want);
  if (teams.length === 0) {
    console.error(`no team with key ${flags.team} on this tenant's contract`);
    process.exit(1);
  }
}

if (flags.json) {
  console.log(JSON.stringify({ slots, teams, ladder, thresholds }));
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n);
for (const team of teams) {
  console.log(`== team ${team.key ?? "(no key)"} — ${team.name ?? team.id} — workflow ${team.workflowMode}, git automation ${team.gitAutomation}, readiness ${team.readiness?.status ?? "unknown"}`);
  console.log(`   ${pad("slot", 12)}${pad("stage", 22)}${pad("type", 12)}${pad("exists", 8)}source`);
  for (const slot of slots) {
    const s = team.stages?.[slot];
    const mark = LOAD_BEARING.has(slot) ? "*" : " ";
    if (!s) {
      console.log(`  ${mark}${pad(slot, 12)}(unmapped)`);
      continue;
    }
    const name = s.stateStillExists ? (s.name ?? "(unnamed)") : "(state gone)";
    console.log(`  ${mark}${pad(slot, 12)}${pad(name, 22)}${pad(s.type ?? "-", 12)}${pad(s.stateStillExists ? "yes" : "NO", 8)}${s.source}`);
  }
  const labels = team.labels ?? {};
  const describe = (list) => (list ?? []).map((l) => `${l.name}${l.preferredId ? "" : " (absent)"}`).join(", ") || "none";
  console.log(`   labels: ask ${describe(labels.ask)}; hold ${describe(labels.hold)}; release ${describe(labels.release)}`);
}

console.log("== ladder");
console.log(`   phases: ${(ladder.phases ?? []).join(" → ")}`);
console.log(`   keying: ${ladder.keying} (${ladder.keyingScope}); intake ${ladder.intakeEnabled ? "enabled" : "off"}`);

console.log("== thresholds (live, fleet-wide)");
const minutes = (ms) => `${Math.round(ms / 60000)} min`;
console.log(`   park after ${thresholds.parkAfterConsecutiveFailures} consecutive failures`);
console.log(`   remediate round cap ${thresholds.remediateRoundCap} (escalated budget ${thresholds.remediateEscalatedRoundBudget}, rewind budget ${thresholds.remediateRewindBudget})`);
console.log(`   retry backoff ${(thresholds.retryBackoffMs ?? []).map(minutes).join(", ")}`);
console.log(`   write budget ${thresholds.hostDailyWriteBudget} per host per day`);
