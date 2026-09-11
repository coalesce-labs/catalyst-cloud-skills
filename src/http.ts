// http.ts — the thin authenticated fetch every read outside the replica and every write goes through.
// One bearer, one 15s timeout, three error kinds (http | network | shape), and the four status lines a
// customer will actually see: 401, 403, 429 (the write budget), and everything else with its reason.
import type { Ctx, CustomerConfig, MeIdentity, MeUser } from "./config.js";
import { normalizeBaseUrl } from "./config.js";
import { CliError, MeError } from "./errors.js";

export const REQUEST_TIMEOUT_MS = 15_000;

export interface JsonResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

export interface GetOptions {
  etag?: string | null;
  query?: Record<string, string | number | undefined>;
  /** Statuses to return instead of throwing (304 for a conditional GET, 404 for a probe). */
  accept?: number[];
}

export class ApiClient {
  constructor(
    private readonly cfg: Pick<CustomerConfig, "baseUrl" | "key">,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /** `path` is absolute under the origin (e.g. `/api/v1/issues`). */
  url(path: string, query?: GetOptions["query"]): string {
    const u = new URL(`${normalizeBaseUrl(this.cfg.baseUrl)}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async getJson<T = unknown>(path: string, opts: GetOptions = {}): Promise<JsonResponse<T>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.cfg.key}`,
      accept: "application/json",
    };
    if (opts.etag) headers["if-none-match"] = opts.etag;
    const url = this.url(path, opts.query);
    const res = await this.send(url, { method: "GET", headers });
    if (opts.accept?.includes(res.status)) {
      return { status: res.status, body: undefined as T, headers: res.headers };
    }
    await this.refuseIfNotOk(res, `GET ${path}`);
    return { status: res.status, body: await this.parseBody<T>(res, `GET ${path}`), headers: res.headers };
  }

  /**
   * A GET whose success body is NDJSON — one JSON object per line, the shape `streamNdjson` sends.
   *
   * ⛔ `/changes` and `/snapshot` ANSWER NDJSON ON 200 AND JSON ON A REFUSAL, so a caller that only
   * has `getJson` reads every real success as "returned a non-JSON body" while its refusals parse
   * perfectly. That asymmetry is why `query changes` looked like it worked: nothing reached a 200.
   * `accept` behaves as it does on `getJson` — those statuses come back with `rows: []` for the
   * caller to branch on, and their (JSON) body is deliberately not parsed here.
   */
  async getNdjson<T = unknown>(path: string, opts: GetOptions = {}): Promise<JsonResponse<T[]>> {
    const url = this.url(path, opts.query);
    const res = await this.send(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.cfg.key}`, accept: "application/x-ndjson, application/json" },
    });
    if (opts.accept?.includes(res.status)) return { status: res.status, body: [], headers: res.headers };
    await this.refuseIfNotOk(res, `GET ${path}`);
    const text = await res.text();
    const rows: T[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        rows.push(JSON.parse(trimmed) as T);
      } catch {
        throw new MeError(`GET ${path} returned a line that is not JSON: ${trimmed.slice(0, 120)}`, "shape");
      }
    }
    return { status: res.status, body: rows, headers: res.headers };
  }

  async postJson<T = unknown>(path: string, body: unknown): Promise<JsonResponse<T>> {
    const url = this.url(path);
    const res = await this.send(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.cfg.key}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    await this.refuseIfNotOk(res, `POST ${path}`);
    return { status: res.status, body: await this.parseBody<T>(res, `POST ${path}`), headers: res.headers };
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      throw new MeError(`could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`, "network");
    }
  }

  private async parseBody<T>(res: Response, what: string): Promise<T> {
    try {
      return (await res.json()) as T;
    } catch {
      throw new MeError(`${what} returned a non-JSON body`, "shape");
    }
  }

  private async refuseIfNotOk(res: Response, what: string): Promise<void> {
    if (res.ok) return;
    let reason = "";
    let raw = "";
    try {
      raw = await res.text();
      const body = JSON.parse(raw) as { error?: string; reason?: string; message?: string };
      reason = body.reason ?? body.error ?? body.message ?? "";
    } catch {
      reason = raw.slice(0, 200);
    }
    if (res.status === 401) {
      throw new CliError(
        `${what} failed (401): credential not accepted — mint a personal key at Settings → API keys and log in again`,
        "unauthorized",
        2,
        401,
      );
    }
    if (res.status === 403) {
      throw new CliError(
        `${what} failed (403): this key may not reach that route${reason ? ` (${reason})` : ""} — a route that acts as a host (claiming work, publishing artifacts) needs the tenant's account key; every read and write a person makes takes your personal key`,
        "forbidden",
        2,
        403,
      );
    }
    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      const budget = /budget/i.test(raw) || /budget/i.test(reason);
      throw new CliError(
        `${what} refused (429)${budget ? ": the per-host daily write budget is spent" : ": rate limited"}${reason ? ` — ${reason}` : ""}${retryAfter ? ` — retry after ${retryAfter}s` : ""}`,
        budget ? "budget" : "rate-limited",
        2,
        429,
      );
    }
    throw new CliError(`${what} failed (${res.status})${reason ? `: ${reason}` : ""}`, "http", 2, res.status);
  }
}

export function apiClient(cfg: Pick<CustomerConfig, "baseUrl" | "key">, ctx: Pick<Ctx, "fetch">): ApiClient {
  return new ApiClient(cfg, ctx.fetch);
}

/** GET /api/v1/me — how a key learns its own tenant. Unchanged contract from 0.1. */
export async function fetchMe(
  baseUrl: string,
  key: string,
  fetchImpl: typeof fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<MeIdentity> {
  const url = `${normalizeBaseUrl(baseUrl)}/api/v1/me`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new MeError(`could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`, "network");
  }
  if (!res.ok) {
    let reason: string;
    try {
      const body = (await res.json()) as { error?: string; reason?: string };
      reason = body.reason ?? body.error ?? "";
    } catch {
      reason = "";
    }
    const detail =
      res.status === 401
        ? "credential not accepted — mint a personal key at Settings → API keys and log in again"
        : reason || `HTTP ${res.status}`;
    throw new MeError(`GET /me failed (${res.status}): ${detail}`, "http", res.status);
  }
  let body: Partial<{
    account: string;
    slug: string;
    name: string;
    permissions: string[] | null;
    principal: string;
    user: unknown;
  }>;
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new MeError("GET /me returned a non-JSON body", "shape");
  }
  if (
    typeof body.account !== "string" ||
    typeof body.slug !== "string" ||
    typeof body.name !== "string" ||
    (body.permissions !== null && !Array.isArray(body.permissions)) ||
    (body.principal !== "service" && body.principal !== "session")
  ) {
    throw new MeError("GET /me returned an unexpected shape", "shape");
  }
  const user = parseMeUser(body.user);
  return {
    account: body.account,
    slug: body.slug,
    name: body.name,
    permissions: body.permissions as string[] | null,
    principal: body.principal,
    ...(user ? { user } : {}),
  };
}

/** The `user` block a personal key gets from /me. Absent (undefined) is "a host key, no person";
 *  present-but-malformed is a shape error like any other field, never silently dropped. */
function parseMeUser(raw: unknown): MeUser | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) throw new MeError("GET /me returned an unexpected user shape", "shape");
  const u = raw as Record<string, unknown>;
  if (
    typeof u.id !== "string" ||
    typeof u.label !== "string" ||
    (u.email !== null && typeof u.email !== "string") ||
    (u.role !== "owner" && u.role !== "admin" && u.role !== "member") ||
    (u.linearUserId !== null && typeof u.linearUserId !== "string")
  ) {
    throw new MeError("GET /me returned an unexpected user shape", "shape");
  }
  return { id: u.id, label: u.label, email: u.email as string | null, role: u.role, linearUserId: u.linearUserId as string | null };
}
