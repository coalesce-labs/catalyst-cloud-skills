import { expect, test } from "vitest";
import { CliError } from "../src/errors.js";
import { pollConsent } from "../src/onboard-consent.js";

test("a consent ends only when the status reports connected", async () => {
  let elapsed = 0;
  const result = await pollConsent({
    readStatus: async () =>
      elapsed >= 4000 ? { outcome: "connected" } : { outcome: "absent" },
    now: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms;
    },
    timeoutMs: 10000,
  });
  expect(result).toEqual({ state: "done", elapsedMs: 4000 });
});

test("a consent expires at its elapsed deadline", async () => {
  let elapsed = 0;
  const result = await pollConsent({
    readStatus: async () => ({ outcome: "absent" }),
    now: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms;
    },
    timeoutMs: 3500,
  });
  expect(result).toEqual({
    state: "waiting",
    reason: "consent_timeout",
    elapsedMs: 3500,
  });
});

test("a wrong-membership status refuses immediately", async () => {
  const result = await pollConsent({
    readStatus: async () => ({
      outcome: "refused",
      reason: "membership_mismatch",
    }),
  });
  expect(result.state).toBe("refused");
  expect(result.reason).toBe("membership_mismatch");
});

test("a provider response cannot put arbitrary reason text into the result", async () => {
  const result = await pollConsent({
    readStatus: async () => ({
      outcome: "refused",
      reason: "Bearer secret-should-never-escape",
    }),
  });
  expect(JSON.stringify(result)).not.toContain("secret-should-never-escape");
  expect(result.reason).toBe("consent_refused");
});

test("a hung status request cannot outlive the consent deadline", async () => {
  const result = await pollConsent({
    readStatus: async () => new Promise<never>(() => {}),
    timeoutMs: 10,
  });
  expect(result.state).toBe("waiting");
  expect(result.reason).toBe("consent_timeout");
});

test("an externally cancelled hung callback promptly returns interrupted", async () => {
  const controller = new AbortController();
  const result = pollConsent({
    signal: controller.signal,
    readStatus: async () => new Promise<never>(() => {}),
    timeoutMs: 1000,
  });
  controller.abort();
  expect(await result).toMatchObject({
    state: "waiting",
    reason: "interrupted",
  });
});

test("an already aborted consent does not begin polling", async () => {
  const controller = new AbortController();
  controller.abort();
  expect(
    await pollConsent({
      signal: controller.signal,
      readStatus: async () => {
        throw new Error("must not run");
      },
    }),
  ).toMatchObject({ state: "waiting", reason: "interrupted" });
});

test("a transport failure returns a safe failure instead of exposing provider text", async () => {
  const secret = "fixture-provider-secret";
  const result = await pollConsent({
    readStatus: async () => {
      throw new Error(secret);
    },
  });
  expect(result).toMatchObject({
    state: "failed",
    reason: "consent_status_failed",
  });
  expect(JSON.stringify(result)).not.toContain(secret);
});

test("a failed grant status preserves a safe refusal reason", async () => {
  expect(
    await pollConsent({
      readStatus: async () => ({ outcome: "failed", reason: "token_revoked" }),
    }),
  ).toMatchObject({ state: "failed", reason: "token_revoked" });
});

test("failure reasons with arbitrary provider text are replaced", async () => {
  expect(
    await pollConsent({
      readStatus: async () => ({
        outcome: "failed",
        reason: "token=fixture-secret",
      }),
    }),
  ).toMatchObject({ state: "failed", reason: "consent_failed" });
});

test("unavailable and lapsed states remain pending until usable status arrives", async () => {
  let elapsed = 0;
  const result = await pollConsent({
    readStatus: async () => ({
      outcome:
        elapsed === 0
          ? "unavailable"
          : elapsed === 2000
            ? "lapsed"
            : "connected",
    }),
    now: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms;
    },
  });
  expect(result).toEqual({ state: "done", elapsedMs: 4000 });
});

test("an unresponsive sleep cannot hold the consent beyond its deadline", async () => {
  expect(
    await pollConsent({
      readStatus: async () => ({ outcome: "absent" }),
      sleep: async () => new Promise<never>(() => {}),
      timeoutMs: 10,
    }),
  ).toMatchObject({ state: "waiting", reason: "consent_timeout" });
});

test.each([0, -1, 600001, 1.5])(
  "invalid consent lifetime %s is rejected",
  async (timeoutMs) => {
    await expect(
      pollConsent({
        readStatus: async () => ({ outcome: "connected" }),
        timeoutMs,
      }),
    ).rejects.toThrow("consent timeout");
  },
);

test.each([0, -1, 1.5])(
  "invalid polling interval %s is rejected",
  async (intervalMs) => {
    await expect(
      pollConsent({
        readStatus: async () => ({ outcome: "connected" }),
        intervalMs,
      }),
    ).rejects.toThrow("consent timeout");
  },
);

test("an HTTP membership refusal is classified without exposing its response message", async () => {
  const result = await pollConsent({
    readStatus: async () => {
      throw new CliError("fixture-sensitive-response", "denied", 12, 403);
    },
  });
  expect(result).toMatchObject({
    state: "refused",
    reason: "consent_identity_refused",
  });
  expect(JSON.stringify(result)).not.toContain("fixture-sensitive-response");
});

test("a status that arrives at the deadline cannot retroactively complete consent", async () => {
  let elapsed = 0;
  const result = await pollConsent({
    readStatus: async () => {
      elapsed = 100;
      return { outcome: "connected" };
    },
    now: () => elapsed,
    timeoutMs: 100,
  });
  expect(result).toMatchObject({ state: "waiting", reason: "consent_timeout" });
});

test("an unavailable capability stops neutrally without another sleep or status request", async () => {
  let calls = 0;
  const result = await pollConsent({
    readStatus: async () => {
      calls++;
      return { outcome: "waiting", reason: "cloud_capability_unavailable" };
    },
    sleep: async () => {
      throw new Error("must not retry");
    },
  });
  expect(result).toMatchObject({
    state: "waiting",
    reason: "cloud_capability_unavailable",
  });
  expect(calls).toBe(1);
});
