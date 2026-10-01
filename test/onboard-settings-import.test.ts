import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultCtx, loadConfig, writeConfig } from "../src/config.js";
import { createOnboardSettingsWriter } from "../src/onboard-settings-import.js";
import type {
  SettingsAuthorityContext,
  SettingsAuthorityPorts,
} from "../src/env/settings-authority.js";

const scratch: string[] = [];
function contract(account = "account-a", methods = ["POST"]) {
  return Response.json({
    contractVersion: "2.16.0",
    account: { id: account },
    onboarding: {
      schema: 1,
      web: {
        connections: "/a/account/connections",
        personalConnections: "/settings/connected-accounts",
      },
      routes: ["/me/env-vars", "/me/secrets/import"].flatMap((path) =>
        methods.map((method) => ({ method, path, personalBearer: true })),
      ),
    },
  });
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "onboard-writer-"));
  scratch.push(home);
  const context: SettingsAuthorityContext = {
    accountId: "account-a",
    personId: "person-a",
    baseUrl: "https://cloud.example.test",
    role: "owner",
    teamId: "team-a",
    teamKey: "CTC",
    repoId: "repo-a",
    repoName: "example/service",
    repoRoot: "/repo",
  };
  writeConfig(home, {
    baseUrl: context.baseUrl,
    account: context.accountId,
    slug: "fixture",
    name: "Fixture",
    principal: "session",
    permissions: null,
    user: {
      id: context.personId,
      role: "owner",
      label: "Fixture",
      email: null,
      linearUserId: null,
    },
    key: "ctc_user_fixture",
    joinedAt: "2026-09-30T23:00:00Z",
    lastSkillBundleVersion: "0.14.3",
  });
  const contractReads: string[] = [];
  const calls: Array<{
    path: string;
    body: Record<string, unknown>;
    init: RequestInit;
  }> = [];
  const ctx = {
    ...defaultCtx(),
    home,
    env: {},
    stdout: vi.fn(),
    stderr: vi.fn(),
    now: () => new Date("2026-09-30T23:00:00Z"),
  };
  const ports: SettingsAuthorityPorts = {
    readContext: async () => ({ ...context }),
    readSettings: async () => null,
  };
  ctx.fetch = (async (url, init) => {
    const parsed = new URL(String(url));
    expect(parsed.origin).toBe(context.baseUrl);
    if (parsed.pathname === "/api/v1/agent/contract") {
      contractReads.push(parsed.pathname);
      return contract();
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ path: parsed.pathname, body, init: init! });
    if (parsed.pathname === "/me/env-vars")
      return Response.json({
        envVar: { name: body.name },
        created: true,
        unresolvedReferences: [],
      });
    return Response.json({ created: ["API_TOKEN"], rotated: [], errors: [] });
  }) as typeof fetch;
  return {
    home,
    context,
    ctx,
    ports,
    calls,
    contractReads,
    writer: (kind: "variable" | "secret", signal?: AbortSignal) =>
      createOnboardSettingsWriter({ context, ctx, ports, kind, signal }),
  };
}
afterEach(() => {
  vi.useRealTimers();
  for (const home of scratch.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe("private selected onboarding writes", () => {
  it("uses the actual repo-ID variable route and maps names-only receipts", async () => {
    const f = fixture();
    expect(
      await f.writer("variable")("PUBLIC_URL=fixture-value\n", ["PUBLIC_URL"]),
    ).toEqual({ writtenNames: ["PUBLIC_URL"], failedNames: [] });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.path).toBe("/me/env-vars");
    expect(f.calls[0]!.body).toEqual({
      scope: "repo",
      repoId: "repo-a",
      name: "PUBLIC_URL",
      value: "fixture-value",
    });
    expect(f.calls[0]!.init.redirect).toBe("error");
    expect(f.ctx.stdout).not.toHaveBeenCalled();
    expect(f.ctx.stderr).not.toHaveBeenCalled();
  });
  it("sends only selected secret assignments, with no implicit rotation", async () => {
    const f = fixture();
    expect(
      await f.writer("secret")(
        "# private annotation\nAPI_TOKEN=synthetic-value\n",
        ["API_TOKEN"],
      ),
    ).toEqual({ writtenNames: ["API_TOKEN"], failedNames: [] });
    expect(f.calls[0]!.body).toEqual({
      repo: "example/service",
      text: "API_TOKEN=synthetic-value\n",
      rotateExisting: [],
      source: "onboarding selected import",
    });
    expect(f.ctx.stdout).not.toHaveBeenCalled();
    expect(f.ctx.stderr).not.toHaveBeenCalled();
  });
  it.each([
    "accountId",
    "personId",
    "baseUrl",
    "role",
    "teamId",
    "teamKey",
    "repoId",
    "repoName",
    "repoRoot",
  ] as const)("refuses changed %s before a write", async (field) => {
    const f = fixture();
    f.ports.readContext = async () =>
      ({ ...f.context, [field]: "changed" }) as SettingsAuthorityContext;
    await expect(
      f.writer("variable")("PUBLIC_URL=synthetic\n", ["PUBLIC_URL"]),
    ).rejects.toThrow("selected import outcome uncertain");
    expect(f.calls).toEqual([]);
  });
  it("rechecks access before each sequential variable, stopping after access changes", async () => {
    const f = fixture();
    let reads = 0;
    f.ports.readContext = async () => (++reads === 1 ? { ...f.context } : null);
    await expect(
      f.writer("variable")("FIRST=synthetic\nSECOND=synthetic\n", [
        "FIRST",
        "SECOND",
      ]),
    ).rejects.toThrow("uncertain");
    expect(f.calls.map((row) => row.body.name)).toEqual(["FIRST"]);
  });
  it.each([
    () =>
      Response.json({
        contractVersion: "2.16.0",
        account: { id: "account-a" },
      }),
    () => contract("foreign-account"),
    () => contract("account-a", ["GET"]),
    () => Response.json({ error: "synthetic-private" }, { status: 503 }),
  ])(
    "never sends a selected value when the fresh cloud cannot authorize its exact POST",
    async (reply) => {
      const f = fixture();
      const requests: string[] = [];
      f.ctx.fetch = (async (url) => {
        requests.push(String(url));
        return reply();
      }) as typeof fetch;
      await expect(
        f.writer("variable")("PUBLIC_URL=synthetic-private-value\n", [
          "PUBLIC_URL",
        ]),
      ).rejects.toThrow("uncertain");
      expect(requests).toEqual([`${f.context.baseUrl}/api/v1/agent/contract`]);
      expect(f.ctx.stdout).not.toHaveBeenCalled();
      expect(f.ctx.stderr).not.toHaveBeenCalled();
    },
  );
  it("rechecks fresh POST support before every selected variable and stops on removal", async () => {
    const f = fixture();
    const original = f.ctx.fetch;
    let contracts = 0;
    f.ctx.fetch = (async (url, init) =>
      String(url).endsWith("/api/v1/agent/contract")
        ? ++contracts === 1
          ? contract()
          : contract("account-a", ["GET"])
        : original(url, init)) as typeof fetch;
    await expect(
      f.writer("variable")("FIRST=synthetic\nSECOND=synthetic\n", [
        "FIRST",
        "SECOND",
      ]),
    ).rejects.toThrow("uncertain");
    expect(contracts).toBe(2);
    expect(f.calls.map((row) => row.body.name)).toEqual(["FIRST"]);
  });

  it("does not read access or post for an empty selection", async () => {
    const f = fixture();
    f.ports.readContext = vi.fn(async () => null);
    expect(await f.writer("secret")("", [])).toEqual({
      writtenNames: [],
      failedNames: [],
    });
    expect(f.calls).toEqual([]);
    expect(f.ports.readContext).not.toHaveBeenCalled();
  });
  it("does not post when interrupted or after a stalled access read completes late", async () => {
    const f = fixture();
    const abort = new AbortController();
    let complete!: (context: SettingsAuthorityContext) => void;
    f.ports.readContext = () =>
      new Promise((resolve) => {
        complete = resolve;
      });
    const result = f.writer("variable", abort.signal)(
      "PUBLIC_URL=synthetic\n",
      ["PUBLIC_URL"],
    );
    await Promise.resolve();
    await Promise.resolve();
    abort.abort();
    await expect(result).rejects.toThrow("uncertain");
    complete(f.context);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.calls).toEqual([]);
  });
  it("bounds a body ignoring abort and never turns its late success into a receipt", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let complete!: (value: unknown) => void;
    f.ctx.fetch = (async (url) =>
      String(url).endsWith("/api/v1/agent/contract")
        ? contract()
        : ({
            ok: true,
            status: 200,
            json: () =>
              new Promise((resolve) => {
                complete = resolve;
              }),
          } as Response)) as typeof fetch;
    const result = f.writer("variable")("PUBLIC_URL=synthetic\n", [
      "PUBLIC_URL",
    ]);
    const rejected = expect(result).rejects.toThrow("uncertain");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    complete({
      envVar: { name: "PUBLIC_URL" },
      created: true,
      unresolvedReferences: [],
    });
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("leaves expired local OAuth for sign-in without posting or refreshing", async () => {
    const f = fixture();
    const cfg = loadConfig(f.home)!;
    cfg.key = "";
    cfg.auth = {
      accessToken: "synthetic",
      refreshToken: "synthetic",
      expiresAt: "2026-09-30T22:00:00Z",
      kind: "oauth",
      sessionId: "fixture",
    };
    writeConfig(f.home, cfg);
    await expect(
      f.writer("variable")("PUBLIC_URL=synthetic\n", ["PUBLIC_URL"]),
    ).rejects.toThrow("uncertain");
    expect(f.calls).toEqual([]);
    expect(loadConfig(f.home)).toEqual(cfg);
  });
  it("does not parse or leak a refusal body", async () => {
    const f = fixture();
    const parse = vi.fn(() => {
      throw new Error("synthetic-private-value");
    });
    const refusal = new Response(null, { status: 403 });
    vi.spyOn(refusal, "json").mockImplementation(parse);
    f.ctx.fetch = async (url) =>
      String(url).endsWith("/api/v1/agent/contract") ? contract() : refusal;
    expect(
      await f.writer("variable")("PUBLIC_URL=synthetic\n", ["PUBLIC_URL"]),
    ).toEqual({ writtenNames: [], failedNames: ["PUBLIC_URL"] });
    expect(parse).not.toHaveBeenCalled();
    expect(f.ctx.stdout).not.toHaveBeenCalled();
    expect(f.ctx.stderr).not.toHaveBeenCalled();
  });
});
