#!/usr/bin/env node
// lib/pull.mjs — resolve "a ticket or a PR id" to one mirrored pull-request detail, the way both
// scripts in this skill need it. A ticket resolves through its own record's linked pull requests
// (the mirror links a PR to the ticket its text names), then the chosen PR's detail is read by node
// id. A library: run read-pr.mjs or is-it-mergeable.mjs with --help for usage.
import { fileURLToPath } from "node:url";
import { forwardSourceLine, looksLikeTicket, parseJson, runCli, runCliOrExit } from "./cli.mjs";

export function truthy(v) {
  return v === true || v === 1 || v === "1" || v === "true";
}

function readIssue(ticket, extra = []) {
  const res = runCli(["query", "issue", ticket, ...extra, "--json"]);
  forwardSourceLine(res);
  if (res.code !== 0) {
    console.error(res.stderr.trim() || `${ticket}: not found`);
    process.exit(res.code === 2 ? 2 : 1);
  }
  const issue = parseJson(res.stdout);
  if (!issue || typeof issue !== "object") {
    console.error(`${ticket}: the ticket read did not return JSON`);
    process.exit(1);
  }
  return issue;
}

/**
 * Every PR that names the ticket, newest number first. Exits 1 when the ticket is unknown. A source
 * whose ticket detail carries no `linked_pulls` field at all (a replica built by an SDK that predates
 * the ticket-to-PR link) is not evidence of "no PR": the ticket is re-read from the API, which is
 * origin-fresh and carries the field, and the second source line says so. An empty list from a source
 * that has the field is a real "no PR yet".
 */
export function linkedPulls(ticket) {
  let issue = readIssue(ticket);
  if (issue.linked_pulls === undefined) {
    console.error("note: this source carries no linked pull requests on a ticket; re-reading the ticket from the API");
    issue = readIssue(ticket, ["--source", "api"]);
  }
  const pulls = Array.isArray(issue.linked_pulls) ? issue.linked_pulls : [];
  return { issue, pulls: [...pulls].sort((a, b) => Number(b.number ?? 0) - Number(a.number ?? 0)) };
}

/** The PR that matters for a ticket: an open one first, else the merged one, else the newest. */
export function pickPull(pulls) {
  const open = pulls.find((p) => String(p.state ?? "").toLowerCase() === "open" && !truthy(p.merged));
  if (open) return open;
  const merged = pulls.find((p) => truthy(p.merged));
  return merged ?? pulls[0] ?? null;
}

/** One PR's detail by node id: checks, reviews, commit statuses, mergeable state, linked ticket. */
export function pullDetail(nodeId) {
  const res = runCliOrExit(["query", "pull", nodeId, "--json"]);
  forwardSourceLine(res);
  const detail = parseJson(res.stdout);
  if (!detail || typeof detail !== "object") {
    console.error(`${nodeId}: the pull read did not return JSON`);
    process.exit(1);
  }
  return detail;
}

/** Ticket or node id → {ticket, detail, linked}. Exits 1 when a ticket has no PR yet. */
export function resolvePull(arg) {
  if (looksLikeTicket(arg)) {
    const { pulls } = linkedPulls(arg);
    const chosen = pickPull(pulls);
    if (!chosen) {
      console.error(`${arg}: no pull request names this ticket yet — the implement phase opens one when it has a branch`);
      process.exit(1);
    }
    return { ticket: arg, detail: pullDetail(String(chosen.node_id)), linked: pulls };
  }
  const detail = pullDetail(arg);
  return { ticket: detail.linear_issue_identifier ? String(detail.linear_issue_identifier) : null, detail, linked: [] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log("lib/pull.mjs is a library used by read-pr.mjs and is-it-mergeable.mjs; run those with --help for usage.");
}
