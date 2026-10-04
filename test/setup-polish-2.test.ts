// setup-polish-2.test.ts — CTC-4680: what fixture captures of main 25f99f2 showed wrong. A member's
// run claimed parts done that an owner or admin still has to do, a status line posed as an action,
// a long last line broke mid-word, a row number went missing, and the Connect accounts page was
// treated like a link that expires. Each test names the capture it comes from.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { createClackOnboardUi } from "../src/onboard-ui.js";
import {
  ONBOARD_STEPS,
  type OnboardJournal,
  type OnboardStepId,
} from "../src/onboard.js";
import { onboardJsonView } from "../src/setup-onboard-copy.js";
import { createSetupRenderer, type SetupStream } from "../src/setup-render.js";

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const plain = (text: string) => text.replace(ANSI, "");
type Step = OnboardJournal["steps"][number];

function journalWith(states: Partial<Record<OnboardStepId, Partial<Step>>> = {}): OnboardJournal {
  return {
    schema: 1,
    runId: "polish-2",
    installer: null,
    cli: "0.16.0",
    tenant: null,
    exit: 11,
    complete: false,
    changes: [],
    steps: ONBOARD_STEPS.map((id) => ({ id, state: "pending" as const, ...states[id] })),
  };
}

interface Asked {
  message: string;
  labels: string[];
}

function fixture() {
  const output = new PassThrough();
  Object.assign(output, { isTTY: false, columns: 80 });
  let text = "";
  output.on("data", (chunk) => {
    text += chunk;
  });
  const asked: Asked[] = [];
  const quiet = () => {};
  const ui = createClackOnboardUi(
    {
      intro: quiet,
      outro: quiet,
      log: { message: quiet, info: quiet, warn: quiet, error: quiet },
      select: async (o) => {
        asked.push({ message: o.message, labels: o.options.map((x) => x.label) });
        return o.initialValue;
      },
      isCancel: () => false,
    },
    { input: new PassThrough(), output },
    {
      renderer: createSetupRenderer(output, { NO_COLOR: "1" }),
      interactive: true,
      signals: new EventEmitter(),
      version: "0.16.0",
      baseUrl: () => "https://cloud.test",
    },
  );
  const journal = journalWith();
  const run = (id: OnboardStepId, state: Step["state"], extra: Partial<Step> = {}) => {
    const step = journal.steps.find((s) => s.id === id)!;
    ui.stepStart(id);
    Object.assign(step, { state, ...extra });
    ui.stepEnd(step, journal);
  };
  return { ui, journal, run, asked, text: () => plain(text) };
}

const admin = { state: "skipped" as const, reason: "member_scope" };

/** A member's run as capture 13 drew it: part 1 done, then every owner-or-admin step skipped. */
function memberRun(f: ReturnType<typeof fixture>) {
  f.ui.plan(f.journal);
  for (const id of ["machine", "cli", "skills", "legacy"] as const) f.run(id, "done");
  f.run("signin", "done", { evidence: { role: "member" } });
  f.run("housekeeping", "done");
  f.run("linear.workspace", admin.state, { reason: admin.reason });
  f.run("linear.personal", "done");
  f.run("linear.team", "done", { evidence: { teamKey: "ADV" } });
  f.run("linear.adopt", admin.state, { reason: admin.reason });
  f.run("linear.automations", admin.state, { reason: admin.reason });
  f.run("github.install", "waiting", { reason: "github_installation_admin_required" });
  f.run("github.personal", "done");
}

describe("setup polish 2", () => {
  test("12/13: a part an owner or admin still has to finish is never called done", () => {
    const f = fixture();
    memberRun(f);
    const before = f.text().length;
    f.run("github.repos", admin.state, { reason: admin.reason });
    const boundary = f.text().slice(before);
    expect(boundary).not.toContain("Part 2 done");
    // Mid-run nothing yet says whether an owner or admin has done their part: the words are neutral.
    expect(boundary).toContain(
      "The rest of part 2 is for an owner or admin of your Catalyst workspace.",
    );
    expect(boundary).not.toContain("still has to");
    expect(boundary).not.toMatch(/\[done\] +2 Linear and GitHub/);
    expect(boundary).toMatch(/\[!\] +2 Linear and GitHub +4 steps are for an owner or admin/);
    for (const id of ["projects", "capacity", "runner", "settings", "first-ticket"] as const)
      f.run(id, admin.state, { reason: admin.reason });
    f.run("values", "done");
    f.run("accounts", "done");
    // Readiness names what an owner or admin has left: the workspace connection and the workflow.
    Object.assign(f.journal.steps.find((s) => s.id === "ready")!, {
      state: "waiting",
      reason: "admin_setup_pending",
      evidence: { admin: "linear.workspace,linear.adopt" },
    });
    const end = f.text().length;
    f.ui.finish(f.journal);
    const screen = f.text().slice(end);
    expect(screen).not.toMatch(/\[done\] +2 Linear and GitHub/);
    expect(screen).toMatch(/\[!\] +2 Linear and GitHub +3 steps wait on an owner or admin/);
    f.ui.dispose();
  });

  test("13: an owner's or admin's task is listed under who does it, not as the member's own", async () => {
    const f = fixture();
    memberRun(f);
    for (const id of ["github.repos", "projects", "capacity", "runner", "settings", "values", "first-ticket"] as const)
      f.run(id, "pending", { reason: "prerequisite_not_ready" });
    f.run("accounts", "done");
    // Nothing on the list is the member's to do, so setup does not offer to check again.
    expect(await f.ui.checkAgain!(f.journal)).toBe(false);
    expect(f.asked).toHaveLength(0);
    const end = f.text().length;
    f.ui.finish(f.journal);
    const screen = f.text().slice(end).replace(/\s+/g, " ");
    expect(screen).toContain("Waiting on an owner or admin of your Catalyst workspace");
    expect(screen).toContain("https://cloud.test/settings/connections");
    expect(screen).not.toMatch(/needs? you/);
    expect(screen).not.toContain("after you finish 1");
    expect(screen).toContain("Next: run catalyst setup once they have.");
    f.ui.dispose();
  });

  test("13: a task listed for an owner or admin is not named again in the steps only they can do", () => {
    const f = fixture();
    for (const id of ONBOARD_STEPS)
      Object.assign(f.journal.steps.find((s) => s.id === id)!, { state: "done" });
    Object.assign(f.journal.steps.find((s) => s.id === "signin")!, { evidence: { role: "member" } });
    Object.assign(f.journal.steps.find((s) => s.id === "linear.adopt")!, admin);
    Object.assign(f.journal.steps.find((s) => s.id === "github.install")!, {
      state: "failed",
      reason: "member_scope",
    });
    Object.assign(f.journal.steps.find((s) => s.id === "ready")!, {
      state: "waiting",
      reason: "admin_setup_pending",
      evidence: { admin: "linear.adopt,github.install" },
    });
    f.ui.finish(f.journal);
    const screen = f.text().slice(f.text().indexOf("Waiting on an owner")).replace(/\s+/g, " ");
    expect(screen).toContain("set up the team's Catalyst workflow");
    expect(screen.match(/Install Catalyst on GitHub|install Catalyst on GitHub/g) ?? []).toHaveLength(1);
    f.ui.dispose();
  });

  test("06: a paused step's 'run the same command' is status, never a numbered action", () => {
    const f = fixture();
    for (const id of ONBOARD_STEPS)
      Object.assign(f.journal.steps.find((s) => s.id === id)!, { state: "done" });
    Object.assign(f.journal.steps.find((s) => s.id === "accounts")!, {
      state: "waiting",
      reason: "account_enrollment_required",
    });
    Object.assign(f.journal.steps.find((s) => s.id === "runner")!, {
      state: "waiting",
      reason: "interrupted",
    });
    f.ui.finish(f.journal);
    const lines = f.text().split("\n");
    expect(lines.filter((l) => /^ {2}\d+\. /.test(l))).toHaveLength(1);
    expect(f.text()).not.toMatch(/\d+\. Setup paused/);
    expect(f.text().replace(/\s+/g, " ")).toContain("Then setup checks runners.");
    // JSON keeps both actions as they were.
    expect(onboardJsonView(f.journal).actions.map((a) => a.step)).toContain("runner");
    f.ui.dispose();
  });

  test("09: a long last line wraps by words and keeps its link whole", () => {
    const chunks: string[] = [];
    const out: SetupStream = {
      isTTY: false,
      columns: 80,
      write: (c) => {
        chunks.push(c);
        return true;
      },
    };
    const r = createSetupRenderer(out, { NO_COLOR: "1" });
    const url = "https://linear.app/catalyst-e2e/issue/ADV-12";
    r.outro(`Follow ${url} in Linear; Catalyst comments there as each phase finishes.`);
    const lines = chunks.join("").trimEnd().split("\n");
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(80);
    // The link is one whole word on its line, never split across two.
    expect(lines.flatMap((l) => l.trim().split(/\s+/))).toContain(url);
    expect(lines.join(" ").replace(/\s+/g, " ")).toContain("comments there as each phase finishes.");
    // A link too long for the line sits whole on a line of its own.
    chunks.length = 0;
    const long = `https://linear.app/catalyst-e2e/issue/ADV-12/${"a-very-long-ticket-slug-".repeat(3)}end`;
    r.outro(`Follow ${long} in Linear.`);
    expect(chunks.join("").trimEnd().split("\n").map((l) => l.trim())).toContain(long);
  });

  test("08: a finished settings review keeps its row, so part 3's numbers run without a gap", () => {
    const f = fixture();
    f.run("github.repos", "done");
    f.run("projects", "done");
    f.run("accounts", "done");
    f.run("capacity", "done");
    f.run("runner", "skipped", { reason: "runner_not_selected" });
    f.run("settings", "done");
    f.run("values", "done");
    const text = f.text();
    for (const n of [1, 2, 3, 4, 5, 6])
      expect(text, `row ${n}`).toMatch(new RegExp(`\\] +${n} `));
    f.ui.dispose();
  });

  test.each([
    ["api-key", "add an API key", false],
    ["subscription,api-key", "add an API key or connect a subscription", true],
  ])(
    "10/11: the Connect accounts page wait ran out (kinds %s), so setup offers to keep waiting and points back there",
    async (kinds, words, subscription) => {
      const f = fixture();
      f.ui.stepStart("accounts");
      await f.ui.wait("Waiting for \"AI account\"", async () => undefined, {
        url: "https://cloud.test/connect-accounts",
        instruction: 'Open this link and finish "AI account":',
      });
      expect(await f.ui.retryTimedOut!("accounts")).toBe(true);
      const question = f.asked.at(-1)!;
      expect(question.message).not.toMatch(/try again/i);
      expect(question.labels.join(" ")).toMatch(/keep waiting/i);
      expect(question.labels.join(" ")).not.toMatch(/new link/i);
      expect(f.text()).toContain("Setup stopped waiting for the Connect accounts page");
      expect(f.text()).not.toMatch(/link timed out/i);
      for (const id of ONBOARD_STEPS)
        if (id !== "accounts")
          Object.assign(f.journal.steps.find((s) => s.id === id)!, { state: "done" });
      Object.assign(f.journal.steps.find((s) => s.id === "accounts")!, {
        state: "waiting",
        reason: "consent_timeout",
        evidence: { aiAccountKinds: kinds },
      });
      f.ui.finish(f.journal);
      const screen = f.text().replace(/\s+/g, " ");
      expect(screen).toContain(`Open https://cloud.test/connect-accounts and ${words}.`);
      expect(screen).not.toContain("/settings/coding-accounts");
      expect(/subscription/.test(screen)).toBe(subscription);
      f.ui.dispose();
    },
  );

  /** A member's journal at the end: every step done except the given ones. */
  function memberEnd(rows: Partial<Record<OnboardStepId, Partial<Step>>>, role = "member") {
    const f = fixture();
    for (const id of ONBOARD_STEPS)
      Object.assign(f.journal.steps.find((s) => s.id === id)!, { state: "done" }, rows[id] ?? {});
    Object.assign(f.journal.steps.find((s) => s.id === "signin")!, { evidence: { role } });
    return f;
  }
  const memberSkips = {
    "linear.workspace": admin,
    "linear.adopt": admin,
    "linear.automations": admin,
    "github.install": admin,
    "github.repos": admin,
    projects: admin,
    settings: admin,
    capacity: admin,
    runner: admin,
    "first-ticket": admin,
  } as const;

  test("review 1: a member in a fully set-up workspace is told setup is complete, with nobody to wait on", () => {
    const f = memberEnd(memberSkips);
    Object.assign(f.journal, { exit: 0, complete: true });
    f.ui.finish(f.journal);
    const text = f.text();
    expect(text).toContain("Setup complete");
    expect(text).toContain("Catalyst is ready to work on your team's tickets.");
    expect(text).not.toContain("Waiting on an owner or admin");
    expect(text).not.toContain("wait on an owner or admin");
    expect(text).not.toMatch(/\[!\]/);
    f.ui.dispose();
  });

  test("review 1: a member's run without --team never puts the team or values under an admin", () => {
    const f = memberEnd({
      ...memberSkips,
      "linear.team": admin,
      values: admin,
      ready: { state: "waiting", reason: "member_team_required" },
    });
    f.ui.finish(f.journal);
    const text = f.text();
    const block = text.includes("Waiting on an owner") ? text.slice(text.indexOf("Waiting on an owner")) : "";
    expect(block).not.toContain("Choose a Linear team");
    expect(block).not.toContain("Check repository values");
    f.ui.dispose();
  });

  test("review 1: readiness naming the GitHub install puts only that step under an admin", () => {
    const f = memberEnd({
      ...memberSkips,
      ready: { state: "waiting", reason: "admin_setup_pending", evidence: { admin: "github.install" } },
    });
    f.ui.finish(f.journal);
    const block = f.text().slice(f.text().indexOf("Waiting on an owner")).replace(/\s+/g, " ");
    expect(block).toContain("install Catalyst on GitHub");
    expect(block).not.toMatch(/workflow|Linear workspace|repositories|runner|first ticket/i);
    expect(f.text()).toMatch(/\[!\] +2 Linear and GitHub +1 step waits on an owner or admin/);
    f.ui.dispose();
  });

  test("review 2: an owner whose login changed sees their own step as theirs", () => {
    const f = memberEnd({ projects: { state: "waiting", reason: "repository_identity_unverified" } }, "owner");
    f.ui.finish(f.journal);
    const text = f.text();
    expect(text).toContain("1 thing needs you:");
    expect(text).not.toContain("Waiting on an owner or admin");
    expect(text).not.toContain("once they have");
    f.ui.dispose();
  });

  test("review 2: a member's runner left unverified waits on an owner or admin", () => {
    const f = memberEnd({ runner: { state: "waiting", reason: "runner_identity_unverified" } });
    f.ui.finish(f.journal);
    expect(f.text()).toContain("Waiting on an owner or admin");
    expect(f.text()).not.toContain("thing needs you");
    f.ui.dispose();
  });

  test("review 3: a member's missing value is an owner's or admin's to set", () => {
    const f = memberEnd({ values: { state: "waiting", reason: "required_values_missing" } });
    f.ui.finish(f.journal);
    expect(f.text()).toContain("Waiting on an owner or admin");
    expect(f.text()).not.toContain("thing needs you");
    f.ui.dispose();
  });

  test("a Ctrl-C-skipped step left alone is still named", () => {
    const f = memberEnd({ runner: { state: "waiting", reason: "interrupted" } }, "owner");
    f.ui.finish(f.journal);
    expect(f.text().replace(/\s+/g, " ")).toContain("Then setup checks runners.");
    f.ui.dispose();
  });

  test.each([
    ["values", "required_values_unverified"],
    ["accounts", "account_inventory_unavailable"],
    ["accounts", "onboard_login_refresh_required"],
  ] as const)(
    "re-review 1: a member's %s probe that could not finish (%s) is their own, with Check again",
    async (id, reason) => {
      const f = memberEnd({ [id]: { state: "waiting", reason } });
      expect(await f.ui.checkAgain!(f.journal)).toBe(true);
      expect(f.asked.at(-1)?.message).toBe("Check again once that's done?");
      const text = f.text();
      expect(text).toContain("1 thing needs you:");
      expect(text).not.toContain("Waiting on an owner or admin");
      f.ui.dispose();
    },
  );

  test("re-review 2: a member's admin skips are not ticked while readiness is still checking", () => {
    const f = memberEnd({
      ...memberSkips,
      ready: { state: "waiting", reason: "onboarding_checks_pending" },
    });
    f.ui.finish(f.journal);
    const text = f.text();
    expect(text).not.toMatch(/\[done\] +2 Linear and GitHub/);
    expect(text).not.toMatch(/\[done\] +3 Ready for work/);
    expect(text).toMatch(/2 Linear and GitHub +\d+ steps? (?:is|are) for an owner or admin/);
    expect(text).not.toContain("still has to");
    f.ui.dispose();
  });

  test("re-review 2: readiness naming only the GitHub install leaves part 3 unticked too", () => {
    const f = memberEnd({
      ...memberSkips,
      ready: { state: "waiting", reason: "admin_setup_pending", evidence: { admin: "github.install" } },
    });
    f.ui.finish(f.journal);
    expect(f.text()).not.toMatch(/\[done\] +3 Ready for work/);
    expect(f.text()).toMatch(/3 Ready for work +\d+ steps? (?:is|are) for an owner or admin/);
    f.ui.dispose();
  });

  test("a member's own skip of the team points at --team, not at an admin", () => {
    const f = fixture();
    f.run("linear.team", "skipped", { reason: "member_scope" });
    expect(f.text()).toMatch(/Choose a Linear team +.*--team/);
    expect(f.text()).not.toMatch(/Choose a Linear team +an admin handles this step/);
    f.ui.dispose();
  });
});


// CTC-4744: Ryan's end of setup asked "Done with these?" under "1 thing needs you" for a settings read
// only the cloud could finish, while `catalyst ready` said READY.
describe("CTC-4744 — the end of setup says who does what, and asks one clear question", () => {
  function ownerEnd(rows: Partial<Record<OnboardStepId, Partial<Step>>>) {
    const f = fixture();
    for (const id of ONBOARD_STEPS)
      Object.assign(f.journal.steps.find((s) => s.id === id)!, { state: "done" }, rows[id] ?? {});
    Object.assign(f.journal.steps.find((s) => s.id === "signin")!, { evidence: { role: "owner" } });
    return f;
  }
  const unread = {
    values: {
      state: "waiting" as const,
      reason: "required_values_unread",
      evidence: { repositories: "coalesce-labs/catalyst-cloud" },
    },
  };

  test("a settings read the cloud has not finished is in progress, not the person's job", async () => {
    const f = ownerEnd(unread);
    expect(await f.ui.checkAgain!(f.journal)).toBe(true);
    const text = plain(f.text()).replace(/\s+/g, " ");
    expect(text).not.toMatch(/needs you|needs someone/);
    expect(text).toContain("Still in progress, nothing for you to do:");
    expect(text).toContain("coalesce-labs/catalyst-cloud");
    expect(text).toContain("still in progress");
    expect(f.asked.at(-1)).toEqual({
      message: "Catalyst is still reading the repositories' settings. Wait for it?",
      labels: ["Wait and check again (about 1 minute)", "Finish now; check later with catalyst ready"],
    });
    f.ui.dispose();
  });

  test("something the person must do is named, and the question says what checking again is for", async () => {
    const f = ownerEnd({ values: { state: "waiting", reason: "required_values_missing" } });
    expect(await f.ui.checkAgain!(f.journal)).toBe(true);
    expect(plain(f.text())).toContain("1 thing needs you:");
    expect(f.asked.at(-1)).toEqual({
      message: "Check again once that's done?",
      labels: ["Check again now", "Finish now; run catalyst setup later to check again"],
    });
    expect(f.asked.map((a) => a.message)).not.toContain("Done with these?");
    f.ui.dispose();
  });
});
