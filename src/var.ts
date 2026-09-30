// var.ts — plain repository/workspace environment values. Values are sent only to the private
// /me/env-vars routes and are never included in CLI output.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { flagList, flagString, positionals, type ParsedArgs } from "./args.js";
import { requireConfig, type Ctx } from "./config.js";
import { readContractCache } from "./contract.js";
import { UsageError } from "./errors.js";
import { parseEnvAssignments } from "./env/parse-env.js";
import { promptSecret, stdinIsTty } from "./prompt.js";
import { apiClient, type ApiClient } from "./transport.js";

export const ENV_VARS_PATH = "/me/env-vars";
const NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const REPO_RE = /^[^/\s]+\/[^/\s]+$/;
const ACCEPT = [400, 401, 403, 404, 409, 422];

interface WriteReply {
  name?: string;
  created?: boolean;
  error?: string;
  message?: string;
}
export interface VarDeps {
  readStdin?: () => Promise<string>;
  isTty?: () => boolean;
  prompt?: (question: string) => Promise<string>;
  client?: Pick<ApiClient, "postJson">;
}

function scope(args: ParsedArgs): { scope: "tenant" | "repo"; repo?: string } {
  const repo = flagString(args, "repo");
  if (repo !== undefined && !REPO_RE.test(repo)) throw new UsageError(`--repo must be owner/name (got "${repo}")`);
  return repo === undefined ? { scope: "tenant" } : { scope: "repo", repo };
}

function selectedNames(args: ParsedArgs): string[] | undefined {
  const raw = flagList(args, "names");
  if (raw.length === 0) return undefined;
  const names = [...new Set(raw.flatMap((part) => part.split(",").map((name) => name.trim())).filter(Boolean))].sort();
  if (names.length === 0) throw new UsageError("--names needs one or more variable names");
  const bad = names.find((name) => !NAME_RE.test(name));
  if (bad !== undefined) throw new UsageError(`--names includes an invalid env-style name: ${bad}`);
  return names;
}

function scopeBody(target: ReturnType<typeof scope>, ctx: Ctx): { scope: "tenant" } | { scope: "repo"; repoId: string } {
  if (target.scope === "tenant") return { scope: "tenant" };
  const [owner, name] = target.repo!.split("/");
  const repositories = readContractCache(ctx.home)?.doc.merge.repositories ?? [];
  const repo = repositories.find((entry) => entry.owner.toLocaleLowerCase() === owner!.toLocaleLowerCase() && entry.name.toLocaleLowerCase() === name!.toLocaleLowerCase());
  if (!repo) throw new UsageError(`--repo ${target.repo} is not in the cached workspace contract; refresh catalyst contract and try again`);
  return { scope: "repo", repoId: repo.repoId };
}

async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function cmdVar(args: ParsedArgs, ctx: Ctx, deps: VarDeps = {}): Promise<number> {
  const [sub, ...rest] = positionals(args);
  if (sub !== "set" && sub !== "import") throw new UsageError(`unknown var subcommand "${sub ?? ""}": set | import`);
  if (rest.length !== 1) throw new UsageError(sub === "set" ? "var set takes one NAME" : "var import takes one file (a .env file)");
  const target = scope(args);
  const writeScope = scopeBody(target, ctx);
  const cfg = requireConfig(ctx);
  const client = deps.client ?? apiClient(cfg, ctx);
  if (sub === "set") {
    const name = rest[0]!;
    if (!NAME_RE.test(name)) throw new UsageError(`"${name}" is not an env-style name (A-Z, 0-9 and _, starting with a letter)`);
    const raw = (deps.isTty ?? stdinIsTty)()
      ? await (deps.prompt ?? promptSecret)(`Value for ${name} (input hidden): `)
      : await (deps.readStdin ?? stdinText)();
    const value = raw.endsWith("\r\n") ? raw.slice(0, -2) : raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    if (value.length === 0) throw new UsageError("var set needs a non-empty value");
    const reply = await client.postJson<WriteReply>(ENV_VARS_PATH, { ...writeScope, name, value }, { accept: ACCEPT });
    if (reply.status !== 200 && reply.status !== 201) {
      ctx.stderr(`var set refused (${reply.status}): ${reply.body.message ?? reply.body.error ?? "no reason given"}`);
      return 1;
    }
    if (args.json) ctx.stdout(JSON.stringify({ name, scope: target.scope, repo: target.repo ?? null, created: reply.body.created ?? null }));
    else ctx.stdout(`stored ${name} (${target.scope}${target.repo ? `: ${target.repo}` : ""}${reply.body.created ? "; new" : "; updated"})`);
    return 0;
  }

  let text: string;
  try { text = readFileSync(rest[0]!, "utf8"); }
  catch (err) { throw new UsageError(`could not read ${rest[0]}: ${err instanceof Error ? err.message : String(err)}`); }
  const names = selectedNames(args);
  const entries = parseEnvAssignments(text, names === undefined ? undefined : new Set(names));
  const found = new Set(entries.map(({ name }) => name));
  const created: string[] = [];
  const updated: string[] = [];
  const errors: Array<{ name: string; reason: string }> = [];
  for (const entry of entries) {
    const reply = await client.postJson<WriteReply>(ENV_VARS_PATH, { ...writeScope, ...entry }, { accept: ACCEPT });
    if (reply.status !== 200 && reply.status !== 201) {
      errors.push({ name: entry.name, reason: reply.body.message ?? reply.body.error ?? `HTTP ${reply.status}` });
    } else if (reply.body.created) created.push(entry.name);
    else updated.push(entry.name);
  }
  const absent = names?.filter((name) => !found.has(name)) ?? [];
  if (args.json) ctx.stdout(JSON.stringify({ scope: target.scope, repo: target.repo ?? null, created, updated, errors, ...(names === undefined ? {} : { requested: names, notFoundInFile: absent }) }));
  else {
    const count = created.length + updated.length;
    ctx.stdout(count === 0 ? `stored nothing (${target.scope}${target.repo ? `: ${target.repo}` : ""})` : `stored ${count} variables: ${[...created, ...updated].join(", ")}`);
    if (updated.length > 0) ctx.stdout(`  updated: ${updated.join(", ")}`);
    if (absent.length > 0) ctx.stdout(`not found in ${basename(rest[0]!)}: ${absent.join(", ")}`);
    for (const error of errors) ctx.stdout(`not stored: ${error.name} (${error.reason})`);
  }
  return errors.length > 0 ? 1 : 0;
}
