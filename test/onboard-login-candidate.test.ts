import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  configPathFor,
  contractPathFor,
  discoveryCachePathFor,
  loadConfig,
  writeConfig,
  type Ctx,
  type CustomerConfig,
  type MeIdentity,
  type MeUser,
} from "../src/config.js";
import { stageOnboardLogin } from "../src/onboard-login-candidate.js";
import { resetDiscoveryCache } from "../src/oauth.js";

const homes: string[] = [];
const now = new Date("2026-09-30T14:00:00Z");
const origin = "https://original-cloud.example";
const accessToken = `e30.${Buffer.from(JSON.stringify({ exp: now.getTime() / 1000 + 3600, sid: "candidate-session" })).toString("base64url")}.candidate-access-sentinel`;
const refreshToken = "candidate-refresh-sentinel";
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("deferred not ready");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
interface SeenRequest {
  url: string;
  headers: Headers;
  redirect: RequestInit["redirect"] | undefined;
  body: string;
}
function fixture() {
  resetDiscoveryCache();
  const home = mkdtempSync(join(tmpdir(), "onboard-candidate-"));
  homes.push(home);
  const output: string[] = [];
  const requests: SeenRequest[] = [];
  const user: MeUser = {
    id: "candidate-person",
    label: "Candidate Person",
    email: "candidate@example.com",
    role: "owner",
    linearUserId: null,
  };
  const me: MeIdentity = {
    account: "candidate-account",
    slug: "candidate",
    name: "Candidate Workspace",
    principal: "session",
    permissions: null,
    user,
  };
  const saved: CustomerConfig = {
    baseUrl: origin,
    account: "original-account",
    slug: "original",
    name: "Original Workspace",
    principal: "service",
    permissions: null,
    key: "original-key-sentinel",
    user: { ...user, id: "original-person" },
    joinedAt: now.toISOString(),
    lastSkillBundleVersion: "0.14.5",
    replicaDb: join(home, "original-replica.db"),
  };
  writeConfig(home, saved);
  const contract = () => ({
    account: { id: me.account },
    contractVersion: "2.10.0",
    teams: [],
    routes: [],
  });
  const handlers = {
    discovery: async () =>
      Response.json({
        clientId: "live-client",
        issuer: "https://auth.example",
        deviceAuthorizationUrl: "https://auth.example/device",
        tokenUrl: "https://auth.example/token",
        jwksUrl: "https://auth.example/jwks",
      }),
    token: async () =>
      Response.json({ access_token: accessToken, refresh_token: refreshToken }),
    me: async () => Response.json(me),
    contract: async () => Response.json(contract()),
  };
  const ctx: Ctx = {
    home,
    env: {
      CATALYST_CLOUD_TOKEN: "ambient-token-sentinel",
      CATALYST_CLOUD_BASE_URL: "https://ambient-cloud.example",
    },
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
    now: () => now,
    fetch: async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({
        url,
        headers: new Headers(init?.headers),
        redirect: init?.redirect,
        body: typeof init?.body === "string" ? init.body : "",
      });
      if (url === `${origin}/api/v1/auth/cli`) return handlers.discovery();
      if (url === "https://auth.example/device")
        return Response.json({
          device_code: "device-fixture",
          user_code: "ABCD-1234",
          verification_uri: "https://auth.example/approve",
          expires_in: 300,
          interval: 1,
        });
      if (url === "https://auth.example/token") return handlers.token();
      if (url === `${origin}/api/v1/me`) return handlers.me();
      if (url === `${origin}/api/v1/agent/contract`) return handlers.contract();
      throw new Error(`unexpected fixture route: ${url}`);
    },
  };
  const stage = (signal?: AbortSignal) =>
    stageOnboardLogin(ctx, {
      signal,
      device: { isTty: () => false, sleep: async () => {} },
    });
  const bytes = () => readFileSync(configPathFor(home), "utf8");
  return {
    home,
    output,
    requests,
    user,
    me,
    saved,
    handlers,
    ctx,
    stage,
    bytes,
    contract,
  };
}
afterEach(() => {
  vi.useRealTimers();
  resetDiscoveryCache();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe("staged onboarding personal login", () => {
  test("uses fresh discovery, /me and contract on the captured origin without changing config or either cache", async () => {
    const f = fixture();
    const original = f.bytes();
    const discoveryPath = discoveryCachePathFor(f.home);
    const contractPath = contractPathFor(f.home);
    const cache = JSON.stringify({
      baseUrl: origin,
      fetchedAt: now.getTime(),
      doc: {
        clientId: "retired-client",
        issuer: "https://retired.example",
        deviceAuthorizationUrl: "https://retired.example/device",
        tokenUrl: "https://retired.example/token",
        jwksUrl: "https://retired.example/jwks",
      },
    });
    writeFileSync(discoveryPath, cache);
    writeFileSync(contractPath, "old-account-contract-cache");
    const candidate = await f.stage();
    expect(candidate.identity).toMatchObject({
      account: "candidate-account",
      membershipId: "candidate-person",
      baseUrl: origin,
      role: "owner",
    });
    expect(candidate.accepted).toBe(false);
    expect(Object.isFrozen(candidate.identity)).toBe(true);
    expect(Object.isFrozen(candidate.identity.display)).toBe(true);
    expect(f.bytes()).toBe(original);
    expect(readFileSync(discoveryPath, "utf8")).toBe(cache);
    expect(readFileSync(contractPath, "utf8")).toBe(
      "old-account-contract-cache",
    );
    expect(f.requests.map((request) => request.url)).toEqual([
      `${origin}/api/v1/auth/cli`,
      "https://auth.example/device",
      "https://auth.example/token",
      `${origin}/api/v1/me`,
      `${origin}/api/v1/agent/contract`,
    ]);
    const authenticated = f.requests.filter(
      (request) =>
        request.url.startsWith(`${origin}/api/v1/`) &&
        !request.url.endsWith("auth/cli"),
    );
    expect(
      authenticated.every(
        (request) =>
          request.headers.get("authorization") === `Bearer ${accessToken}` &&
          request.redirect === "error" &&
          !request.headers.has("if-none-match"),
      ),
    ).toBe(true);
    expect(f.output.join("\n")).not.toContain(accessToken);
    expect(f.output.join("\n")).not.toContain(refreshToken);
    await candidate.accept();
    expect(candidate.accepted).toBe(true);
    expect(loadConfig(f.home)).toMatchObject({
      account: "candidate-account",
      user: { id: "candidate-person" },
      auth: { accessToken, refreshToken },
    });
    expect(loadConfig(f.home)?.key).toBeUndefined();
    expect(loadConfig(f.home)?.replicaDb).toBeUndefined();
    expect(statSync(configPathFor(f.home)).mode & 0o777).toBe(0o600);
    expect(existsSync(contractPath)).toBe(false);
    expect(readFileSync(discoveryPath, "utf8")).toBe(cache);
    expect(
      f.requests.filter((request) => request.url.endsWith("/api/v1/me")),
    ).toHaveLength(2);
    expect(
      f.requests.filter((request) =>
        request.url.endsWith("/api/v1/agent/contract"),
      ),
    ).toHaveLength(2);
    await expect(candidate.accept()).rejects.toMatchObject({
      code: "onboard-candidate-used",
    });
  });

  test("refuses an explicit conflicting origin before device authorization", async () => {
    const f = fixture();
    const original = f.bytes();
    await expect(
      stageOnboardLogin(f.ctx, { baseUrl: "https://different-cloud.example" }),
    ).rejects.toMatchObject({ code: "onboard-base-url-mismatch" });
    expect(f.requests).toHaveLength(0);
    expect(f.bytes()).toBe(original);
  });

  test.each([
    {
      label: "HTTP refusal",
      response: () => Response.json({ error: "forbidden" }, { status: 403 }),
    },
    {
      label: "wrong account",
      response: () =>
        Response.json({
          account: { id: "another-account" },
          contractVersion: "2.10.0",
        }),
    },
    {
      label: "unsupported version",
      response: () =>
        Response.json({
          account: { id: "candidate-account" },
          contractVersion: "9.0.0",
        }),
    },
    { label: "malformed body", response: () => new Response("not-json") },
  ])(
    "does not accept a $label contract or overwrite a cached contract",
    async ({ response }) => {
      const f = fixture();
      const original = f.bytes();
      writeFileSync(contractPathFor(f.home), "cached-contract-sentinel");
      f.handlers.contract = async () => response();
      await expect(f.stage()).rejects.toMatchObject({
        code: "onboard-candidate-unverified",
      });
      expect(f.bytes()).toBe(original);
      expect(readFileSync(contractPathFor(f.home), "utf8")).toBe(
        "cached-contract-sentinel",
      );
    },
  );

  test("a contract network failure cannot fall back to the original account cache", async () => {
    const f = fixture();
    const original = f.bytes();
    writeFileSync(
      contractPathFor(f.home),
      JSON.stringify({
        contractVersion: "2.10.0",
        fetchedAt: now.toISOString(),
        doc: f.contract(),
      }),
    );
    f.handlers.contract = async () => {
      throw new Error("network fixture");
    };
    await expect(f.stage()).rejects.toThrow();
    expect(f.bytes()).toBe(original);
  });

  test("refuses a config changed after staging, even when its identity fields stay the same", async () => {
    const f = fixture();
    const candidate = await f.stage();
    writeConfig(f.home, { ...f.saved, key: "newer-original-key" });
    const foreign = f.bytes();
    await expect(candidate.accept()).rejects.toMatchObject({
      code: "onboard-login-changed",
    });
    expect(candidate.accepted).toBe(false);
    expect(f.bytes()).toBe(foreign);
  });

  test("revalidates the candidate person during acceptance before changing saved credentials", async () => {
    const f = fixture();
    const original = f.bytes();
    const candidate = await f.stage();
    f.handlers.me = async () =>
      Response.json({ ...f.me, user: { ...f.user, id: "another-person" } });
    await expect(candidate.accept()).rejects.toMatchObject({
      code: "onboard-login-changed",
    });
    expect(f.bytes()).toBe(original);
    expect(candidate.accepted).toBe(false);
  });

  test("a canceled discovery that ignores abort cannot later reach token publication", async () => {
    const f = fixture();
    const original = f.bytes();
    const response = deferred<Response>();
    const started = deferred<void>();
    f.handlers.discovery = async () => {
      started.resolve();
      return response.promise;
    };
    const stop = new AbortController();
    const outcome = f.stage(stop.signal).catch((error: unknown) => error);
    await started.promise;
    stop.abort();
    expect(await outcome).toMatchObject({ code: "onboard-signin-paused" });
    response.resolve(
      Response.json({
        clientId: "late",
        issuer: "https://auth.example",
        deviceAuthorizationUrl: "https://auth.example/device",
        tokenUrl: "https://auth.example/token",
        jwksUrl: "https://auth.example/jwks",
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(f.bytes()).toBe(original);
    expect(f.requests).toHaveLength(1);
    expect(existsSync(discoveryCachePathFor(f.home))).toBe(false);
  });

  test("the 600s staging budget rejects an uncooperative discovery and never writes after its late completion", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const original = f.bytes();
    const response = deferred<Response>();
    const started = deferred<void>();
    f.handlers.discovery = async () => {
      started.resolve();
      return response.promise;
    };
    const outcome = f.stage().catch((error: unknown) => error);
    await started.promise;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(await outcome).toMatchObject({ code: "onboard-signin-paused" });
    response.resolve(Response.json({}));
    await Promise.resolve();
    expect(f.bytes()).toBe(original);
  });

  test("a 30s acceptance body timeout cannot write config when the body later arrives", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const original = f.bytes();
    const candidate = await f.stage();
    const body = deferred<ReadableStreamDefaultController<Uint8Array>>();
    f.handlers.contract = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            body.resolve(controller);
          },
        }),
      );
    const outcome = candidate.accept().catch((error: unknown) => error);
    const controller = await body.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await outcome).toMatchObject({ code: "onboard-signin-paused" });
    controller.enqueue(new TextEncoder().encode(JSON.stringify(f.contract())));
    controller.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.bytes()).toBe(original);
    expect(candidate.accepted).toBe(false);
  });

  test("the original 600s flow deadline also bounds review and acceptance, not a renewed independent budget", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const original = f.bytes();
    const candidate = await f.stage();
    await vi.advanceTimersByTimeAsync(600_001);
    await expect(candidate.accept()).rejects.toMatchObject({ exitCode: 11 });
    expect(f.bytes()).toBe(original);
    expect(candidate.accepted).toBe(false);
  });

  test("a symlinked original config is refused before any OAuth request and its target is preserved", async () => {
    const f = fixture();
    const foreign = join(f.home, "foreign-config.json");
    const original = f.bytes();
    writeFileSync(foreign, original);
    unlinkSync(configPathFor(f.home));
    symlinkSync(foreign, configPathFor(f.home));
    await expect(f.stage()).rejects.toMatchObject({
      code: "onboard-file-unverified",
      exitCode: 12,
    });
    expect(f.requests).toHaveLength(0);
    expect(readFileSync(foreign, "utf8")).toBe(original);
  });

  test("a symlinked original contract cache is refused before authorization and its target is preserved", async () => {
    const f = fixture();
    const original = f.bytes();
    const foreign = join(f.home, "foreign-cache.json");
    writeFileSync(foreign, "foreign-cache-kept");
    symlinkSync(foreign, contractPathFor(f.home));
    await expect(f.stage()).rejects.toMatchObject({
      code: "onboard-file-unverified",
      exitCode: 12,
    });
    expect(f.requests).toHaveLength(0);
    expect(f.bytes()).toBe(original);
    expect(readFileSync(foreign, "utf8")).toBe("foreign-cache-kept");
  });

  test("changing the old contract cache during review refuses config publication and preserves that cache", async () => {
    const f = fixture();
    const original = f.bytes();
    const path = contractPathFor(f.home);
    writeFileSync(path, "original-contract-cache");
    const candidate = await f.stage();
    writeFileSync(path, "foreign-contract-cache");
    await expect(candidate.accept()).rejects.toMatchObject({
      code: "onboard-login-changed",
    });
    expect(candidate.accepted).toBe(false);
    expect(f.bytes()).toBe(original);
    expect(readFileSync(path, "utf8")).toBe("foreign-contract-cache");
  });

  test("a cache changed at publication is preserved with an honest accepted partial result", async () => {
    const f = fixture();
    const path = contractPathFor(f.home);
    writeFileSync(path, "original-contract-cache");
    const candidate = await f.stage();
    await expect(
      candidate.accept(undefined, () => {
        writeFileSync(path, "foreign-contract-cache");
      }),
    ).rejects.toMatchObject({
      code: "onboard-connection-accepted",
      exitCode: 11,
    });
    expect(candidate.accepted).toBe(true);
    expect(loadConfig(f.home)?.account).toBe(f.me.account);
    expect(readFileSync(path, "utf8")).toBe("foreign-contract-cache");
  });

  test("a synchronous receipt guard refusal after fresh reads cannot publish credentials or invalidate the cache", async () => {
    const f = fixture();
    const original = f.bytes();
    const path = contractPathFor(f.home);
    writeFileSync(path, "original-contract-cache");
    const candidate = await f.stage();
    let guarded = false;
    await expect(
      candidate.accept(undefined, () => {
        guarded = true;
        throw new Error("receipt changed fixture");
      }),
    ).rejects.toThrow("receipt changed fixture");
    expect(guarded).toBe(true);
    expect(
      f.requests.filter((request) =>
        request.url.endsWith("/api/v1/agent/contract"),
      ),
    ).toHaveLength(2);
    expect(candidate.accepted).toBe(false);
    expect(f.bytes()).toBe(original);
    expect(readFileSync(path, "utf8")).toBe("original-contract-cache");
  });

  test("a streaming contract exceeding 1MiB is canceled before any credentials are published", async () => {
    const f = fixture();
    const original = f.bytes();
    const canceled = deferred<void>();
    let pulls = 0;
    f.handlers.contract = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (++pulls === 1)
              controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
            else if (pulls === 2) controller.enqueue(new Uint8Array([32]));
          },
          cancel() {
            canceled.resolve();
          },
        }),
      );
    await expect(f.stage()).rejects.toMatchObject({
      code: "onboard-response-unverified",
      exitCode: 11,
    });
    await canceled.promise;
    expect(f.bytes()).toBe(original);
  });

  test("a bodyless 204 contract response refuses approval without constructing an invalid response body", async () => {
    const f = fixture();
    const original = f.bytes();
    f.handlers.contract = async () => new Response(null, { status: 204 });
    await expect(f.stage()).rejects.toMatchObject({
      code: "onboard-candidate-unverified",
    });
    expect(f.bytes()).toBe(original);
  });

  test("terminal OAuth errors do not expose a returned credential in a staged error", async () => {
    const f = fixture();
    const original = f.bytes();
    f.handlers.token = async () =>
      Response.json(
        { error_description: `rejected ${refreshToken}` },
        { status: 400 },
      );
    const error: unknown = await f.stage().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("expected stage failure");
    expect(error.message).not.toContain(refreshToken);
    expect(f.bytes()).toBe(original);
  });
});
