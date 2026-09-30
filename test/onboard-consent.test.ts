import { expect, test } from "vitest";
import { pollConsent } from "../src/onboard-consent.js";
import { CliError, UsageError } from "../src/errors.js";

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

test("invalid polling bounds are rejected", async () => {
  await expect(
    pollConsent({
      readStatus: async () => ({ outcome: "absent" }),
      timeoutMs: 0,
    }),
  ).rejects.toBeInstanceOf(UsageError);
  await expect(
    pollConsent({
      readStatus: async () => ({ outcome: "absent" }),
      intervalMs: 0,
    }),
  ).rejects.toBeInstanceOf(UsageError);
});

test("a status authorization failure refuses and other transport errors fail", async () => {
  const denied = await pollConsent({
    readStatus: async () => {
      throw new CliError("denied", "denied", 1, 403);
    },
  });
  const unavailable = await pollConsent({
    readStatus: async () => {
      throw new Error("network");
    },
  });
  expect(denied).toMatchObject({
    state: "refused",
    reason: "consent_identity_refused",
  });
  expect(unavailable).toMatchObject({
    state: "failed",
    reason: "consent_status_failed",
  });
});

test("an aborted signal returns interrupted and a rejected sleep returns timeout", async () => {
  const controller = new AbortController();
  controller.abort();
  const interrupted = await pollConsent({
    readStatus: async () => ({ outcome: "absent" }),
    signal: controller.signal,
  });
  const failedSleep = await pollConsent({
    readStatus: async () => ({ outcome: "absent" }),
    sleep: async () => {
      throw new Error("sleep failed");
    },
  });
  expect(interrupted).toMatchObject({
    state: "waiting",
    reason: "interrupted",
  });
  expect(failedSleep).toMatchObject({
    state: "waiting",
    reason: "consent_timeout",
  });
});
