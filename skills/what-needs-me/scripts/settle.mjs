#!/usr/bin/env node
// settle.mjs — record the human's answer on an ask and release the work it held.
// 1. `catalyst-skills ask accept <ask> --answer <commentId> --role <role>` records which comment is
//    the accepted answer, as the app actor.
// 2. Every open ticket the ask blocks gets one bookkeeping comment naming the ask and the answer,
//    so the next agent on that ticket reads the decision without opening the ask.
// 3. With --close, the ask moves to its team's done slot (the contract's mapping), since a settled
//    ask is a closed record.
import { mustRun, parseFlags, parseJson, printHelp, runCli } from "./lib/cli.mjs";

const SPEC = {
  answer: { value: true, help: "the id of the comment that holds the human's answer (required)" },
  role: { value: true, help: "the role recording it, e.g. steward or concierge (required)" },
  close: { value: false, help: "also move the ask to the done slot" },
  "no-release-note": { value: false, help: "skip the bookkeeping comment on the held tickets" },
  json: { value: false, help: "print what happened as JSON" },
};

const { help, flags, positionals } = parseFlags(process.argv.slice(2), SPEC);
const askTicket = positionals[0];
if (help || !askTicket || !flags.answer || !flags.role) {
  printHelp("node scripts/settle.mjs <askTicket> --answer <commentId> --role <role> [--close] [--no-release-note] [--json] [--help]", SPEC, [
    "The answer must already be a comment on the ask. When it arrived in chat, post it there first with",
    "the catalyst-linear skill's comment script (as the app actor, never as the human), then settle with that",
    "comment's id. A free-text reply that names no option is recorded exactly as written, never interpreted.",
  ]);
  process.exit(help ? 0 : 1);
}

const detail = parseJson(mustRun(["query", "issue", askTicket, "--json"], { quiet: true }).stdout, "issue");
const comments = Array.isArray(detail.comments) ? detail.comments : [];
const answer = comments.find((c) => String(c.id) === String(flags.answer));
if (!answer) {
  process.stderr.write(`comment ${flags.answer} is not on ${detail.identifier ?? askTicket} (${comments.length} comment${comments.length === 1 ? "" : "s"} read); post the answer there first\n`);
  process.exit(1);
}
const answerLine = String(answer.body ?? "").trim().split("\n")[0].slice(0, 200) || "(empty comment)";

const accepted = parseJson(mustRun(["ask", "accept", askTicket, "--answer", flags.answer, "--role", flags.role, "--json"], { quiet: true }).stdout, "ask accept");

const relations = Array.isArray(detail.relations) ? detail.relations : [];
const held = [...new Set(relations
  .filter((r) => r.type === "blocks" && (r.issue_identifier === detail.identifier || r.issue_identifier === undefined))
  .map((r) => r.related_identifier ?? r.related_issue_identifier)
  .filter((id) => typeof id === "string"))];

const released = [];
const failed = [];
if (!flags["no-release-note"]) {
  for (const t of held) {
    const body = `${detail.identifier ?? askTicket} was answered (comment ${flags.answer}, recorded by ${flags.role}): ${answerLine}`;
    const r = runCli(["write", "comment", t, "--bookkeeping", "--body", body, "--json"]);
    if (r.code === 0) released.push(t);
    else failed.push({ ticket: t, error: (r.stderr || `exit ${r.code}`).trim().split("\n").at(-1) });
  }
}

let closed = false;
if (flags.close) {
  const r = runCli(["write", "state", askTicket, "--slot", "done", "--json"]);
  if (r.code === 0) closed = true;
  else failed.push({ ticket: askTicket, error: (r.stderr || `exit ${r.code}`).trim().split("\n").at(-1) });
}

const out = { ask: detail.identifier ?? askTicket, answerComment: flags.answer, role: flags.role, answer: answerLine, accepted, held, released, closed, failed };
if (flags.json) process.stdout.write(JSON.stringify(out) + "\n");
else {
  process.stdout.write(`${out.ask}: answer ${flags.answer} recorded by ${flags.role} — "${answerLine}"\n`);
  process.stdout.write(held.length ? `held: ${held.join(", ")}; release note posted on: ${released.join(", ") || "none"}\n` : "held nothing\n");
  if (closed) process.stdout.write(`${out.ask} moved to the done slot\n`);
  for (const f of failed) process.stdout.write(`failed on ${f.ticket}: ${f.error}\n`);
}
process.exit(failed.length ? 1 : 0);
