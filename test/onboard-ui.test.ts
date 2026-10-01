import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { pollConsent } from "../src/onboard-consent.js";
import { parseArgs } from "../src/args.js";
import { createClackOnboardUi, shouldUseOnboardUi } from "../src/onboard-ui.js";
import type { OnboardIdentity, OnboardJournal } from "../src/onboard.js";

function journal(extra: Partial<OnboardJournal> = {}): OnboardJournal {
  return {
    schema: 1,
    runId: "ui-fixture",
    installer: null,
    cli: "0.14.1",
    tenant: null,
    exit: 11,
    steps: [],
    changes: [],
    complete: false,
    ...extra,
  };
}
function fixture(answer: string | symbol = "cloud") {
  const events: Array<{ kind: string; text?: string }> = [];
  const selections: Array<{
    options: Array<{ value: string }>;
    initialValue?: string;
  }> = [];
  const cancel = Symbol("cancel");
  const signals = new EventEmitter();
  const prompts = {
    intro: (text: string) => events.push({ kind: "intro", text }),
    outro: (text: string) => events.push({ kind: "outro", text }),
    log: {
      message: (text: string) => {
        events.push({ kind: "message", text });
      },
      info: (text: string) => {
        events.push({ kind: "info", text });
      },
      warn: (text: string) => {
        events.push({ kind: "warn", text });
      },
      error: (text: string) => {
        events.push({ kind: "error", text });
      },
    },
    select: async (options: {
      options: Array<{ value: string }>;
      initialValue?: string;
    }) => {
      selections.push(options);
      events.push({ kind: "select" });
      return answer;
    },
    isCancel: (value: unknown) => typeof value === "symbol",
    spinner: () => {
      throw new Error("Clack spinner must never own onboarding input");
    },
  };
  const progress = {
    start: (text: string) => {
      events.push({ kind: "start", text });
    },
    stop: () => {
      events.push({ kind: "stop" });
    },
    dispose: () => {
      events.push({ kind: "progress-dispose" });
    },
  };
  const ui = createClackOnboardUi(
    prompts,
    { input: new PassThrough(), output: new PassThrough() },
    { signals, progress },
  );
  return {
    ui,
    events,
    selections,
    cancel,
    signals,
    progress,
    cancelSpinner: () => signals.emit("SIGINT"),
  };
}

test("Q4 presents one shared keep-or-stop question with no import or approval default", async () => {
  const f = fixture("keep");
  f.ui.stepStart("settings");
  const rows = ["one", "two"].map((name) => ({
    repository: `example/${name}`,
    state: "draft" as const,
    variableNames: ["PUBLIC_URL"],
    secretNames: [],
    sources: [".env.example"],
  }));
  expect(await f.ui.reviewSettings!(rows)).toBe("keep");
  expect(f.selections).toHaveLength(1);
  expect(f.selections[0]!.initialValue).toBe("keep");
  expect(f.selections[0]!.options.map((option) => option.value)).toEqual([
    "keep",
    "stop",
  ]);
  expect(
    f.events[f.events.findIndex((event) => event.kind === "select") - 1]!.kind,
  ).toBe("stop");
  f.ui.dispose();
});
test("Q4 cancellation aborts before any drafts are accepted", async () => {
  const f = fixture(Symbol("cancel"));
  expect(
    await f.ui.reviewSettings!([
      {
        repository: "example/service",
        state: "draft",
        variableNames: [],
        secretNames: [],
        sources: [],
      },
    ]),
  ).toBe("cancel");
  expect(f.ui.signal.aborted).toBe(true);
  f.ui.dispose();
});
test("Q4 has no fictional chooser when no repositories are available", async () => {
  const f = fixture("keep");
  expect(await f.ui.reviewSettings!([])).toBe("cancel");
  expect(f.selections).toEqual([]);
  f.ui.dispose();
});

test.each([
  [["onboard"], true, true],
  [["onboard"], false, false],
  [["onboard", "--yes"], true, false],
  [["onboard", "--json"], true, false],
  [["onboard", "--dry-run"], true, false],
] as const)(
  "interactive onboarding selection honors flags %#",
  (argv, tty, expected) => {
    expect(shouldUseOnboardUi(parseArgs([...argv]), tty)).toBe(expected);
  },
);

test.each([
  ["cloud", false, true, false],
  ["local", false, true, true],
  ["stop", false, false, false],
  ["local", true, true, true],
] as const)(
  "one plan choice %s returns explicit consent and mode",
  async (answer, persisted, proceed, localSync) => {
    const f = fixture(answer);
    expect(await f.ui.confirmPlan(persisted)).toEqual({ proceed, localSync });
    expect(f.selections).toHaveLength(1);
    expect(f.selections[0]!.options.map((option) => option.value)).toEqual(
      expect.arrayContaining(["cloud", "local", "stop"]),
    );
    expect(f.selections[0]!.initialValue).toBe(persisted ? "local" : "cloud");
    f.ui.dispose();
  },
);

test("plan cancellation stops setup and aborts its UI signal", async () => {
  const f = fixture(Symbol("cancel"));
  expect(await f.ui.confirmPlan(false)).toMatchObject({ proceed: false });
  expect(f.ui.signal.aborted).toBe(true);
  f.ui.dispose();
});

test("progress stops before another message or plan prompt writes to the terminal", async () => {
  const f = fixture();
  f.ui.stepStart("signin");
  f.ui.message("Approve your sign-in in the browser.");
  const messageIndex = f.events.findIndex(
    (event) => event.text === "Approve your sign-in in the browser.",
  );
  expect(
    f.events
      .slice(0, messageIndex)
      .some((event) => ["stop", "cancel"].includes(event.kind)),
  ).toBe(true);
  f.ui.stepStart("github.personal");
  await f.ui.confirmPlan(false);
  const promptIndex = f.events.findIndex((event) => event.kind === "select");
  expect(f.events[promptIndex - 1]!.kind).toMatch(/stop|cancel/);
  f.ui.dispose();
});

test("waiting progress uses a waiting warning rather than a success message", () => {
  const f = fixture();
  f.ui.stepStart("github.personal");
  f.ui.stepEnd({
    id: "github.personal",
    state: "waiting",
    reason: "consent_timeout",
  });
  expect(f.events.some((event) => event.kind === "warn")).toBe(true);
  expect(
    f.events.some((event) =>
      /complete|connected|finished successfully/i.test(event.text ?? ""),
    ),
  ).toBe(false);
  f.ui.dispose();
});

test("incomplete and complete receipts produce distinct finish outcomes", () => {
  const incomplete = fixture();
  incomplete.ui.finish(journal());
  expect(
    incomplete.events.map((event) => event.text ?? "").join("\n"),
  ).not.toContain("Onboarding complete");
  expect(incomplete.events.map((event) => event.text ?? "").join("\n")).toMatch(
    /resume|still|needs|saved/i,
  );
  incomplete.ui.dispose();
  const complete = fixture();
  complete.ui.finish(journal({ exit: 0, complete: true }));
  expect(complete.events.map((event) => event.text ?? "").join("\n")).toMatch(
    /onboarding complete/i,
  );
  complete.ui.dispose();
});

test("successful single-step completion never claims complete onboarding", () => {
  const f = fixture();
  f.ui.finish(journal({ exit: 0, complete: false, scope: "step" }), "signin");
  expect(f.events.map((event) => event.text ?? "").join("\n")).not.toMatch(
    /onboarding complete/i,
  );
  f.ui.dispose();
});

test("wait returns its result after stopping progress", async () => {
  const f = fixture();
  expect(await f.ui.wait("Checking live membership", async () => 42)).toBe(42);
  expect(f.events.some((event) => event.kind === "start")).toBe(true);
  expect(f.events.some((event) => event.kind === "stop")).toBe(true);
  expect(
    f.events
      .filter((event) => event.kind === "stop")
      .every((event) => event.text === undefined),
  ).toBe(true);
  f.ui.dispose();
});

test("wait cleans up progress when its operation rejects", async () => {
  const f = fixture();
  await expect(
    f.ui.wait("Checking live membership", async () => {
      throw new Error("fixture failure");
    }),
  ).rejects.toThrow("fixture failure");
  expect(
    f.events.some((event) =>
      ["stop", "cancel", "spinner-error"].includes(event.kind),
    ),
  ).toBe(true);
  f.ui.dispose();
});

test("dispose stops active progress and aborts further UI work", () => {
  const f = fixture();
  f.ui.stepStart("signin");
  f.ui.dispose();
  expect(
    f.events.some((event) => ["stop", "cancel"].includes(event.kind)),
  ).toBe(true);
  expect(f.ui.signal.aborted).toBe(true);
});

test("spinner cancellation aborts the shared onboarding signal", () => {
  const f = fixture();
  f.ui.stepStart("signin");
  f.cancelSpinner();
  expect(f.ui.signal.aborted).toBe(true);
  f.ui.dispose();
});

test("a saved plan is shown as needing recheck rather than verified success and intro is not repeated", () => {
  const f = fixture();
  f.ui.plan(journal({ steps: [{ id: "signin", state: "done" }] }));
  f.ui.plan(journal());
  expect(f.events.filter((event) => event.kind === "intro")).toHaveLength(1);
  const text = f.events.map((event) => event.text ?? "").join("\n");
  expect(text).toContain("(recheck)");
  expect(text).not.toContain("✓");
  f.ui.dispose();
});

test("progress groups follow the whole onboarding journey without repeating a shared group", () => {
  const f = fixture();
  for (const id of [
    "machine",
    "cli",
    "signin",
    "linear.personal",
    "github.personal",
    "projects",
    "accounts",
    "capacity",
    "daemon",
    "first-ticket",
    "ready",
  ] as const)
    f.ui.stepStart(id);
  const messages = f.events
    .filter((event) => event.kind === "message")
    .map((event) => event.text);
  expect(messages).toEqual([
    "This computer",
    "Catalyst sign-in",
    "Connections",
    "Project setup",
    "Runner and services",
    "Work and readiness",
  ]);
  f.ui.dispose();
});

test.each([
  ["done", undefined, "info"],
  ["failed", "token_revoked", "error"],
  ["pending", "prerequisite_not_ready", "warn"],
  ["skipped", "member_scope", "message"],
] as const)(
  "progress %s is displayed honestly with its appropriate status",
  (state, reason, kind) => {
    const f = fixture();
    f.ui.stepStart("accounts");
    f.ui.stepEnd({ id: "accounts", state, ...(reason ? { reason } : {}) });
    const result = f.events.at(-1)!;
    expect(result.kind).toBe(kind);
    expect(result.text?.includes("✓")).toBe(state === "done");
    if (reason === "token_revoked")
      expect(result.text).toContain("token revoked");
    if (reason === "member_scope")
      expect(result.text).toContain("administrator");
    f.ui.dispose();
  },
);

test("an unrecognized plan answer cannot approve setup", async () => {
  const f = fixture("unexpected-value");
  expect(await f.ui.confirmPlan(false)).toEqual({
    proceed: false,
    localSync: false,
  });
  f.ui.dispose();
});

test("cancelled UI cannot start more terminal progress", () => {
  const f = fixture();
  f.ui.stepStart("signin");
  f.cancelSpinner();
  const starts = f.events.filter((event) => event.kind === "start").length;
  f.ui.stepStart("github.personal");
  expect(f.events.filter((event) => event.kind === "start")).toHaveLength(
    starts,
  );
  f.ui.dispose();
});

test("a complete flag with a nonzero exit is never rendered as complete onboarding", () => {
  const f = fixture();
  f.ui.finish(journal({ complete: true, exit: 11 }));
  expect(f.events.map((event) => event.text ?? "").join("\n")).not.toMatch(
    /onboarding complete/i,
  );
  f.ui.dispose();
});

test("spinner cancellation ends a hung consent callback and cleans up progress", async () => {
  const f = fixture();
  const result = f.ui.wait("Waiting for provider approval", () =>
    pollConsent({
      signal: f.ui.signal,
      timeoutMs: 1000,
      readStatus: async () => new Promise<never>(() => {}),
    }),
  );
  f.cancelSpinner();
  expect(await result).toMatchObject({
    state: "waiting",
    reason: "interrupted",
  });
  expect(f.events.some((event) => event.kind === "stop")).toBe(true);
  f.ui.dispose();
});

test.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
  "UI signal %s cancels without changing process listeners",
  (signal) => {
    const before = process.listenerCount(signal);
    const f = fixture();
    f.ui.stepStart("signin");
    expect(f.signals.listenerCount(signal)).toBe(1);
    f.signals.emit(signal);
    expect(f.ui.signal.aborted).toBe(true);
    f.ui.dispose();
    expect(f.signals.listenerCount(signal)).toBe(0);
    expect(process.listenerCount(signal)).toBe(before);
  },
);

test.each(["stop", "dispose"] as const)(
  "UI disposal releases signal listeners even when progress %s fails",
  (operation) => {
    const f = fixture();
    f.ui.stepStart("signin");
    f.progress[operation] = () => {
      throw new Error("fixture progress cleanup failed");
    };
    expect(() => f.ui.dispose()).toThrow("fixture progress cleanup failed");
    expect(f.ui.signal.aborted).toBe(true);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
      expect(f.signals.listenerCount(signal)).toBe(0);
  },
);

test.each(["live@example.com", null])(
  "Q1 displays the live person and workspace before selecting a plan, email=%s",
  async (email) => {
    const f = fixture("stop");
    const identity: OnboardIdentity = {
      account: "tenant-live",
      membershipId: "person-live",
      baseUrl: "https://staging.catalystcloud.dev",
      role: "admin",
      display: {
        personLabel: "Live Person",
        email,
        workspaceName: "Live Workspace",
        workspaceSlug: "live-workspace",
      },
    };
    const receipt = journal();
    const before = JSON.stringify(receipt);
    f.ui.plan(receipt, identity);
    expect(await f.ui.confirmPlan(false)).toMatchObject({ proceed: false });
    const person = f.events.findIndex(
      (event) =>
        event.text === `Signed in as Live Person${email ? ` (${email})` : ""}`,
    );
    const workspace = f.events.findIndex(
      (event) =>
        event.text === "Workspace: Live Workspace (live-workspace) · admin",
    );
    const prompt = f.events.findIndex((event) => event.kind === "select");
    expect(person).toBeGreaterThanOrEqual(0);
    expect(workspace).toBeGreaterThan(person);
    expect(prompt).toBeGreaterThan(workspace);
    expect(f.selections).toHaveLength(1);
    expect(f.events.map((event) => event.text ?? "").join("\n")).not.toContain(
      "(null)",
    );
    expect(JSON.stringify(receipt)).toBe(before);
    f.ui.dispose();
  },
);

test("live display fields cannot insert terminal controls, new lines or unbounded labels", () => {
  const f = fixture();
  const identity: OnboardIdentity = {
    account: "tenant-a",
    membershipId: "person-a",
    baseUrl: "https://staging.catalystcloud.dev",
    role: "member",
    display: {
      personLabel: "Live\nPerson\u001b[31m\u0000",
      email: "mail\r@example.com",
      workspaceName: "Workspace\u2028name\u009b",
      workspaceSlug: "x".repeat(250),
    },
  };
  f.ui.plan(journal(), identity);
  const person = f.events.find((event) =>
    event.text?.startsWith("Signed in as "),
  )?.text;
  const workspace = f.events.find((event) =>
    event.text?.startsWith("Workspace: "),
  )?.text;
  expect(person).toBe("Signed in as Live Person [31m (mail @example.com)");
  expect(workspace).toBe(
    `Workspace: Workspace name (${"x".repeat(180)}) · member`,
  );
  expect(person).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
  expect(workspace).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
  f.ui.dispose();
});

test("a first-run plan explains account or invitation prerequisites without inventing a login", async () => {
  const f = fixture("stop");
  f.ui.plan(journal(), null);
  await f.ui.confirmPlan(false);
  const prerequisite = f.events.findIndex(
    (event) =>
      event.text ===
      "Use an existing Catalyst account or accept your invitation before approving sign-in.",
  );
  expect(prerequisite).toBeGreaterThanOrEqual(0);
  expect(
    f.events.findIndex((event) => event.kind === "select"),
  ).toBeGreaterThan(prerequisite);
  expect(
    f.events.some((event) => event.text?.startsWith("Signed in as ")),
  ).toBe(false);
  expect(f.events.some((event) => event.text?.startsWith("Workspace: "))).toBe(
    false,
  );
  f.ui.dispose();
});

test("a login expiring after Q1 stays neutral and displays the actual renewal command", () => {
  const f = fixture();
  f.ui.stepStart("signin");
  f.ui.stepEnd({
    id: "signin",
    state: "waiting",
    reason: "onboard_login_refresh_required",
  });
  expect(
    f.events.some(
      (event) =>
        event.kind === "warn" && event.text?.includes("catalyst login"),
    ),
  ).toBe(true);
  expect(
    f.events.some((event) => event.kind === "error" || event.kind === "info"),
  ).toBe(false);
  f.ui.dispose();
});
