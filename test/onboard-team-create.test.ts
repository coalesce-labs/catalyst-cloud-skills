import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import { parseArgs } from "../src/args.js";
import { CliError } from "../src/errors.js";
import { defaultCtx, writeConfig, type Ctx } from "../src/config.js";
import {
  cmdOnboard,
  onboardStatePath,
  readOnboardJournal,
  writeOnboardJournal,
  type OnboardJournal,
  type OnboardStep,
} from "../src/onboard.js";
import { onboardReasonText } from "../src/onboard-next.js";
import { createOnboardRuntime } from "../src/onboard-runtime.js";
import {
  CREATE_TEAM_CHOICE,
  suggestTeamKey,
  teamKeyProblem,
  teamNameProblem,
  type TeamCreateOffer,
} from "../src/onboard-team-create.js";
import {
  createClackOnboardUi,
  type ClackOnboardPort,
  type OnboardUi,
} from "../src/onboard-ui.js";

const now = Date.parse("2026-10-02T14:00:00Z");
const origin = "https://fixture.invalid";
const CREATE = "/api/v1/agent/linear/team";
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe("suggestTeamKey", () => {
  test.each([
    ["Engineering", "ENG"],
    ["Mobile app", "MA"],
    ["  web-platform team ", "WPT"],
    ["one two three four five six", "OTTFF"],
    ["123 go", "G"],
    ["Ünïcode ✓", "UNI"],
    ["", "TEAM"],
    ["!!!", "TEAM"],
  ])("%j suggests %j", (name, key) => {
    const suggested = suggestTeamKey(name);
    expect(suggested).toBe(key);
    expect(teamKeyProblem(suggested)).toBeUndefined();
  });
});

describe("team name and key validation", () => {
  test("a key starts with a letter and has up to 7 letters or digits", () => {
    expect(teamKeyProblem("MOB")).toBeUndefined();
    expect(teamKeyProblem("mob")).toBeUndefined();
    expect(teamKeyProblem("M0B2")).toBeUndefined();
    for (const bad of ["", "1AB", "AB-C", "ABCDEFGH", "A B"])
      expect(teamKeyProblem(bad)).toMatch(/letter/);
  });
  test("a name is 1 to 80 printable characters", () => {
    expect(teamNameProblem("Mobile")).toBeUndefined();
    expect(teamNameProblem("  ")).toBeDefined();
    expect(teamNameProblem("x".repeat(81))).toBeDefined();
    expect(teamNameProblem("bad\u0007")).toBeDefined();
  });
});

function clack(answers: Array<string | symbol>) {
  const asked: Array<{ kind: string; question: Record<string, unknown> }> = [];
  const port: ClackOnboardPort = {
    intro: () => {},
    outro: () => {},
    log: { message: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    select: async (question) => {
      asked.push({ kind: "select", question: { ...question } });
      return answers.shift()!;
    },
    text: async (question) => {
      asked.push({ kind: "text", question: { ...question } });
      return answers.shift()!;
    },
    isCancel: (value) => typeof value === "symbol",
  };
  const progress = { start: () => {}, stop: () => {}, dispose: () => {} };
  const ui = createClackOnboardUi(
    port,
    { input: new PassThrough(), output: new PassThrough() },
    { signals: new EventEmitter(), progress },
  );
  return { ui, asked };
}
const options = [{ id: "team-a", key: "ENG", name: "Engineering" }];

describe("the Q2 picker", () => {
  test("the same UI preserves existing-team adoption approval and new-team confirmation", async () => {
    const f = clack(["team-a", "apply", "Mobile app", "MOB", "create"]);
    try {
      expect(await f.ui.chooseTeam!(options, { available: true })).toBe(
        "team-a",
      );
      expect(
        await f.ui.confirmWorkflowAdoption!("ENG", ["Create stages: Intake"]),
      ).toBe(true);
      expect(await f.ui.nameNewTeam!({})).toEqual({
        name: "Mobile app",
        key: "MOB",
      });
      expect(f.asked.map((row) => row.kind)).toEqual([
        "select",
        "select",
        "text",
        "text",
        "select",
      ]);
      expect(f.asked[1]!.question.message).toBe("Apply this to ENG?");
      expect(String(f.asked[4]!.question.message)).toContain(
        "Mobile app (MOB)",
      );
      expect(f.ui.signal.aborted).toBe(false);
    } finally {
      f.ui.dispose();
    }
  });
  test("offers 'Create a new Linear team…' as the last option when the cloud supports it", async () => {
    const f = clack([CREATE_TEAM_CHOICE]);
    try {
      expect(await f.ui.chooseTeam!(options, { available: true })).toBe(
        CREATE_TEAM_CHOICE,
      );
      const choices = f.asked[0]!.question.options as Array<{
        value: string;
        label: string;
        disabled?: boolean;
      }>;
      expect(choices.map((c) => c.value)).toEqual([
        "team-a",
        CREATE_TEAM_CHOICE,
      ]);
      expect(choices.at(-1)).toMatchObject({
        label: "Create a new Linear team…",
      });
      expect(choices.at(-1)!.disabled).toBeUndefined();
    } finally {
      f.ui.dispose();
    }
  });
  test("an unavailable create says why, and cannot be chosen", async () => {
    const f = clack(["team-a"]);
    try {
      await f.ui.chooseTeam!(options, {
        available: false,
        reason: "Needs a Catalyst workspace owner or admin.",
      });
      const choices = f.asked[0]!.question.options as Array<{
        value: string;
        hint?: string;
        disabled?: boolean;
      }>;
      expect(choices.at(-1)).toMatchObject({
        value: CREATE_TEAM_CHOICE,
        disabled: true,
        hint: "Needs a Catalyst workspace owner or admin.",
      });
    } finally {
      f.ui.dispose();
    }
  });
  test("an older cloud shows only existing teams", async () => {
    const f = clack(["team-a"]);
    try {
      await f.ui.chooseTeam!(options);
      const choices = f.asked[0]!.question.options as Array<{ value: string }>;
      expect(choices.map((c) => c.value)).toEqual(["team-a"]);
    } finally {
      f.ui.dispose();
    }
  });
  test("with no existing team the picker still offers create", async () => {
    const f = clack([CREATE_TEAM_CHOICE]);
    try {
      expect(await f.ui.chooseTeam!([], { available: true })).toBe(
        CREATE_TEAM_CHOICE,
      );
    } finally {
      f.ui.dispose();
    }
  });
});

describe("naming the new team", () => {
  test("asks the name, suggests an editable key from it, and confirms before creating", async () => {
    const f = clack(["Mobile app", "MOB", "create"]);
    try {
      expect(await f.ui.nameNewTeam!({})).toEqual({
        name: "Mobile app",
        key: "MOB",
      });
      expect(f.asked.map((a) => a.kind)).toEqual(["text", "text", "select"]);
      expect(f.asked[1]!.question.initialValue).toBe("MA");
      const confirm = f.asked[2]!.question;
      expect(String(confirm.message)).toContain("Mobile app (MOB)");
      expect(String(confirm.message)).toMatch(/workflow/);
    } finally {
      f.ui.dispose();
    }
  });
  test("a re-ask after a taken key keeps the name and shows the problem", async () => {
    const f = clack(["Mobile app", "MOBI", "create"]);
    try {
      await f.ui.nameNewTeam!({
        name: "Mobile app",
        key: "MOB",
        problem:
          "The key MOB is already used by another Linear team. Choose another.",
      });
      expect(f.asked[0]!.question.initialValue).toBe("Mobile app");
      expect(f.asked[1]!.question.initialValue).toBe("MOB");
      expect(String(f.asked[0]!.question.message)).toContain("already used");
    } finally {
      f.ui.dispose();
    }
  });
  test("a resumed uncertain result prefills its original key even without a saved name", async () => {
    const f = clack(["Mobile app", "MOB", "create"]);
    try {
      await f.ui.nameNewTeam!({
        key: "MOB",
        problem: "Could not confirm creation",
      });
      expect(f.asked[1]!.question.initialValue).toBe("MOB");
    } finally {
      f.ui.dispose();
    }
  });
  test("the prompts validate the name and key", async () => {
    const f = clack(["Mobile", "mob", "create"]);
    try {
      expect(await f.ui.nameNewTeam!({})).toEqual({
        name: "Mobile",
        key: "MOB",
      });
      const nameCheck = f.asked[0]!.question.validate as (
        v?: string,
      ) => unknown;
      const keyCheck = f.asked[1]!.question.validate as (v?: string) => unknown;
      expect(nameCheck("")).toBeDefined();
      expect(keyCheck("1AB")).toBeDefined();
      expect(keyCheck("mob")).toBeUndefined();
    } finally {
      f.ui.dispose();
    }
  });
  test("going back returns no team and keeps setup running", async () => {
    const f = clack(["Mobile", "MOB", "back"]);
    try {
      expect(await f.ui.nameNewTeam!({})).toBeNull();
      expect(f.ui.signal.aborted).toBe(false);
    } finally {
      f.ui.dispose();
    }
  });
  test("cancelling stops setup", async () => {
    const f = clack([Symbol("cancel")]);
    try {
      expect(await f.ui.nameNewTeam!({})).toBeNull();
      expect(f.ui.signal.aborted).toBe(true);
    } finally {
      f.ui.dispose();
    }
  });
});

const existing = {
  teamId: "team-engineering",
  teamKey: "ENG",
  teamName: "Engineering",
};
const created = { id: "team-new", key: "MOB", name: "Mobile" };
function readiness(teamId: string) {
  return {
    teamId,
    checkedAt: now,
    workflowRev: 4,
    status: "ready",
    checks: [{ id: "team_visible", state: "pass" }],
  };
}
type Reply = { status: number; body: unknown };
function fixture(
  input: {
    role?: "owner" | "admin" | "member";
    advertise?: boolean;
    replies?: Reply[];
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "team-create-"));
  homes.push(home);
  const role = input.role ?? "owner";
  const user = {
    id: "fixture-person",
    label: "Fixture",
    email: "fixture@example.com",
    role,
    linearUserId: null,
  };
  const me = {
    account: "fixture-account",
    slug: "fixture",
    name: "Fixture",
    permissions: null,
    principal: "session" as const,
    user,
  };
  writeConfig(home, {
    ...me,
    baseUrl: origin,
    key: "ctc_user_fixture",
    joinedAt: new Date(now).toISOString(),
    lastSkillBundleVersion: "0.14.1",
  });
  let inventory: unknown[] = [existing];
  const replies = [...(input.replies ?? [])];
  const posts: unknown[] = [];
  const reads: string[] = [];
  const routes = [
    "/api/v1/agent/contract",
    "/api/v1/agent/teams",
    "/api/v1/agent/tenant/readiness",
  ].map((path) => ({ method: "GET", path, personalBearer: true }));
  if (input.advertise !== false)
    routes.push({ method: "POST", path: CREATE, personalBearer: true });
  const ctx: Ctx = {
    ...defaultCtx(),
    home,
    env: {} as NodeJS.ProcessEnv,
    now: () => new Date(now),
    stdout: () => {},
    stderr: () => {},
  };
  ctx.fetch = (async (
    request: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = new URL(
      String(request instanceof Request ? request.url : request),
    );
    reads.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (init?.method === "POST" && url.pathname === CREATE) {
      posts.push(JSON.parse(String(init.body)));
      const reply = replies.shift();
      if (!reply)
        return Response.json({ error: "unexpected" }, { status: 500 });
      // The census lists a created team once its adoption has landed (a saved mapping).
      const answer = reply.body as {
        team?: typeof created;
        adoption?: { outcome: string };
      };
      if (reply.status === 201 && answer.adoption?.outcome === "adopted") {
        const team = answer.team!;
        inventory = [
          ...inventory,
          { teamId: team.id, teamKey: team.key, teamName: team.name },
        ];
      }
      return Response.json(reply.body, { status: reply.status });
    }
    if (init?.method && init.method !== "GET")
      return Response.json({ error: "write_not_authorized" }, { status: 403 });
    if (url.pathname === "/api/v1/agent/contract")
      return Response.json({
        account: { id: me.account },
        contractVersion: "2.16.0",
        onboarding: {
          schema: 1,
          routes,
          web: {
            connections: "/a/account/connections",
            personalConnections: "/settings/connected-accounts",
          },
        },
      });
    if (url.pathname === "/api/v1/agent/teams")
      return Response.json({
        teams: inventory,
        liveTeamRead: { attempted: false, error: null },
      });
    if (url.pathname === "/api/v1/agent/tenant/readiness")
      return Response.json({
        readiness: readiness(url.searchParams.get("team")!),
      });
    return Response.json({ error: "unexpected_route" }, { status: 404 });
  }) as typeof fetch;
  const journal: OnboardJournal = {
    schema: 1,
    runId: "team-create",
    installer: null,
    cli: "0.14.1",
    tenant: me.account,
    account: me.account,
    membershipId: user.id,
    baseUrl: origin,
    exit: null,
    steps: [],
    changes: [],
  };
  return {
    ctx,
    journal,
    posts,
    reads,
    setInventory: (rows: unknown[]) => {
      inventory = rows;
    },
  };
}
function scriptedUi(script: {
  choices: Array<string | null>;
  names?: Array<{ name: string; key: string } | null>;
}) {
  const offers: Array<TeamCreateOffer | undefined> = [];
  const nameAsks: Array<{ name?: string; key?: string; problem?: string }> = [];
  const messages: string[] = [];
  const ui: OnboardUi = {
    signal: new AbortController().signal,
    plan: () => {},
    confirmPlan: async () => ({ proceed: true, localSync: false }),
    stepStart: () => {},
    stepEnd: () => {},
    message: (text) => messages.push(text),
    finish: () => {},
    dispose: () => {},
    wait: async (_message, run) => run(),
    chooseTeam: async (_teams, offer) => {
      offers.push(offer);
      return script.choices.shift() ?? null;
    },
    nameNewTeam: async (input) => {
      nameAsks.push(input);
      return script.names?.shift() ?? null;
    },
  };
  return { ui, offers, nameAsks, messages };
}
const hooks = {
  login: async () => 0,
  ready: async () => ({ state: "waiting" as const, reason: "not_ready" }),
};
function act(f: ReturnType<typeof fixture>, ui: OnboardUi) {
  const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, {
    ...hooks,
    ui,
  });
  return runtime.adapters!["linear.team"]!.act!(f.ctx, f.journal);
}

describe("creating a team during onboarding", () => {
  test("creates the named team, then continues with it selected", async () => {
    const f = fixture({
      replies: [
        {
          status: 201,
          body: { team: created, adoption: { outcome: "adopted" } },
        },
      ],
    });
    const s = scriptedUi({
      choices: [CREATE_TEAM_CHOICE],
      names: [{ name: "Mobile", key: "MOB" }],
    });
    expect(await act(f, s.ui)).toMatchObject({
      state: "done",
      evidence: { team: "team-new", teamKey: "MOB" },
    });
    expect(s.offers).toEqual([{ available: true }]);
    expect(f.posts).toEqual([{ name: "Mobile", key: "MOB" }]);
    expect(s.messages.join("\n")).toContain("Created Linear team Mobile (MOB)");
  });

  test("a taken key is re-asked before anything is created, keeping the name", async () => {
    const f = fixture({
      replies: [
        {
          status: 409,
          body: {
            error: "key-taken",
            key: "MOB",
            message:
              "The key MOB is already used by another Linear team. Choose another.",
          },
        },
        {
          status: 201,
          body: {
            team: { ...created, key: "MOBI" },
            adoption: { outcome: "adopted" },
          },
        },
      ],
    });
    const s = scriptedUi({
      choices: [CREATE_TEAM_CHOICE],
      names: [
        { name: "Mobile", key: "MOB" },
        { name: "Mobile", key: "MOBI" },
      ],
    });
    expect(await act(f, s.ui)).toMatchObject({
      state: "done",
      evidence: { teamKey: "MOBI" },
    });
    expect(s.nameAsks[1]).toEqual({
      name: "Mobile",
      key: "MOB",
      problem:
        "The key MOB is already used by another Linear team. Choose another.",
    });
  });

  test("Linear refusing the person says why, then the picker comes back with create unavailable", async () => {
    const f = fixture({
      replies: [
        {
          status: 403,
          body: {
            error: "linear-refused",
            message:
              "Linear did not let you create a team. Ask a workspace admin, or create the team in Linear, then pick it here.",
            linearMessage: "Only admins can create teams",
          },
        },
      ],
    });
    const s = scriptedUi({
      choices: [CREATE_TEAM_CHOICE, existing.teamId],
      names: [{ name: "Mobile", key: "MOB" }],
    });
    expect(await act(f, s.ui)).toMatchObject({
      state: "done",
      evidence: { team: existing.teamId },
    });
    expect(s.messages.join("\n")).toContain(
      "Linear did not let you create a team. Ask a workspace admin, or create the team in Linear, then pick it here.",
    );
    expect(s.messages.join("\n")).toContain("Only admins can create teams");
    expect(s.offers[1]).toEqual({
      available: false,
      reason:
        "Linear did not let you create a team. Ask a workspace admin, or create the team in Linear, then pick it here.",
    });
  });

  test("a team created but not adopted is reported with the exact retry command", async () => {
    const f = fixture({
      replies: [
        {
          status: 201,
          body: {
            team: created,
            adoption: {
              outcome: "not-adopted",
              error: "apply-in-progress",
              reason: "An adoption is running.",
            },
          },
        },
      ],
    });
    const s = scriptedUi({
      choices: [CREATE_TEAM_CHOICE],
      names: [{ name: "Mobile", key: "MOB" }],
    });
    const result = await act(f, s.ui);
    expect(result).toEqual({
      state: "waiting",
      reason: "team_created_not_adopted",
      evidence: { team: "team-new", teamKey: "MOB" },
    });
    const step: OnboardStep = { id: "linear.team", ...result } as OnboardStep;
    const text = onboardReasonText(step);
    expect(text).toContain("Linear team MOB was created");
    expect(text).toContain("catalyst team adopt MOB");
    expect(s.messages.join("\n")).toContain("An adoption is running.");
  });

  test("on resume, a created team that is now adopted becomes the selection", async () => {
    const f = fixture();
    f.setInventory([
      existing,
      { teamId: "team-new", teamKey: "MOB", teamName: "Mobile" },
    ]);
    f.journal.steps.push({
      id: "linear.team",
      state: "waiting",
      reason: "team_created_not_adopted",
      at: new Date(now).toISOString(),
      evidence: { team: "team-new", teamKey: "MOB" },
    });
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, hooks);
    expect(
      await runtime.adapters!["linear.team"]!.check(f.ctx, f.journal),
    ).toMatchObject({
      state: "done",
      evidence: { team: "team-new", teamKey: "MOB" },
    });
  });

  test("on resume, a created team still not adopted keeps its retry command", async () => {
    const f = fixture();
    f.journal.steps.push({
      id: "linear.team",
      state: "waiting",
      reason: "team_created_not_adopted",
      at: new Date(now).toISOString(),
      evidence: { team: "team-new", teamKey: "MOB" },
    });
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, hooks);
    expect(
      await runtime.adapters!["linear.team"]!.check(f.ctx, f.journal),
    ).toEqual({
      state: "waiting",
      reason: "team_created_not_adopted",
      evidence: { team: "team-new", teamKey: "MOB" },
    });
  });

  test("going back from naming returns to the picker", async () => {
    const f = fixture();
    const s = scriptedUi({
      choices: [CREATE_TEAM_CHOICE, existing.teamId],
      names: [null],
    });
    expect(await act(f, s.ui)).toMatchObject({
      state: "done",
      evidence: { team: existing.teamId },
    });
    expect(f.posts).toEqual([]);
  });

  test("a member sees why create is unavailable and nothing is posted", async () => {
    const f = fixture({ role: "member" });
    const s = scriptedUi({ choices: [existing.teamId] });
    await act(f, s.ui);
    expect(s.offers).toEqual([
      {
        available: false,
        reason:
          "Creating a Linear team needs a Catalyst workspace owner or admin.",
      },
    ]);
    expect(f.posts).toEqual([]);
  });

  test("a cloud that does not advertise team creation shows no create option", async () => {
    const f = fixture({ advertise: false });
    const s = scriptedUi({ choices: [existing.teamId] });
    await act(f, s.ui);
    expect(s.offers).toEqual([undefined]);
    expect(f.reads.some((r) => r.startsWith("POST"))).toBe(false);
  });

  test("an unreachable Linear stops with nothing created and nothing selected", async () => {
    const f = fixture({
      replies: [
        {
          status: 503,
          body: {
            error: "linear-unavailable",
            message:
              "Catalyst could not reach Linear. Nothing was created. Try again in a moment.",
          },
        },
      ],
    });
    const s = scriptedUi({
      choices: [CREATE_TEAM_CHOICE],
      names: [{ name: "Mobile", key: "MOB" }],
    });
    expect(await act(f, s.ui)).toEqual({
      state: "waiting",
      reason: "team_create_unavailable",
    });
    expect(s.messages.join("\n")).toContain("Nothing was created");
    expect(
      onboardReasonText({
        id: "linear.team",
        state: "waiting",
        reason: "team_create_unavailable",
      }),
    ).toMatch(/catalyst onboard/);
  });

  test.each([
    { status: 400, error: "no-grant" },
    { status: 400, error: "identity-unknown" },
    { status: 401, error: "expired" },
  ])(
    "a $error grant refusal says to reconnect Linear and never loops through naming",
    async ({ status, error }) => {
      const f = fixture({
        replies: [
          {
            status,
            body: {
              error,
              reason: "Connect your own Linear account first.",
            },
          },
        ],
      });
      const s = scriptedUi({
        choices: [CREATE_TEAM_CHOICE],
        names: [{ name: "Mobile", key: "MOB" }],
      });
      expect(await act(f, s.ui)).toEqual({
        state: "waiting",
        reason: "team_create_grant_required",
      });
      expect(s.nameAsks).toHaveLength(1);
      expect(s.messages.join("\n")).toContain(
        "Connect your own Linear account first.",
      );
      expect(
        onboardReasonText({
          id: "linear.team",
          state: "waiting",
          reason: "team_create_grant_required",
        }),
      ).toMatch(/Reconnect it/);
    },
  );

  test("an unconfirmed create names the key and both ways forward", async () => {
    const f = fixture({
      replies: [
        {
          status: 502,
          body: {
            error: "linear-unconfirmed",
            key: "MOB",
            message:
              "Catalyst could not confirm whether Linear created the team MOB. Check Linear before creating it again.",
          },
        },
      ],
    });
    const s = scriptedUi({
      choices: [CREATE_TEAM_CHOICE],
      names: [{ name: "Mobile", key: "mob" }],
    });
    const result = await act(f, s.ui);
    expect(result).toEqual({
      state: "waiting",
      reason: "team_create_unverified",
      evidence: { teamKey: "MOB" },
    });
    const text = onboardReasonText({
      id: "linear.team",
      ...result,
    } as OnboardStep);
    expect(text).toContain("catalyst team adopt MOB");
    expect(text).toContain("run catalyst onboard to create it again");
  });

  test.each([500, 504, 502, 503])(
    "an unnamed HTTP %s preserves the uncertain team key and never re-asks",
    async (status) => {
      const f = fixture({
        replies: [{ status, body: { message: "Worker limits exceeded" } }],
      });
      const s = scriptedUi({
        choices: [CREATE_TEAM_CHOICE],
        names: [{ name: "Mobile", key: "mob" }],
      });
      const result = await act(f, s.ui);
      expect(result).toEqual({
        state: "waiting",
        reason: "team_create_unverified",
        evidence: { teamKey: "MOB" },
      });
      expect(s.nameAsks).toHaveLength(1);
      expect(
        onboardReasonText({ id: "linear.team", ...result } as OnboardStep),
      ).toContain("could not confirm whether Linear created the team MOB");
    },
  );

  test.each(["signal", "SIGINT"] as const)(
    "cancel via %s after sending keeps the key on disk and after resume",
    async (cancel) => {
      const f = fixture();
      const s = scriptedUi({
        choices: [CREATE_TEAM_CHOICE],
        names: [{ name: "Mobile", key: "mob" }],
      });
      const stop = new AbortController();
      const fetch = f.ctx.fetch;
      const prior = new Set(process.listeners("SIGINT"));
      let beforeSend: OnboardStep | undefined;
      let sent = false;
      f.ctx.fetch = (async (request, init) => {
        if (init?.method === "POST") {
          // A crash here must already leave a durable warning naming the attempted team.
          sent = true;
          beforeSend = readOnboardJournal(
            onboardStatePath(f.ctx.home),
          )?.steps.find((row) => row.id === "linear.team");
          if (cancel === "signal") stop.abort();
          else
            for (const listener of process.listeners("SIGINT"))
              if (!prior.has(listener)) listener("SIGINT");
          return new Promise<Response>(() => {});
        }
        return fetch(request, init);
      }) as typeof fetch;
      f.journal.steps = ["signin", "linear.workspace", "linear.personal"].map(
        (id) => ({ id, state: "done" }),
      ) as OnboardStep[];
      writeOnboardJournal(onboardStatePath(f.ctx.home), f.journal);
      const args = parseArgs(["onboard", "--only", "linear.team"]);
      const runtime = createOnboardRuntime(args, f.ctx, { ...hooks, ui: s.ui });
      expect(
        await cmdOnboard(args, f.ctx, {
          ...runtime,
          adapters: {
            ...runtime.adapters,
            signin: { check: async () => ({ state: "done" }) },
            "linear.workspace": { check: async () => ({ state: "done" }) },
            "linear.personal": { check: async () => ({ state: "done" }) },
          },
          signal: stop.signal,
          identity: async () => ({
            account: "fixture-account",
            membershipId: "fixture-person",
            baseUrl: origin,
            role: "owner",
          }),
        }),
      ).toBe(11);
      expect(sent).toBe(true);
      expect(beforeSend).toMatchObject({
        reason: "team_create_unverified",
        evidence: { teamKey: "MOB" },
      });
      const saved = readOnboardJournal(onboardStatePath(f.ctx.home))!;
      const step = saved.steps.find((row) => row.id === "linear.team")!;
      expect(step).toMatchObject({
        state: "waiting",
        reason: "team_create_unverified",
        evidence: { teamKey: "MOB" },
      });
      expect(onboardReasonText(step)).toContain(
        "could not confirm whether Linear created the team MOB",
      );
      expect(process.listeners("SIGINT")).toEqual([...prior]);
    },
  );

  test("an interrupted naming retry after a definite collision does not retain uncertainty", async () => {
    const f = fixture({
      replies: [{ status: 409, body: { error: "key-taken" } }],
    });
    const stop = new AbortController();
    const s = scriptedUi({
      choices: [CREATE_TEAM_CHOICE],
      names: [{ name: "Mobile", key: "MOB" }],
    });
    let questions = 0;
    const ask = s.ui.nameNewTeam!;
    s.ui.nameNewTeam = async (question) => {
      if (++questions === 2) {
        stop.abort();
        return null;
      }
      return ask(question);
    };
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, {
      ...hooks,
      ui: s.ui,
    });
    expect(
      await runtime.adapters!["linear.team"]!.act!(
        f.ctx,
        f.journal,
        stop.signal,
      ),
    ).toMatchObject({ reason: "interrupted" });
    expect(
      readOnboardJournal(onboardStatePath(f.ctx.home))?.steps.find(
        (row) => row.id === "linear.team",
      )?.reason,
    ).not.toBe("team_create_unverified");
  });

  test("resuming an uncertain create keeps its key in the naming prompt", async () => {
    const f = fixture();
    f.journal.steps.push({
      id: "linear.team",
      state: "waiting",
      reason: "team_create_unverified",
      evidence: { teamKey: "MOB" },
    });
    const s = scriptedUi({ choices: [CREATE_TEAM_CHOICE], names: [null] });
    const runtime = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, {
      ...hooks,
      ui: s.ui,
    });
    await runtime.adapters!["linear.team"]!.check(f.ctx, f.journal);
    await runtime.adapters!["linear.team"]!.act!(f.ctx, f.journal);
    expect(s.nameAsks[0]).toMatchObject({ key: "MOB" });
    expect(s.messages.join("\n")).toContain(
      "could not confirm whether Linear created the team MOB",
    );
    expect(f.posts).toEqual([]);
  });

  test.each(["no UI", "cancel picker", "inventory outage"] as const)(
    "resuming after uncertainty preserves the receipt with %s",
    async (mode) => {
      const f = fixture();
      f.journal.steps = ["signin", "linear.workspace", "linear.personal"].map(
        (id) => ({ id, state: "done" }),
      ) as OnboardStep[];
      f.journal.steps.push({
        id: "linear.team",
        state: "waiting",
        reason: "team_create_unverified",
        evidence: { teamKey: "MOB" },
      });
      writeOnboardJournal(onboardStatePath(f.ctx.home), f.journal);
      const s = scriptedUi({ choices: [null] });
      const args = parseArgs(["onboard", "--only", "linear.team", "--yes"]);
      const runtime = createOnboardRuntime(args, f.ctx, {
        ...hooks,
        ...(mode === "no UI" ? {} : { ui: s.ui }),
      });
      const fetch = f.ctx.fetch;
      if (mode === "inventory outage")
        f.ctx.fetch = (async (request, init) => {
          if (String(request).includes("/agent/teams")) {
            f.reads.push("GET /api/v1/agent/teams");
            return Response.json({}, { status: 503 });
          }
          return fetch(request, init);
        }) as typeof fetch;
      expect(
        await cmdOnboard(args, f.ctx, {
          ...runtime,
          adapters: {
            ...runtime.adapters,
            signin: { check: async () => ({ state: "done" }) },
            "linear.workspace": { check: async () => ({ state: "done" }) },
            "linear.personal": { check: async () => ({ state: "done" }) },
          },
          identity: async () => ({
            account: "fixture-account",
            membershipId: "fixture-person",
            baseUrl: origin,
            role: "owner",
          }),
        }),
      ).toBe(11);
      expect(
        readOnboardJournal(onboardStatePath(f.ctx.home))?.steps.find(
          (row) => row.id === "linear.team",
        ),
      ).toMatchObject({
        state: "waiting",
        reason: "team_create_unverified",
        evidence: { teamKey: "MOB" },
      });
      expect(f.posts).toEqual([]);
      expect(f.reads.some((read) => read.includes("/api/v1/agent/teams"))).toBe(
        true,
      );
    },
  );

  test.each([
    ["team_create_unverified", "identity outage"],
    ["team_create_unverified", "member before act"],
    ["team_create_unverified", "member on resume"],
    ["team_created_not_adopted", "identity outage"],
    ["team_created_not_adopted", "member before act"],
    ["team_created_not_adopted", "member on resume"],
  ] as const)(
    "%s survives %s before a recovery action",
    async (reason, mode) => {
      const f = fixture();
      f.journal.steps = ["signin", "linear.workspace", "linear.personal"].map(
        (id) => ({ id, state: "done" }),
      ) as OnboardStep[];
      const evidence: Record<string, string> =
        reason === "team_created_not_adopted"
          ? { teamKey: "MOB", team: "team-new" }
          : { teamKey: "MOB" };
      f.journal.steps.push({
        id: "linear.team",
        state: "waiting",
        reason,
        evidence,
      });
      writeOnboardJournal(onboardStatePath(f.ctx.home), f.journal);
      const args = parseArgs([
        "onboard",
        "--resume-from",
        "linear.team",
        "--yes",
      ]);
      const s = scriptedUi({
        choices: [CREATE_TEAM_CHOICE],
        names: [{ name: "Other", key: "MOB2" }],
      });
      const runtime = createOnboardRuntime(args, f.ctx, { ...hooks, ui: s.ui });
      let recoveryChecked = false;
      let actions = 0;
      // Model a check that needs an action; the engine must refresh identity before it.
      await cmdOnboard(args, f.ctx, {
        ...runtime,
        adapters: {
          ...runtime.adapters,
          signin: { check: async () => ({ state: "done" }) },
          "linear.workspace": { check: async () => ({ state: "done" }) },
          "linear.personal": { check: async () => ({ state: "done" }) },
          "linear.team": {
            check: async () => {
              recoveryChecked = true;
              return { state: "pending" };
            },
            act: async () => {
              actions++;
              return { state: "done" };
            },
          },
        },
        identity: async () => {
          if (mode === "identity outage" && actions === 0 && recoveryChecked)
            throw new CliError(
              "Membership unavailable",
              "onboard-membership-unavailable",
              11,
            );
          return {
            account: "fixture-account",
            membershipId: "fixture-person",
            baseUrl: origin,
            role:
              mode === "member on resume" ||
              (mode === "member before act" && recoveryChecked)
                ? "member"
                : "owner",
          };
        },
      });
      expect(actions).toBe(0);
      const saved = readOnboardJournal(onboardStatePath(f.ctx.home))!;
      expect(saved.steps.find((row) => row.id === "linear.team")).toMatchObject(
        { state: "waiting", reason, evidence },
      );
      // A later healthy run still sees the exact saved key: it must never send MOB2.
      if (reason === "team_create_unverified") {
        f.journal = saved;
        const recovery = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, {
          ...hooks,
          ui: s.ui,
        }).adapters!["linear.team"]!;
        await recovery.check(f.ctx, saved);
        const resumed = await recovery.act!(f.ctx, saved);
        expect(resumed).toMatchObject({ state: "waiting", reason, evidence });
        expect(s.nameAsks[0]).toMatchObject({ key: "MOB" });
      }
      expect(f.posts).toEqual([]);
    },
  );

  test.each([
    "contract outage",
    "abort team read",
    "abort created readback",
  ] as const)(
    "%s keeps recovery evidence through engine result handling",
    async (mode) => {
      const f = fixture({
        replies: [
          {
            status: 201,
            body: { team: created, adoption: { outcome: "adopted" } },
          },
        ],
      });
      f.journal.steps = ["signin", "linear.workspace", "linear.personal"].map(
        (id) => ({ id, state: "done" }),
      ) as OnboardStep[];
      if (mode !== "abort created readback")
        f.journal.steps.push({
          id: "linear.team",
          state: "waiting",
          reason: "team_create_unverified",
          evidence: { teamKey: "MOB" },
        });
      writeOnboardJournal(onboardStatePath(f.ctx.home), f.journal);
      const stop = new AbortController();
      const realFetch = f.ctx.fetch;
      f.ctx.fetch = (async (request, init) => {
        const path = new URL(
          String(request instanceof Request ? request.url : request),
        ).pathname;
        if (mode === "contract outage" && path.endsWith("/contract"))
          return Response.json({}, { status: 503 });
        if (
          path.endsWith("/teams") &&
          (mode === "abort team read" ||
            (mode === "abort created readback" && f.posts.length))
        ) {
          stop.abort();
          throw new DOMException("Interrupted", "AbortError");
        }
        return realFetch(request, init);
      }) as typeof fetch;
      const s = scriptedUi({
        choices: [CREATE_TEAM_CHOICE],
        names: [{ name: "Mobile", key: "MOB" }],
      });
      const args = parseArgs(["onboard", "--only", "linear.team", "--yes"]);
      const runtime = createOnboardRuntime(args, f.ctx, { ...hooks, ui: s.ui });
      await cmdOnboard(args, f.ctx, {
        ...runtime,
        signal: stop.signal,
        adapters: {
          ...runtime.adapters,
          signin: { check: async () => ({ state: "done" }) },
          "linear.workspace": { check: async () => ({ state: "done" }) },
          "linear.personal": { check: async () => ({ state: "done" }) },
        },
        identity: async () => ({
          account: "fixture-account",
          membershipId: "fixture-person",
          baseUrl: origin,
          role: "owner",
        }),
      });
      const saved = readOnboardJournal(onboardStatePath(f.ctx.home))!;
      const reason =
        mode === "abort created readback"
          ? "team_created_not_adopted"
          : "team_create_unverified";
      expect(saved.steps.find((row) => row.id === "linear.team")).toMatchObject(
        {
          state: "waiting",
          reason,
          evidence: {
            teamKey: "MOB",
            ...(mode === "abort created readback" ? { team: "team-new" } : {}),
          },
        },
      );
      expect(f.posts).toHaveLength(mode === "abort created readback" ? 1 : 0);
      f.journal = saved;
      f.ctx.fetch = realFetch;
      f.setInventory([existing]);
      const next = scriptedUi({
        choices: [CREATE_TEAM_CHOICE],
        names: [{ name: "Other", key: "OTH" }],
      });
      const recovery = createOnboardRuntime(parseArgs(["onboard"]), f.ctx, {
        ...hooks,
        ui: next.ui,
      }).adapters!["linear.team"]!;
      const checked = await recovery.check(f.ctx, saved);
      if (checked.state === "pending") await recovery.act!(f.ctx, saved);
      expect(f.posts).toHaveLength(mode === "abort created readback" ? 1 : 0);
    },
  );

  test("a same-key collision after uncertainty keeps recovery instead of proposing another team", async () => {
    const f = fixture({
      replies: [
        {
          status: 409,
          body: { error: "key-taken", message: "Choose another key" },
        },
      ],
    });
    f.journal.steps.push({
      id: "linear.team",
      state: "waiting",
      reason: "team_create_unverified",
      evidence: { teamKey: "MOB" },
    });
    const s = scriptedUi({
      choices: [CREATE_TEAM_CHOICE],
      names: [
        { name: "Mobile", key: "MOB" },
        { name: "Mobile", key: "MOBI" },
      ],
    });
    const result = await act(f, s.ui);
    expect(result).toEqual({
      state: "waiting",
      reason: "team_create_unverified",
      evidence: { teamKey: "MOB" },
    });
    expect(s.nameAsks).toHaveLength(1);
    expect(f.posts).toHaveLength(1);
  });

  test("an outstanding uncertain key cannot be replaced by another create attempt", async () => {
    const f = fixture({
      replies: [{ status: 409, body: { error: "key-taken" } }],
    });
    f.journal.steps.push({
      id: "linear.team",
      state: "waiting",
      reason: "team_create_unverified",
      evidence: { teamKey: "MOB" },
    });
    writeOnboardJournal(onboardStatePath(f.ctx.home), f.journal);
    const s = scriptedUi({
      choices: [CREATE_TEAM_CHOICE],
      names: [{ name: "Mobile app", key: "MA" }],
    });
    expect(await act(f, s.ui)).toEqual({
      state: "waiting",
      reason: "team_create_unverified",
      evidence: { teamKey: "MOB" },
    });
    expect(f.posts).toEqual([]);
    expect(
      readOnboardJournal(onboardStatePath(f.ctx.home))?.steps.find(
        (row) => row.id === "linear.team",
      ),
    ).toMatchObject({
      reason: "team_create_unverified",
      evidence: { teamKey: "MOB" },
    });
  });

  test("a definite input refusal on resume keeps the original key through the next prompt and collision", async () => {
    const f = fixture({
      replies: [
        {
          status: 422,
          body: { error: "linear-rejected", linearMessage: "Invalid name" },
        },
        {
          status: 409,
          body: { error: "key-taken", message: "Choose another" },
        },
        {
          status: 201,
          body: { team: created, adoption: { outcome: "adopted" } },
        },
      ],
    });
    f.journal.steps.push({
      id: "linear.team",
      state: "waiting",
      reason: "team_create_unverified",
      evidence: { teamKey: "MOB" },
    });
    const s = scriptedUi({
      choices: [CREATE_TEAM_CHOICE],
      names: [
        { name: "Mobile", key: "MOB" },
        { name: "Mobile app", key: "MOB" },
        { name: "Duplicate", key: "MOBX" },
      ],
    });
    let betweenPrompts: OnboardStep | undefined;
    const ask = s.ui.nameNewTeam!;
    let asks = 0;
    s.ui.nameNewTeam = async (question) => {
      if (++asks === 2)
        betweenPrompts = readOnboardJournal(
          onboardStatePath(f.ctx.home),
        )?.steps.find((row) => row.id === "linear.team");
      return ask(question);
    };
    expect(await act(f, s.ui)).toEqual({
      state: "waiting",
      reason: "team_create_unverified",
      evidence: { teamKey: "MOB" },
    });
    expect(betweenPrompts).toMatchObject({
      reason: "team_create_unverified",
      evidence: { teamKey: "MOB" },
    });
    expect(f.posts).toHaveLength(2);
    expect(s.nameAsks).toHaveLength(2);
  });

  test("Linear rejecting the input re-asks with Linear's words", async () => {
    const f = fixture({
      replies: [
        {
          status: 422,
          body: {
            error: "linear-rejected",
            message: "Linear did not accept that team.",
            linearMessage: "Key must be at most 5 characters",
          },
        },
        {
          status: 201,
          body: { team: created, adoption: { outcome: "adopted" } },
        },
      ],
    });
    const s = scriptedUi({
      choices: [CREATE_TEAM_CHOICE],
      names: [
        { name: "Mobile", key: "MOBILEX" },
        { name: "Mobile", key: "MOB" },
      ],
    });
    expect(await act(f, s.ui)).toMatchObject({ state: "done" });
    expect(s.nameAsks[1]!.problem).toBe("Key must be at most 5 characters");
  });
});
