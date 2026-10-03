import { existsSync } from "node:fs";
import { afterEach, beforeEach, expect, test } from "vitest";
import { configPathFor } from "../src/config.js";
import { deviceFlowLogin, resetDiscoveryCache } from "../src/oauth.js";
import { startMeFixture, type FixtureServer } from "./fixture.js";
import { makeCtx, tempHome, type TestCtx } from "./helpers.js";

let server: FixtureServer;
let ctx: TestCtx;
let home: string;
beforeEach(async () => { server = await startMeFixture(); home = tempHome(); ctx = makeCtx(home); resetDiscoveryCache(); });
afterEach(async () => { await server.close(); });
function progress() {
  const events: string[] = [];
  const waitingOutputs: string[][] = [];
  const baseOutput = ctx.stdout;
  ctx.stdout = line => { events.push(`output:${line}`); baseOutput(line); };
  const waitForApproval = async <T>(run: () => Promise<T>): Promise<T> => {
    waitingOutputs.push([...ctx.out]); events.push("spinner:start");
    try { return await run(); } finally { events.push("spinner:stop"); }
  };
  return { events, waitingOutputs, waitForApproval };
}

test("sign-in progress starts only after browser instructions and code are visible", async () => {
  const p = progress();
  const auth = await deviceFlowLogin(ctx, server.url, { isTty: () => true, openBrowser: () => {}, sleep: async () => {}, waitForApproval: p.waitForApproval });
  expect(auth.kind).toBe("oauth");
  expect(p.waitingOutputs).toHaveLength(1);
  expect(p.waitingOutputs[0]!.join("\n")).toContain("WXYZ-1234");
  expect(p.waitingOutputs[0]!.join("\n")).toContain("Opened your browser");
  expect(p.waitingOutputs[0]!.at(-1)).toContain("Waiting for you to approve");
  expect(p.events.at(-1)).toBe("spinner:stop");
});

test("expired code stops its progress before printing the replacement and starting the next round", async () => {
  server.oauth.expireNextCodes = 1;
  const p = progress();
  expect((await deviceFlowLogin(ctx, server.url, { sleep: async () => {}, waitForApproval: p.waitForApproval })).kind).toBe("oauth");
  expect(p.waitingOutputs).toHaveLength(2);
  expect(p.waitingOutputs[1]!.join("\n")).toContain("WXYZ-1235");
  const firstStop = p.events.indexOf("spinner:stop");
  const replacement = p.events.findIndex(event => event.includes("That code expired"));
  expect(firstStop).toBeGreaterThan(p.events.indexOf("spinner:start"));
  expect(replacement).toBeGreaterThan(firstStop);
  expect(p.events.at(-1)).toBe("spinner:stop");
});

test("denied sign-in cleans up progress and never saves credentials", async () => {
  server.oauth.denied = true;
  const p = progress();
  await expect(deviceFlowLogin(ctx, server.url, { sleep: async () => {}, waitForApproval: p.waitForApproval })).rejects.toMatchObject({ code: "login-denied" });
  expect(p.events.at(-1)).toBe("spinner:stop");
  expect(p.waitingOutputs).toHaveLength(1);
  expect(existsSync(configPathFor(home))).toBe(false);
});

test("cancellation interrupts an unresponsive polling sleep without fetching tokens or minting another code", async () => {
  const p = progress();
  const controller = new AbortController();
  const login = deviceFlowLogin(ctx, server.url, { signal: controller.signal, waitForApproval: p.waitForApproval,
    sleep: async () => { controller.abort(); return new Promise<never>(() => {}); },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      login.then(() => ({ code: "unexpected token success" }), error => error),
      new Promise<string>(resolve => { timer = setTimeout(() => resolve("cancellation did not stop sleep"), 100); }),
    ]);
    expect(result).toMatchObject({ code: "login-cancelled", exitCode: 11 });
  } finally { if (timer) clearTimeout(timer); }
  expect(p.events.at(-1)).toBe("spinner:stop");
  expect(server.oauth.tokenPollCount).toBe(0);
  expect(server.oauth.deviceAuthorizeCount).toBe(1);
  expect(existsSync(configPathFor(home))).toBe(false);
});

test("device login without a progress wrapper keeps its existing browser and token behavior", async () => {
  const opened: string[] = [];
  const auth = await deviceFlowLogin(ctx, server.url, { isTty: () => true, openBrowser: url => { opened.push(url); }, sleep: async () => {} });
  expect(auth.kind).toBe("oauth");
  expect(auth.refreshToken).toBe("refresh-1");
  expect(opened).toEqual([`${server.url}/activate?user_code=WXYZ-1234`]);
  expect(ctx.out.join("\n")).toContain("Waiting for you to approve");
});

test("abort during a token fetch is cancellation rather than a transient retry", async () => {
  const p = progress();
  const controller = new AbortController();
  const originalFetch = ctx.fetch;
  let tokenAttempts = 0;
  ctx.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/oauth/token")) {
      tokenAttempts++;
      controller.abort();
      throw new TypeError("fixture cancelled network request");
    }
    return originalFetch(input, init);
  };
  await expect(deviceFlowLogin(ctx, server.url, { signal: controller.signal, sleep: async () => {}, waitForApproval: p.waitForApproval })).rejects.toMatchObject({ code: "login-cancelled", exitCode: 11 });
  expect(tokenAttempts).toBe(1);
  expect(server.oauth.tokenPollCount).toBe(0);
  expect(server.oauth.deviceAuthorizeCount).toBe(1);
  expect(p.events.at(-1)).toBe("spinner:stop");
  expect(existsSync(configPathFor(home))).toBe(false);
});

test("cancellation clears the real default polling timer before it can fetch a token", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  const waitForApproval = async <T>(run: () => Promise<T>): Promise<T> => {
    events.push("start");
    const pending = run();
    cancelTimer = setTimeout(() => controller.abort(), 10);
    try { return await pending; } finally { events.push("stop"); }
  };
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      deviceFlowLogin(ctx, server.url, { signal: controller.signal, waitForApproval }).then(() => ({ code: "unexpected tokens" }), error => error),
      new Promise<string>(resolve => { guard = setTimeout(() => resolve("default timer ignored cancellation"), 250); }),
    ]);
    expect(result).toMatchObject({ code: "login-cancelled", exitCode: 11 });
  } finally {
    if (guard) clearTimeout(guard);
    if (cancelTimer) clearTimeout(cancelTimer);
  }
  expect(events).toEqual(["start", "stop"]);
  expect(server.oauth.tokenPollCount).toBe(0);
  expect(server.oauth.deviceAuthorizeCount).toBe(1);
  expect(existsSync(configPathFor(home))).toBe(false);
});

test("CTC-4625: a presenter shows each code itself, before the wait starts, and the default lines stay out", async () => {
  server.oauth.expireNextCodes = 1;
  const p = progress();
  const shown: unknown[] = [];
  const auth = await deviceFlowLogin(ctx, server.url, {
    isTty: () => true,
    openBrowser: () => {},
    sleep: async () => {},
    waitForApproval: p.waitForApproval,
    present: code => { shown.push(code); p.events.push(`present:${code.userCode}`); },
    presentBrowser: opened => { p.events.push(`browser:${opened}`); },
  });
  expect(auth.kind).toBe("oauth");
  expect(shown).toEqual([
    { verificationUri: `${server.url}/activate`, userCode: "WXYZ-1234", completeUri: `${server.url}/activate?user_code=WXYZ-1234`, round: 1, rounds: 3 },
    { verificationUri: `${server.url}/activate`, userCode: "WXYZ-1235", completeUri: `${server.url}/activate?user_code=WXYZ-1235`, round: 2, rounds: 3 },
  ]);
  expect(p.events.filter(e => /^(present|spinner|browser):/.test(e))).toEqual([
    "present:WXYZ-1234", "browser:true", "spinner:start", "spinner:stop", "present:WXYZ-1235", "browser:true", "spinner:start", "spinner:stop",
  ]);
  expect(ctx.out.join("\n")).not.toContain("WXYZ");
  expect(ctx.out.join("\n")).not.toContain("Waiting for you to approve");
});

test("CTC-4625: the code is presented before a slow browser opener finishes, and the presenter hears it failed", async () => {
  server.oauth.omitVerificationUriComplete = true;
  const order: string[] = [];
  const shown: Array<{ completeUri?: string }> = [];
  await deviceFlowLogin(ctx, server.url, {
    isTty: () => true,
    openBrowser: async () => { order.push("opener:start"); await new Promise(r => setTimeout(r, 50)); throw new Error("no browser"); },
    sleep: async () => {},
    present: code => { shown.push(code); order.push("present"); },
    presentBrowser: opened => { order.push(`browser:${opened}`); },
  });
  expect(order).toEqual(["present", "opener:start", "browser:false"]);
  expect(shown[0]!.completeUri).toBeUndefined();
});

test("CTC-4625: with no terminal the presenter is never told about a browser", async () => {
  const order: string[] = [];
  await deviceFlowLogin(ctx, server.url, {
    isTty: () => false,
    sleep: async () => {},
    present: () => { order.push("present"); },
    presentBrowser: opened => { order.push(`browser:${opened}`); },
  });
  expect(order).toEqual(["present"]);
});
