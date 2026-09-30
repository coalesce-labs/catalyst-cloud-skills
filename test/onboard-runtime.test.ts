import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { main } from "../src/cli.js";
import { parseArgs } from "../src/args.js";
import { configPathFor, contractPathFor, defaultCtx, writeConfig, type CustomerConfig } from "../src/config.js";
import { cmdOnboard, onboardStatePath, type OnboardJournal } from "../src/onboard.js";
import { createOnboardRuntime } from "../src/onboard-runtime.js";

const homes: string[] = [];
const baseUrl = "https://staging.catalystcloud.dev";
const user = { id: "person-a", label: "Test Person", email: "test@example.com", role: "member" as const, linearUserId: null };
const me = { account: "tenant-a", slug: "tenant-a", name: "Tenant A", permissions: null, principal: "session" as const, user };
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "onboard-runtime-")); homes.push(home);
  const transcript: string[] = [];
  const ctx = { ...defaultCtx(), home, env: {} as NodeJS.ProcessEnv, stdout: (s: string) => transcript.push(s), stderr: (s: string) => transcript.push(s), now: () => new Date("2026-09-30T14:00:00Z"),
    fetch: (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input instanceof Request ? input.url : input);
      return url === `${baseUrl}/api/v1/me` ? Response.json(me) : Response.json({ error: "unexpected_route" }, { status: 404 });
    }) as typeof fetch };
  const cfg: CustomerConfig = { ...me, baseUrl, key: "ctc_user_test_fixture", joinedAt: "2026-09-30T14:00:00Z", lastSkillBundleVersion: "0.14.0" };
  const seed = (extra: Partial<CustomerConfig> = {}) => writeConfig(home, { ...cfg, ...extra });
  const journal: OnboardJournal = { schema: 1, runId: "runtime-fixture", installer: null, cli: "0.14.0", tenant: null, exit: null, steps: [], changes: [] };
  const hooks = { login: async () => 0, ready: async () => ({ state: "waiting" as const, reason: "not_ready" }), realHome: () => "/a/different/real/home" };
  return { home, ctx, seed, journal, hooks, transcript };
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("onboarding production runtime", () => {
  test("fake HOME reports a legacy service and never stops or removes it", async () => {
    const f = fixture();
    const plist = join(f.home, "Library", "LaunchAgents", "com.catalyst.agent.plist");
    mkdirSync(join(plist, ".."), { recursive: true }); writeFileSync(plist, "fixture legacy service");
    const touched = join(f.home, "service-was-stopped");
    const runtime = createOnboardRuntime(parseArgs(["onboard", "--only", "legacy", "--yes"]), f.ctx, {
      ...f.hooks, legacy: { platform: "darwin", run: () => { writeFileSync(touched, "unexpected"); return { status: 0, stdout: "", stderr: "" }; } },
    });
    const adapter = runtime.adapters!.legacy!;
    expect(await adapter.check(f.ctx, f.journal)).toMatchObject({ state: "skipped", reason: "fake_home_report_only" });
    if (adapter.act) expect(await adapter.act(f.ctx, f.journal)).toMatchObject({ state: "skipped", reason: "fake_home_report_only" });
    expect(readFileSync(plist, "utf8")).toBe("fixture legacy service");
    expect(existsSync(touched)).toBe(false);
  });

  test("personal identity uses live account and user id rather than interpreting user role as a membership id", async () => {
    const f = fixture(); f.seed();
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, f.hooks);
    expect(await runtime.identity!()).toMatchObject({ account: me.account, membershipId: user.id, baseUrl, role: "member" });
  });

  test("a fresh successful sign-in is verified and bound in the same run", async () => {
    const f = fixture();
    const args = parseArgs(["onboard", "--only", "signin", "--yes"]);
    const runtime = createOnboardRuntime(args, f.ctx, { ...f.hooks, login: async () => { f.seed(); return 0; } });
    expect(await cmdOnboard(args, f.ctx, runtime)).toBe(0);
    const receipt = JSON.parse(readFileSync(onboardStatePath(f.home), "utf8"));
    expect(receipt).toMatchObject({ exit: 0, account: me.account, membershipId: user.id, baseUrl });
    expect(receipt.steps.find((step: { id: string }) => step.id === "signin")).toMatchObject({ state: "done", evidence: { account: me.account, membershipId: user.id } });
  });

  test("receipt identity mismatch refuses before attempting an expired OAuth refresh", async () => {
    const f = fixture();
    f.seed({ key: undefined, auth: { kind: "oauth", accessToken: "expired-fixture", refreshToken: "refresh-fixture", expiresAt: "2026-09-30T13:00:00Z", sessionId: "session-fixture" } });
    const before = readFileSync(configPathFor(f.home), "utf8");
    const fetched = join(f.home, "network-was-used");
    f.ctx.fetch = (async () => { writeFileSync(fetched, "unexpected"); return Response.json({}); }) as typeof fetch;
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, f.hooks);
    const journal = { ...f.journal, account: "another-tenant", tenant: "another-tenant", membershipId: user.id, baseUrl };
    await expect(runtime.identity!(journal)).rejects.toMatchObject({ exitCode: 12 });
    expect(existsSync(fetched)).toBe(false);
    expect(readFileSync(configPathFor(f.home), "utf8")).toBe(before);
  });

  test("main refuses a mismatched receipt before automatic config or skills repair", async () => {
    const f = fixture();
    const skillsDir = join(f.home, "skills");
    mkdirSync(join(skillsDir, "ask"), { recursive: true });
    const skill = join(skillsDir, "ask", "SKILL.md");
    writeFileSync(skill, "fixture skill to preserve");
    f.seed({ cliPath: join(f.home, "old-package", "bin", "catalyst-skills.js"), lastSkillBundleVersion: "0.1.0", skillsDir });
    const before = readFileSync(configPathFor(f.home), "utf8");
    const path = onboardStatePath(f.home);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...f.journal, account: "another-tenant", tenant: "another-tenant" }));
    expect(await main(["onboard", "--only", "legacy", "--yes"], f.ctx)).toBe(12);
    expect(readFileSync(configPathFor(f.home), "utf8")).toBe(before);
    expect(readFileSync(skill, "utf8")).toBe("fixture skill to preserve");
  });

  test("fresh onboarding refuses an account token before saving host credentials", async () => {
    const f = fixture();
    const token = "ctc_account_private_fixture";
    f.ctx.env.CATALYST_CLOUD_TOKEN = token;
    f.ctx.fetch = (async () => Response.json({ ...me, principal: "service", user: undefined })) as typeof fetch;
    expect(await main(["onboard", "--only", "signin", "--yes"], f.ctx)).toBe(12);
    expect(existsSync(configPathFor(f.home))).toBe(false);
    expect(f.transcript.join("\n")).not.toContain(token);
  });

  test("an account credential never becomes a member identity", async () => {
    const f = fixture(); f.seed({ key: "ctc_account_fixture", principal: "service", user: undefined });
    f.ctx.fetch = (async () => Response.json({ ...me, principal: "service", user: undefined })) as typeof fetch;
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, f.hooks);
    let identity: unknown = null;
    try { identity = await runtime.identity!(); }
    catch (error) { expect((error as { exitCode: number }).exitCode).toBe(12); }
    expect(identity).toBeNull();
  });

  test("base URL mismatch refuses before writing a receipt or changing login config", async () => {
    const f = fixture(); f.seed();
    const before = readFileSync(configPathFor(f.home), "utf8");
    const args = parseArgs(["onboard", "--yes", "--base-url", "https://other.example.com"]);
    let code: number;
    try { code = await cmdOnboard(args, f.ctx, createOnboardRuntime(args, f.ctx, f.hooks)); }
    catch (error) { code = (error as { exitCode: number }).exitCode; }
    expect(code).toBe(12);
    expect(readFileSync(configPathFor(f.home), "utf8")).toBe(before);
    expect(existsSync(onboardStatePath(f.home))).toBe(false);
  });

  test("signin check validates the saved personal user against the live me endpoint", async () => {
    const f = fixture(); f.seed();
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, f.hooks);
    expect(await runtime.adapters!.signin!.check(f.ctx, f.journal)).toMatchObject({ state: "done" });
    f.ctx.fetch = (async () => Response.json({ ...me, user: { ...user, id: "another-person" } })) as typeof fetch;
    let state: string;
    try { state = (await runtime.adapters!.signin!.check(f.ctx, f.journal)).state; }
    catch (error) { expect((error as { exitCode: number }).exitCode).toBe(12); state = "refused"; }
    expect(state).toBe("refused");
  });

  test("a contract without exact workspace bearer routes cannot enable browser-session calls", async () => {
    const f = fixture(); f.seed();
    writeFileSync(contractPathFor(f.home), JSON.stringify({ schema: 1, routes: ["/connect/linear", "/connect/github"] }));
    const forbidden = join(f.home, "workspace-session-called");
    f.ctx.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `${baseUrl}/api/v1/me`) return Response.json(me);
      writeFileSync(forbidden, url); return Response.json({ connected: true });
    }) as typeof fetch;
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, f.hooks);
    for (const id of ["linear.workspace", "github.install"] as const) {
      const adapter = runtime.adapters?.[id];
      if (adapter) {
        expect(await adapter.check(f.ctx, f.journal)).toMatchObject({ state: "waiting" });
        if (adapter.act) expect(await adapter.act(f.ctx, f.journal)).toMatchObject({ state: "waiting" });
      }
    }
    expect(existsSync(forbidden)).toBe(false);
  });
  test("personal Linear consent opens the signed Catalyst handoff and polls usable status in JSON mode", async () => {
    const f = fixture(); f.seed();
    const browser = join(f.home, "opened-url");
    const grant = join(f.home, "linear-granted");
    const url = `${baseUrl}/connect/linear/personal/start?handoff=signed-fixture`;
    f.ctx.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ctc_user_test_fixture");
      const path = new URL(String(input)).pathname;
      if (path === "/api/v1/me/connections/linear/personal") return Response.json({ connected: existsSync(grant) });
      if (path === "/connect/linear/personal/start") return Response.json({ authorizationUrl: url, expiresAt: Date.now() + 60_000 });
      return Response.json({ error: "unexpected_route" }, { status: 404 });
    }) as typeof fetch;
    const runtime = createOnboardRuntime(parseArgs(["onboard", "--json"]), f.ctx, { ...f.hooks, openBrowser: opened => { writeFileSync(browser, opened); writeFileSync(grant, "connected"); }, sleep: async () => {} });
    const adapter = runtime.adapters!["linear.personal"]!;
    expect(await adapter.check(f.ctx, f.journal)).toMatchObject({ state: "pending" });
    expect(await adapter.act!(f.ctx, f.journal)).toMatchObject({ state: "done" });
    expect(readFileSync(browser, "utf8")).toBe(url);
    expect(await adapter.check(f.ctx, f.journal)).toMatchObject({ state: "done" });
    expect(f.transcript.join("\n")).not.toContain("ctc_user_test_fixture");
  });

  test("an already usable personal grant is verified without a new consent", async () => {
    const f = fixture(); f.seed();
    const unexpected = join(f.home, "unexpected-start-or-browser");
    f.ctx.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith("/api/v1/me/connections/linear/personal")) return Response.json({ connected: true });
      writeFileSync(unexpected, String(input)); return Response.json({ error: "unexpected_route" }, { status: 404 });
    }) as typeof fetch;
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, { ...f.hooks, openBrowser: url => writeFileSync(unexpected, url) });
    expect(await runtime.adapters!["linear.personal"]!.check(f.ctx, f.journal)).toMatchObject({ state: "done" });
    expect(existsSync(unexpected)).toBe(false);
  });

  test.each([
    [403, { connected: false }, "refused", "personal_consent_refused"],
    [503, { error: "unavailable" }, "waiting", "personal_status_unavailable"],
    [200, { connected: "yes" }, "failed", "personal_status_shape"],
  ] as const)("personal status %s preserves refusal, unavailable and malformed outcomes", async (status, body, state, reason) => {
    const f = fixture(); f.seed();
    f.ctx.fetch = (async () => Response.json(body, { status })) as typeof fetch;
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, f.hooks);
    expect(await runtime.adapters!["linear.personal"]!.check(f.ctx, f.journal)).toMatchObject({ state, reason });
  });

  test("a handoff to another origin is refused without opening the browser", async () => {
    const f = fixture(); f.seed();
    const opened = join(f.home, "unsafe-browser-opened");
    f.ctx.fetch = (async () => Response.json({ authorizationUrl: "https://unrelated.example/consent", expiresAt: Date.now() + 60_000 })) as typeof fetch;
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, { ...f.hooks, openBrowser: url => writeFileSync(opened, url) });
    expect(await runtime.adapters!["linear.personal"]!.act!(f.ctx, f.journal)).toMatchObject({ state: "refused", reason: "personal_consent_origin" });
    expect(existsSync(opened)).toBe(false);
  });

  test("workspace prerequisite refusal leaves personal consent waiting without opening a browser", async () => {
    const f = fixture(); f.seed();
    const opened = join(f.home, "premature-browser-opened");
    f.ctx.fetch = (async () => Response.json({ error: "linear_workspace_required" }, { status: 409 })) as typeof fetch;
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, { ...f.hooks, openBrowser: url => writeFileSync(opened, url) });
    expect(await runtime.adapters!["linear.personal"]!.act!(f.ctx, f.journal)).toMatchObject({ state: "waiting", reason: "linear_workspace_required" });
    expect(existsSync(opened)).toBe(false);
  });

  test("real-home legacy service cleanup retains data and suppresses raw provider output", async () => {
    const f = fixture();
    const plist = join(f.home, "Library", "LaunchAgents", "com.catalyst.agent.plist");
    mkdirSync(join(plist, ".."), { recursive: true }); writeFileSync(plist, "legacy service");
    const data = join(f.home, ".catalyst", "kept-data");
    mkdirSync(join(data, ".."), { recursive: true }); writeFileSync(data, "retain this data");
    const service = join(f.home, "stopped-service");
    const secret = "raw-provider-fixture-secret";
    const runtime = createOnboardRuntime(parseArgs(["onboard", "--yes", "--json"]), f.ctx, { ...f.hooks, realHome: () => f.home,
      legacy: { platform: "darwin", uid: 501, run: (command, argv) => { writeFileSync(service, JSON.stringify({ command, argv })); return { status: 0, stdout: secret, stderr: secret }; } },
    });
    const adapter = runtime.adapters!.legacy!;
    expect(await adapter.check(f.ctx, f.journal)).toMatchObject({ state: "pending" });
    expect(await adapter.act!(f.ctx, f.journal)).toMatchObject({ state: "done" });
    expect(JSON.parse(readFileSync(service, "utf8"))).toEqual({ command: "launchctl", argv: ["bootout", "gui/501/com.catalyst.agent"] });
    expect(existsSync(plist)).toBe(false);
    expect(readFileSync(data, "utf8")).toBe("retain this data");
    expect(f.transcript.join("\n")).not.toContain(secret);
  });

  test.each([
    [401, {}, "refused", "personal_consent_refused"],
    [500, {}, "failed", "personal_consent_start_failed"],
    [200, { authorizationUrl: null, expiresAt: 1 }, "failed", "personal_consent_shape"],
    [200, { authorizationUrl: "not-a-url", expiresAt: 1 }, "failed", "personal_consent_shape"],
    [200, { authorizationUrl: "http://staging.catalystcloud.dev/consent", expiresAt: 1 }, "refused", "personal_consent_origin"],
    [200, { authorizationUrl: "https://user:pass@staging.catalystcloud.dev/consent", expiresAt: 1 }, "refused", "personal_consent_origin"],
  ] as const)("unsafe or refused personal handoff %s never opens a browser", async (status, body, state, reason) => {
    const f = fixture(); f.seed();
    const opened = join(f.home, "unexpected-browser");
    f.ctx.fetch = (async () => Response.json(body, { status })) as typeof fetch;
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, { ...f.hooks, openBrowser: url => writeFileSync(opened, url) });
    expect(await runtime.adapters!["linear.personal"]!.act!(f.ctx, f.journal)).toMatchObject({ state, reason });
    expect(existsSync(opened)).toBe(false);
  });

  test("personal consent without login refuses both status and start", async () => {
    const f = fixture();
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, f.hooks);
    const adapter = runtime.adapters!["linear.personal"]!;
    expect(await adapter.check(f.ctx, f.journal)).toMatchObject({ state: "refused", reason: "personal_login_required" });
    expect(await adapter.act!(f.ctx, f.journal)).toMatchObject({ state: "refused", reason: "personal_login_required" });
  });

  test("a lapsed personal connection is not reported usable", async () => {
    const f = fixture(); f.seed();
    f.ctx.fetch = (async () => Response.json({ connected: false, reason: "lapsed" })) as typeof fetch;
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, f.hooks);
    expect(await runtime.adapters!["linear.personal"]!.check(f.ctx, f.journal)).toMatchObject({ state: "pending" });
  });

  test.each([null, {}, { connected: false }, { error: "provider_problem" }] as const)("status response distinguishes absent from malformed evidence %#", async body => {
    const f = fixture(); f.seed();
    f.ctx.fetch = (async () => Response.json(body)) as typeof fetch;
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, f.hooks);
    const result = await runtime.adapters!["linear.personal"]!.check(f.ctx, f.journal);
    expect(result.state).toBe(body && "connected" in body ? "pending" : "failed");
  });

  test("skills verification remains pending until every selected skill exists", async () => {
    const f = fixture();
    const skillsDir = join(f.home, "skills");
    f.ctx.env.CATALYST_SKILLS_DIR = skillsDir;
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, { ...f.hooks, skillNames: ["ask", "research"] });
    const adapter = runtime.adapters!.skills!;
    expect(await adapter.check(f.ctx, f.journal)).toMatchObject({ state: "waiting", reason: "skills_install_unverified" });
    for (const name of ["ask", "research"]) { mkdirSync(join(skillsDir, name), { recursive: true }); writeFileSync(join(skillsDir, name, "SKILL.md"), `fixture ${name}`); }
    expect(await adapter.check(f.ctx, f.journal)).toMatchObject({ state: "done", evidence: { count: 2, path: skillsDir } });
  });

  test("failed legacy service removal retains its plist and hides raw command errors", async () => {
    const f = fixture();
    const plist = join(f.home, "Library", "LaunchAgents", "com.catalyst.agent.plist");
    mkdirSync(join(plist, ".."), { recursive: true }); writeFileSync(plist, "legacy service");
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, { ...f.hooks, realHome: () => f.home, legacy: { platform: "darwin", run: () => ({ status: 1, stdout: "fixture-private-secret", stderr: "fixture-private-secret" }) } });
    expect(await runtime.adapters!.legacy!.act!(f.ctx, f.journal)).toMatchObject({ state: "failed", reason: "legacy_cleanup_failed" });
    expect(existsSync(plist)).toBe(true);
    expect(f.transcript.join("\n")).not.toContain("fixture-private-secret");
  });

  test("member personal GitHub onboarding works without administering the workspace installation", async () => {
    const f = fixture(); f.seed();
    const opened = join(f.home, "github-browser");
    const grant = join(f.home, "github-personal-granted");
    const handoff = `${baseUrl}/connect/github/personal/start?handoff=signed-github-fixture`;
    f.ctx.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ctc_user_test_fixture");
      const path = new URL(String(input)).pathname;
      if (path === "/api/v1/me") return Response.json(me);
      if (path === "/api/v1/me/connections/github/personal") return Response.json({ connected: existsSync(grant), githubLogin: "fixture-person" });
      if (path === "/connect/github/personal/start") return Response.json({ authorizationUrl: handoff, expiresAt: Date.now() + 60000 });
      return Response.json({ error: "unexpected_route" }, { status: 404 });
    }) as typeof fetch;
    const args = parseArgs(["onboard", "--only", "github.personal", "--yes", "--json"]);
    const runtime = createOnboardRuntime(args, f.ctx, { ...f.hooks, openBrowser: url => { writeFileSync(opened, url); writeFileSync(grant, "connected"); }, sleep: async () => {} });
    expect(await cmdOnboard(args, f.ctx, runtime)).toBe(0);
    expect(readFileSync(opened, "utf8")).toBe(handoff);
    const receipt = JSON.parse(readFileSync(onboardStatePath(f.home), "utf8"));
    expect(receipt.steps.find((step: { id: string }) => step.id === "github.personal")).toMatchObject({ state: "done" });
    expect(receipt.steps.find((step: { id: string }) => step.id === "github.install").state).not.toBe("done");
  });

  test.each([
    [200, { connected: false, reason: "lapsed" }, "pending"],
    [200, { connected: true, githubLogin: "fixture-person" }, "done"],
    [403, { error: "forbidden" }, "refused"],
    [503, { error: "github_grant_check_unavailable" }, "waiting"],
  ] as const)("personal GitHub status %s remains distinct from workspace installation", async (status, body, state) => {
    const f = fixture(); f.seed();
    f.ctx.fetch = (async () => Response.json(body, { status })) as typeof fetch;
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, f.hooks);
    expect(await runtime.adapters!["github.personal"]!.check(f.ctx, f.journal)).toMatchObject({ state });
    expect(await runtime.adapters!["github.install"]!.check(f.ctx, f.journal)).toMatchObject({ state: "waiting" });
  });

  test("personal GitHub handoff refuses another origin before opening a browser", async () => {
    const f = fixture(); f.seed();
    const opened = join(f.home, "unsafe-github-browser");
    f.ctx.fetch = (async () => Response.json({ authorizationUrl: "https://unrelated.example/consent", expiresAt: Date.now() + 60000 })) as typeof fetch;
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, { ...f.hooks, openBrowser: url => writeFileSync(opened, url) });
    expect(await runtime.adapters!["github.personal"]!.act!(f.ctx, f.journal)).toMatchObject({ state: "refused" });
    expect(existsSync(opened)).toBe(false);
  });

  test("personal GitHub status server failure cannot become a pending consent or expose its error body", async () => {
    const f = fixture(); f.seed();
    const secret = "private-github-provider-error";
    f.ctx.fetch = (async (input: Parameters<typeof fetch>[0]) => String(input).endsWith("/api/v1/me")
      ? Response.json(me) : Response.json({ error: secret }, { status: 500 })) as typeof fetch;
    const args = parseArgs(["onboard", "--only", "github.personal", "--yes", "--json"]);
    const runtime = createOnboardRuntime(args, f.ctx, f.hooks);
    expect(await cmdOnboard(args, f.ctx, runtime)).toBe(10);
    const stored = readFileSync(onboardStatePath(f.home), "utf8");
    const receipt = JSON.parse(stored);
    expect(receipt.steps.find((step: { id: string }) => step.id === "github.personal")).toMatchObject({ state: "failed", reason: "personal_status_failed" });
    expect(stored).not.toContain(secret);
    expect(f.transcript.join("\n")).not.toContain(secret);
  });

  test("nonboolean GitHub connected status is invalid evidence rather than consent completion", async () => {
    const f = fixture(); f.seed();
    f.ctx.fetch = (async () => Response.json({ connected: 1 })) as typeof fetch;
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, f.hooks);
    expect(await runtime.adapters!["github.personal"]!.check(f.ctx, f.journal)).toMatchObject({ state: "failed", reason: "personal_status_shape" });
  });

  test.each([
    [409, "waiting", "github_workspace_required"],
    [500, "failed", "personal_consent_start_failed"],
  ] as const)("GitHub start %s does not open a browser or claim connection", async (status, state, reason) => {
    const f = fixture(); f.seed();
    const opened = join(f.home, "github-start-error-browser");
    const secret = "private-github-start-error";
    f.ctx.fetch = (async () => Response.json({ error: secret }, { status })) as typeof fetch;
    const runtime = createOnboardRuntime(parseArgs(["onboard", "--json"]), f.ctx, { ...f.hooks, openBrowser: url => writeFileSync(opened, url) });
    expect(await runtime.adapters!["github.personal"]!.act!(f.ctx, f.journal)).toMatchObject({ state, reason });
    expect(existsSync(opened)).toBe(false);
    expect(f.transcript.join("\n")).not.toContain(secret);
  });

  test("retryable Linear status outage during consent can recover without another browser opening", async () => {
    const f = fixture(); f.seed();
    const recovered = join(f.home, "linear-status-recovered");
    const opened = join(f.home, "linear-recovery-browser");
    const handoff = `${baseUrl}/connect/linear/personal/start?handoff=recovery-fixture`;
    f.ctx.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).endsWith("/connect/linear/personal/start")) return Response.json({ authorizationUrl: handoff, expiresAt: Date.now() + 60000 });
      return existsSync(recovered) ? Response.json({ connected: true }) : Response.json({ error: "linear_grant_check_unavailable" }, { status: 503 });
    }) as typeof fetch;
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, { ...f.hooks,
      openBrowser: url => writeFileSync(opened, url), sleep: async () => { writeFileSync(recovered, "usable"); },
    });
    expect(await runtime.adapters!["linear.personal"]!.act!(f.ctx, f.journal)).toMatchObject({ state: "done" });
    expect(readFileSync(opened, "utf8")).toBe(handoff);
    expect(existsSync(recovered)).toBe(true);
  });

});
