import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildFixtureContract } from "./fixture-contract.js";
import { parseArgs } from "../src/args.js";
import { main, type MainDeps } from "../src/cli.js";
import {
  configPathFor,
  contractPathFor,
  discoveryCachePathFor,
  defaultCtx,
  writeConfig,
  type Ctx,
} from "../src/config.js";
import { CliError, UsageError } from "../src/errors.js";
import {
  cmdOnboard,
  onboardLockPath,
  onboardStatePath,
  type OnboardJournal,
} from "../src/onboard.js";
import {
  createOnboardRuntime,
  type OnboardRuntimeHooks,
} from "../src/onboard-runtime.js";
import { resetDiscoveryCache } from "../src/oauth.js";
import { stageOnboardLogin } from "../src/onboard-login-candidate.js";

const homes: string[] = [];
const args = parseArgs(["onboard", "--only", "signin", "--yes", "--json"]);
const user = {
  id: "timeout-member",
  label: "Fixture",
  email: "fixture@example.com",
  role: "member" as const,
  linearUserId: null,
};
const me = {
  account: "timeout-account",
  slug: "timeout",
  name: "Fixture",
  permissions: null,
  principal: "session" as const,
  user,
};
function fixture(login: OnboardRuntimeHooks["login"], signinTimeoutMs = 20) {
  const home = mkdtempSync(join(tmpdir(), "onboard-signin-timeout-"));
  homes.push(home);
  const ctx: Ctx = {
    ...defaultCtx(),
    home,
    env: {} as NodeJS.ProcessEnv,
    stdout: () => {},
    stderr: () => {},
    fetch: (async () => Response.json(me)) as typeof fetch,
  };
  // Structural typing lets the baseline run before this optional production seam exists.
  const hooks: OnboardRuntimeHooks & { signinTimeoutMs: number } = {
    login,
    signinTimeoutMs,
    ready: async () => ({ state: "waiting" }),
  };
  const runtime = createOnboardRuntime(args, ctx, hooks);
  const journal: OnboardJournal = {
    schema: 1,
    runId: "timeout-fixture",
    installer: null,
    cli: "0.14.1",
    tenant: null,
    exit: null,
    steps: [],
    changes: [],
  };
  return { home, ctx, runtime, journal };
}
async function watched<T>(work: Promise<T>): Promise<T | "watchdog"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<"watchdog">((resolve) => {
        timer = setTimeout(() => resolve("watchdog"), 250);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe("onboarding native sign-in cumulative deadline", () => {
  test("a login callback ignoring abort cannot hold onboarding forever", async () => {
    let observed: AbortSignal | undefined;
    const f = fixture(async (_ctx, signal) => {
      observed = signal;
      return new Promise<number>(() => {});
    });
    expect(
      await watched(f.runtime.adapters!.signin!.act!(f.ctx, f.journal)),
    ).toMatchObject({ state: "waiting", reason: "signin_timeout" });
    expect(observed?.aborted).toBe(true);
    expect(existsSync(configPathFor(f.home))).toBe(false);
  });

  test("the login hook receives a deadline that aborts before retrying a device code", async () => {
    let sawAbort = false;
    const f = fixture(
      async (_ctx, signal) =>
        new Promise<number>((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              resolve(0);
            },
            { once: true },
          );
        }),
    );
    expect(
      await watched(f.runtime.adapters!.signin!.act!(f.ctx, f.journal)),
    ).toMatchObject({ state: "waiting", reason: "signin_timeout" });
    expect(sawAbort).toBe(true);
  });

  test("user cancellation stays interrupted with exit 11 rather than becoming a timeout", async () => {
    const controller = new AbortController();
    const f = fixture(
      async (_ctx, signal) =>
        new Promise<number>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new CliError("paused", "login-cancelled", 11)),
            { once: true },
          );
          queueMicrotask(() => controller.abort());
        }),
      200,
    );
    const result = await watched(
      cmdOnboard(args, f.ctx, {
        ...f.runtime,
        signal: controller.signal,
        bindSignals: false,
      }),
    );
    expect(result).toBe(11);
    const receipt = JSON.parse(readFileSync(onboardStatePath(f.home), "utf8"));
    expect(
      receipt.steps.find((step: { id: string }) => step.id === "signin"),
    ).toMatchObject({ state: "waiting", reason: "interrupted" });
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });

  test("fast successful login remains done", async () => {
    const f = fixture(async () => 0);
    expect(await f.runtime.adapters!.signin!.act!(f.ctx, f.journal)).toEqual({
      state: "done",
    });
  });

  test("a genuine login failure remains a failure, not a timeout", async () => {
    const f = fixture(async () => {
      throw new CliError("denied", "login-denied");
    });
    await expect(
      f.runtime.adapters!.signin!.act!(f.ctx, f.journal),
    ).rejects.toMatchObject({ code: "login-denied" });
    const unsuccessful = fixture(async () => 2);
    expect(
      await unsuccessful.runtime.adapters!.signin!.act!(
        unsuccessful.ctx,
        unsuccessful.journal,
      ),
    ).toEqual({ state: "failed", reason: "signin_failed" });
  });

  test.each([0, -1, 600_001, 1.5, NaN])(
    "illegal deadline %s is refused before login",
    async (timeout) => {
      let invoked = false;
      await expect(async () => {
        const f = fixture(async () => {
          invoked = true;
          return 0;
        }, timeout);
        await f.runtime.adapters!.signin!.act!(f.ctx, f.journal);
      }).rejects.toThrow();
      expect(invoked).toBe(false);
    },
  );

  test("a timed-out receipt releases its lock and the same run can resume without changing operation identity", async () => {
    const first = fixture(async () => new Promise<number>(() => {}));
    expect(
      await watched(
        cmdOnboard(args, first.ctx, { ...first.runtime, bindSignals: false }),
      ),
    ).toBe(11);
    const path = onboardStatePath(first.home);
    const before = JSON.parse(readFileSync(path, "utf8"));
    expect(
      before.steps.find((step: { id: string }) => step.id === "signin"),
    ).toMatchObject({ state: "waiting", reason: "signin_timeout" });
    expect(existsSync(onboardLockPath(first.home))).toBe(false);
    let attempts = 0;
    const hooks: OnboardRuntimeHooks & { signinTimeoutMs: number } = {
      signinTimeoutMs: 100,
      ready: async () => ({ state: "waiting" }),
      login: async () => {
        attempts++;
        writeConfig(first.home, {
          ...me,
          baseUrl: "https://fixture.invalid",
          key: "ctc_user_fixture",
          joinedAt: new Date().toISOString(),
          lastSkillBundleVersion: "0.14.1",
        });
        return 0;
      },
    };
    expect(
      await cmdOnboard(args, first.ctx, {
        ...createOnboardRuntime(args, first.ctx, hooks),
        bindSignals: false,
      }),
    ).toBe(0);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.runId).toBe(before.runId);
    expect(after.operations.signin).toBe(before.operations.signin);
    expect(
      after.steps.find((step: { id: string }) => step.id === "signin"),
    ).toMatchObject({ state: "done" });
    expect(attempts).toBe(1);
    expect(existsSync(onboardLockPath(first.home))).toBe(false);
  });

  test.each([0, -1, 600_001, 1.5, NaN])(
    "actual staging rejects invalid budget %s before saved-state parsing or network",
    async (timeoutMs) => {
      const f = fixture(async () => 0);
      const path = configPathFor(f.home);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "invalid-config-must-not-be-parsed");
      let calls = 0;
      f.ctx.fetch = async () => {
        calls++;
        throw new Error("unexpected network");
      };
      await expect(
        stageOnboardLogin(f.ctx, {
          timeoutMs,
          baseUrl: "https://signin-timeout.invalid",
        }),
      ).rejects.toBeInstanceOf(UsageError);
      expect(calls).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(
        "invalid-config-must-not-be-parsed",
      );
      expect(existsSync(onboardStatePath(f.home))).toBe(false);
      expect(existsSync(onboardLockPath(f.home))).toBe(false);
    },
  );

  test("actual main cannot save a late personal /me response after the cumulative deadline", async () => {
    resetDiscoveryCache();
    const f = fixture(async () => 0);
    let releaseMe: (() => void) | undefined;
    let meStarted = false;
    const meSignal: { value?: AbortSignal | null } = {};
    const baseUrl = "https://signin-timeout.invalid";
    const access = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(f.ctx.now().getTime() / 1000) + 3600, sid: "fixture-session" })).toString("base64url")}.fixture`;
    const output: string[] = [];
    const savedReceipt = JSON.stringify(f.journal);
    for (const [path, bytes] of [
      [contractPathFor(f.home), "old-contract-cache"],
      [discoveryCachePathFor(f.home), "old-discovery-cache"],
      [onboardStatePath(f.home), savedReceipt],
    ] as const) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
    f.ctx.stdout = (text) => {
      output.push(text);
    };
    f.ctx.fetch = async (input, init) => {
      const path = new URL(String(input instanceof Request ? input.url : input))
        .pathname;
      if (path === "/api/v1/auth/cli")
        return Response.json({
          clientId: "fixture",
          issuer: baseUrl,
          deviceAuthorizationUrl: baseUrl + "/device",
          tokenUrl: baseUrl + "/token",
          jwksUrl: baseUrl + "/jwks",
        });
      if (path === "/device")
        return Response.json({
          device_code: "fixture-device",
          user_code: "LOCAL-1234",
          verification_uri: baseUrl + "/activate",
          expires_in: 300,
          interval: 1,
        });
      if (path === "/token")
        return Response.json({
          access_token: access,
          refresh_token: "fixture-refresh",
        });
      if (path === "/api/v1/me") {
        meStarted = true;
        meSignal.value = init?.signal;
        return new Promise<Response>((resolve) => {
          releaseMe = () => resolve(Response.json(me));
        });
      }
      return Response.json({}, { status: 404 });
    };
    const deps: MainDeps = {
      onboardSigninTimeoutMs: 80,
      sleep: async () => {},
      openBrowser: () => {},
    };
    const running = main(
      ["onboard", "--only", "signin", "--yes", "--json", "--base-url", baseUrl],
      f.ctx,
      deps,
    );
    const result = await watched(running);
    expect(meStarted).toBe(true);
    expect(result).toBe(11);
    expect(meSignal.value?.aborted).toBe(true);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ exit: 11, complete: false });
    const outputAtDeadline = [...output];
    releaseMe?.();
    await watched(running);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(output).toEqual(outputAtDeadline);
    expect(existsSync(configPathFor(f.home))).toBe(false);
    expect(readFileSync(contractPathFor(f.home), "utf8")).toBe(
      "old-contract-cache",
    );
    expect(readFileSync(discoveryCachePathFor(f.home), "utf8")).toBe(
      "old-discovery-cache",
    );
    expect(readFileSync(onboardStatePath(f.home), "utf8")).toBe(savedReceipt);
    expect(existsSync(onboardLockPath(f.home))).toBe(false);
  });

  test.each(["discovery", "me", "contract"] as const)(
    "actual onboarding rejects late %s JSON before cache or post-timeout success",
    async (phase) => {
      resetDiscoveryCache();
      const f = fixture(async () => 0);
      mkdirSync(dirname(discoveryCachePathFor(f.home)), { recursive: true });
      const output: string[] = [],
        json: string[] = [];
      f.ctx.stdout = (text) => {
        output.push(text);
        json.push(text);
      };
      f.ctx.stderr = (text) => {
        output.push(text);
      };
      const baseUrl = "https://signin-timeout.invalid";
      const access = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(f.ctx.now().getTime() / 1000) + 3600, sid: "fixture-session" })).toString("base64url")}.fixture`;
      const requested: string[] = [];
      let releaseBody: (() => void) | undefined;
      let bodyStarted = false;
      const bodySignal: { value?: AbortSignal | null } = {};
      const delayed = (
        body: unknown,
        signal?: AbortSignal | null,
      ): Response => {
        const bytes = new TextEncoder().encode(JSON.stringify(body));
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes.subarray(0, 1));
              releaseBody = () => {
                controller.enqueue(bytes.subarray(1));
                controller.close();
              };
            },
            pull() {
              bodyStarted = true;
              bodySignal.value = signal;
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };
      f.ctx.fetch = async (input, init) => {
        const path = new URL(
          String(input instanceof Request ? input.url : input),
        ).pathname;
        requested.push(path);
        if (path === "/api/v1/auth/cli") {
          const body = {
            clientId: "fixture",
            issuer: baseUrl,
            deviceAuthorizationUrl: baseUrl + "/device",
            tokenUrl: baseUrl + "/token",
            jwksUrl: baseUrl + "/jwks",
          };
          return phase === "discovery"
            ? delayed(body, init?.signal)
            : Response.json(body);
        }
        if (path === "/device")
          return Response.json({
            device_code: "fixture-device",
            user_code: "LOCAL-1234",
            verification_uri: baseUrl + "/activate",
            expires_in: 300,
            interval: 1,
          });
        if (path === "/token")
          return Response.json({
            access_token: access,
            refresh_token: "fixture-refresh",
          });
        if (path === "/api/v1/me")
          return phase === "me" ? delayed(me, init?.signal) : Response.json(me);
        if (path === "/api/v1/agent/contract") {
          const body = {
            ...buildFixtureContract(),
            account: { ...buildFixtureContract().account, id: me.account },
          };
          return phase === "contract"
            ? delayed(body, init?.signal)
            : Response.json(body);
        }
        return Response.json({}, { status: 404 });
      };
      const deps: MainDeps = {
        onboardSigninTimeoutMs: 80,
        sleep: async () => {},
        isTty: () => true,
        openBrowser: () => {
          output.push("browser opened");
        },
      };
      const running = main(
        [
          "onboard",
          "--only",
          "signin",
          "--yes",
          "--json",
          "--base-url",
          baseUrl,
        ],
        f.ctx,
        deps,
      );
      const result = await watched(running);
      expect(bodyStarted).toBe(true);
      expect(result).toBe(11);
      expect(bodySignal.value?.aborted).toBe(true);
      expect(json).toHaveLength(1);
      expect(JSON.parse(json[0]!)).toMatchObject({ exit: 11, complete: false });
      const outputAtDeadline = [...output];
      releaseBody?.();
      await watched(running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(output).toEqual(outputAtDeadline);
      expect(existsSync(configPathFor(f.home))).toBe(false);
      expect(existsSync(discoveryCachePathFor(f.home))).toBe(false);
      expect(existsSync(contractPathFor(f.home))).toBe(false);
      expect(existsSync(onboardStatePath(f.home))).toBe(false);
      expect(existsSync(onboardLockPath(f.home))).toBe(false);
      if (phase === "discovery") {
        expect(requested).not.toContain("/device");
        expect(output).not.toContain("browser opened");
      }
      if (phase === "me")
        expect(requested).not.toContain("/api/v1/agent/contract");
    },
  );
});
