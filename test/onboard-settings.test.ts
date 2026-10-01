import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  readFileSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultCtx } from "../src/config.js";
import {
  onboardSettingsAdapter,
  type OnboardDraftStoreInput,
  type OnboardSettingsHooks,
} from "../src/onboard-settings.js";
import { onboardStateRoot, type OnboardJournal } from "../src/onboard.js";
import type { SettingsAuthorityContext } from "../src/env/settings-authority.js";

const scratch: string[] = [];
const toml =
  '[project]\nlinear_team="CTC"\n[environment]\n[[environment.variables]]\nname="PUBLIC_URL"\nrequired=false\n[[environment.variables]]\nname="API_TOKEN"\nsecret=true\nrequired=false\n';
function fixture(count = 1) {
  const root = mkdtempSync(join(tmpdir(), "q4-spine-"));
  scratch.push(root);
  const repositories = Array.from({ length: count }, (_, index) => ({
    owner: "example",
    name: `service${index}`,
    repoId: `repo-${index}`,
    teamId: "team-a",
  }));
  const journal: OnboardJournal = {
    schema: 1,
    runId: "run-a",
    cli: "0.14.3",
    installer: null,
    tenant: "account-a",
    account: "account-a",
    membershipId: "person-a",
    baseUrl: "https://cloud.example.test",
    exit: null,
    changes: [],
    steps: [
      { id: "linear.team", state: "done", evidence: { team: "team-a" } },
      {
        id: "github.repos",
        state: "done",
        evidence: { repository: JSON.stringify(repositories) },
      },
    ],
  };
  const ctx = {
    ...defaultCtx(),
    home: root,
    env: {},
    stdout: vi.fn(),
    stderr: vi.fn(),
    fetch: vi.fn<typeof fetch>(async () => new Response(null, { status: 500 })),
  };
  const store = vi.fn(async (_input: OnboardDraftStoreInput) => ({
    state: "stored" as const,
    path: join(root, "draft.toml"),
  }));
  const message = vi.fn();
  const contexts = new Map<string, SettingsAuthorityContext>();
  for (const repo of repositories)
    contexts.set(repo.repoId, {
      accountId: "account-a",
      personId: "person-a",
      baseUrl: journal.baseUrl!,
      role: "owner",
      teamId: "team-a",
      teamKey: "CTC",
      repoId: repo.repoId,
      repoName: `${repo.owner}/${repo.name}`,
      repoRoot: root,
    });
  const hooks: OnboardSettingsHooks = {
    repositoryRoot: () => root,
    authorityPorts: (_ctx, _journal, repository) => ({
      readContext: async () => ({ ...contexts.get(repository.repoId)! }),
      readSettings: async () => null,
    }),
    draft: vi.fn(() => ({
      state: "draft" as const,
      teamKey: "CTC",
      names: ["PUBLIC_URL", "API_TOKEN"],
      secretNames: ["API_TOKEN"],
      setup: [],
      verify: [],
      sources: [".env.example"],
      toml,
    })),
    storeDraft: store,
    message,
  };
  return {
    root,
    ctx,
    journal,
    hooks,
    store,
    message,
    contexts,
    adapter: () => onboardSettingsAdapter(hooks),
  };
}
afterEach(() => {
  vi.useRealTimers();
  for (const root of scratch.splice(0))
    rmSync(root, { recursive: true, force: true });
});
describe("one settings review across selected repositories", () => {
  it("checks validated drafts without prompting, writing, or marking approval", async () => {
    const f = fixture();
    f.hooks.review = vi.fn(async (): Promise<"keep"> => "keep");
    expect(await f.adapter().check(f.ctx, f.journal)).toEqual({
      state: "pending",
    });
    expect(f.store).not.toHaveBeenCalled();
    expect(f.hooks.review).not.toHaveBeenCalled();
    expect(f.message).not.toHaveBeenCalled();
  });
  it("uses one Q4 choice for all repositories, keeps private artifacts, and still waits for approval", async () => {
    const f = fixture(2);
    f.hooks.review = vi.fn(async (summaries): Promise<"keep"> => {
      expect(summaries).toHaveLength(2);
      return "keep";
    });
    expect(await f.adapter().act!(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "settings_approval_unverified",
      evidence: { count: 2 },
    });
    expect(f.hooks.review).toHaveBeenCalledTimes(1);
    expect(f.store).toHaveBeenCalledTimes(2);
    expect(f.store.mock.calls.map(([input]) => input.repoId)).toEqual([
      "repo-0",
      "repo-1",
    ]);
    const output = JSON.stringify(f.message.mock.calls);
    expect(output).toContain("API_TOKEN");
    expect(output).not.toContain(toml);
    expect(f.ctx.fetch).not.toHaveBeenCalled();
  });
  it("uses keep as the unattended default without importing values", async () => {
    const f = fixture();
    expect((await f.adapter().act!(f.ctx, f.journal)).state).toBe("waiting");
    expect(f.store).toHaveBeenCalledTimes(1);
    expect(f.ctx.fetch).not.toHaveBeenCalled();
  });
  it("cancellation after summaries makes zero artifact writes", async () => {
    const f = fixture();
    f.hooks.review = async () => "cancel";
    expect(await f.adapter().act!(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "interrupted",
    });
    expect(f.store).not.toHaveBeenCalled();
  });
  it("refuses a foreign or invalid whole file even when its environment portion looks valid", async () => {
    const f = fixture();
    f.hooks.draft = () => ({
      state: "draft",
      teamKey: "CTC",
      names: [],
      secretNames: [],
      setup: [],
      verify: [],
      sources: [],
      toml: toml + "\n[bogus]\nunknown=true\n",
    });
    expect((await f.adapter().check(f.ctx, f.journal)).reason).toBe(
      "settings_checkout_unverified",
    );
    expect(f.store).not.toHaveBeenCalled();
  });
  it("valid existing settings are observations rather than approval or overwrite permission", async () => {
    const f = fixture();
    const original = f.hooks.authorityPorts!;
    f.hooks.authorityPorts = (...args) => ({
      ...original(...args),
      readSettings: async () => toml,
    });
    expect(await f.adapter().check(f.ctx, f.journal)).toEqual({
      state: "waiting",
      reason: "settings_approval_unverified",
    });
    expect((await f.adapter().act!(f.ctx, f.journal)).reason).toBe(
      "settings_approval_unverified",
    );
    expect(f.hooks.draft).not.toHaveBeenCalled();
    expect(f.store).not.toHaveBeenCalled();
  });
  it("does not write a partial repository set when another checkout is unavailable", async () => {
    const f = fixture(2);
    f.hooks.repositoryRoot = (repo) =>
      repo.repoId === "repo-0" ? f.root : null;
    expect((await f.adapter().act!(f.ctx, f.journal)).reason).toBe(
      "settings_checkout_unverified",
    );
    expect(f.store).not.toHaveBeenCalled();
    expect(JSON.stringify(f.message.mock.calls)).toContain("example/service1");
  });
  it("refuses redirected local roots before the scanner or network", async () => {
    const f = fixture();
    const redirect = join(f.root, "redirect");
    symlinkSync(f.root, redirect, "dir");
    f.hooks.repositoryRoot = () => redirect;
    expect((await f.adapter().check(f.ctx, f.journal)).reason).toBe(
      "settings_checkout_unverified",
    );
    expect(f.hooks.draft).not.toHaveBeenCalled();
    expect(f.ctx.fetch).not.toHaveBeenCalled();
  });
  it("requires a current team declaration match", async () => {
    const f = fixture();
    f.contexts.get("repo-0")!.teamKey = "OTHER";
    expect((await f.adapter().check(f.ctx, f.journal)).reason).toBe(
      "settings_checkout_unverified",
    );
    expect(f.store).not.toHaveBeenCalled();
  });
  it("rechecks identity after review before keeping a draft", async () => {
    const f = fixture();
    f.hooks.review = async () => {
      f.contexts.get("repo-0")!.personId = "other-person";
      return "keep";
    };
    expect((await f.adapter().act!(f.ctx, f.journal)).reason).toBe(
      "settings_checkout_unverified",
    );
    expect(f.store).not.toHaveBeenCalled();
  });
  it("keeps a private validated draft with the production store and reuses it on resume", async () => {
    const f = fixture();
    delete f.hooks.storeDraft;
    const path = join(
      onboardStateRoot(f.ctx.home, f.ctx.env),
      "install",
      "drafts",
      f.journal.runId,
      "repo-0.toml",
    );
    for (let run = 0; run < 2; run++) {
      expect(await f.adapter().act!(f.ctx, f.journal)).toEqual({
        state: "waiting",
        reason: "settings_approval_unverified",
        evidence: { count: 1 },
      });
      expect(readFileSync(path, "utf8")).toBe(toml);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    }
    expect(f.store).not.toHaveBeenCalled();
  });
  it("waits for the store cancellation acknowledgment before returning at its budget", async () => {
    const f = fixture();
    f.hooks.storeTimeoutMs = 5;
    let acknowledge!: () => void;
    let sawAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      sawAbort = resolve;
    });
    f.hooks.storeDraft = async (input) =>
      new Promise((resolve) => {
        acknowledge = () => resolve({ state: "rejected" });
        input.signal!.addEventListener("abort", sawAbort, { once: true });
      });
    let finished = false;
    const pending = f.adapter().act!(f.ctx, f.journal).then((result) => {
      finished = true;
      return result;
    });
    await aborted;
    expect(finished).toBe(false);
    acknowledge();
    expect(await pending).toMatchObject({
      state: "waiting",
      reason: "settings_draft_storage_timeout",
      evidence: { count: 0 },
    });
  });
  it("waits for an externally cancelled writer and ignores its late stored result", async () => {
    const f = fixture();
    const controller = new AbortController();
    let finish!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.hooks.storeDraft = async (input) =>
      new Promise((resolve) => {
        finish = () => resolve({ state: "stored", path: "late artifact" });
        entered();
        input.signal!.addEventListener("abort", () => {}, { once: true });
      });
    let completed = false;
    const pending = f.adapter().act!(f.ctx, f.journal, controller.signal).then(
      (result) => {
        completed = true;
        return result;
      },
    );
    await started;
    controller.abort();
    await Promise.resolve();
    expect(completed).toBe(false);
    finish();
    expect(await pending).toMatchObject({
      state: "waiting",
      reason: "interrupted",
      evidence: { count: 0 },
    });
    expect(JSON.stringify(f.message.mock.calls)).not.toContain("late artifact");
  });
  it("a stalled read reaches its deadline and late completion cannot store", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let complete!: (context: SettingsAuthorityContext) => void;
    f.hooks.authorityPorts = () => ({
      readContext: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
      readSettings: async () => null,
    });
    const pending = f.adapter().act!(f.ctx, f.journal);
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).reason).toBe("settings_checkout_unverified");
    complete(f.contexts.get("repo-0")!);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.store).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("interruption ends a chooser ignoring abort without allowing its late keep to write", async () => {
    const f = fixture();
    const abort = new AbortController();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let complete!: (choice: "keep") => void;
    f.hooks.review = () =>
      new Promise((resolve) => {
        complete = resolve;
        started();
      });
    const pending = f.adapter().act!(f.ctx, f.journal, abort.signal);
    await entered;
    abort.abort();
    expect((await pending).reason).toBe("interrupted");
    complete("keep");
    await Promise.resolve();
    expect(f.store).not.toHaveBeenCalled();
  });
});
