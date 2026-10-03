import { expect, test } from "vitest";
import { setupStepView, setupFinalScreen, onboardJsonView } from "../src/setup-onboard-copy.js";
import { ONBOARD_STEPS, type OnboardJournal } from "../src/onboard.js";
function journal(): OnboardJournal {
  return {
    schema: 1,
    runId: "test",
    installer: null,
    cli: "0.15.0",
    tenant: null,
    exit: 11,
    complete: false,
    changes: [],
    steps: ONBOARD_STEPS.map((id) => ({ id, state: "done" })),
  };
}
test("an unfinished parent is a later line, never a root action", () => {
  const j = journal();
  j.steps.find((s) => s.id === "github.install")!.state = "waiting";
  const child = j.steps.find((s) => s.id === "github.repos")!;
  Object.assign(child, { state: "waiting", reason: "prerequisite_not_ready" });
  expect(setupStepView(child, j)).toMatchObject({
    number: 13,
    mark: "later",
    outcome: "after step 11",
  });
  expect(
    setupFinalScreen(j, "https://staging.catalystcloud.dev").actions.map(
      (a) => a.id,
    ),
  ).toEqual(["github.install"]);
});
test("optional daily update is skipped while a broken step still fails", () => {
  const j = journal();
  const s = j.steps.find((s) => s.id === "housekeeping")!;
  Object.assign(s, {
    state: "waiting",
    reason: "housekeeping_service_unverified",
  });
  expect(setupStepView(s, j)).toMatchObject({
    mark: "skip",
    outcome: "no scheduler here. catalyst says when an update is out",
  });
  s.state = "failed";
  expect(setupStepView(s, j).mark).toBe("fail");
});
test("final actions cap at five, are in step order and do not repeat reasons", () => {
  const j = journal();
  for (const id of [
    "linear.workspace",
    "machine",
    "cli",
    "skills",
    "legacy",
    "housekeeping",
    "github.install",
    "github.personal",
  ] as const)
    j.steps.find((s) => s.id === id)!.state = "waiting";
  const f = setupFinalScreen(j, "https://staging.catalystcloud.dev");
  expect(f.actions).toHaveLength(5);
  expect(f.more).toBe(3);
  expect(f.actions[0]!.text).toBe(
    "Try this step again when setup checks again.",
  );
  expect(f.next).toBe("Next: run catalyst onboard after you finish 1 to 5.");
});
test("final headings keep complete, ready, waiting and paused distinct", () => {
  const j = journal();
  expect(setupFinalScreen(j).heading).toBe("Not ready for work yet");
  j.exit = 0;
  expect(setupFinalScreen(j).heading).toBe("Ready for work");
  j.complete = true;
  expect(setupFinalScreen(j).heading).toBe("Setup complete");
  expect(setupFinalScreen(j, undefined, true).heading).toBe("Setup paused");
});
test("done outcomes do not print internal identifiers or reason codes", () => {
  const j = journal();
  const s = j.steps.find((s) => s.id === "accounts")!;
  s.evidence = {
    provider: "claude",
    accountSlot: "secret-id",
    checkedAt: "today",
  };
  s.reason = "account_provider_access_verified";
  expect(setupStepView(s, j).outcome).toBe("Claude can take work");
});

test("paused before sign-in has no unreached root actions", () => {
  const j = journal();
  j.steps = j.steps.map((s) => ({ id: s.id, state: "pending" }));
  Object.assign(
    j.steps.find((s) => s.id === "signin")!,
    { state: "waiting", reason: "interrupted" },
  );
  expect(
    setupStepView(
      j.steps.find((s) => s.id === "linear.workspace")!,
      j,
    ).mark,
  ).toBe("later");
  expect(setupFinalScreen(j, undefined, true).actions.map((a) => a.id)).toEqual(
    ["signin"],
  );
});
test("failed dependent step is not another root action", () => {
  const j = journal();
  Object.assign(
    j.steps.find((s) => s.id === "linear.workspace")!,
    { state: "waiting" },
  );
  Object.assign(
    j.steps.find((s) => s.id === "linear.personal")!,
    { state: "failed" },
  );
  expect(setupFinalScreen(j).actions.map((a) => a.id)).toEqual([
    "linear.workspace",
  ]);
});

test("JSON final facts preserve the journal and expose only reachable actions", async () => {
  const { onboardJsonView } = await import("../src/setup-onboard-copy.js");
  const j = journal();
  Object.assign(
    j.steps.find((s) => s.id === "github.install")!,
    { state: "waiting" },
  );
  Object.assign(
    j.steps.find((s) => s.id === "github.repos")!,
    { state: "waiting", reason: "prerequisite_not_ready" },
  );
  const result = onboardJsonView(j, "https://staging.catalystcloud.dev");
  expect(result.steps).toBe(j.steps);
  expect(result.verdict).toBe("not-ready");
  expect(result.actions).toEqual([
    {
      step: "github.install",
      number: 11,
      text: "Install Catalyst on your GitHub organization.",
      url: "https://staging.catalystcloud.dev/connect/github/start",
      who: "github-org-admin",
    },
  ]);
  expect(result.next).toBe("catalyst onboard");
  expect(onboardJsonView(j, undefined, true).verdict).toBe("paused");
  j.exit = 10;
  expect(onboardJsonView(j).verdict).toBe("failed");
});

test("required skipped runner gets a real remedy and selected JSON excludes unrelated prior failures", async () => {
  const { onboardJsonView } = await import("../src/setup-onboard-copy.js");
  const j = journal();
  Object.assign(
    j.steps.find((s) => s.id === "runner")!,
    { state: "skipped", reason: "runner_docker_missing" },
  );
  Object.assign(
    j.steps.find((s) => s.id === "github.install")!,
    { state: "failed" },
  );
  const json = onboardJsonView(j, "https://staging.catalystcloud.dev", false, {
    only: "runner",
    requiredSteps: ["runner"],
  });
  expect(json.actions.map((a) => a.step)).toEqual(["runner"]);
  expect(json.actions[0]!.text).not.toContain("/settings/runner-hosts");
  expect(json.steps.find((s) => s.id === "runner")!.state).toBe("skipped");
});

test("explicit runner and scoped optional prerequisites remain actionable without altering raw skips", async () => {
  const { onboardJsonView } = await import("../src/setup-onboard-copy.js");
  const j = journal();
  Object.assign(
    j.steps.find((s) => s.id === "runner")!,
    { state: "skipped", reason: "member_scope" },
  );
  const runner = onboardJsonView(j, undefined, false, {
    only: "runner",
    requiredSteps: ["runner"],
  });
  expect(runner.actions.map((a) => [a.step, a.number])).toEqual([
    ["runner", 15],
  ]);
  Object.assign(
    j.steps.find((s) => s.id === "settings")!,
    { state: "waiting", reason: "settings_approval_unverified" },
  );
  Object.assign(
    j.steps.find((s) => s.id === "values")!,
    { state: "waiting", reason: "prerequisite_not_ready" },
  );
  expect(
    onboardJsonView(j, undefined, false, { only: "values" }).actions.map(
      (a) => a.step,
    ),
  ).toEqual(["settings"]);
});
test("continuation names only remaining downstream work", async () => {
  const { pendingContinuation } =
    await import("../src/onboard-standalone-copy.js");
  const j = journal();
  expect(pendingContinuation(j)).toBeNull();
  j.steps.find((s) => s.id === "accounts")!.state = "waiting";
  expect(pendingContinuation(j)).toBe("Then setup checks a coding account.");
});

test("runner and capacity can carry different actionable gates on visible step15", async () => {
  const { onboardJsonView } = await import("../src/setup-onboard-copy.js");
  const j = journal();
  Object.assign(
    j.steps.find((s) => s.id === "runner")!,
    { state: "skipped", reason: "runner_docker_missing" },
  );
  Object.assign(
    j.steps.find((s) => s.id === "capacity")!,
    { state: "waiting", reason: "capacity_admission_unverified" },
  );
  expect(
    onboardJsonView(j, undefined, false, {
      requiredSteps: ["runner"],
    }).actions.map((a) => a.step),
  ).toEqual(["capacity", "runner"]);
});

test("a scoped accepted skip has no invented action unless explicitly required", async () => {
  const { onboardJsonView } = await import("../src/setup-onboard-copy.js");
  const j = journal();
  Object.assign(
    j.steps.find((s) => s.id === "legacy")!,
    { state: "skipped", reason: "fake_home_report_only" },
  );
  expect(
    onboardJsonView(j, undefined, false, { only: "legacy" }).actions,
  ).toEqual([]);
  Object.assign(
    j.steps.find((s) => s.id === "runner")!,
    { state: "skipped", reason: "runner_not_selected" },
  );
  expect(
    onboardJsonView(j, undefined, false, { only: "runner" }).actions,
  ).toEqual([]);
});

test("a selected runner missing Docker is actionable in production views", async () => {
  const { onboardJsonView } = await import("../src/setup-onboard-copy.js");
  const j = journal();
  j.exit = 0;
  const runner = j.steps.find((s) => s.id === "runner")!;
  Object.assign(runner, {
    state: "skipped",
    reason: "runner_docker_missing",
    evidence: { selected: true },
  });
  expect(setupStepView(runner, j)).toMatchObject({
    mark: "act",
    outcome: "Docker is not running",
  });
  expect(setupFinalScreen(j).heading).toBe("Not ready for work yet");
  expect(onboardJsonView(j).verdict).toBe("not-ready");
  expect(onboardJsonView(j).actions.map((a) => a.step)).toEqual(["runner"]);
});

test("JSON next follows a completed first ticket and choices belong to you", async () => {
  const { onboardJsonView } = await import("../src/setup-onboard-copy.js");
  const j = journal();
  j.exit = 0;
  j.complete = true;
  j.steps.find((s) => s.id === "first-ticket")!.evidence = {
    ticketKey: "TEST-1",
    url: "https://linear.app/example/issue/TEST-1",
  };
  expect(onboardJsonView(j).next).toBe(
    "open https://linear.app/example/issue/TEST-1 and follow TEST-1.",
  );
  j.exit = 11;
  j.complete = false;
  for (const id of [
    "linear.team",
    "github.repos",
    "first-ticket",
    "settings",
  ] as const) {
    const copy = journal();
    const row = copy.steps.find((s) => s.id === id)!;
    row.state = "waiting";
    const action = onboardJsonView(copy).actions.find((a) => a.step === id)!;
    expect(action.who).toBe("you");
    expect(action.text).toMatch(/^[A-Z]/);
  }
});

test("optional checkout waits do not promise a continuation setup cannot perform", async () => {
  const { pendingContinuation } =
    await import("../src/onboard-standalone-copy.js");
  const j = journal();
  for (const id of ["settings", "values"] as const)
    Object.assign(
      j.steps.find((s) => s.id === id)!,
      { state: "waiting", reason: "settings_checkout_unverified" },
    );
  expect(pendingContinuation(j)).toBeNull();
});

test.each([undefined, "ADV", "TEAM / A"])(
  "workflow remedy uses the real team adoption route (%s)",
  async (teamKey) => {
    const { onboardJsonView } = await import("../src/setup-onboard-copy.js");
    const j = journal();
    if (teamKey)
      j.steps.find((s) => s.id === "linear.team")!.evidence = { teamKey };
    Object.assign(
      j.steps.find((s) => s.id === "linear.adopt")!,
      { state: "waiting" },
    );
    const path = teamKey
      ? `/settings/linear-teams/${encodeURIComponent(teamKey)}/adopt`
      : "/settings/linear-teams";
    expect(onboardJsonView(j, "https://cloud.test").actions[0]!.url).toBe(
      `https://cloud.test${path}`,
    );
    expect(
      setupFinalScreen(j, "https://cloud.test").actions[0]!.text,
    ).toContain(path);
  },
);
test.each(["member_scope", "runner_identity_unverified"])(
  "JSON assigns administrator gates to an admin (%s)",
  async (reason) => {
    const { onboardJsonView } = await import("../src/setup-onboard-copy.js");
    const j = journal();
    Object.assign(
      j.steps.find((s) => s.id === "runner")!,
      { state: "waiting", reason, evidence: { selected: true } },
    );
    expect(onboardJsonView(j).actions[0]!.who).toBe("admin");
  },
);
test("coding account enrollment names an admin until an owner/admin role is verified", async () => {
  const { onboardJsonView } = await import("../src/setup-onboard-copy.js");
  const j = journal();
  j.steps.find((s) => s.id === "accounts")!.state = "waiting";
  expect(onboardJsonView(j).actions[0]!.who).toBe("admin");
  j.steps.find((s) => s.id === "signin")!.evidence = { role: "owner" };
  expect(onboardJsonView(j).actions[0]!.who).toBe("you");
});


test.each([
  ["github.install", "github_app_permissions_outdated", "needs updated permissions", "https://github.com/organizations/acme/settings/installations/17/permissions/update"],
  ["github.install", "github_app_repository_missing", "cannot reach a project repository", "https://github.com/organizations/acme/settings/installations/17"],
  ["linear.workspace", "linear_workspace_scope_outdated", "needs updated permissions", "https://staging.catalystcloud.dev/settings/connections?reauthorize=linear"],
  ["linear.personal", "linear_personal_scope_outdated", "needs updated permissions", "https://staging.catalystcloud.dev/connect/linear/personal/start"],
] as const)("%s %s retains its verified repair in human and JSON actions", (id, reason, outcome, url) => {
  const j = journal();
  const step = j.steps.find((s) => s.id === id)!;
  Object.assign(step, { state: "waiting", reason, evidence: { installation: "17", org: "acme", repository: "acme/widget", missing: "write", url } });
  expect(setupStepView(step, j).outcome).toBe(outcome);
  const screen = setupFinalScreen(j, "https://staging.catalystcloud.dev");
  expect(screen.actions.find((a) => a.id === id)?.text).toContain(url);
  const json = onboardJsonView(j, "https://staging.catalystcloud.dev");
  expect(json.actions.find((a) => a.step === id)?.url).toBe(url);
  step.evidence!.url = "https://untrusted.invalid/not-a-review";
  expect(setupFinalScreen(j, "https://staging.catalystcloud.dev").actions.find((a) => a.id === id)?.text).not.toContain("untrusted.invalid");
});
test("a project repository without an installation is never presented as a permission approval", () => {
 const j = journal(); const step=j.steps.find((s)=>s.id==="github.install")!;
 Object.assign(step,{state:"waiting",reason:"github_app_repository_not_installed",evidence:{repository:"acme/widget",org:"acme"}});
 expect(setupStepView(step,j).outcome).toBe("no installation reaches the project repository");
 expect(setupFinalScreen(j,"https://staging.catalystcloud.dev").actions[0]?.text).toContain("acme/widget");
});

test("CTC-4680 round 5: the GitHub install link starts the install, never the settings page", async () => {
  const { setupBrowserInstruction } = await import("../src/setup-onboard-copy.js");
  const base = "https://staging.catalystcloud.dev";
  for (const opened of [false, true]) {
    const copy = setupBrowserInstruction("github.install", base, opened)!;
    expect(copy.url).toBe(`${base}/connect/github/start`);
  }
  const screen = setupFinalScreen(
    {
      schema: 1,
      runId: "r5",
      installer: null,
      cli: "0.15.1",
      tenant: null,
      exit: 11,
      changes: [],
      steps: [
        { id: "signin", state: "done" },
        { id: "github.install", state: "waiting", reason: "github_installation_browser_unavailable" },
      ],
    } as OnboardJournal,
    base,
    true,
  );
  const text = screen.actions.map((a) => a.text).join("\n");
  expect(text).toContain(`${base}/connect/github/start`);
  expect(text).not.toContain("/settings/connections");
});

test("CTC-4680 round 5: a timed-out step says so, and the runner waits for GitHub", () => {
  for (const reason of ["consent_timeout", "github_installation_browser_unavailable"]) {
    const view = setupStepView({ id: "github.install", state: "waiting", reason });
    expect(view.outcome).toBe("the link timed out");
    expect(view.mark).toBe("act");
  }
  const runner = setupStepView(
    { id: "runner", state: "waiting", reason: "github_install_pending" },
    {
      schema: 1, runId: "r5", installer: null, cli: "0.15.1", tenant: null, exit: null, changes: [],
      steps: [{ id: "github.install", state: "waiting", reason: "consent_timeout" }],
    } as OnboardJournal,
  );
  expect(runner).toMatchObject({ mark: "later", outcome: "after step 11" });
});

test("CTC-4680: a pending GitHub install request still offers the install link", async () => {
  const { onboardReasonText } = await import("../src/onboard-next.js");
  const text = onboardReasonText(
    { id: "github.install", state: "waiting", reason: "github_installation_approval_pending" },
    { baseUrl: "https://staging.catalystcloud.dev" },
  );
  expect(text).toContain("An install request is waiting on GitHub.");
  expect(text).toContain("https://staging.catalystcloud.dev/connect/github/start");
});
