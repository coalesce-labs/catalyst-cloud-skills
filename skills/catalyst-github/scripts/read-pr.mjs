#!/usr/bin/env node
// read-pr.mjs — one ticket's pull request (or one PR by node id) as the mirror holds it: state,
// branch, head, base, linked ticket and its stage, GitHub's own mergeable verdict, every check,
// review and commit status. Reads through `catalyst-skills query`; composes no URL.
import { linkedPulls, resolvePull, truthy } from "./lib/pull.mjs";

const HELP = `Usage: node scripts/read-pr.mjs <ticket | pr-node-id> [--all] [--json]

  <ticket>       a ticket identifier such as ABC-123: its open PR is shown (else the merged one, else the newest)
  <pr-node-id>   a GitHub pull-request node id, as printed by "catalyst-skills query pulls"
  --all          for a ticket: list every PR that names it instead of one detail
  --json         print the raw detail document instead of the summary

Exit 0 shown, 1 not found or no PR yet, 2 this machine is not connected to a tenant.
The first stderr line names the source the CLI read from (a fresh replica, or the API).`;

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
const json = args.includes("--json");
const all = args.includes("--all");
const target = args.find((a) => !a.startsWith("--"));
if (!target) {
  console.error("read-pr needs a ticket or a PR node id");
  console.log(HELP);
  process.exit(1);
}

function fmt(v, fallback = "?") {
  return v === null || v === undefined || v === "" ? fallback : String(v);
}

function when(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : fmt(ms, "");
}

if (all) {
  if (!/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(target)) {
    console.error("--all takes a ticket identifier");
    process.exit(1);
  }
  const { pulls } = linkedPulls(target);
  if (json) {
    console.log(JSON.stringify(pulls));
    process.exit(0);
  }
  if (pulls.length === 0) {
    console.log(`${target}: no pull request names this ticket yet`);
    process.exit(1);
  }
  for (const p of pulls) {
    const flags = [truthy(p.draft) ? "draft" : null, truthy(p.merged) ? "merged" : null].filter(Boolean).join(" ");
    console.log(`${fmt(p.repo_id)}#${fmt(p.number)}  ${fmt(p.state)}${flags ? ` ${flags}` : ""}  ${fmt(p.title, "")}  [${fmt(p.node_id, "")}]`);
  }
  process.exit(0);
}

const { ticket, detail } = resolvePull(target);
if (json) {
  console.log(JSON.stringify(detail));
  process.exit(0);
}

const checks = Array.isArray(detail.checks) ? detail.checks : [];
const reviews = Array.isArray(detail.reviews) ? detail.reviews : [];
const statuses = Array.isArray(detail.commit_statuses) ? detail.commit_statuses : [];
const state = [fmt(detail.state), truthy(detail.draft) ? "draft" : null, truthy(detail.merged) ? `merged ${when(detail.merged_at)}` : null].filter(Boolean).join(", ");

console.log(`${fmt(detail.repo_id)}#${fmt(detail.number)}  ${fmt(detail.title, "(no title yet)")}`);
console.log(`state: ${state}  by ${fmt(detail.author_login)}  opened ${when(detail.created_at)}  updated ${when(detail.updated_at)}`);
console.log(`branch: ${fmt(detail.head_ref)} → ${fmt(detail.base_ref)}  head ${fmt(detail.head_sha).slice(0, 12)}`);
console.log(`ticket: ${fmt(ticket ?? detail.linear_issue_identifier, "none named")}${detail.linked_issue_state ? ` (stage: ${detail.linked_issue_state})` : ""}`);
console.log(`github says: mergeable=${fmt(detail.mergeable, "unknown")} state=${fmt(detail.mergeable_state, "unknown")} auto-merge=${truthy(detail.auto_merge) ? "on" : "off"}`);
if (detail.blocked_on_ask && typeof detail.blocked_on_ask === "object") {
  const b = detail.blocked_on_ask;
  console.log(`blocked on an ask: ${fmt(b.identifier ?? b.id, "")} ${fmt(b.title, "")}`.trim());
}
console.log(`node id: ${fmt(detail.node_id)}`);

console.log(`checks (${checks.length}):`);
if (checks.length === 0) console.log("  none reported at this head yet");
for (const c of checks) console.log(`  ${fmt(c.status)}/${fmt(c.conclusion, "-")}  ${fmt(c.name)}`);

if (statuses.length > 0) {
  console.log(`commit statuses (${statuses.length}):`);
  for (const s of statuses) console.log(`  ${fmt(s.state)}  ${fmt(s.context)}`);
}

console.log(`reviews (${reviews.length}):`);
if (reviews.length === 0) console.log("  none mirrored; a reviewer's clean pass is a reaction, which this read does not carry");
for (const r of reviews) console.log(`  ${fmt(r.state)}  ${fmt(r.reviewer_name, fmt(r.reviewer_id))}  ${when(r.submitted_at)}`);

console.log("not visible to an account key here: PR labels (holds, queue attestation) and the reviewer's reaction — see references/what-a-pr-accumulates.md");
process.exit(0);
