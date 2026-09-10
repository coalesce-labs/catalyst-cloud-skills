#!/usr/bin/env node
// is-it-mergeable.mjs — the three legs of merge evidence for one PR (checks, reviewer signal,
// unresolved threads) judged under the policy the tenant contract resolves for its repository, plus
// the prerequisites a queue applies before any leg counts (open, not a draft, no conflict). Every
// input comes from `catalyst-skills query`, `contract` and, when fresh, `replica sql`.
// Exit 0 no leg is red, 1 a leg or prerequisite is red, 2 this machine is not connected.
import { parseJson, runCli, runCliOrExit } from "./lib/cli.mjs";
import { resolvePull, truthy } from "./lib/pull.mjs";

const HELP = `Usage: node scripts/is-it-mergeable.mjs <ticket | pr-node-id> [--json]

Judges one pull request against the merge policy the tenant contract resolves for its repository:
  checks     every gating check at the head completed without failing (pending or absent is not green)
  reviewer   the reviewer signal the policy requires; the clean-pass reaction itself is not mirrored,
             so this leg is reported as inconclusive rather than guessed, unless the policy waives it
  threads    zero unresolved review threads, read from the local replica when it is fresh

A red prerequisite (closed, draft, merge conflict) is also exit 1. Inconclusive legs never fail the
exit code; the cloud's own evaluator, which holds the reaction and the thread ancestry, is authoritative.
--json prints {pr, policy, legs[], verdict} instead of lines.`;

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}
const json = args.includes("--json");
const target = args.find((a) => !a.startsWith("--"));
if (!target) {
  console.error("is-it-mergeable needs a ticket or a PR node id");
  process.exit(1);
}

const { ticket, detail } = resolvePull(target);
const merge = parseJson(runCliOrExit(["contract", "--path", "merge", "--json"]).stdout);
if (!merge || !Array.isArray(merge.policies)) {
  console.error("the contract's merge block did not parse; run: catalyst-skills contract --refresh");
  process.exit(1);
}

const repoId = String(detail.repo_id ?? "");
const repoRow = (merge.repositories ?? []).find((r) => `${r.owner}/${r.name}`.toLowerCase() === repoId.toLowerCase());
const policy = repoRow?.policy ?? merge.defaultPolicy;
const policySource = repoRow ? repoRow.policySource : "default";
const requiresReviewer = policy !== "checks-and-threads";
const acceptsEarlierHead = policy === "codex-attestation";

const legs = [];
const add = (leg, state, line) => legs.push({ leg, state, line });

// ── prerequisites the queue applies before any leg counts ──────────────────────────────────────
if (truthy(detail.merged)) {
  add("state", "pass", `already merged${detail.merged_at ? ` at ${new Date(Number(detail.merged_at)).toISOString()}` : ""}; nothing left to judge`);
} else {
  const state = String(detail.state ?? "").toLowerCase();
  if (state && state !== "open") add("state", "fail", `the PR is ${state}, not open`);
  else if (truthy(detail.draft)) add("state", "fail", "the PR is still a draft; the pr phase marks it ready for review, a queue never takes a draft");
  else add("state", "pass", "open and ready for review");
  const ms = String(detail.mergeable_state ?? "").toLowerCase();
  if (ms === "dirty" || detail.mergeable === false || detail.mergeable === 0) add("conflict", "fail", `GitHub reports a merge conflict with the base branch (mergeable_state=${ms || "unknown"}); a remediate round rebases it`);
  else if (ms) add("conflict", "pass", `GitHub reports mergeable_state=${ms}`);
  else add("conflict", "inconclusive", "GitHub has not reported a mergeable state for this head yet");
}

// ── leg 1: checks ───────────────────────────────────────────────────────────────────────────────
const checks = Array.isArray(detail.checks) ? detail.checks : [];
const required = Array.isArray(merge.cloudRemediateRequiredChecks) ? merge.cloudRemediateRequiredChecks : [];
const notQueue = checks.filter((c) => !/mergify|^queue:|^summary$/i.test(String(c.name ?? "")));
const gating = notQueue.filter((c) => required.includes(String(c.name)));
const judged = gating.length > 0 ? gating : notQueue;
const ok = new Set(["success", "neutral", "skipped"]);
const red = judged.filter((c) => String(c.status).toLowerCase() === "completed" && !ok.has(String(c.conclusion).toLowerCase()));
const pending = judged.filter((c) => String(c.status).toLowerCase() !== "completed");
const statuses = Array.isArray(detail.commit_statuses) ? detail.commit_statuses : [];
const redStatuses = statuses.filter((s) => ["failure", "error"].includes(String(s.state).toLowerCase()));
const scope = gating.length > 0 ? `the ${gating.length} required check(s) the contract names` : `every mirrored check (none of the contract's required names is present at this head)`;
if (judged.length === 0 && redStatuses.length === 0) add("checks", "inconclusive", "no check has reported at this head; an unrun set is unknown, never green");
else if (red.length > 0 || redStatuses.length > 0) add("checks", "fail", `red: ${[...red.map((c) => `${c.name} (${c.conclusion})`), ...redStatuses.map((s) => `${s.context} (${s.state})`)].join(", ")}`);
else if (pending.length > 0) add("checks", "inconclusive", `still running: ${pending.map((c) => c.name).join(", ")} — judged over ${scope}`);
else add("checks", "pass", `green over ${scope}`);

// ── leg 2: the reviewer signal ─────────────────────────────────────────────────────────────────
const reviews = Array.isArray(detail.reviews) ? detail.reviews : [];
const login = String(merge.reviewerLogin ?? "");
const byReviewer = reviews.filter((r) => String(r.reviewer_name ?? "") === login || String(r.reviewer_id ?? "") === `github:${login}`);
if (!requiresReviewer) add("reviewer", "pass", `policy ${policy} needs no reviewer signal`);
else if (byReviewer.length > 0) {
  const states = [...new Set(byReviewer.map((r) => String(r.state ?? "?")))].join(", ");
  add("reviewer", "inconclusive", `${login} left ${byReviewer.length} review object(s) (${states}); whether they stand at the current head or an earlier one, and whether a clean-pass reaction followed, is not mirrored${acceptsEarlierHead ? " — under this policy, findings on an earlier head plus green checks and zero unresolved threads are accepted" : " — this policy requires a clean pass at the current head"}`);
} else add("reviewer", "inconclusive", `no review object from ${login} is mirrored; a clean pass is a reaction, which this read cannot see`);

// ── leg 3: unresolved threads, from the replica when it is fresh ───────────────────────────────
const replica = parseJson(runCli(["replica", "status", "--json"]).stdout);
if (replica && replica.verdict === "fresh") {
  const num = Number(detail.number);
  const esc = repoId.replace(/'/g, "''");
  const sql = `select resolved, count(*) as n from pr_review_threads where repo_id = '${esc}' and pr_number = ${Number.isInteger(num) ? num : -1} group by resolved`;
  const rows = parseJson(runCli(["replica", "sql", sql, "--json"]).stdout) ?? [];
  const count = (want) => rows.filter((r) => (want === null ? r.resolved === null || r.resolved === undefined : Number(r.resolved) === want)).reduce((a, r) => a + Number(r.n ?? 0), 0);
  const unresolved = count(0);
  const unknown = count(null);
  if (unresolved > 0) add("threads", "fail", `${unresolved} unresolved review thread(s)`);
  else if (unknown > 0) add("threads", "inconclusive", `${unknown} thread(s) with no resolved flag mirrored`);
  else add("threads", "pass", `${count(1)} thread(s), all resolved (ancestry against force-pushes is judged by the cloud, not here)`);
} else {
  add("threads", "inconclusive", `the PR detail carries no thread count and the replica is ${replica?.verdict ?? "unavailable"}; start it (catalyst-skills replica start --detach) for a local read`);
}

const failed = legs.filter((l) => l.state === "fail");
const open = legs.filter((l) => l.state === "inconclusive");
let verdict;
if (failed.length > 0) verdict = `NOT MERGEABLE: ${failed.map((l) => l.leg).join(", ")}`;
else if (open.length > 0) verdict = `NOT PROVEN MERGEABLE from this read (${open.map((l) => l.leg).join(", ")} inconclusive); the cloud's evaluator decides`;
else verdict = "MERGEABLE as far as this read can see";

const header = `${repoId}#${detail.number ?? "?"}${ticket ? ` (${ticket})` : ""} head ${String(detail.head_sha ?? "").slice(0, 12)} — policy ${policy} (${policySource})`;
if (json) {
  console.log(JSON.stringify({ pr: { repo_id: repoId, number: detail.number, node_id: detail.node_id, ticket, head_sha: detail.head_sha }, policy: { name: policy, source: policySource }, legs, verdict }));
} else {
  console.log(header);
  for (const l of legs) console.log(`${l.state === "pass" ? "ok  " : l.state === "fail" ? "FAIL" : "?   "}  ${l.leg}: ${l.line}`);
  console.log(verdict);
}
process.exit(failed.length > 0 ? 1 : 0);
