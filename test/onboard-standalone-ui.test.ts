import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { createClackOnboardUi } from "../src/onboard-ui.js";
import { createSetupRenderer } from "../src/setup-render.js";
import { ONBOARD_STEPS, type OnboardJournal } from "../src/onboard.js";

function fixture(interactive = false, answer = "stop", fancy = false) {
  const output = new PassThrough();
  Object.assign(output, { isTTY: fancy, columns: 80 });
  let text = "";
  output.on("data", (chunk) => {
    text += chunk;
  });
  const quiet = () => {};
  const ui = createClackOnboardUi(
    {
      intro: quiet,
      outro: quiet,
      log: { message: quiet, info: quiet, warn: quiet, error: quiet },
      select: async () => answer,
      isCancel: () => false,
    },
    { input: new PassThrough(), output },
    {
      renderer: createSetupRenderer(
        output,
        fancy ? { TERM: "xterm", LANG: "en_US.UTF-8" } : { NO_COLOR: "1" },
      ),
      interactive,
      signals: new EventEmitter(),
    },
  );
  const journal: OnboardJournal = {
    schema: 1,
    runId: "standalone",
    installer: null,
    cli: "0.15.0",
    tenant: null,
    exit: 11,
    complete: false,
    changes: [],
    steps: ONBOARD_STEPS.map((id) => ({ id, state: "pending" })),
  };
  return { ui, journal, text: () => text };
}

test("standalone plan names the three parts, lists part 1, and discloses rechecked steps when their part starts", () => {
  const f = fixture();
  f.journal.steps.find((step) => step.id === "linear.workspace")!.state =
    "done";
  f.ui.plan(f.journal);
  const plan = f.text();
  expect(plan).toContain("1 This computer");
  expect(plan).toContain("2 Linear and GitHub");
  expect(plan).toContain("3 Ready for work");
  expect(plan).toContain("Part 1 of 3: This computer");
  expect(plan).toContain("2 Sign in to Catalyst");
  expect(plan).toContain("3 Daily update");
  expect(plan).not.toContain("(recheck)");
  expect("  0 Unknown").toMatch(/^\s*0 /m);
  expect(plan).not.toMatch(/^\s*0 /m);
  expect(plan).not.toContain("tenant");
  for (const id of ["machine", "cli", "skills", "legacy", "signin"] as const) {
    const step = f.journal.steps.find((s) => s.id === id)!;
    step.state = "done";
    f.ui.stepStart(id);
    f.ui.stepEnd(step, f.journal);
  }
  f.ui.stepStart("linear.workspace");
  const part2 = f.text().slice(plan.length);
  expect(part2).toContain("Part 2 of 3: Linear and GitHub");
  expect(part2).toContain("1 Connect your Linear workspace");
  expect(part2).toContain("check again;");
  expect(part2).toContain("2 Connect your Linear account");
  f.ui.dispose();
});

test("standalone machine checks produce one success and no step zero", () => {
  const f = fixture();
  for (const id of ["machine", "cli", "skills", "legacy"] as const) {
    const step = f.journal.steps.find((step) => step.id === id)!;
    step.state = "done";
    f.ui.stepStart(id);
    f.ui.stepEnd(step, f.journal);
  }
  expect("[done] 0 Unknown").toMatch(/^\s*\[[^\]]+\] +0 /m);
  expect(f.text()).not.toMatch(/^\s*\[[^\]]+\] +0 /m);
  const done = f
    .text()
    .split("\n")
    .filter((line) => line.startsWith("    [done]"));
  expect(done).toHaveLength(1);
  expect(done[0]).toContain("This computer");
  f.ui.dispose();
});

test("final continuation names only the stages still pending", () => {
  const f = fixture();
  for (const step of f.journal.steps) step.state = "done";
  Object.assign(
    f.journal.steps.find((step) => step.id === "linear.personal")!,
    { state: "waiting", reason: "personal_linear_missing" },
  );
  Object.assign(
    f.journal.steps.find((step) => step.id === "first-ticket")!,
    { state: "pending", reason: "prerequisite_not_ready" },
  );
  f.ui.finish(f.journal);
  expect(f.text()).not.toContain("Then setup chooses repositories");
  expect(f.text()).toContain("Then setup starts a first ticket.");
  f.ui.dispose();
});

for (const id of ["machine", "cli", "skills", "legacy"] as const) {
  test(`a scoped ${id} check resolves and cannot report the whole onboarding ready`, () => {
    const f = fixture();
    f.ui.plan(f.journal, undefined, { localSync: false, scope: [id] });
    const step = f.journal.steps.find((step) => step.id === id)!;
    step.state = "done";
    f.ui.stepStart(id);
    f.ui.stepEnd(step, f.journal);
    f.journal.exit = 0;
    f.ui.finish(f.journal, id);
    expect(f.text()).toContain("[done]");
    expect(f.text()).toContain("the selected checks passed");
    expect(f.text()).toContain("Step complete");
    expect(f.text()).not.toContain("Ready for work");
    expect(f.text()).toContain("Onboarding still has other steps");
    f.ui.dispose();
  });
}

test("effective local sync is disclosed before the journal is updated", () => {
  const f = fixture();
  f.ui.plan(f.journal, undefined, {
    localSync: true,
    scope: ["signin", "daemon"],
  });
  expect(f.text()).toContain("Local sync is selected");
  expect(f.text()).not.toContain("Local sync stays off");
  expect(f.text().replace(/\s+/g, " ")).toContain(
    "Setup reads your AI accounts without sending them a request.",
  );
  f.ui.dispose();
});

test("check again resolves only the unfinished computer check", async () => {
  const f = fixture(true, "again");
  for (const step of f.journal.steps) step.state = "done";
  const step = f.journal.steps.find((step) => step.id === "skills")!;
  Object.assign(step, { state: "waiting", reason: "skills_missing" });
  f.ui.plan(f.journal);
  expect(await f.ui.checkAgain!(f.journal)).toBe(true);
  step.state = "done";
  f.ui.stepStart("skills");
  f.ui.stepEnd(step, f.journal);
  expect(f.text()).toContain("the selected checks passed");
  f.ui.dispose();
});

test("a failed computer check closes the live combined row before its failure", () => {
  const f = fixture(false, "stop", true);
  f.ui.plan(f.journal);
  for (const id of ["machine", "cli", "skills"] as const) {
    const step = f.journal.steps.find((s) => s.id === id)!;
    Object.assign(step, {
      state: id === "skills" ? "failed" : "done",
      reason: id === "skills" ? "skills_missing" : undefined,
    });
    f.ui.stepStart(id);
    f.ui.stepEnd(step, f.journal);
  }
  expect(f.text().lastIndexOf("checking…")).toBeLessThan(
    f.text().lastIndexOf("✗"),
  );
  expect(f.text()).not.toContain("Check the full log");
  f.ui.dispose();
});

test("a display scope without computer checks never reports their success", () => {
  const f = fixture();
  f.ui.plan(f.journal, undefined, { localSync: false, scope: ["linear.team"] });
  for (const id of ["machine", "cli", "skills", "legacy"] as const) {
    const step = f.journal.steps.find((s) => s.id === id)!;
    step.state = "done";
    f.ui.stepStart(id);
    f.ui.stepEnd(step, f.journal);
  }
  expect(f.text()).not.toContain("the selected checks passed");
  f.ui.dispose();
});

test("old member skips cannot hide a currently selected team", () => {
  const f = fixture();
  Object.assign(
    f.journal.steps.find((s) => s.id === "linear.team")!,
    { state: "skipped", reason: "member_scope" },
  );
  f.ui.plan(f.journal, undefined, { localSync: false, scope: ["linear.team"] });
  expect(f.text()).toContain("3 Choose a Linear team");
  f.ui.dispose();
});

test("local sync has no step number and readiness has no step row", () => {
  const f = fixture();
  f.ui.plan(f.journal);
  const d = f.journal.steps.find((s) => s.id === "daemon")!;
  Object.assign(d, { state: "skipped", reason: "local_sync_not_selected" });
  f.ui.stepStart("daemon");
  f.ui.stepEnd(d, f.journal);
  const r = f.journal.steps.find((s) => s.id === "ready")!;
  Object.assign(r, { state: "waiting", reason: "onboarding_not_ready" });
  f.ui.stepStart("ready");
  f.ui.stepEnd(r, f.journal);
  expect(f.text()).not.toContain("5 Check optional local sync");
  expect(f.text()).not.toContain("17 Check onboarding readiness");
  expect(f.text()).not.toContain("Check onboarding readiness");
  expect(f.text()).toContain("Local sync");
  f.ui.dispose();
});

test("the standalone consent question owns a safe unnumbered prompt frame", async () => {
  const f = fixture(true, "cloud", true);
  f.ui.plan(f.journal);
  expect(await f.ui.confirmPlan(false, "saved")).toMatchObject({
    proceed: true,
  });
  expect(f.text()).toMatch(/\x1b\[[1-9][0-9]*A\r\x1b\[J/);
  expect(f.text()).not.toContain("0 Continue with this plan");
  f.ui.dispose();
});

for (const [id, row] of [
  ["runner", "4 Run Catalyst's work on this machine"],
  ["values", "6 Check repository values"],
] as const) {
  test(`the scoped ${id} plan displays its own public row`, () => {
    const f = fixture();
    f.ui.plan(f.journal, undefined, { localSync: false, scope: [id] });
    expect(f.text()).toContain(row);
    f.ui.dispose();
  });
}

test("a failed check gives one final next action without leaking a raw step ID", () => {
  const f = fixture();
  const step = f.journal.steps.find((s) => s.id === "linear.workspace")!;
  Object.assign(step, { state: "failed", reason: "workspace_linear_missing" });
  f.ui.stepStart(step.id);
  f.ui.stepEnd(step, f.journal);
  f.ui.finish(f.journal);
  expect(f.text()).not.toContain("--only linear.workspace");
  expect(f.text()).toContain("Next: run catalyst setup");
  f.ui.dispose();
});

test("staged approval followed by the engine identity check prints one sign-in outcome", () => {
  const f = fixture();
  f.ui.message("To connect this machine, visit: https://example.test/device");
  f.ui.message("and enter the code: TEST-4321");
  expect(f.ui.stagedSigninEnd!("done")).toBe(true);
  f.ui.plan(f.journal);
  const signin = f.journal.steps.find((step) => step.id === "signin")!;
  Object.assign(signin, { state: "done", evidence: { signedIn: true } });
  f.ui.stepStart("signin");
  f.ui.stepEnd(signin, f.journal);
  const outcomes = f
    .text()
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("    [done]") && line.includes("Sign in to Catalyst"),
    );
  expect(outcomes).toHaveLength(1);
  f.ui.dispose();
});

test("the computer plan discloses removing earlier installs while keeping data", () => {
  const f = fixture();
  f.ui.plan(f.journal);
  expect(f.text().replace(/\s+/g, " ")).toContain(
    "remove any earlier Catalyst install",
  );
  expect(f.text().replace(/\s+/g, " ")).toContain("keep its data folders");
  f.ui.dispose();
});

test("a machine-only plan does not promise legacy removal or unrelated skill checks", () => {
  const f = fixture();
  f.ui.plan(f.journal, undefined, { localSync: false, scope: ["machine"] });
  const text = f.text().replace(/\s+/g, " ");
  expect(text).not.toContain("remove any earlier");
  expect(text).not.toContain("check the command and skills");
  f.ui.dispose();
});

test("a selected runner is disclosed as a Docker start in the reviewed plan", () => {
  const f = fixture();
  f.ui.plan(f.journal, undefined, {
    localSync: false,
    scope: ["runner"],
    runner: true,
  });
  expect(f.text().replace(/\s+/g, " ")).toContain(
    "start a Catalyst runner here with Docker",
  );
  expect(f.text()).not.toContain("check which runners can take work");
  f.ui.dispose();
});
