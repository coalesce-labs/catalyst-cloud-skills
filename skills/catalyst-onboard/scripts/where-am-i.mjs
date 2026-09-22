#!/usr/bin/env node
// where-am-i.mjs — how far has setup got? FIVE PARTS, EACH READ BY THE INSTRUMENT THAT OWNS IT, and
// each finding labelled with the part it belongs to. The whole point of this script is that no part
// answers for another: a project that is not ready is reported as a project finding with a tenant
// owner's name on it, never as something the person at this keyboard can fix by running anything.
//
// Every count and every name below is read off what a verb printed. Nothing here is written down.
import { cliTarget, CONNECT_LINE, parseFlags, printHelp, runCli, tryJson, tryLoadConfig } from "./lib/cli.mjs";

const SPEC = {
  next: { help: "print only the single next step" },
  json: { help: "one JSON document instead of the report" },
};
const NOTES = [
  "Reads, in this order: `status` (machine), `ready --json` (machine checks and project checks, kept apart),",
  "`me --json` (person), and `contract --path …` for the account, the projects and the repositories.",
  "Writes nothing and changes nothing. Runs before this machine is connected — that is one of the states it reports.",
];

const { help, flags, positionals } = parseFlags(process.argv.slice(2), SPEC);
if (help) {
  printHelp("node scripts/where-am-i.mjs [--next] [--json]", SPEC, NOTES);
  process.exit(0);
}
if (positionals.length > 0) {
  process.stderr.write(`unexpected argument: ${positionals[0]} (try --help)\n`);
  process.exit(1);
}

const via = cliTarget().via;
const parts = [];
// `blocking` is false for a finding that is real and reportable but does not stop the next step —
// an unmatched Linear identity is the one that matters: it must be said, and it must not become the
// thing the person is told to go and do before they can map a project.
const add = (part, instrument, verdict, lines, owner = null, where = null, blocking = true) =>
  parts.push({ part, instrument, verdict, lines, owner, where, blocking });

// ── machine ───────────────────────────────────────────────────────────────────────────────────────
const status = runCli(["status"]);
if (!status.ran) {
  process.stderr.write(`${status.stderr}\n`);
  process.stderr.write(`the catalyst-skills CLI could not be started. Install it, then run this again.\n`);
  process.exit(2);
}
const statusLines = status.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
const field = (name) => {
  const line = statusLines.find((l) => l.startsWith(`${name}:`));
  return line ? line.slice(name.length + 1).trim() : null;
};
const tenant = field("Tenant");
const api = field("API");
const connected = tenant !== null && tryLoadConfig() !== null;
// The app and the API share an origin; the base URL is whatever this machine was connected to, so
// no page link in this report is a host anyone typed from memory.
const cloud = api === null ? null : api.split(" ")[0].replace(/\/+$/, "");
const link = (path) => (cloud === null ? `<your cloud>${path}` : `${cloud}${path}`);

const machineLines = connected ? statusLines : [statusLines[0] ?? "status printed nothing"];
let machineVerdict = connected ? "ok" : "unfinished";

// `ready` is ONE verdict over two parts; split it by check id before anything is reported. A check
// whose id begins with "team:" belongs to a project and cannot be moved from this machine.
let projectChecks = [];
let machineFix = null;
if (connected) {
  const ready = runCli(["ready", "--json"]);
  const report = tryJson(ready.stdout);
  const checks = Array.isArray(report?.checks) ? report.checks : null;
  if (checks === null) {
    machineLines.push(`ready: could not be read (${(ready.stderr || ready.stdout).trim().split("\n")[0] ?? "no output"})`);
    machineVerdict = "unfinished";
  } else {
    projectChecks = checks.filter((c) => typeof c.id === "string" && c.id.startsWith("team:"));
    const machineChecks = checks.filter((c) => !(typeof c.id === "string" && c.id.startsWith("team:")));
    const failed = machineChecks.filter((c) => !c.ok && !c.note);
    for (const c of machineChecks) machineLines.push(`${c.note ? "note" : c.ok ? "ok  " : "FAIL"} ${c.line}${!c.ok && !c.note && c.fix ? ` — fix: ${c.fix}` : ""}`);
    if (failed.length > 0) {
      machineVerdict = "unfinished";
      machineFix = failed.find((c) => typeof c.fix === "string")?.fix ?? null;
    }
  }
}
add(
  "machine",
  "catalyst-skills status, and the non-team checks of catalyst-skills ready",
  machineVerdict,
  machineLines,
  "you, on this machine",
  connected ? null : CONNECT_LINE,
);

// ── person ────────────────────────────────────────────────────────────────────────────────────────
if (!connected) {
  add("person", "catalyst-skills me", "unreadable", ["not readable until this machine is connected"], null, null);
} else {
  const me = runCli(["me", "--json"]);
  const doc = tryJson(me.stdout);
  const user = doc && typeof doc.user === "object" && doc.user !== null ? doc.user : null;
  if (doc === null) {
    add("person", "catalyst-skills me", "unreadable", [`me could not be read (${(me.stderr || me.stdout).trim().split("\n")[0] ?? "no output"})`], null, null);
  } else if (user === null) {
    add(
      "person",
      "catalyst-skills me",
      "unfinished",
      ["this credential names no person — it is a host credential, so nothing an agent writes will carry a name"],
      "you: connect again with your own login",
      CONNECT_LINE,
    );
  } else {
    const matched = typeof user.linearUserId === "string" && user.linearUserId !== "";
    add(
      "person",
      "catalyst-skills me",
      matched ? "ok" : "unfinished",
      [`${user.label ?? "(unnamed)"} (${user.role ?? "role unknown"})`, matched ? "Linear identity matched" : "Linear identity NOT matched — asks assigned to you cannot be told apart from everyone else's. It blocks nothing below; get it fixed when convenient."],
      matched ? null : "a tenant owner or admin",
      matched ? null : link("/settings/account"),
      false,
    );
  }
}

// ── account ───────────────────────────────────────────────────────────────────────────────────────
if (!connected) {
  add("account", "catalyst-skills contract --path account", "unreadable", ["not readable until this machine is connected"], null, null);
} else {
  const acct = runCli(["contract", "--path", "account", "--json"]);
  const doc = tryJson(acct.stdout);
  if (doc === null) {
    add("account", "catalyst-skills contract --path account", "unreadable", ["the account block could not be read — try: catalyst-skills contract --refresh"], null, null);
  } else {
    const workspace = typeof doc.linearWorkspaceSlug === "string" && doc.linearWorkspaceSlug !== "" ? doc.linearWorkspaceSlug : typeof doc.linearWorkspaceId === "string" && doc.linearWorkspaceId !== "" ? doc.linearWorkspaceId : null;
    // The declaration is the one part of the account a key can also READ — and it is the one part a
    // key can WRITE, so it is reported here rather than left to the settings page like the rest.
    const envLines = [];
    const env = runCli(["environment", "read", "--json"]);
    const envDoc = tryJson(env.stdout);
    if (envDoc === null) {
      envLines.push(`environment: not readable (${(env.stderr || env.stdout).trim().split("\n")[0] ?? "no output"})`);
    } else if (envDoc.current === null || envDoc.current === undefined) {
      envLines.push("environment: nothing declared yet — declare it with `catalyst-skills environment propose --file <path> --approve`");
    } else {
      envLines.push(`environment: revision ${envDoc.current.revision} (${envDoc.current.canonicalHash}), ${envDoc.isApproved ? "approved" : "NOT approved — a proposal nobody approved changes nothing"}`);
      envLines.push(envDoc.delivered ? `environment delivered to phases: revision ${envDoc.delivered.revision}` : "environment delivered to phases: nothing yet");
      const unresolved = Array.isArray(envDoc.unresolvedReferences) ? envDoc.unresolvedReferences : [];
      if (unresolved.length > 0) envLines.push(`environment names values this tenant does not carry yet: ${unresolved.join(", ")}`);
    }
    add(
      "account",
      "catalyst-skills contract --path account, and catalyst-skills environment read",
      workspace === null ? "unfinished" : "ok",
      [
        `${doc.name ?? "(unnamed tenant)"} (${doc.slug ?? "?"})`,
        workspace === null ? "no Linear workspace resolved on this contract" : `Linear workspace resolved: ${workspace}`,
        "the GitHub App install is NOT carried here — the connections page is the only place that shows it",
        ...envLines,
      ],
      "a tenant owner or admin",
      link("/settings/connections"),
    );
  }
}

// ── projects (a project is one Linear team) ───────────────────────────────────────────────────────
if (!connected) {
  add("projects", "catalyst-skills contract --path teams", "unreadable", ["not readable until this machine is connected"], null, null);
} else {
  const teams = runCli(["contract", "--path", "teams", "--json"]);
  const doc = tryJson(teams.stdout);
  const rows = Array.isArray(doc) ? doc : null;
  if (rows === null) {
    add("projects", "catalyst-skills contract --path teams", "unreadable", ["the project list could not be read — try: catalyst-skills contract --refresh"], null, null);
  } else {
    const lines = [`${rows.length} mapped`];
    for (const t of rows) {
      const key = t.key ?? t.id ?? "(unkeyed)";
      const readiness = t.readiness ?? {};
      const bad = Array.isArray(readiness.checks) ? readiness.checks.filter((c) => c.state !== "pass") : [];
      lines.push(`${key}: ${readiness.status ?? "unknown"}${bad.length ? ` — ${bad.map((c) => `${c.id} ${c.state}`).join(", ")}` : ""}`);
    }
    for (const c of projectChecks) lines.push(`${c.ok ? "note" : "FAIL"} ${c.line}${c.who ? ` — who: ${c.who}` : ""}`);
    lines.push("⛔ MAPPED projects only. An empty list means nothing is mapped yet, NOT that there are no projects — the full list is on the page below.");
    // A project is set up when its dispatch gate is open (its stages are mapped), or when its
    // readiness reads ready. Readiness alone kept `--next` on "map its stages" for a tenant whose
    // gates were open: readiness stays "unchecked" until someone presses Re-check, and a new team
    // stays "degraded" until a repository is attached, which is the step AFTER this one.
    const setUp = (t) => t.dispatchGate?.status === "open" || (t.readiness?.status ?? "unchecked") === "ready";
    for (const t of rows) {
      if (t.dispatchGate?.status === "open" && (t.readiness?.status ?? "unchecked") === "unchecked") {
        lines.push(`${t.key ?? t.id ?? "(unkeyed)"}: stages mapped; readiness not checked yet: press Re-check on the page below to see the rest`);
      }
    }
    const ready = rows.length > 0 && rows.every(setUp);
    add("projects", "catalyst-skills contract --path teams, and the team: checks of ready", ready ? "ok" : "unfinished", lines, "a tenant owner or admin", link("/settings/linear-teams"));
  }
}

// ── repositories ──────────────────────────────────────────────────────────────────────────────────
if (!connected) {
  add("repositories", "catalyst-skills contract --path merge.repositories", "unreadable", ["not readable until this machine is connected"], null, null);
} else {
  const repos = runCli(["contract", "--path", "merge.repositories", "--json"]);
  const doc = tryJson(repos.stdout);
  const rows = Array.isArray(doc) ? doc : null;
  if (rows === null) {
    add("repositories", "catalyst-skills contract --path merge.repositories", "unreadable", ["the repository list could not be read — try: catalyst-skills contract --refresh"], null, null);
  } else {
    const lines = [`${rows.length} registered`, ...rows.map((r) => `${r.owner ?? "?"}/${r.name ?? "?"}`)];
    lines.push("⛔ REGISTRATION only. This carries no status and no project attachment, so it never proves a repository can be dispatched into.");
    add("repositories", "catalyst-skills contract --path merge.repositories", rows.length > 0 ? "ok" : "unfinished", lines, "a tenant owner or admin", link("/settings/repositories"));
  }
}

// ── the single next step ──────────────────────────────────────────────────────────────────────────
// The machine's next action is not one sentence: an unconnected machine needs the login, and a
// connected one needs whatever check failed — and `ready` already printed that check's own fix, so
// this carries it through rather than inventing a second answer to the same question.
const machineNext = connected
  ? `clear the machine check that failed — ${machineFix ?? "see the machine lines above"}`
  : "connect this machine";
const NEXT = {
  machine: machineNext,
  person: "get this person's seat and Linear identity sorted",
  account: "connect Linear, and install the GitHub App",
  projects: "pick ONE project and map its stages (or adopt the Catalyst workflow)",
  repositories: "register the repository, attaching it to the project you mapped",
};
const blocked = parts.filter((p) => p.verdict !== "ok" && p.blocking);
const stuck = blocked[0] ?? parts.find((p) => p.verdict !== "ok") ?? null;
const next =
  stuck === null
    ? null
    : { part: stuck.part, action: NEXT[stuck.part], owner: stuck.owner, where: stuck.where, blocking: stuck.blocking };
const finished = parts.every((p) => p.verdict === "ok");

if (flags.json) {
  console.log(JSON.stringify({ cli: via, connected, cloud, parts, next, finished }));
} else if (flags.next) {
  if (next === null) console.log("nothing left: every part this machine can read is finished. Move one card into the project's dispatch stage.");
  else console.log(`${next.part}: ${next.action}${next.blocking ? "" : " (does not block the steps below)"}${next.owner ? ` — who: ${next.owner}` : ""}${next.where ? ` — ${next.where.startsWith("http") ? "where" : "do"}: ${next.where}` : ""}`);
} else {
  for (const p of parts) {
    console.log(`${p.part}  [${p.verdict}]`);
    console.log(`  instrument: ${p.instrument}`);
    for (const l of p.lines) console.log(`  ${l}`);
    if (p.verdict !== "ok" && p.owner) console.log(`  who: ${p.owner}`);
    // A page gets "where"; a command gets "do". Labelling a command "where" is how a person ends up
    // looking for a settings page that is actually a line to run.
    if (p.verdict !== "ok" && p.where) console.log(`  ${p.where.startsWith("http") ? "where" : "do"}: ${p.where}`);
    console.log("");
  }
  console.log(next === null ? "next: nothing left — move one card into the project's dispatch stage and watch." : `next: ${next.part} — ${next.action}${next.owner ? ` (${next.owner})` : ""}${next.where ? ` — ${next.where}` : ""}`);
}
process.exit(finished ? 0 : 1);
