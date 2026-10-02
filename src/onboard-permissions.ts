/** CTC-4629: the cloud's typed permissions verdict on an existing connection, verified before use.
 * A verdict that fails any check is a shape error, so no unverified URL is ever printed. */
import { loadConfig, normalizeBaseUrl, type Ctx } from "./config.js";

/** The saved login's origin, which a re-authorize URL must share; an unreadable one matches none. */
export function savedOrigin(ctx: Ctx): string {
  try {
    const cfg = loadConfig(ctx.home);
    return cfg ? new URL(normalizeBaseUrl(cfg.baseUrl)).origin : "";
  } catch {
    return "";
  }
}

const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

export type PermissionsVerdict =
  | { state: "current"; granted: string[] }
  | {
      state: "outdated";
      granted: string[];
      missing: string[];
      url: string;
      actor: string;
    }
  | { state: "unknown"; reason: string };

export const LINEAR_SCOPE = /^[A-Za-z][A-Za-z0-9:_-]{0,63}$/;
export const GITHUB_PERMISSION =
  /^[A-Za-z0-9_-]{1,80} \((?:read|write|admin)\)$/;
const UNKNOWN = new Set([
  "not-run",
  "unreachable",
  "expired-or-revoked",
  "not-connected",
  "grant-unreadable",
]);

const labels = (value: unknown, label: RegExp, min = 0): string[] | null =>
  Array.isArray(value) &&
  value.length >= min &&
  value.length <= 128 &&
  value.every((item) => typeof item === "string" && label.test(item))
    ? (value as string[])
    : null;

/** `undefined` when the cloud sent no verdict (an older cloud); `null` when it sent a bad one. */
export function parsePermissions(
  value: unknown,
  expected: {
    grant: string;
    action: string;
    label: RegExp;
    /** The actor the action URL implies, or null when the URL is not one this grant may print. */
    actorFor: (url: URL) => string | null;
  },
): PermissionsVerdict | null | undefined {
  if (value === undefined) return undefined;
  const row = object(value);
  if (!row || row.grant !== expected.grant) return null;
  if (row.state === "unknown")
    return typeof row.reason === "string" && UNKNOWN.has(row.reason)
      ? { state: "unknown", reason: row.reason }
      : null;
  const granted = labels(row.granted, expected.label);
  if (!granted) return null;
  if (row.state === "current") return { state: "current", granted };
  const missing = labels(row.missing, expected.label, 1);
  const action = object(row.action);
  if (
    row.state !== "outdated" ||
    !missing ||
    !action ||
    action.kind !== expected.action ||
    typeof action.url !== "string" ||
    action.url.length > 2048 ||
    typeof action.actor !== "string"
  )
    return null;
  let url: URL;
  try {
    url = new URL(action.url);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.search &&
      !(
        expected.grant === "linear-workspace" &&
        url.pathname === "/settings/connections" &&
        url.search === "?reauthorize=linear"
      )) ||
    url.hash ||
    expected.actorFor(url) !== action.actor
  )
    return null;
  return {
    state: "outdated",
    granted,
    missing,
    url: url.toString(),
    actor: action.actor,
  };
}

const GITHUB_INSTALLATION_PAGE =
  /^\/(?:organizations\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/)?settings\/installations\/([0-9]{1,20})(\/permissions\/update)?$/;

/** github.com's page for one installation: its settings, or its permission-request review. The
 * actor is GitHub's: an organization owner, or the owner of a personal account. */
export function githubInstallationPage(
  url: URL,
  installationId: string,
  org: string | null,
  review: boolean,
): { actor: string; login: string | null } | null {
  const match = GITHUB_INSTALLATION_PAGE.exec(url.pathname);
  if (
    url.origin !== "https://github.com" ||
    !match ||
    match[2] !== installationId ||
    Boolean(match[3]) !== review
  )
    return null;
  const login = match[1] ?? null;
  if (login && org && login.toLowerCase() !== org.toLowerCase()) return null;
  return {
    actor: login ? "github-org-admin" : "github-account-owner",
    login,
  };
}
