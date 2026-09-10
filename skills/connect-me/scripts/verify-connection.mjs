#!/usr/bin/env node
// verify-connection.mjs — did the connect step land? One line each for the tenant, the contract version and the
// replica, from the CLI's own verbs. The machine is connected when `status` names a tenant.
import { CHECK_FAILED_EXIT, cliCommand, loadCustomerConfig, parseFlags, runCli, wantsHelp } from "./lib/cli.mjs";

const HELP = `Usage: node scripts/verify-connection.mjs [--json]

Runs catalyst-skills status, contract --path contractVersion, and replica status, and prints one
line for each: the tenant this machine is connected to, the cached contract version, and the replica
verdict. Nothing is written.

Options:
  --json   one JSON document instead of three lines
  --help   this text

Exit codes: 1 when status reports the machine is not connected (or the CLI could not be run);
0 otherwise, whatever the replica verdict is, because the replica is optional.`;

const argv = process.argv.slice(2);
if (wantsHelp(argv)) {
  console.log(HELP);
  process.exit(0);
}
const { flags, positionals } = parseFlags(argv, { booleans: ["json"] });
if (positionals.length > 0) {
  console.error(`unexpected argument: ${positionals[0]} (see --help)`);
  process.exit(CHECK_FAILED_EXIT);
}

const cfg = loadCustomerConfig();
const { via } = cliCommand(cfg);
const out = { cli: via, connected: false, tenant: null, contractVersion: null, replica: null };

let status;
try {
  status = await runCli(["status"]);
} catch (err) {
  console.error(`could not run the CLI (${via}): ${err instanceof Error ? err.message : String(err)}`);
  process.exit(CHECK_FAILED_EXIT);
}
const tenantLine = status.stdout.split("\n").find((l) => l.startsWith("Tenant:"));
out.connected = status.code === 0 && Boolean(tenantLine) && !status.notConfigured;
out.tenant = tenantLine ? tenantLine.slice("Tenant:".length).trim() : null;

if (out.connected) {
  const contract = await runCli(["contract", "--path", "contractVersion"]);
  out.contractVersion = contract.code === 0 ? contract.stdout.trim() : null;
  out.contractError = contract.code === 0 ? undefined : (contract.stderr || contract.stdout).trim().split("\n").at(-1);
  const replica = await runCli(["replica", "status", "--json"]);
  try {
    const parsed = JSON.parse(replica.stdout);
    out.replica = { verdict: parsed.verdict, exitCode: replica.code, cursor: parsed.cursor ?? null, reasons: parsed.reasons ?? [] };
  } catch {
    out.replica = { verdict: "unknown", exitCode: replica.code, line: (replica.stdout || replica.stderr).trim() };
  }
}

if (flags.json) {
  console.log(JSON.stringify(out));
} else if (!out.connected) {
  console.log(`not connected (${via}): ${(status.stdout || status.stderr).trim().split("\n")[0] ?? "status printed nothing"}`);
} else {
  console.log(`tenant: ${out.tenant}`);
  console.log(out.contractVersion ? `contract: version ${out.contractVersion} cached` : `contract: not cached (${out.contractError ?? "unknown reason"}) — run: catalyst-skills contract --refresh`);
  const r = out.replica;
  console.log(`replica: ${r.verdict}${r.cursor !== null && r.cursor !== undefined ? ` (cursor ${r.cursor})` : ""}${r.reasons && r.reasons.length ? ` — ${r.reasons.join("; ")}` : ""}${r.verdict === "absent" ? " — optional; start it with: catalyst-skills replica start --detach" : ""}`);
}
process.exit(out.connected ? 0 : CHECK_FAILED_EXIT);
