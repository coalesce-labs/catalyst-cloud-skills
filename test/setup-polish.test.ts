// setup-polish.test.ts — CTC-4680: what fixture captures of `catalyst setup` showed wrong after the
// tracker landed. Each test names the capture it comes from.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "vitest";
import { createClackOnboardUi } from "../src/onboard-ui.js";
import {
  ONBOARD_STEPS,
  type OnboardIdentity,
  type OnboardJournal,
  type OnboardStepId,
} from "../src/onboard.js";
import { SETUP_PART_NUMBERS, SETUP_PART_OF } from "../src/setup-onboard-copy.js";
import { createSetupRenderer } from "../src/setup-render.js";

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const plain = (text: string) => text.replace(ANSI, "");
/** What a terminal still shows: everything after the last erase-to-end. */
const onScreen = (text: string) =>
  plain(text.slice(Math.max(0, text.lastIndexOf("\u001b[J"))));

function journalWith(
  states: Partial<Record<OnboardStepId, Partial<OnboardJournal["steps"][number]>>> = {},
): OnboardJournal {
  return {
    schema: 1,
    runId: "polish",
    installer: null,
    cli: "0.15.2",
    tenant: null,
    exit: 11,
    complete: false,
    changes: [],
    steps: ONBOARD_STEPS.map((id) => ({ id, state: "pending" as const, ...states[id] })),
  };
}

function fixture(fancy: boolean, onSelect?: (text: string) => void) {
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
      select: async () => {
        onSelect?.(text);
        return "again";
      },
      isCancel: () => false,
    },
    { input: new PassThrough(), output },
    {
      renderer: createSetupRenderer(
        output,
        fancy ? { TERM: "xterm-256color", LANG: "en_US.UTF-8" } : { NO_COLOR: "1" },
      ),
      interactive: true,
      signals: new EventEmitter(),
      version: "0.15.2",
      baseUrl: () => "https://cloud.test",
    },
  );
  const journal = journalWith();
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
  return { ui, journal, run, raw: () => text, text: () => plain(text) };
}

describe("setup polish", () => {
  test("04a: a timed-out link keeps its reason on screen above the question", async () => {
    let shown = "";
    const f = fixture(true, (text) => {
      shown = onScreen(text);
    });
    f.ui.stepStart("github.install");
    expect(await f.ui.retryTimedOut!("github.install")).toBe(true);
    expect(shown).toContain("Install Catalyst on GitHub");
    expect(shown).toMatch(/the link timed out/i);
    f.ui.dispose();
  });

  test("every row in a part has its own number: runners and this computer's runner differ", () => {
    for (const p of [1, 2, 3] as const) {
      const rows = new Map<number, string[]>();
      for (const id of ONBOARD_STEPS) {
        const n = SETUP_PART_NUMBERS[id];
        if (SETUP_PART_OF[id] !== p || n === undefined) continue;
        rows.set(n, [...(rows.get(n) ?? []), id]);
      }
      for (const ids of rows.values())
        // Folded pairs share a row on purpose: the second resolves the first's line.
        expect(
          ids.length === 1 ||
            ["machine,cli,skills,legacy", "github.repos,projects", "settings,values"].includes(ids.join(",")),
          ids.join(","),
        ).toBe(true);
    }
    expect(SETUP_PART_NUMBERS.runner).not.toBe(SETUP_PART_NUMBERS.capacity);
  });

  test("02b: approving sign-in prints who you are, not the header, tracker and plan again", () => {
    const f = fixture(false);
    f.ui.plan(f.journal, null);
    const identity = {
      account: "acme",
      membershipId: "m",
      role: "admin",
      display: { personLabel: "Ryan", email: "ryan@example.com", workspaceName: "Acme" },
    } as unknown as OnboardIdentity;
    f.ui.plan(f.journal, identity);
    const text = f.text();
    expect(text.match(/Catalyst Cloud setup/g)).toHaveLength(1);
    expect(text.match(/It has three parts/g)).toHaveLength(1);
    expect(text.match(/Part 1 of 3: This computer/g)).toHaveLength(1);
    expect(text).toContain("Signed in to Catalyst as Ryan (ryan@example.com)");
    f.ui.dispose();
  });

  test("02a: the sign-in wait says how to stop once", async () => {
    const f = fixture(false);
    f.ui.message("To connect this machine, visit:  https://signin.test/device");
    f.ui.message("and enter the code:              ABCD-1234");
    f.ui.message("Waiting for you to approve… (Ctrl-C to cancel)");
    await f.ui.wait("Waiting for Catalyst approval", async () => undefined);
    const text = f.text();
    expect(text).not.toContain("Ctrl-C to cancel");
    expect(text.match(/Ctrl-C/g)).toHaveLength(1);
    f.ui.dispose();
  });

  test("04b/06: a numbered action that wraps hangs under its own text", () => {
    const f = fixture(false);
    for (const id of ONBOARD_STEPS)
      Object.assign(f.journal.steps.find((s) => s.id === id)!, { state: "done" });
    Object.assign(f.journal.steps.find((s) => s.id === "github.install")!, {
      state: "waiting",
      reason: "github_installation_approval_pending",
    });
    f.ui.finish(f.journal);
    const lines = f.text().split("\n");
    const first = lines.findIndex((l) => l.startsWith("  1. "));
    expect(first).toBeGreaterThan(-1);
    expect(lines[first + 1]).toMatch(/^ {5}\S/);
    f.ui.dispose();
  });

  test("04b: a step setup never reached because it paused is listed as still to come", () => {
    const f = fixture(false);
    for (const id of ONBOARD_STEPS)
      if (ONBOARD_STEPS.indexOf(id) < ONBOARD_STEPS.indexOf("github.install"))
        Object.assign(f.journal.steps.find((s) => s.id === id)!, { state: "done" });
    Object.assign(f.journal.steps.find((s) => s.id === "github.install")!, {
      state: "waiting",
      reason: "consent_timeout",
    });
    f.ui.finish(f.journal);
    const text = f.text().replace(/\s+/g, " ");
    expect(text).toMatch(/Then setup connects your GitHub account, chooses repositories/);
    expect(text).not.toMatch(/\[fail\].*Connect your GitHub account/);
    f.ui.dispose();
  });
});
