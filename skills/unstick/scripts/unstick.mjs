#!/usr/bin/env node
// unstick.mjs — "why is this stuck, and can it be released?" in one JSON document. Runs
// `catalyst-skills explain`, `explain --history` and a dry-run `release` for one ticket (or a dry-run
// class release for one team), and only with --because runs the real release. Reaches the cloud only
// by spawning the CLI.
import { mustRun, parseFlags, parseJson, printHelp, runCli } from "./lib/cli.mjs";

const SPEC = {
  because: { value: true, help: "what changed since the ticket was held; runs the real release after the preview" },
  "retry-unchanged": { value: false, help: "release even though nothing the cloud can see changed (say what did in --because)" },
  class: { value: true, help: "release every ticket on --team parked under this failure class" },
  team: { value: true, help: "with --class: the team key" },
  limit: { value: true, help: "with --class: at most this many tickets (the cloud caps it at 25)" },
};

const { help, flags, positionals } = parseFlags(process.argv.slice(2), SPEC);
const ticket = positionals[0];
const byClass = typeof flags.class === "string";
if (help || (!ticket && !byClass) || (byClass && (ticket || typeof flags.team !== "string"))) {
  printHelp("node scripts/unstick.mjs <ticket> [--because <text>] [--retry-unchanged] [--help] | --class <c> --team <K> [--because <text>] [--retry-unchanged] [--limit N] [--help]", SPEC, [
    "Without --because it changes nothing: it prints the explanation, the history (every governor holding the ticket",
    "and past releases) and a dry-run release. With --because it then runs the real release. Read references/playbook.md",
    "before passing --because. A refused release exits 1 with the refusals in the document.",
  ]);
  process.exit(help ? 0 : 1);
}

const releaseArgs = byClass ? ["release", "--class", flags.class, "--team", flags.team] : ["release", ticket];
if (flags["retry-unchanged"]) releaseArgs.push("--retry-unchanged");
if (byClass && typeof flags.limit === "string") releaseArgs.push("--limit", flags.limit);

const out = {};
if (!byClass) {
  out.explain = parseJson(mustRun(["explain", ticket, "--json"]).stdout, "explain");
  out.history = parseJson(mustRun(["explain", ticket, "--history", "--json"]).stdout, "history");
}

const preview = runCli([...releaseArgs, "--dry-run", "--json"]);
if (preview.code !== 0 && preview.code !== 1) {
  process.stderr.write(preview.stderr);
  process.exit(preview.code);
}
out.preview = parseJson(preview.stdout, "the dry-run release");

let exit = 0;
if (typeof flags.because === "string") {
  const real = runCli([...releaseArgs, "--because", flags.because, "--json"]);
  if (real.code !== 0 && real.code !== 1) {
    process.stderr.write(real.stderr);
    process.exit(real.code);
  }
  out.release = parseJson(real.stdout, "the release");
  exit = real.code;
}

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
process.exit(exit);
