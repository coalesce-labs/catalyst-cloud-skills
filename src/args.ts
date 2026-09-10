// args.ts — argument parsing for every verb. Positional 0 is the command, positional 1 the
// subcommand, the rest are positionals; flags are per-verb tables so an unknown flag is a usage
// error naming the verb, and every verb's --help is generated from its own table.
import { UsageError } from "./errors.js";

export type FlagValue = string | boolean | string[];

export interface ParsedArgs {
  command: string | null;
  subcommand: string | null;
  rest: string[];
  flags: Record<string, FlagValue>;
  /** Global flags, kept top-level for the verbs (and tests) that read them directly. */
  key?: string;
  baseUrl?: string;
  skillsDir?: string;
  force: boolean;
  help: boolean;
  version: boolean;
  json: boolean;
}

export interface FlagSpec {
  /** Takes a value (`--name value` / `--name=value`); otherwise boolean. */
  value: boolean;
  /** May be given more than once; collected into a string[]. */
  repeat?: boolean;
  help: string;
}

export type FlagTable = Record<string, FlagSpec>;

const GLOBAL_FLAGS: FlagTable = {
  key: { value: true, help: "account key (or CATALYST_CLOUD_TOKEN)" },
  "base-url": { value: true, help: "Catalyst Cloud origin (or CATALYST_CLOUD_BASE_URL)" },
  "skills-dir": { value: true, help: "where the skills are copied (default ~/.claude/skills)" },
  force: { value: false, help: "replace a skill directory this package did not install" },
  json: { value: false, help: "machine-readable output" },
};

/** Per-verb flag tables. A verb absent here accepts only the global flags. */
export const FLAG_TABLES: Record<string, FlagTable> = {
  join: {
    "start-replica": { value: false, help: "run `replica start --detach` after joining" },
  },
  install: {},
  status: {},
  notice: {},
  me: {},
  contract: {
    refresh: { value: false, help: "ignore the cache age and revalidate now" },
    path: { value: true, help: "print a sub-document, e.g. teams.0.stages" },
  },
  query: {
    team: { value: true, help: "team key filter" },
    project: { value: true, help: "project id filter" },
    state: { value: true, help: "state name filter" },
    limit: { value: true, help: "max rows (default 50)" },
    since: { value: true, help: "changes: the cursor to read after" },
    source: { value: true, help: "replica | api (default: replica when fresh, else api)" },
    ticket: { value: true, help: "pulls: only PRs linked to this ticket" },
  },
  replica: {
    detach: { value: false, help: "start: run the writer in the background and write a pidfile" },
    db: { value: true, help: "replica file path (default from customer.json)" },
    probe: { value: false, help: "status: also fetch the cloud head and print the lag" },
    "stale-ms": { value: true, help: "status: heartbeat age that counts as stale (default 15000)" },
  },
  explain: {
    history: { value: false, help: "per-ticket execution history (not visible to an account key yet)" },
  },
  running: {},
  queue: {
    team: { value: true, help: "team key" },
  },
  watch: {
    team: { value: true, help: "scope: a team key" },
    ticket: { value: true, repeat: true, help: "scope: a ticket identifier (repeatable)" },
    project: { value: true, help: "scope: a project id" },
    exec: { value: true, help: "run this shell command per frame with the frame on stdin" },
    "cursor-file": { value: true, help: "cursor file path (default ~/.config/catalyst-cloud/watch-cursor.json)" },
    from: { value: true, help: "cursor | head (default cursor)" },
  },
  write: {
    body: { value: true, help: "comment: the body text" },
    stdin: { value: false, help: "comment: read the body from stdin" },
    parent: { value: true, help: "comment: reply under this comment id" },
    bookkeeping: { value: false, help: "comment: prefix the contract's bookkeeping marker" },
    "as-user": { value: false, help: "post with the personal identity instead of the app actor" },
    slot: { value: true, help: "state: the workflow slot to move to" },
    "state-id": { value: true, help: "state: an explicit Linear state id" },
    "state-type": { value: true, help: "state: the first state of this type on the ticket's team (e.g. backlog)" },
    add: { value: true, repeat: true, help: "label: label name or id to add (repeatable)" },
    remove: { value: true, repeat: true, help: "label: label name or id to remove (repeatable)" },
    team: { value: true, help: "create: team key" },
    title: { value: true, help: "create/attachment/session: title" },
    label: { value: true, repeat: true, help: "create: label name or id (repeatable)" },
    priority: { value: true, help: "create: Linear priority 0-4" },
    comment: { value: true, help: "reaction: react to this comment id instead of the ticket" },
    emoji: { value: true, help: "reaction: the emoji" },
    url: { value: true, help: "attachment/session: the URL" },
    "plan-file": { value: true, help: "session: a JSON file holding the plan" },
    activity: { value: true, help: "session: one activity line" },
  },
  ask: {
    team: { value: true, help: "raise: team key" },
    title: { value: true, help: "raise: the question" },
    context: { value: true, help: "raise: context paragraph" },
    option: { value: true, repeat: true, help: "raise: an option (repeatable)" },
    default: { value: true, help: "raise: the default if silent" },
    blocks: { value: true, repeat: true, help: "raise: a ticket this decision blocks (repeatable)" },
    "nothing-to-block": { value: false, help: "raise: declare that nothing is blocked" },
    "ask-key": { value: true, help: "raise: idempotency key" },
    answer: { value: true, help: "accept: the answering comment id" },
    role: { value: true, help: "accept: the role recording the answer" },
  },
  ready: {},
  accounts: {},
};

export const VERB_USAGE: Record<string, string> = {
  join: "join [--key <account-key>] [--base-url <url>] [--skills-dir <dir>] [--force] [--start-replica]",
  install: "install [--skills-dir <dir>] [--force]",
  status: "status",
  notice: "notice",
  me: "me [--json]",
  contract: "contract [--refresh] [--path <a.b.c>] [--json]",
  query:
    "query <issues|issue <id>|pulls|pull <id>|projects|cycles|search <terms>|changes --since <n>> [--team K] [--project P] [--state S] [--limit N] [--source replica|api] [--json]",
  replica:
    "replica <start [--detach]|stop|status [--probe] [--json]|sql \"<select>\"|schema [table]> [--db <path>]",
  explain: "explain <ticket> [--history] [--json]",
  running: "running [--json]",
  queue: "queue [--team K] [--json]",
  watch: "watch [--team K] [--ticket T]... [--project P] [--exec CMD] [--cursor-file <path>] [--from cursor|head]",
  write:
    "write <comment <ticket> --body|--stdin [--parent] [--bookkeeping] [--as-user] | state <ticket> --slot|--state-id|--state-type | label <ticket> --add... --remove... | create --team --title [--label] [--priority] | reaction <ticket>|--comment <id> --emoji <e> | attachment <ticket> --title --url | session <ticket> [--title] [--plan-file] [--activity]>",
  ask: "ask <raise --team --title [--context] [--option]... [--default] --blocks <ticket>...|--nothing-to-block [--ask-key] | accept <askTicket> --answer <commentId> --role <role> | list [--json]>",
  ready: "ready [--json]",
  accounts: "accounts",
};

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    command: null,
    subcommand: null,
    rest: [],
    flags: {},
    force: false,
    help: false,
    version: false,
    json: false,
  };
  const positionals: string[] = [];
  // The per-verb table is switched in the moment the command positional is seen, so a verb's own
  // flags are accepted after it and a global flag is accepted anywhere.
  let table: FlagTable = { ...GLOBAL_FLAGS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (a === "-V" || a === "--version") {
      out.version = true;
      continue;
    }
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      let name = a.slice(2);
      let inlineValue: string | undefined;
      const eq = name.indexOf("=");
      if (eq !== -1) {
        inlineValue = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      const spec = table[name];
      if (!spec) {
        throw new UsageError(
          out.command ? `unknown option for ${out.command}: --${name}` : `unknown option: --${name}`,
        );
      }
      if (spec.value) {
        const v = inlineValue ?? requireValue(argv, ++i, `--${name}`);
        if (spec.repeat) {
          const prev = out.flags[name];
          out.flags[name] = Array.isArray(prev) ? [...prev, v] : [v];
        } else {
          out.flags[name] = v;
        }
      } else {
        if (inlineValue !== undefined) throw new UsageError(`--${name} takes no value`);
        out.flags[name] = true;
      }
      continue;
    }
    if (a.startsWith("-") && a.length > 1) throw new UsageError(`unknown option: ${a}`);
    positionals.push(a);
    if (positionals.length === 1) {
      out.command = a;
      table = { ...GLOBAL_FLAGS, ...(FLAG_TABLES[a] ?? {}) };
    }
  }
  out.command = positionals[0] ?? null;
  out.subcommand = positionals[1] ?? null;
  out.rest = positionals.slice(2);
  if (typeof out.flags.key === "string") out.key = out.flags.key;
  if (typeof out.flags["base-url"] === "string") out.baseUrl = out.flags["base-url"];
  if (typeof out.flags["skills-dir"] === "string") out.skillsDir = out.flags["skills-dir"];
  out.force = out.flags.force === true;
  out.json = out.flags.json === true;
  return out;
}

function requireValue(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined || v === "") throw new UsageError(`${flag} requires a value`);
  return v;
}

/** The positional arguments after the command: `[subcommand, ...rest]` with nulls dropped. */
export function positionals(args: ParsedArgs): string[] {
  return args.subcommand === null ? [] : [args.subcommand, ...args.rest];
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function flagList(args: ParsedArgs, name: string): string[] {
  const v = args.flags[name];
  if (Array.isArray(v)) return v;
  return typeof v === "string" ? [v] : [];
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}

export function flagInt(args: ParsedArgs, name: string, fallback: number): number {
  const v = flagString(args, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new UsageError(`--${name} must be an integer`);
  return n;
}

/** The help text for one verb: usage line, then every flag in its table and the global ones. */
export function verbHelp(verb: string): string {
  const lines = [`Usage: catalyst-skills ${VERB_USAGE[verb] ?? verb}`, ""];
  const table = FLAG_TABLES[verb] ?? {};
  const names = Object.keys(table);
  if (names.length > 0) {
    lines.push("Options:");
    for (const name of names) lines.push(`  --${name}${table[name]!.value ? " <value>" : ""}  ${table[name]!.help}`);
    lines.push("");
  }
  lines.push("Global options:");
  for (const name of Object.keys(GLOBAL_FLAGS)) {
    lines.push(`  --${name}${GLOBAL_FLAGS[name]!.value ? " <value>" : ""}  ${GLOBAL_FLAGS[name]!.help}`);
  }
  lines.push("  -h, --help  this text", "  -V, --version  the bundle version");
  return lines.join("\n");
}
