import { verifyOnboardRoutes } from "./onboard-capabilities.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig, normalizeBaseUrl, type Ctx } from "./config.js";
import {
  readExistingOnboardJson,
  readOnboardTeamInventory,
  selectedOnboardTeam,
} from "./onboard-existing.js";
import {
  readOnboardRepositoryInventory,
  selectedOnboardRepositories,
  type ExistingOnboardRepository,
} from "./onboard-repositories.js";
import {
  readLocalSettings,
  type SettingsAuthorityContext,
  type SettingsAuthorityPorts,
} from "./env/settings-authority.js";
import type { OnboardJournal } from "./onboard.js";

const run = promisify(execFile);
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const repoKey = (repo: ExistingOnboardRepository) =>
  `${repo.owner}/${repo.name}`.toLowerCase();

/** Read only Git's local origin; no credential helper, provider call, hook or repo command runs. */
export async function readLocalRepositoryName(
  repoRoot: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    if (signal?.aborted) return null;
    const result = await run(
      "git",
      ["config", "--local", "--get-all", "remote.origin.url"],
      {
        cwd: repoRoot,
        timeout: 3_000,
        maxBuffer: 16_384,
        signal,
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
    const urls = result.stdout.trim().split(/\r?\n/);
    if (urls.length !== 1 || signal?.aborted) return null;
    const raw = urls[0]!;
    if (/[\u0000-\u0020\u007f]/.test(raw)) return null;
    const ssh =
      /^git@github\.com:([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?$/.exec(
        raw,
      );
    if (ssh) return `${ssh[1]}/${ssh[2]}`.toLowerCase();
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    const path = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
    return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(path)
      ? path.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

/** Fresh account/member, team inventory and personal repository ACL establish authority. The
 * journal chooses identifiers only; neither its done state nor the disk contract is proof. */
export function onboardSettingsAuthorityPorts(input: {
  ctx: Ctx;
  journal: OnboardJournal;
  repository: ExistingOnboardRepository;
  repoRoot: string;
  readRepositoryName?: (
    root: string,
    signal?: AbortSignal,
  ) => Promise<string | null>;
}): SettingsAuthorityPorts {
  const selected = { ...input.repository };
  const root = input.repoRoot;
  return {
    readSettings: readLocalSettings,
    readContext: async (signal) => {
      try {
        const { ctx, journal } = input;
        const cfg = loadConfig(ctx.home);
        const account = journal.account ?? journal.tenant;
        if (
          signal?.aborted ||
          !cfg?.user ||
          !account ||
          account !== cfg.account ||
          journal.membershipId !== cfg.user.id ||
          !journal.baseUrl ||
          normalizeBaseUrl(journal.baseUrl) !== normalizeBaseUrl(cfg.baseUrl)
        )
          return null;
        const teamId = selectedOnboardTeam(journal);
        if (
          !teamId ||
          teamId !== selected.teamId ||
          !selectedOnboardRepositories(journal).some(
            (repo) =>
              repoKey(repo) === repoKey(selected) &&
              repo.repoId === selected.repoId &&
              repo.teamId === teamId,
          )
        )
          return null;
        const supported = await verifyOnboardRoutes(
          ctx,
          journal,
          [
            { method: "GET", path: "/api/v1/agent/teams" },
            { method: "GET", path: "/api/v1/repos" },
            { method: "GET", path: "/api/v1/agent/contract" },
          ],
          signal,
        );
        if ("reason" in supported || signal?.aborted) return null;
        const meRead = await readExistingOnboardJson(ctx, "/api/v1/me", signal);
        if ("reason" in meRead) return null;
        const me = object(meRead.body);
        const user = object(me?.user);
        if (
          me?.account !== account ||
          user?.id !== cfg.user.id ||
          typeof user.role !== "string" ||
          !["owner", "admin"].includes(user.role)
        )
          return null;
        const teams = await readOnboardTeamInventory(ctx, signal);
        if ("reason" in teams) return null;
        const team = teams.teams.find((row) => row.id === teamId);
        if (!team || !/^[A-Z][A-Z0-9]{0,15}$/.test(team.key)) return null;
        const inventory = await readOnboardRepositoryInventory(
          ctx,
          journal,
          signal,
        );
        if (
          "reason" in inventory ||
          !inventory.repositories.some(
            (repo) =>
              repoKey(repo) === repoKey(selected) &&
              repo.repoId === selected.repoId &&
              repo.teamId === selected.teamId,
          )
        )
          return null;
        const local = await (
          input.readRepositoryName ?? readLocalRepositoryName
        )(root, signal);
        if (local !== repoKey(selected) || signal?.aborted) return null;
        const current = loadConfig(ctx.home);
        if (
          !current?.user ||
          current.account !== cfg.account ||
          current.user.id !== cfg.user.id ||
          normalizeBaseUrl(current.baseUrl) !== normalizeBaseUrl(cfg.baseUrl) ||
          !["owner", "admin"].includes(current.user.role)
        )
          return null;
        return {
          accountId: account,
          personId: cfg.user.id,
          baseUrl: normalizeBaseUrl(cfg.baseUrl),
          role: user.role,
          teamId,
          teamKey: team.key,
          repoId: selected.repoId,
          repoName: repoKey(selected),
          repoRoot: root,
        } as SettingsAuthorityContext;
      } catch {
        return null;
      }
    },
  };
}
