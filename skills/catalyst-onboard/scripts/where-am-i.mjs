#!/usr/bin/env node
// where-am-i.mjs — how far has setup got? SEVEN PARTS, EACH READ BY THE INSTRUMENT THAT OWNS IT, and
// each finding labelled with the part it belongs to. The whole point of this script is that no part
// answers for another: a project that is not ready is reported as a project finding with a tenant
// owner's name on it, never as something the person at this keyboard can fix by running anything.
//
// Every count and every name below is read off what a verb printed. Nothing here is written down.
import { cliTarget, CONNECT_LINE, parseFlags, printHelp, runCli, tryJson, tryLoadConfig } from "./lib/cli.mjs";
import { spawnSync } from "node:child_process";
import { runLocalSync } from "./local-sync.mjs";

const SPEC = {
  next: { help: "print only the single next step" },
  json: { help: "one JSON document instead of the report" },
};
const NOTES = [
  "Reads, in this order: `status` (machine), `ready --json` (machine checks and project checks, kept apart),",
  "`replica status --probe --json` and `events status --probe --json` (optional local freshness),",
  "`me --json` and personal connection statuses (person), `contract --path …` for the account, the projects and the repositories,",
  "`contract --path codingAccounts` and `accounts --json` (coding accounts, and which one needs a new credential), and each",
  "project's hosts_current check with its fixedWhere (host).",
  "Also runs `gh repo view <owner>/thoughts` for each registered repository's owner, as a note: it shows the repository exists, never that the GitHub App can reach it.",
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
const personalConnections = {};
let personalGrantIncomplete = false;
let personalLinearIncomplete = false;
let personalGithubIncomplete = false;
let personalNext = null;
let workspaceResolved = false;
let repositoryRegistered = false;
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
let localSync;
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
  // Supplemental only: local caches are optional and do not change setup completion or --next.
  localSync = await runLocalSync({ waitSeconds: 0 });
  machineLines.push(
    `note optional local sync ${localSync.assessment.verdict}: ${localSync.assessment.reason}; check with 'node scripts/local-sync.mjs', and start only with the person's opt-in via 'node scripts/local-sync.mjs --start'`,
  );
} else {
  localSync = {
    assessment: { verdict: "unknown", current: false, reason: "connect this machine before local freshness can be checked" },
    started: false,
    recovery: "catalyst-skills login",
  };
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
    const grantLines = [];
    for (const provider of ["linear", "github"]) {
      const read = runCli(["connections", "personal", provider, "status", "--json"]);
      const result = tryJson(read.stdout);
      const outcome = typeof result?.outcome === "string" ? result.outcome : "unreadable";
      personalConnections[provider] = outcome;
      if (outcome === "connected") {
        grantLines.push(`personal ${provider}: connected`);
      } else if (outcome === "absent" || outcome === "lapsed") {
        personalGrantIncomplete = true;
        if (provider === "linear") personalLinearIncomplete = true;
        else personalGithubIncomplete = true;
        grantLines.push(`personal ${provider}: ${outcome === "absent" ? "not connected" : "expired"}`);
        if (provider === "linear") personalNext ??= "connect your personal linear account";
      } else {
        personalGrantIncomplete = true;
        if (provider === "linear") personalLinearIncomplete = true;
        else personalGithubIncomplete = true;
        grantLines.push(`personal ${provider}: ${outcome === "unavailable" ? "temporarily unavailable; grant state unknown" : "could not be checked; update the catalyst-skills CLI or inspect its status output"}`);
        if (provider === "linear") personalNext ??= "re-check your personal linear connection";
      }
    }
    add(
      "person",
      "catalyst-skills me, and catalyst-skills connections personal <provider> status --json",
      matched && !personalGrantIncomplete ? "ok" : "unfinished",
      [`${user.label ?? "(unnamed)"} (${user.role ?? "role unknown"})`, matched ? "Linear identity matched" : "Linear identity NOT matched — asks assigned to you cannot be told apart from everyone else's. It blocks nothing below. Run catalyst-skills identity linear options for self-service recovery; personal Linear consent normally binds its viewer automatically.", ...grantLines],
      personalGrantIncomplete ? "you" : matched ? null : "a tenant owner or admin",
      personalGrantIncomplete ? "catalyst-skills connections personal <provider> start or status" : matched ? null : link("/settings/account"),
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
    workspaceResolved = workspace !== null;
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

// The host part reads the same rows, so they are kept rather than read twice.
let teamRows = null;
// ── projects (a project is one Linear team) ───────────────────────────────────────────────────────
if (!connected) {
  add("projects", "catalyst-skills contract --path teams", "unreadable", ["not readable until this machine is connected"], null, null);
} else {
  const teams = runCli(["contract", "--path", "teams", "--json"]);
  const doc = tryJson(teams.stdout);
  const rows = Array.isArray(doc) ? doc : null;
  teamRows = rows;
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
// Cloud phases write their notes to <owner>/thoughts, where <owner> owns the code repository. The
// person's own `gh` can say whether that repository exists. It cannot say whether the GitHub App can
// reach it, so this note never claims that, and it never changes a verdict.
function thoughtsNote(owner) {
  const repo = `${owner}/thoughts`;
  const res = spawnSync("gh", ["repo", "view", repo, "--json", "name"], { encoding: "utf8", timeout: 15_000, env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
  if (res.error) return `note ${repo}: not checked (the gh command could not run here). Confirm it exists on GitHub (step 5a).`;
  if (res.status === 0) return `note ${repo}: exists; App access not verifiable from here. Confirm the GitHub App installation includes it (step 5a).`;
  const why = (res.stderr || res.stdout).trim().split("\n")[0] || `gh exited ${res.status}`;
  return `note ${repo}: gh could not see it (${why}). It does not exist, or this GitHub login cannot see it. Create or confirm it (step 5a).`;
}
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
    repositoryRegistered = rows.length > 0;
    lines.push("⛔ REGISTRATION only. This carries no status and no project attachment, so it never proves a repository can be dispatched into.");
    for (const owner of [...new Set(rows.map((r) => r.owner).filter((o) => typeof o === "string" && o !== ""))]) lines.push(thoughtsNote(owner));
    add("repositories", "catalyst-skills contract --path merge.repositories", rows.length > 0 ? "ok" : "unfinished", lines, "a tenant owner or admin", link("/settings/repositories"));
  }
}

// ── coding accounts ───────────────────────────────────────────────────────────────────────────────
// A phase runs on one of the tenant's enrolled coding accounts. With none, every step above can be
// finished and nothing will ever start, so this part blocks the "ready" line like any other.
// The contract says the state, its sentence, who enrolls one and on which page. An older cloud's
// contract has no `codingAccounts`, and only then is the owner assumed.
let accountsNext = "enrol a coding account a phase can run on";
// The contract counts accounts by declared rotation, so one healthy account can hide another whose
// credential is dead. When it says `enrolled`, each account is read as well. An account needs a new
// credential when it is quarantined, expired or revoked, or when its last polls failed on the
// credential itself. The poll fields are read only when the cloud sends them.
const CREDENTIAL_ERROR_CODES = new Set(["no_access_token", "no_credential", "http_401", "http_403", "usage_unauthorized", "usage_forbidden"]);
const CREDENTIAL_FAILURE_STREAK = 3;
const credentialProblem = (a) => {
  if (a?.quarantined === true) return `quarantined${typeof a.quarantineReason === "string" && a.quarantineReason !== "" ? `: ${a.quarantineReason}` : ""}`;
  if (a?.status === "expired-or-revoked") return "expired or revoked";
  if (CREDENTIAL_ERROR_CODES.has(a?.lastPollErrorCode) && typeof a?.pollFailureCount === "number" && a.pollFailureCount >= CREDENTIAL_FAILURE_STREAK) {
    return `its last ${a.pollFailureCount} polls failed with ${a.lastPollErrorCode}`;
  }
  return null;
};
const readAccountRows = () => {
  const acc = runCli(["accounts", "--json"]);
  const doc = tryJson(acc.stdout);
  const rows = Array.isArray(doc) ? doc : Array.isArray(doc?.accounts) ? doc.accounts : null;
  return { rows, error: rows === null ? (acc.stderr || acc.stdout).trim().split("\n")[0] || "no output" : null };
};
if (!connected) {
  add("coding accounts", "codingAccounts in catalyst-skills contract", "unreadable", ["not readable until this machine is connected"], null, null);
} else {
  const res = runCli(["contract", "--path", "codingAccounts", "--json"]);
  const ca = tryJson(res.stdout);
  const older = ca === null && /has nothing at/.test(res.stderr ?? "");
  const INSTRUMENT = "codingAccounts in catalyst-skills contract";
  if (ca !== null && typeof ca === "object" && typeof ca.state === "string") {
    const line = typeof ca.line === "string" ? ca.line : `state ${ca.state}`;
    const owner = typeof ca.enrolledByLine === "string" ? ca.enrolledByLine : null;
    const where = typeof ca.page === "string" ? link(ca.page) : null;
    if (ca.state === "enrolled" || ca.state === "needs_credential") {
      const DETAIL = `${INSTRUMENT}, and catalyst-skills accounts`;
      const head = [line, `${ca.activeCount ?? "?"} active`];
      const { rows, error } = readAccountRows();
      const dead = rows === null ? [] : rows.filter((a) => credentialProblem(a) !== null);
      if (rows === null) {
        accountsNext = "read the coding accounts again; each account's credential could not be checked";
        add("coding accounts", DETAIL, "unreadable", [...head, `coding accounts could not be checked in detail (${error}). Whether each one still has a working credential is unknown. Do not enroll one on this reading.`], null, null);
      } else if (dead.length > 0) {
        const name = (a) => `${a.provider ?? "unknown provider"} account ${a.accountSlot ?? "?"}`;
        const more = dead.length > 1 ? ` (and ${dead.length - 1} more)` : "";
        accountsNext = `${name(dead[0])} needs a new credential${more}. Replace it on the AI accounts page (Settings → AI accounts → the account → Replace credential). Do not enroll another account.`;
        add(
          "coding accounts",
          DETAIL,
          "unfinished",
          [...head, ...dead.map((a) => `${name(a)} needs a new credential: ${credentialProblem(a)}`), "Replace its credential on its own page. Do not enroll another account. The steps are in references/replacing-a-credential.md."],
          owner,
          where,
        );
      } else if (ca.state === "needs_credential") {
        accountsNext = "replace the credential of the coding account the page marks; do not enroll another account";
        add("coding accounts", DETAIL, "unfinished", [...head, "The contract says an account needs a new credential, and the account list does not say which. Open the page and look for it."], owner, where);
      } else {
        add("coding accounts", DETAIL, "ok", [...head, `${rows.length} checked, none needs a new credential`]);
      }
    } else if (ca.state === "inactive") {
      accountsNext = "reactivate a coding account that is out of rotation; do not enroll another one";
      add("coding accounts", INSTRUMENT, "unfinished", [line, "Every account is out of rotation. Reactivate one. Do not enroll another account."], owner, where);
    } else if (ca.state === "none_enrolled") {
      add("coding accounts", INSTRUMENT, "unfinished", [line, "no phase can start until one is enrolled"], owner, where);
    } else {
      // `unread`, or a state this bundle does not know: could not look is not the same as none there.
      accountsNext = "read the coding accounts again; the cloud could not read them this time";
      add("coding accounts", INSTRUMENT, "unreadable", [line, "This is not a missing account. Do not enroll one on this reading. Run this again later."], null, null);
    }
  } else if (older) {
    const { rows, error } = readAccountRows();
    const olderLine = "this cloud is older than the bundle: its contract does not say whether a coding account is enrolled, so the account list is read instead";
    if (rows === null) {
      add("coding accounts", "catalyst-skills accounts", "unreadable", [olderLine, `coding accounts could not be read (${error})`], null, null);
    } else {
      // An expired or revoked slot, or a quarantined one, cannot take work until an admin acts on it.
      const usable = rows.filter((a) => a?.status !== "expired-or-revoked" && a?.quarantined !== true);
      const lines = [olderLine, `${rows.length} enrolled, ${usable.length} able to take work`];
      for (const a of rows) lines.push(`${a.accountSlot ?? "?"}: ${a.provider ?? "?"}, ${a.status ?? "status unknown"}${a.quarantined ? ", quarantined" : ""}`);
      if (usable.length === 0) lines.push("no phase can start until one is enrolled and able to take work");
      add("coding accounts", "catalyst-skills accounts", usable.length > 0 ? "ok" : "unfinished", lines, "a tenant owner or admin", link("/settings/coding-accounts"));
    }
  } else {
    accountsNext = "read the coding accounts again; the contract could not be read";
    add("coding accounts", INSTRUMENT, "unreadable", [`the contract could not be read (${(res.stderr || res.stdout).trim().split("\n").pop() || "no output"}); try: catalyst-skills contract --refresh`], null, null);
  }
}

// ── host ──────────────────────────────────────────────────────────────────────────────────────────
// Read off the contract, never assumed: each checked project carries a hosts_current check, and the
// contract says who owns it. The check is account-wide, so any one project's reading is the answer.
// A tenant that runs no host of its own reads `pass` here, and then nothing is asked of anyone.
if (!connected) {
  add("host", "hosts_current in catalyst-skills contract --path teams", "unreadable", ["not readable until this machine is connected"], null, null);
} else {
  const checks = (teamRows ?? []).flatMap((t) => (Array.isArray(t.readiness?.checks) ? t.readiness.checks : []).filter((c) => c.id === "hosts_current").map((c) => ({ ...c, team: t.key ?? t.id ?? "(unkeyed)" })));
  const meta = tryJson(runCli(["contract", "--path", "readinessChecks", "--json"]).stdout);
  const row = Array.isArray(meta) ? meta.find((r) => r.id === "hosts_current") : null;
  const hc = checks.find((c) => c.state === "fail") ?? checks.find((c) => c.state === "unknown") ?? checks[0] ?? null;
  // The contract's printed line for this owner is written for a host that is behind. When no host is
  // connected there is nothing behind, so the owner is named by its id instead of by that sentence.
  const owner = row?.fixedBy === undefined
    ? "the contract names no owner for hosts_current"
    : hc?.state === "fail" && typeof row.fixedByLine === "string"
      ? row.fixedByLine
      : `the host operator (the contract's owner for hosts_current: ${row.fixedBy})`;
  // Where the owner acts comes from the contract's `fixedWhere`. Null (every fixer today, and absent on
  // an older cloud) means no page exists, so the owner sentence is printed alone and no page is made up.
  const fw = row?.fixedWhere && typeof row.fixedWhere.page === "string" ? row.fixedWhere : null;
  const how = fw === null ? null : link(fw.page);
  const howLines = fw?.command ? [`the owner runs: ${fw.command}`] : [];
  if (hc === null) {
    add("host", "hosts_current in catalyst-skills contract --path teams", "unreadable", [teamRows === null ? "the project list could not be read, so the host check cannot be either" : "no project has a readiness check yet, so whether a host is connected cannot be read. Press Re-check on the projects page."], "a tenant owner or admin", link("/settings/linear-teams"));
  } else if (hc.state === "pass") {
    add("host", "hosts_current in catalyst-skills contract --path teams", "ok", [`hosts_current pass (read on ${hc.team})`]);
  } else {
    const detail = hc.reason === "no_host_connected" ? "no Catalyst host is connected" : hc.reason === "hosts_behind" ? "a connected host runs an older mapping" : hc.reason === "hosts_unreported" ? "a host is connected but has not reported what it loaded" : `state ${hc.state}`;
    add("host", "hosts_current in catalyst-skills contract --path teams", "unfinished", [`hosts_current ${hc.state}${hc.reason ? ` (${hc.reason})` : ""} on ${hc.team}: ${detail}`, ...howLines], owner, how);
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
  person: personalLinearIncomplete
    ? personalNext
    : personalGithubIncomplete && repositoryRegistered
      ? "connect your personal github account"
      : personalGithubIncomplete
        ? "install the tenant GitHub App and register its repository before connecting your personal GitHub account"
        : "get this person's seat and Linear identity sorted",
  account: "connect Linear, and install the GitHub App",
  projects: "pick ONE project and map its stages (or adopt the Catalyst workflow)",
  repositories: "register the repository, attaching it to the project you mapped",
  "coding accounts": accountsNext,
  host: "connect a Catalyst host",
};
// A personal Linear grant cannot start until the tenant's Linear workspace exists. Once that account
// connection is present, a missing personal grant becomes the next member step before project setup.
const personPart = parts.find((p) => p.part === "person");
// A personal Linear grant is the next provider step once the tenant workspace exists. A personal
// GitHub grant is sequenced after the tenant GitHub App: successful repository registration is the
// onboarding path's existing proof that the App installation is usable.
if (personPart && personalGrantIncomplete && workspaceResolved) {
  personPart.blocking = personalLinearIncomplete || (personalGithubIncomplete && repositoryRegistered);
}
const blocked = parts.filter((p) => p.verdict !== "ok" && p.blocking);
const stuck = blocked[0] ?? parts.find((p) => p.verdict !== "ok") ?? null;
const next =
  stuck === null
    ? null
    : { part: stuck.part, action: NEXT[stuck.part], owner: stuck.owner, where: stuck.where, blocking: stuck.blocking };
const finished = parts.every((p) => p.verdict === "ok");

if (flags.json) {
  console.log(JSON.stringify({ cli: via, connected, cloud, personalConnections, parts, localSync, next, finished }));
} else if (flags.next) {
  if (next === null) console.log("nothing left: every part is finished, a coding account is enrolled and the host check passes. Move one card into the project's dispatch stage.");
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
