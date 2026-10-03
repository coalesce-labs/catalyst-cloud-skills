import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { defaultCtx } from "../src/config.js";
import {
  onboardHousekeepingAdapter,
  type SchedulerRun,
} from "../src/onboard-housekeeping.js";
import type { OnboardDailyUpdate, OnboardJournal, OnboardStep } from "../src/onboard.js";
import { setupStepView, setupFinalScreen } from "../src/setup-onboard-copy.js";
import { ONBOARD_STEPS, readOnboardJournal, stepSatisfied } from "../src/onboard.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture(tools: string[], dailyUpdate?: OnboardDailyUpdate) {
  const home = mkdtempSync(join(tmpdir(), "onboard-housekeeping-"));
  homes.push(home);
  const bin = join(home, "bin");
  mkdirSync(bin);
  for (const tool of tools) {
    writeFileSync(join(bin, tool), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, tool), 0o755);
  }
  const ctx = { ...defaultCtx(), home, env: { PATH: bin } as NodeJS.ProcessEnv };
  const journal: OnboardJournal = {
    schema: 1,
    runId: "housekeeping-fixture",
    installer: null,
    cli: "0.15.0",
    tenant: null,
    exit: null,
    steps: [],
    changes: [],
    ...(dailyUpdate ? { dailyUpdate } : {}),
  };
  const calls: string[] = [];
  const answers = new Map<string, ReturnType<SchedulerRun>>();
  const run: SchedulerRun = (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    calls.push(key);
    return answers.get(key) ?? { status: 1, stdout: "", stderr: "" };
  };
  const plist = join(home, "Library", "LaunchAgents", "dev.catalystcloud.housekeeping.plist");
  const timer = join(home, ".config", "systemd", "user", "catalyst-housekeeping.timer");
  const place = (path: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "fixture");
  };
  return { home, ctx, journal, calls, answers, run, plist, timer, place };
}

describe("macOS", () => {
  const check = (f: ReturnType<typeof fixture>) =>
    onboardHousekeepingAdapter({ platform: "darwin", run: f.run, uid: 501 }).check(f.ctx, f.journal);

  test("a loaded LaunchAgent is done", async () => {
    const f = fixture(["launchctl"]);
    f.place(f.plist);
    f.answers.set("launchctl print gui/501/dev.catalystcloud.housekeeping", { status: 0, stdout: "", stderr: "" });
    expect(await check(f)).toEqual({
      state: "done",
      evidence: { scheduled: true, provider: "launchd", path: f.plist },
    });
  });
  test("a plist launchd has not loaded is not scheduled", async () => {
    const f = fixture(["launchctl"]);
    f.place(f.plist);
    expect(await check(f)).toMatchObject({ state: "skipped", reason: "housekeeping_not_loaded" });
  });
  test("no plist is not scheduled, and launchd is asked nothing", async () => {
    const f = fixture(["launchctl"]);
    expect(await check(f)).toEqual({ state: "skipped", reason: "housekeeping_not_scheduled" });
    expect(f.calls).toEqual([]);
  });
  test("the installer's 'off' is skipped, as chosen", async () => {
    const f = fixture(["launchctl"], { state: "off" });
    expect(await check(f)).toEqual({ state: "skipped", reason: "housekeeping_off_chosen" });
  });
  test("a scheduled job is reported even when the record says off", async () => {
    const f = fixture(["launchctl"], { state: "off" });
    f.place(f.plist);
    f.answers.set("launchctl print gui/501/dev.catalystcloud.housekeeping", { status: 0, stdout: "", stderr: "" });
    expect((await check(f)).state).toBe("done");
  });
  test("no launchctl is a computer that can't run it", async () => {
    const f = fixture([]);
    expect(await check(f)).toEqual({ state: "skipped", reason: "housekeeping_no_scheduler" });
  });
});

describe("Linux", () => {
  const check = (f: ReturnType<typeof fixture>) =>
    onboardHousekeepingAdapter({ platform: "linux", run: f.run }).check(f.ctx, f.journal);

  test("an enabled timer is done", async () => {
    const f = fixture(["systemctl"]);
    f.place(f.timer);
    f.answers.set("systemctl --user is-enabled catalyst-housekeeping.timer", {
      status: 0,
      stdout: "enabled\n",
      stderr: "",
    });
    expect(await check(f)).toMatchObject({ state: "done", evidence: { provider: "systemd" } });
  });
  test("a timer that is not enabled is not scheduled", async () => {
    const f = fixture(["systemctl"]);
    f.place(f.timer);
    expect(await check(f)).toMatchObject({ state: "skipped", reason: "housekeeping_not_enabled" });
  });
  test("systemctl with no user manager behind it can't run the job", async () => {
    const f = fixture(["systemctl"]);
    f.answers.set("systemctl --user show-environment", {
      status: 1,
      stdout: "",
      stderr: "Failed to connect to bus: No medium found",
    });
    expect(await check(f)).toEqual({ state: "skipped", reason: "housekeeping_no_scheduler" });
  });
  test("a user manager with no timer is not scheduled", async () => {
    const f = fixture(["systemctl"]);
    f.answers.set("systemctl --user show-environment", { status: 0, stdout: "", stderr: "" });
    expect(await check(f)).toEqual({ state: "skipped", reason: "housekeeping_not_scheduled" });
  });
  test("the installer's recorded 'no scheduler' is believed without a probe", async () => {
    const f = fixture(["systemctl"], { state: "skipped", reason: "no_scheduler" });
    expect(await check(f)).toEqual({ state: "skipped", reason: "housekeeping_no_scheduler" });
    expect(f.calls).toEqual([]);
  });
});

test("the record keeps the installer's choice when setup rewrites it", () => {
  const f = fixture([]);
  const path = join(f.home, "last-run.json");
  writeFileSync(path, JSON.stringify({ schema: 1, steps: [], dailyUpdate: { state: "off" } }));
  expect(readOnboardJournal(path)?.dailyUpdate).toEqual({ state: "off" });
  writeFileSync(path, JSON.stringify({ schema: 1, steps: [], dailyUpdate: { state: "weekly" } }));
  expect(readOnboardJournal(path)?.dailyUpdate).toBeUndefined();
  writeFileSync(path, JSON.stringify({ schema: 1, steps: [] }));
  expect(readOnboardJournal(path)?.dailyUpdate).toBeUndefined();
});

describe("the daily update is optional: one row, never an action", () => {
  const done = (id: string): OnboardStep => ({ id, state: "done" }) as OnboardStep;
  const journal = (housekeeping: OnboardStep): OnboardJournal => ({
    schema: 1,
    runId: "x",
    installer: null,
    cli: "0.15.0",
    tenant: null,
    exit: 0,
    complete: true,
    steps: [...ONBOARD_STEPS.filter((id) => id !== "housekeeping").map(done), housekeeping],
    changes: [],
  });
  test.each([
    ["housekeeping_off_chosen", "skipped, as you chose"],
    ["housekeeping_no_scheduler", "can't run on this computer"],
    ["housekeeping_not_scheduled", "not scheduled; the install command turns it on"],
    ["housekeeping_not_loaded", "not scheduled; the install command turns it on"],
    ["housekeeping_not_enabled", "not scheduled; the install command turns it on"],
  ])("%s reads as a skipped row and keeps setup complete", (reason, outcome) => {
    const step: OnboardStep = { id: "housekeeping", state: "skipped", reason };
    expect(setupStepView(step)).toMatchObject({ title: "Daily update", mark: "skip", outcome });
    expect(stepSatisfied(step)).toBe(true);
    const screen = setupFinalScreen(journal(step), "https://staging.catalystcloud.dev");
    expect(screen).toMatchObject({
      heading: "Setup complete",
      actions: [],
      next: "Next: move a ticket to Todo in Linear.",
    });
  });
  test("a scheduled one reads as done", () => {
    expect(setupStepView(done("housekeeping"))).toMatchObject({
      mark: "done",
      outcome: "scheduled, runs daily",
    });
  });
});
