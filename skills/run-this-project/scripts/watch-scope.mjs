#!/usr/bin/env node
// watch-scope.mjs — subscribe to the tenant stream filtered to one scope and pass every in-scope
// frame through, one JSON line each. This is `catalyst-skills watch` with the scope flags checked
// up front; the CLI owns the socket, the cursor file, the replay and the reconnects.
import { CHECK_FAILED_EXIT, execCli, parseFlags, requireConfigured, wantsHelp } from "./lib/cli.mjs";

const HELP = `Usage: node scripts/watch-scope.mjs (--project <id> | --team <key> | --ticket <id>...) [options]

Streams one JSON line per change inside the scope: a ticket, a comment, a pull request, a check, a
review thread, an agent session or a fleet anomaly. Runs until the session ends (Ctrl-C).

Scope (at least one; they combine):
  --project <id>      every ticket in this Linear project, resolved through the ticket's own record
  --team <key>        every ticket whose identifier carries this team key
  --ticket <id>       one ticket (repeatable)

Options:
  --exec <command>    run this shell command once per frame with the frame on stdin; a non-zero exit
                      is a failed reaction, so the cursor holds and the frame is offered again
  --from cursor|head  start from the saved cursor (default) or skip straight to the tenant head
  --cursor-file <p>   where the cursor lives (default ~/.config/catalyst-cloud/watch-cursor.json)
  --help              this text

Exit codes: 2 not connected; 1 no scope given; otherwise the CLI's own exit code.

In Claude Code, arm a monitor on this command and react to each line in the same turn. In a harness
with no monitor, pass --exec so the reaction still happens per frame and nothing polls.`;

const argv = process.argv.slice(2);
if (wantsHelp(argv)) {
  console.log(HELP);
  process.exit(0);
}
const { flags, positionals } = parseFlags(argv, {
  values: ["project", "team", "exec", "from", "cursor-file"],
  repeat: ["ticket"],
});
if (positionals.length > 0) {
  console.error(`unexpected argument: ${positionals[0]} (scope is given with --project, --team or --ticket)`);
  process.exit(CHECK_FAILED_EXIT);
}
if (!flags.project && !flags.team && !(flags.ticket && flags.ticket.length)) {
  console.error("watch-scope needs a scope: --project <id>, --team <key> or --ticket <id> (see --help)");
  process.exit(CHECK_FAILED_EXIT);
}
if (flags.from && flags.from !== "cursor" && flags.from !== "head") {
  console.error("--from must be cursor or head");
  process.exit(CHECK_FAILED_EXIT);
}
requireConfigured();

const args = ["watch"];
if (flags.project) args.push("--project", flags.project);
if (flags.team) args.push("--team", flags.team);
for (const t of flags.ticket ?? []) args.push("--ticket", t);
if (flags.exec) args.push("--exec", flags.exec);
if (flags.from) args.push("--from", flags.from);
if (flags["cursor-file"]) args.push("--cursor-file", flags["cursor-file"]);

const code = await execCli(args);
process.exit(code);
