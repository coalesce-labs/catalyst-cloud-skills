// setup-tracker.test.ts — CTC-4680: setup says what it is and where the person is. The Pixel
// Nucleus header comes first, then the three parts with their times; each part restarts its step
// numbers, and the tracker comes back at every part boundary and at the end.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { createClackOnboardUi } from "../src/onboard-ui.js";
import {
  ONBOARD_STEPS,
  type OnboardJournal,
  type OnboardStepId,
} from "../src/onboard.js";
import {
  onboardJsonView,
  SETUP_NUMBERS,
  SETUP_PART_NUMBERS,
  SETUP_PART_OF,
  setupPartProgress,
  setupStepView,
  setupTrackerRows,
} from "../src/setup-onboard-copy.js";
import { standalonePlan } from "../src/onboard-standalone-copy.js";
import {
  createSetupRenderer,
  pixelNucleusLines,
  type SetupStream,
} from "../src/setup-render.js";

const ANSI = /\u001b\[[0-9;]*m/g;
const plain = (text: string) => text.replace(ANSI, "");

function sink(tty: boolean, columns = 80): SetupStream & { text(): string } {
  const chunks: string[] = [];
  return {
    isTTY: tty,
    columns,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    text: () => chunks.join(""),
  };
}

const term = { TERM: "xterm-256color", LANG: "en_US.UTF-8" };

describe("the Pixel Nucleus header", () => {
  test("draws the mark in two lines of half blocks, eight columns wide", () => {
    const [one, two] = pixelNucleusLines({ ...term, COLORTERM: "truecolor" });
    expect(plain(one!)).toBe("▄▄▀▀▀▀▀▀");
    expect(plain(two!)).toBe("▀▀▀▀▀▀▄▄");
  });

  test("the core is copper on a dark background and rust on a light one, in truecolor", () => {
    const dark = pixelNucleusLines({ ...term, COLORTERM: "truecolor" }).join("");
    expect(dark).toContain("48;2;210;142;99");
    const light = pixelNucleusLines({
      ...term,
      COLORTERM: "truecolor",
      COLORFGBG: "0;15",
    }).join("");
    expect(light).toContain("48;2;169;81;47");
    expect(light).not.toContain("210;142;99");
  });

  test("the ring keeps the terminal's own foreground colour", () => {
    const [one, two] = pixelNucleusLines({ ...term, COLORTERM: "truecolor" });
    // No foreground colour is ever set: the ring cells print in whatever the terminal's text is.
    expect(`${one}${two}`).not.toMatch(/\u001b\[(?:[0-9;]*;)?3[0-9][;m]/);
    expect(one!.startsWith("▄▄")).toBe(true);
    expect(two!.endsWith("▄▄")).toBe(true);
  });

  test("without truecolor it uses the nearest 256 colour, then the nearest of 16", () => {
    expect(pixelNucleusLines(term).join("")).toContain("48;5;173");
    expect(
      pixelNucleusLines({ ...term, COLORFGBG: "0;7" }).join(""),
    ).toContain("48;5;130");
    expect(pixelNucleusLines({ ...term, TERM: "xterm" }).join("")).toContain(
      "\u001b[43m",
    );
  });

  test("prints the mark beside Catalyst Cloud, with the program and version under it", () => {
    const out = sink(true);
    const r = createSetupRenderer(out, { ...term, COLORTERM: "truecolor" });
    r.brand("setup", "0.15.2");
    const lines = plain(out.text()).split("\n");
    expect(lines[0]).toBe("  ▄▄▀▀▀▀▀▀  Catalyst Cloud");
    expect(lines[1]).toBe("  ▀▀▀▀▀▀▄▄  setup · 0.15.2");
  });

  test("prints once per program start", () => {
    const out = sink(true);
    const r = createSetupRenderer(out, term);
    r.brand("setup", "0.15.2");
    r.brand("setup", "0.15.2");
    expect(plain(out.text()).match(/Catalyst Cloud/g)).toHaveLength(1);
  });

  test.each([
    ["NO_COLOR", sink(true), { ...term, NO_COLOR: "1" }],
    ["no terminal", sink(false), term],
    ["a non-UTF-8 locale", sink(true), { ...term, LANG: "C" }],
    ["fewer than 50 columns", sink(true, 49), term],
  ])("with %s it prints one plain line", (_why, out, env) => {
    const r = createSetupRenderer(out, env);
    r.brand("setup", "0.15.2");
    expect(out.text()).toBe("  Catalyst Cloud setup 0.15.2\n");
  });
});

describe("parts and part-local numbers", () => {
  test("every step belongs to one of three parts, and numbers restart at 1 in each", () => {
    const part = (ids: OnboardStepId[]) => ids.map((id) => SETUP_PART_OF[id]);
    expect(
      part(["machine", "cli", "skills", "legacy", "signin", "daemon", "housekeeping"]),
    ).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(
      part([
        "linear.workspace",
        "linear.personal",
        "linear.team",
        "linear.adopt",
        "linear.automations",
        "github.install",
        "github.personal",
      ]),
    ).toEqual([2, 2, 2, 2, 2, 2, 2]);
    expect(
      part([
        "accounts",
        "github.repos",
        "projects",
        "settings",
        "values",
        "capacity",
        "runner",
        "first-ticket",
        "ready",
      ]),
    ).toEqual([3, 3, 3, 3, 3, 3, 3, 3, 3]);
    expect(ONBOARD_STEPS.every((id) => SETUP_PART_OF[id])).toBe(true);
    for (const p of [1, 2, 3])
      expect(
        Math.min(
          ...ONBOARD_STEPS.filter(
            (id) => SETUP_PART_OF[id] === p && SETUP_PART_NUMBERS[id],
          ).map((id) => SETUP_PART_NUMBERS[id]!),
        ),
      ).toBe(1);
  });

  test("within a part the numbers follow the order setup runs the steps", () => {
    for (const p of [1, 2, 3]) {
      const numbers = ONBOARD_STEPS.filter((id) => SETUP_PART_OF[id] === p)
        .map((id) => SETUP_PART_NUMBERS[id])
        .filter((n): n is number => n !== undefined);
      expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    }
    expect(SETUP_PART_NUMBERS["linear.workspace"]).toBe(1);
    expect(SETUP_PART_NUMBERS["github.personal"]).toBe(7);
    expect(SETUP_PART_NUMBERS.signin).toBe(2);
  });

  test("a step's row carries its part-local number", () => {
    expect(setupStepView({ id: "linear.workspace", state: "done" }).number).toBe(1);
    expect(setupStepView({ id: "first-ticket", state: "done" }).number).toBe(6);
  });

  test("a step that waits on another part names that part", () => {
    const view = setupStepView({
      id: "github.repos",
      state: "pending",
      reason: "github_install_pending",
    });
    expect(view.outcome).toBe("after step 6 of part 2");
  });

  test("waiting on steps in two parts names each part once, after this part's own steps", () => {
    const j = journalWith({
      projects: { state: "waiting", reason: "x" },
      "linear.adopt": { state: "waiting", reason: "x" },
      "linear.team": { state: "waiting", reason: "x" },
      "github.install": { state: "waiting", reason: "x" },
    });
    const ticket = setupStepView(
      { id: "first-ticket", state: "pending", reason: "prerequisite_not_ready" },
      { ...j, steps: j.steps.map((s) => (s.id === "projects" || s.id === "linear.adopt" ? s : { ...s, state: "done" as const })) },
    );
    expect(ticket.outcome).toBe("after step 1, and step 4 of part 2");
    const repos = setupStepView(
      { id: "github.repos", state: "pending", reason: "prerequisite_not_ready" },
      { ...j, steps: j.steps.map((s) => (s.id === "linear.team" || s.id === "github.install" ? s : { ...s, state: "done" as const })) },
    );
    expect(repos.outcome).toBe("after steps 3 and 6 of part 2");
  });

  test("JSON keeps the step numbers it always had", () => {
    const journal: OnboardJournal = {
      schema: 1,
      runId: "json",
      installer: null,
      cli: "0.15.2",
      tenant: null,
      exit: 11,
      complete: false,
      changes: [],
      steps: ONBOARD_STEPS.map((id) =>
        id === "github.install"
          ? { id, state: "waiting" as const, reason: "github_install_missing" }
          : { id, state: "done" as const },
      ),
    };
    const action = onboardJsonView(journal).actions.find(
      (a) => a.step === "github.install",
    );
    expect(action?.number).toBe(SETUP_NUMBERS["github.install"]);
    expect(action?.number).toBe(11);
    expect(onboardJsonView(journal).next).toBe("catalyst onboard");
  });

  test("the plan groups its rows by part, numbered within each part", () => {
    const journal = {
      steps: ONBOARD_STEPS.map((id) => ({ id, state: "pending" as const })),
    } as unknown as OnboardJournal;
    const rows = standalonePlan(journal);
    expect(rows.map((r) => [r.part, r.number])).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
      [2, 1],
      [2, 2],
      [2, 3],
      [2, 4],
      [2, 5],
      [2, 6],
      [2, 7],
      [3, 1],
      [3, 2],
      [3, 3],
      [3, 4],
      [3, 5],
      [3, 6],
    ]);
    expect(rows[0]!.group).toBe("Part 1 of 3: This computer");
  });
});

function journalWith(
  states: Partial<Record<OnboardStepId, Partial<OnboardJournal["steps"][number]>>>,
): OnboardJournal {
  return {
    schema: 1,
    runId: "tracker",
    installer: null,
    cli: "0.15.2",
    tenant: null,
    exit: 11,
    complete: false,
    changes: [],
    steps: ONBOARD_STEPS.map((id) => ({
      id,
      state: "pending" as const,
      ...states[id],
    })),
  };
}

describe("the three-part tracker", () => {
  test("progress counts each numbered row once, and a step that needs someone separately", () => {
    const done = { state: "done" as const };
    const j = journalWith({
      machine: done,
      cli: done,
      skills: done,
      legacy: done,
      signin: done,
      daemon: { state: "skipped", reason: "local_sync_not_selected" },
      housekeeping: done,
      "linear.workspace": done,
      "github.install": {
        state: "waiting",
        reason: "github_installation_approval_pending",
      },
    });
    const progress = setupPartProgress(j);
    expect(progress[1]).toMatchObject({ total: 3, done: 3, needs: 0 });
    expect(progress[2]).toMatchObject({ total: 7, done: 1, needs: 1 });
    expect(progress[3]).toMatchObject({ total: 6, done: 0, needs: 0 });
  });

  test("the first screen marks part 1 current and the others later, with times", () => {
    const rows = setupTrackerRows(setupPartProgress(journalWith({})), {
      plan: 1,
    });
    expect(rows.map((r) => [r.mark, r.number, r.title])).toEqual([
      ["now", 1, "This computer"],
      ["later", 2, "Linear and GitHub"],
      ["later", 3, "Ready for work"],
    ]);
    expect(rows[0]!.note).toContain("about 2 min");
    expect(rows[1]!.note).toContain("about 10 min");
    expect(rows[2]!.note).toContain("about 5 min");
  });

  test("a boundary marks the finished part done and the next one current", () => {
    const done = { state: "done" as const };
    const j = journalWith({
      machine: done,
      cli: done,
      skills: done,
      legacy: done,
      signin: done,
      housekeeping: done,
    });
    const rows = setupTrackerRows(setupPartProgress(j), { next: 2 });
    expect(rows.map((r) => [r.mark, r.note])).toEqual([
      ["done", "done"],
      ["now", "next · about 10 min"],
      ["later", "about 5 min"],
    ]);
  });
});

function fixture(env: NodeJS.ProcessEnv, consentGiven = false) {
  const output = new PassThrough();
  Object.assign(output, { isTTY: env.TERM !== undefined, columns: 80 });
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
      select: async () => "stop",
      isCancel: () => false,
    },
    { input: new PassThrough(), output },
    {
      renderer: createSetupRenderer(output, env),
      interactive: false,
      signals: new EventEmitter(),
      version: "0.15.2",
      consentGiven,
    },
  );
  const journal = journalWith({});
  const run = (
    id: OnboardStepId,
    state: OnboardJournal["steps"][number]["state"],
    extra: Partial<OnboardJournal["steps"][number]> = {},
  ) => {
    const step = journal.steps.find((s) => s.id === id)!;
    ui.stepStart(id);
    Object.assign(step, { state, ...extra });
    ui.stepEnd(step, journal);
  };
  return { ui, journal, run, text: () => plain(text) };
}

const PART_1 = ["machine", "cli", "skills", "legacy", "signin"] as const;

describe("setup's orientation", () => {
  test("the first screen says what setup does, shows the three parts, then lists only part 1", () => {
    const f = fixture({ NO_COLOR: "1" });
    f.ui.plan(f.journal);
    const text = f.text();
    expect(text.startsWith("  Catalyst Cloud setup 0.15.2\n")).toBe(true);
    expect(text).toContain(
      "Setup gets Catalyst working on your team's Linear tickets.",
    );
    expect(text).toMatch(/\[next\] +1 This computer +about 2 min/);
    expect(text).toMatch(/\[later\] +2 Linear and GitHub +about 10 min/);
    expect(text).toMatch(/\[later\] +3 Ready for work +about 5 min/);
    expect(text).toContain("Part 1 of 3: This computer");
    expect(text).toMatch(/ 2 Sign in to Catalyst/);
    expect(text).not.toContain("Connect your Linear workspace");
    expect(text).not.toContain("Catalyst setup\n");
    expect(text).not.toContain("tenant");
    f.ui.dispose();
  });

  test("part 1's heading prints once, over its plan, and its steps follow under it", () => {
    const f = fixture({ NO_COLOR: "1" });
    f.ui.plan(f.journal);
    for (const id of PART_1) f.run(id, "done");
    expect(f.text().match(/Part 1 of 3: This computer/g)).toHaveLength(1);
    f.ui.dispose();
  });

  test("the header shows the mark on a colour terminal", () => {
    const f = fixture({ ...term, COLORTERM: "truecolor" });
    f.ui.plan(f.journal);
    expect(f.text()).toContain("  ▄▄▀▀▀▀▀▀  Catalyst Cloud");
    expect(f.text()).toContain("Part 1 of 3 · This computer");
    f.ui.dispose();
  });

  test("part 1 ending shows the tracker again and part 2's plan, numbered from 1", () => {
    const f = fixture({ NO_COLOR: "1" });
    f.ui.plan(f.journal);
    for (const id of PART_1) f.run(id, "done");
    f.run("daemon", "skipped", { reason: "local_sync_not_selected" });
    f.run("housekeeping", "done");
    const before = f.text().length;
    f.run("linear.workspace", "done");
    const boundary = f.text().slice(before);
    expect(boundary).toContain("Part 1 done. This computer is set up.");
    expect(boundary).toMatch(/\[done\] +1 This computer +done/);
    expect(boundary).toMatch(/\[next\] +2 Linear and GitHub +next · about 10 min/);
    expect(boundary).toContain("Part 2 of 3: Linear and GitHub");
    expect(boundary).toMatch(/ 7 Connect your GitHub account/);
    expect(boundary).toMatch(/\[done\] +1 Connect your Linear workspace/);
    f.ui.dispose();
  });

  test("part 2 ending says so and lists part 3", () => {
    const f = fixture({ NO_COLOR: "1" });
    f.ui.plan(f.journal);
    for (const id of PART_1) f.run(id, "done");
    f.run("housekeeping", "done");
    for (const id of [
      "linear.workspace",
      "linear.personal",
      "linear.team",
      "linear.adopt",
      "linear.automations",
      "github.install",
      "github.personal",
    ] as const)
      f.run(id, "done");
    const before = f.text().length;
    f.run("github.repos", "done", { evidence: { count: 2 } });
    const boundary = f.text().slice(before);
    expect(boundary).toContain("Part 2 done. Linear and GitHub are connected.");
    expect(boundary).toMatch(/\[next\] +3 Ready for work/);
    expect(boundary).toContain("Part 3 of 3: Ready for work");
    expect(boundary).toMatch(/ 4 Run Catalyst's work on this machine/);
    expect(boundary).toMatch(/ 6 Start a first ticket/);
    f.ui.dispose();
  });

  test("a part left unfinished says how many steps are left, and setup carries on", () => {
    const f = fixture({ NO_COLOR: "1" });
    f.ui.plan(f.journal);
    for (const id of PART_1) f.run(id, "done");
    f.run("housekeeping", "done");
    f.run("linear.workspace", "done");
    f.run("github.install", "waiting", {
      reason: "github_installation_approval_pending",
    });
    const before = f.text().length;
    f.run("github.repos", "pending", { reason: "github_install_pending" });
    const boundary = f.text().slice(before);
    expect(boundary).not.toContain("Part 2 done");
    expect(boundary).toContain("Part 2 has 6 steps left. Setup carries on with part 3.");
    expect(boundary).toMatch(/\[!\] +2 Linear and GitHub/);
    expect(boundary).toContain("after step 6 of part 2");
    f.ui.dispose();
  });

  test("the end shows the tracker with what is done and what waits on someone", () => {
    const f = fixture({ NO_COLOR: "1" });
    f.ui.plan(f.journal);
    for (const id of PART_1) f.run(id, "done");
    f.run("housekeeping", "done");
    f.run("github.install", "waiting", {
      reason: "github_installation_approval_pending",
    });
    const before = f.text().length;
    f.ui.finish(f.journal);
    const end = f.text().slice(before);
    expect(end).toMatch(/\[done\] +1 This computer/);
    expect(end).toMatch(/\[!\] +2 Linear and GitHub +1 step needs someone/);
    expect(end).toMatch(/\[later\] +3 Ready for work +0 of 6 steps done/);
    // People type `catalyst setup`; `catalyst onboard` stays an alias that setup no longer names.
    expect(end).toContain("Next: run catalyst setup");
    expect(end).not.toContain("catalyst onboard");
    f.ui.dispose();
  });

  test("after the install engine's part 1, setup opens on the part 1 boundary", () => {
    const f = fixture({ NO_COLOR: "1" }, true);
    for (const id of PART_1) f.run(id, "done");
    f.run("housekeeping", "done");
    f.run("linear.workspace", "done");
    const text = f.text();
    expect(text).not.toContain("Catalyst Cloud setup");
    expect(text).toContain("Part 1 done. This computer is set up.");
    expect(text).toContain("Part 2 of 3: Linear and GitHub");
    expect(text).toMatch(/\[done\] +1 Connect your Linear workspace/);
    f.ui.dispose();
  });
});
