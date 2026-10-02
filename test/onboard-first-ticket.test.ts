import { afterEach, describe, expect, it, vi } from "vitest";
import {
  firstTicketIntent,
  firstTicketLaunch,
  checkFirstTicket,
  parseFirstTicketReceipt,
  runFirstTicket,
  type FirstTicketBinding,
  type FirstTicketPorts,
  type FirstTicketReceipt,
  type FreshFirstTicketContext,
} from "../src/onboard-first-ticket.js";

const NOW = 1_700_000_000_000;
const KEY = "first-ticket-fixture-key";
// The public agent route derives an account-scoped issue UUID from the key.
// It is not the caller's literal idempotency key.
const TICKET = {
  id: "cf113ae0-85c0-5d0a-baea-b1dbcb6d94d4",
  identifier: "CTC-41",
  url: "https://linear.app/example/issue/CTC-41/repository-test-documentation",
};
const binding: FirstTicketBinding = {
  account: "account-1",
  person: "person-1",
  origin: "https://first-ticket-fixture.invalid",
  teamId: "team-1",
  teamKey: "CTC",
  repoId: "repo-sdk",
  repoName: "Acme/SDK",
  dispatchStateId: "state-dispatch",
  starter: "contributing-tests",
};
function intent(value: FirstTicketBinding = binding) {
  const result = firstTicketIntent(value, KEY);
  if (!result) throw new Error("positive intent fixture refused");
  return result;
}
function saved(stage: FirstTicketReceipt["stage"] = "requested"): FirstTicketReceipt {
  return {
    schema: 1,
    intent: { ...intent() },
    stage,
    ticket: stage === "creating" ? null : { ...TICKET },
    baseline: stage === "requesting" || stage === "requested" ? { cursor: 10, at: NOW } : null,
    requestId: stage === "requested" ? 17 : null,
  };
}

// Actual ticket-execution-report wire shape. Phase attempt counts retry rounds;
// lease/retained attempt generation is the nonce. They intentionally differ here.
function execution() {
  const unreadable: Array<{ table: string; error: string }> = [];
  return {
    ticket: TICKET.identifier,
    observedAtMs: NOW + 2_000,
    attemptHistory: "latest-per-phase",
    hasLadderHistory: true,
    phases: [{
      phase: "intake",
      attempt: 3,
      status: "ready",
      updatedAtMs: NOW + 1_000,
      startedAtMs: NOW + 1_000,
      endedAtMs: null,
      attempts: [
        { generation: 6, startedAtMs: NOW - 60_000, imageSha: "older-image", ranOn: null },
        { generation: 7, startedAtMs: NOW + 1_000, imageSha: "current-image", ranOn: { substrate: "cloudflare", node: "node-a", actor: null } },
      ],
      parkSentinel: null,
      lastFailureClass: null,
      consecutiveFailures: null,
      lastFailureMs: null,
      timeouts: null,
      writability: null,
    }],
    failure: null,
    remediate: { roundsDispatched: null, cap: 3, roundsReachingModel: "counted on the runner's remediate-round.json ledger, not here", series: null, moveState: null },
    park: null,
    retryBackoffInForce: [],
    lease: [{ phase: "intake", holder: "node-a", generation: 7, deadlineMs: NOW + 60_000 }],
    lastAdvance: null,
    hostInterrupted: [],
    governors: [],
    releases: [],
    unreadable,
    reader: "operator",
  };
}
function accepted(overrides: Record<string, unknown> = {}) {
  return {
    seq: 11,
    host: null,
    event_id: "work-request-CTC-41-intake-17",
    event_name: "work.request.accepted",
    ts: new Date(NOW).toISOString(),
    caused_by: null,
    attributes: { ticket: TICKET.identifier, phase: "intake", requestId: 17, disposition: "queued", actorKeyId: "personal-key-row", actorHost: null },
    resource: {},
    ...overrides,
  };
}
function launched(overrides: Record<string, unknown> = {}) {
  return {
    seq: 12,
    host: "node-a",
    event_id: "phase-dispatch-launched.CTC-41.intake.7",
    event_name: "phase.dispatch.launched",
    ts: new Date(NOW + 1_000).toISOString(),
    caused_by: "lease:CTC-41/intake#7",
    attributes: { ticket: TICKET.identifier, phase: "intake", nonce: 7, node: "node-a", team: "CTC", provider: "claude", model: "fixture-model", effort: "high", repository_id: binding.repoId, repository_name: "acme/sdk", repository_rule: "team_default" },
    resource: {},
    ...overrides,
  };
}
const events = () => [accepted(), launched()];
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(initial: unknown = null) {
  const state = {
    saved: initial,
    clock: NOW + 2_000,
    available: true,
    binding: { ...binding },
    current: true,
  };
  const controller = new AbortController();
  const writes: FirstTicketReceipt[] = [];
  const ports: FirstTicketPorts = {
    now: () => state.clock,
    assertCurrent: vi.fn(() => { if (!state.current) throw new Error("fixture_current_changed"); }),
    fresh: vi.fn(async (): Promise<FreshFirstTicketContext | null> => state.available ? {
      binding: { ...state.binding }, checkedAt: state.clock, expiresAt: state.clock + 30_000,
      readiness: "pass", capacity: "available", defaultRepository: "active-and-exact", principal: "service", role: "owner",
    } : null),
    readReceipt: vi.fn(() => state.saved),
    persist: vi.fn(async (receipt) => { writes.push(receipt); state.saved = structuredClone(receipt); }),
    approve: vi.fn(async () => true),
    create: vi.fn(async () => ({ outcome: "succeeded", attempts: 1, ...TICKET })),
    baseline: vi.fn(async () => ({ cursor: 10, at: NOW })),
    request: vi.fn(async () => ({ status: "queued", ticket: TICKET.identifier, phase: "intake", instruction: "none", disposition: "queued", priorArtifacts: [], requestId: 17 })),
    observe: vi.fn(async () => ({ events: events(), execution: execution(), linearComment: true, fleetActivity: true })),
    explain: vi.fn(async () => ({ reason: "capacity_unavailable", action: "wait_for_capacity" })),
    sleep: vi.fn(async (ms) => { state.clock += ms; }),
    message: vi.fn(),
  };
  const run = () => runFirstTicket({ binding, operationKey: KEY, ports, signal: controller.signal });
  return { state, controller, writes, ports, run };
}
afterEach(() => vi.useRealTimers());

describe("first ticket intent and closed receipt", () => {
  it.each([161, 256])("retains a cloud repository ID of %i characters in the approved receipt", length => {
    const repoId = "tenant-a:acme__" + "r".repeat(length - "tenant-a:acme__".length);
    const value = firstTicketIntent({ ...binding, repoId }, KEY);
    expect(value?.repoId).toBe(repoId);
    expect(parseFirstTicketReceipt({ ...saved("creating"), intent: value })?.intent.repoId).toBe(repoId);
  });
  it.each(["r".repeat(257), "repo/name", "repo\\name", "repo%2fother", "repo\nother"])("rejects an unsafe repository ID %j", repoId => {
    expect(firstTicketIntent({ ...binding, repoId }, KEY)).toBeNull();
  });
  it("does not widen the account, person, team, dispatch, or operation ID bounds", () => {
    const long = "a".repeat(161);
    for (const field of ["account", "person", "teamId", "dispatchStateId"] as const)
      expect(firstTicketIntent({ ...binding, [field]: long }, KEY)).toBeNull();
    expect(firstTicketIntent(binding, long)).toBeNull();
  });
  it("retains wire repository case and freezes the exact displayed starter plan", () => {
    const value = intent();
    expect(value.repoName).toBe("Acme/SDK");
    expect(Object.isFrozen(value)).toBe(true);
    expect(value.title).toBe("Document how to run repository tests");
    expect(value.description).toContain("Update only CONTRIBUTING.md");
    expect(firstTicketIntent({ ...binding, repoId: "different-repo" }, KEY)?.hash).not.toBe(value.hash);
  });
  it.each(["http://first-ticket-fixture.invalid", "https://user@first-ticket-fixture.invalid", "https://first-ticket-fixture.invalid/path"])("refuses origin %s before a usable intent", (origin) => {
    expect(firstTicketIntent({ ...binding, origin }, KEY)).toBeNull();
  });
  it.each(["creating", "created", "requesting", "requested"] as const)("accepts the exact %s checkpoint", (stage) => {
    expect(parseFirstTicketReceipt(saved(stage))).toEqual(saved(stage));
  });
  it("refuses changed approved text and extra receipt fields", () => {
    const value = saved();
    expect(parseFirstTicketReceipt({ ...value, intent: { ...value.intent, description: "change executable code" } })).toBeNull();
    expect(parseFirstTicketReceipt({ ...value, approved: true })).toBeNull();
  });
  it.each([
    { stage: "creating", ticket: TICKET },
    { stage: "created", baseline: { cursor: 10, at: NOW } },
    { stage: "requesting", baseline: null },
    { stage: "requested", requestId: null },
    { stage: "requested", requestId: 0 },
    { stage: "requested", ticket: { ...TICKET, identifier: "OTHER-41" } },
  ])("refuses contradictory stage checkpoint %j", (change) => {
    const stage = change.stage === "creating" || change.stage === "created" || change.stage === "requesting" ? change.stage : "requested";
    expect(parseFirstTicketReceipt({ ...saved(stage), ...change })).toBeNull();
  });
});

describe("read-only saved first-ticket check", () => {
  const check = (f: ReturnType<typeof fixture>) => checkFirstTicket({ binding, operationKey: KEY, ports: f.ports, signal: f.controller.signal });
  const expectReadOnly = (f: ReturnType<typeof fixture>) => {
    expect(f.ports.approve).not.toHaveBeenCalled();
    expect(f.ports.create).not.toHaveBeenCalled();
    expect(f.ports.request).not.toHaveBeenCalled();
    expect(f.ports.persist).not.toHaveBeenCalled();
    expect(f.ports.baseline).not.toHaveBeenCalled();
    expect(f.ports.sleep).not.toHaveBeenCalled();
    expect(f.ports.message).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  };
  const full = (f: ReturnType<typeof fixture>) => {
    const fresh = f.ports.fresh;
    f.ports.fresh = vi.fn(async (signal): Promise<FreshFirstTicketContext | null> => {
      const current = await fresh(signal);
      return current ? { ...current, capacity: "full" } : null;
    });
  };
  const lateProof = (f: ReturnType<typeof fixture>) => {
    f.state.clock = NOW + 160_000;
    f.ports.observe = vi.fn(async () => {
      const report = execution();
      const phase = report.phases[0];
      if (!phase) throw new Error("positive retained phase missing");
      const older = phase.attempts[0], latest = phase.attempts[1];
      if (!older || !latest) throw new Error("positive retained generations missing");
      return {
        events: [accepted(), launched({ ts: new Date(NOW + 130_000).toISOString() })],
        execution: {
          ...report, observedAtMs: f.state.clock, lease: [],
          phases: [{ ...phase, startedAtMs: NOW + 130_000, attempts: [older, { ...latest, generation: 7, startedAtMs: NOW + 130_000 }] }],
        },
        linearComment: true,
        fleetActivity: true,
      };
    });
  };
  it("keeps the first check pending without receipt and without provider or write ports", async () => {
    const f = fixture();
    expect(await check(f)).toEqual({ state: "pending" });
    expect(f.ports.fresh).not.toHaveBeenCalled();
    expect(f.ports.observe).not.toHaveBeenCalled();
    expectReadOnly(f);
  });
  it.each(["creating", "created"] as const)("keeps a saved %s stage pending for the same keyed action", async (stage) => {
    const value = saved(stage);
    const f = fixture(value);
    expect(await check(f)).toEqual({ state: "pending" });
    expect(f.state.saved).toEqual(value);
    expect(f.ports.fresh).not.toHaveBeenCalled();
    expect(f.ports.observe).not.toHaveBeenCalled();
    expectReadOnly(f);
  });
  it.each(["requesting", "requested"] as const)("corroborates a saved %s after the original poll window even when capacity is full", async (stage) => {
    const value = saved(stage);
    const f = fixture(value);
    full(f);
    lateProof(f);
    const result = await check(f);
    expect(result).toMatchObject({ state: "done", evidence: { ticket: TICKET.identifier, phaseStarted: true, cursor: 12, checkedAt: NOW + 160_000 } });
    expect(f.state.saved).toEqual(value);
    expect(f.ports.observe).toHaveBeenCalledTimes(1);
    expectReadOnly(f);
  });
  it.each(["linearComment", "fleetActivity"] as const)("does not promote a read-only check without %s corroboration", async (missing) => {
    const f = fixture(saved());
    full(f);
    f.ports.observe = vi.fn(async () => ({ events: events(), execution: execution(), linearComment: missing !== "linearComment", fleetActivity: missing !== "fleetActivity" }));
    expect(await check(f)).toMatchObject({ state: "waiting", evidence: { phaseStarted: false } });
    expectReadOnly(f);
  });
  it("keeps malformed late feed evidence waiting without entering the action ports", async () => {
    const f = fixture(saved());
    lateProof(f);
    const observe = f.ports.observe;
    f.ports.observe = vi.fn(async (receipt, signal) => {
      const proof = await observe(receipt, signal);
      if (!proof || !Array.isArray(proof.events)) throw new Error("positive late feed missing");
      return { ...proof, events: [...proof.events, null] };
    });
    expect(await check(f)).toMatchObject({ state: "waiting", reason: "first_ticket_launch_unconfirmed" });
    expectReadOnly(f);
  });
  it("refuses a foreign saved intent before fresh reads or observation", async () => {
    const value = saved();
    const f = fixture({ ...value, intent: { ...intent({ ...binding, account: "other-account" }) } });
    expect(await check(f)).toMatchObject({ state: "waiting", reason: "first_ticket_saved_intent_changed" });
    expect(f.ports.fresh).not.toHaveBeenCalled();
    expect(f.ports.observe).not.toHaveBeenCalled();
    expectReadOnly(f);
  });
  it("refuses a current scope change during read-only observation", async () => {
    const f = fixture(saved());
    const observe = f.ports.observe;
    f.ports.observe = vi.fn(async (receipt, signal) => {
      const proof = await observe(receipt, signal);
      f.state.current = false;
      return proof;
    });
    expect((await check(f)).state).toBe("waiting");
    expectReadOnly(f);
  });
  it("refuses proof that ages past thirty seconds during the final fresh read", async () => {
    const f = fixture(saved());
    let reads = 0;
    const fresh = f.ports.fresh;
    f.ports.fresh = vi.fn(async (signal) => {
      reads += 1;
      if (reads === 2) f.state.clock += 30_001;
      return fresh(signal);
    });
    expect(await check(f)).toMatchObject({ state: "waiting", reason: "first_ticket_launch_unconfirmed" });
    expectReadOnly(f);
  });
  it("joins entered read-only observation cleanup after caller abort", async () => {
    const f = fixture(saved());
    const entered = deferred<void>(), aborted = deferred<void>(), cleanup = deferred<void>();
    f.ports.observe = vi.fn(async (_receipt, signal) => {
      entered.resolve();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted.resolve(); resolve(); }, { once: true }));
      await cleanup.promise;
      throw signal.reason;
    });
    let settled = false;
    const task = check(f).finally(() => { settled = true; });
    await entered.promise;
    f.controller.abort(new Error("fixture check cancelled"));
    await aborted.promise;
    expect(settled).toBe(false);
    cleanup.resolve();
    expect(await task).toMatchObject({ state: "waiting", reason: "interrupted" });
    expectReadOnly(f);
  });
  it("refuses new creation at full capacity before approval or durable write", async () => {
    const f = fixture();
    full(f);
    expect(await f.run()).toMatchObject({ state: "waiting", reason: "first_ticket_readiness_unverified" });
    expectReadOnly(f);
  });
  it.each(["creating", "created"] as const)("requires available capacity before resumed %s writes", async (stage) => {
    const value = saved(stage);
    const f = fixture(value);
    full(f);
    expect((await f.run()).state).toBe("waiting");
    expect(f.state.saved).toEqual(value);
    expectReadOnly(f);
  });
  it("confirms the launch after its request consumes the last available capacity unit", async () => {
    const f = fixture();
    let consumed = false;
    const fresh = f.ports.fresh;
    f.ports.fresh = vi.fn(async (signal): Promise<FreshFirstTicketContext | null> => {
      const current = await fresh(signal);
      return current ? { ...current, capacity: consumed ? "full" : "available" } : null;
    });
    const request = f.ports.request;
    f.ports.request = vi.fn(async (payload, signal) => {
      const answer = await request(payload, signal);
      consumed = true;
      return answer;
    });
    expect((await f.run()).state).toBe("done");
    expect(f.ports.approve).toHaveBeenCalledTimes(1);
    expect(f.ports.create).toHaveBeenCalledTimes(1);
    expect(f.ports.request).toHaveBeenCalledTimes(1);
    const before = structuredClone(f.state.saved);
    expect((await check(f)).state).toBe("done");
    expect(f.state.saved).toEqual(before);
    expect(f.ports.approve).toHaveBeenCalledTimes(1);
    expect(f.ports.create).toHaveBeenCalledTimes(1);
    expect(f.ports.request).toHaveBeenCalledTimes(1);
    expect(f.ports.persist).toHaveBeenCalledTimes(4);
  });
});

describe("actual execution and coordination wire correlation", () => {
  it("pairs generation 7 despite retry-round attempt 3, using top-level ticket and unreadable", () => {
    expect(firstTicketLaunch(saved(), events(), execution())).toEqual({ nonce: 7, at: NOW + 1_000, cursor: 12 });
  });
  it("reconciles a lost request response from a requesting receipt and ordered accepted evidence", () => {
    expect(firstTicketLaunch(saved("requesting"), events(), execution())).toEqual({ nonce: 7, at: NOW + 1_000, cursor: 12 });
  });
  const badReports: Array<{ name: string; value: () => unknown }> = [
    { name: "another ticket", value: () => ({ ...execution(), ticket: "CTC-42" }) },
    { name: "an invented top identifier without the real ticket key", value: () => ({ ...execution(), ticket: undefined, identifier: TICKET.identifier }) },
    { name: "unreadable retained grants", value: () => ({ ...execution(), unreadable: [{ table: "relay_attempt_image", error: "fixture unavailable" }] }) },
    { name: "null unreadable sections", value: () => ({ ...execution(), unreadable: null }) },
    { name: "null retained attempts", value: () => ({ ...execution(), phases: [{ ...execution().phases[0], attempts: null }] }) },
    { name: "a duplicate phase", value: () => ({ ...execution(), phases: [...execution().phases, ...execution().phases] }) },
    { name: "nonmonotonic retained generations", value: () => ({ ...execution(), phases: [{ ...execution().phases[0], attempts: [...execution().phases[0]!.attempts].reverse() }] }) },
    { name: "a changed latest start", value: () => ({ ...execution(), phases: [{ ...execution().phases[0], startedAtMs: NOW + 999 }] }) },
    { name: "a conflicting current lease generation", value: () => ({ ...execution(), lease: [{ ...execution().lease[0], generation: 8 }] }) },
    { name: "a future grant relative to the report", value: () => ({ ...execution(), observedAtMs: NOW + 999 }) },
  ];
  it.each(badReports)("refuses $name", ({ value }) => {
    expect(firstTicketLaunch(saved(), events(), value())).toBeNull();
  });
  const badEvents: Array<{ name: string; value: () => unknown }> = [
    { name: "no accepted request", value: () => [launched({ seq: 11 })] },
    { name: "a different accepted request ID", value: () => [accepted({ attributes: { ...accepted().attributes, requestId: 18 } }), launched()] },
    { name: "launch before acceptance", value: () => [launched({ seq: 11 }), accepted({ seq: 12 })] },
    { name: "a gap in the unfiltered feed", value: () => [accepted(), launched({ seq: 13 })] },
    { name: "a malformed tail after a valid launch", value: () => [...events(), null] },
    { name: "an out-of-order tail after a valid launch", value: () => [...events(), accepted({ seq: 10 })] },
    { name: "a different repository ID", value: () => [accepted(), launched({ attributes: { ...launched().attributes, repository_id: "repo-other" } })] },
    { name: "a different repository name", value: () => [accepted(), launched({ attributes: { ...launched().attributes, repository_name: "acme/other" } })] },
    { name: "a per-ticket override instead of approved default", value: () => [accepted(), launched({ attributes: { ...launched().attributes, repository_rule: "label" } })] },
    { name: "a changed lease causal key", value: () => [accepted(), launched({ caused_by: "lease:CTC-41/intake#3" })] },
    { name: "a changed launch ID", value: () => [accepted(), launched({ event_id: "phase-dispatch-launched.CTC-41.intake.3" })] },
    { name: "a numeric timestamp", value: () => [accepted(), launched({ ts: NOW + 1_000 })] },
    { name: "a launch after the report was observed", value: () => [accepted(), launched({ ts: new Date(NOW + 3_000).toISOString() })] },
  ];
  it.each(badEvents)("refuses $name", ({ value }) => {
    expect(firstTicketLaunch(saved(), value(), execution())).toBeNull();
  });
});

describe("one approval and durable first-ticket transitions", () => {
  it("approves once, checkpoints before each write, and corroborates the actual created ticket", async () => {
    const f = fixture();
    const create = f.ports.create;
    f.ports.create = vi.fn(async (payload, signal) => {
      expect(f.state.saved).toMatchObject({ stage: "creating", ticket: null });
      expect(payload.idempotencyId).toBe(KEY);
      expect(Object.isFrozen(payload)).toBe(true);
      return create(payload, signal);
    });
    const request = f.ports.request;
    f.ports.request = vi.fn(async (payload, signal) => {
      expect(f.state.saved).toMatchObject({ stage: "requesting", baseline: { cursor: 10, at: NOW } });
      expect(payload).toEqual({ issueId: TICKET.identifier, phase: "intake" });
      return request(payload, signal);
    });
    const result = await f.run();
    expect(result.state).toBe("done");
    expect(result.evidence).toMatchObject({ ticket: TICKET.identifier, repository: "Acme/SDK", phaseStarted: true, linearComment: true, fleetActivity: true, cursor: 12 });
    expect(f.ports.approve).toHaveBeenCalledTimes(1);
    expect(f.writes.map((r) => r.stage)).toEqual(["creating", "created", "requesting", "requested"]);
    expect(TICKET.id).not.toBe(KEY);
    expect(f.ports.message).toHaveBeenCalledWith("CTC-41 started in Acme/SDK.");
  });
  it("declines without persisting intent or entering create, request, or observation", async () => {
    const f = fixture();
    f.ports.approve = vi.fn(async () => false);
    expect(await f.run()).toMatchObject({ state: "skipped", reason: "first_ticket_not_selected" });
    expect(f.writes).toEqual([]);
    expect(f.ports.create).not.toHaveBeenCalled();
    expect(f.ports.request).not.toHaveBeenCalled();
    expect(f.ports.observe).not.toHaveBeenCalled();
  });
  it("refuses a foreign saved intent before fresh network ports or approval", async () => {
    const receipt = saved();
    const f = fixture({ ...receipt, intent: { ...intent({ ...binding, person: "other-person" }) } });
    expect(await f.run()).toMatchObject({ state: "waiting", reason: "first_ticket_saved_intent_changed" });
    expect(f.ports.fresh).not.toHaveBeenCalled();
    expect(f.ports.approve).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });
  it("handles a real receipt-read failure as unavailable with no later actions", async () => {
    const f = fixture();
    f.ports.readReceipt = vi.fn(() => { throw new Error("fixture EACCES"); });
    expect(await f.run()).toMatchObject({ state: "waiting", reason: "first_ticket_receipt_unavailable" });
    expect(f.ports.fresh).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });
  it("waits for fresh readiness before asking for approval", async () => {
    const f = fixture();
    f.state.available = false;
    expect(await f.run()).toMatchObject({ state: "waiting", reason: "first_ticket_readiness_unverified" });
    expect(f.ports.approve).not.toHaveBeenCalled();
    expect(f.ports.create).not.toHaveBeenCalled();
  });
  it("refuses an identity change during approval before checkpoint or create", async () => {
    const f = fixture();
    f.ports.approve = vi.fn(async () => { f.state.binding.person = "other-person"; return true; });
    expect(await f.run()).toMatchObject({ state: "waiting", reason: "first_ticket_readiness_changed" });
    expect(f.writes).toEqual([]);
    expect(f.ports.create).not.toHaveBeenCalled();
  });
  it("compares a fresh canonical GitHub name without discarding the approved display case", async () => {
    const f = fixture(saved());
    f.state.binding.repoName = "acme/sdk";
    expect(await f.run()).toMatchObject({ state: "done", evidence: { repository: "Acme/SDK" } });
  });
  it("preserves the created checkpoint when current scope changes during the baseline read", async () => {
    const f = fixture(saved("created"));
    f.ports.baseline = vi.fn(async () => { f.state.current = false; return { cursor: 10, at: NOW }; });
    expect((await f.run()).state).toBe("waiting");
    expect(f.state.saved).toMatchObject({ stage: "created", baseline: null });
    expect(f.ports.persist).not.toHaveBeenCalled();
    expect(f.ports.request).not.toHaveBeenCalled();
  });
  it("does not accept writes when the caller cancels during Q5 approval", async () => {
    const f = fixture();
    f.ports.approve = vi.fn(async () => { f.controller.abort(new Error("fixture stop")); return true; });
    expect(await f.run()).toMatchObject({ state: "skipped", reason: "interrupted" });
    expect(f.writes).toEqual([]);
    expect(f.ports.create).not.toHaveBeenCalled();
  });
  it("retains only the durable creating checkpoint after an unconfirmed create response", async () => {
    const f = fixture();
    f.ports.create = vi.fn(async () => ({ outcome: "exhausted", attempts: 4, lastError: "fixture write uncertain" }));
    expect(await f.run()).toMatchObject({ state: "waiting", reason: "first_ticket_create_unconfirmed" });
    expect(f.state.saved).toMatchObject({ stage: "creating", ticket: null });
    expect(f.ports.request).not.toHaveBeenCalled();
    expect(f.writes).toHaveLength(1);
  });
  it("joins an entered durable intent checkpoint before create", async () => {
    const f = fixture();
    const entered = deferred<void>(), release = deferred<void>();
    const persist = f.ports.persist;
    f.ports.persist = vi.fn(async (receipt) => {
      if (receipt.stage === "creating") { entered.resolve(); await release.promise; }
      return persist(receipt);
    });
    let settled = false;
    const task = f.run().finally(() => { settled = true; });
    await entered.promise;
    expect(settled).toBe(false);
    expect(f.ports.create).not.toHaveBeenCalled();
    release.resolve();
    expect((await task).state).toBe("done");
  });
  it("reuses the same keyed create after a lost response without another approval", async () => {
    const f = fixture();
    const keys: string[] = [];
    f.ports.create = vi.fn(async (payload) => {
      keys.push(payload.idempotencyId);
      if (keys.length === 1) throw new Error("fixture lost response");
      return { outcome: "reused", attempts: 0, ...TICKET };
    });
    expect((await f.run()).state).toBe("waiting");
    expect(f.state.saved).toMatchObject({ stage: "creating", ticket: null });
    expect((await f.run()).state).toBe("done");
    expect(keys).toEqual([KEY, KEY]);
    expect(f.ports.approve).toHaveBeenCalledTimes(1);
    expect(f.writes.filter((r) => r.stage === "creating")).toHaveLength(1);
  });
  it("reconciles a lost request response without a second request or approval", async () => {
    const f = fixture();
    f.ports.request = vi.fn(async () => { throw new Error("fixture request response lost"); });
    expect((await f.run()).state).toBe("waiting");
    expect(f.state.saved).toMatchObject({ stage: "requesting", requestId: null });
    expect((await f.run()).state).toBe("done");
    expect(f.ports.request).toHaveBeenCalledTimes(1);
    expect(f.ports.create).toHaveBeenCalledTimes(1);
    expect(f.ports.approve).toHaveBeenCalledTimes(1);
  });
  it("resumes a fully requested receipt with no write or extra Q5 approval", async () => {
    const f = fixture(saved());
    expect((await f.run()).state).toBe("done");
    expect(f.ports.approve).not.toHaveBeenCalled();
    expect(f.ports.create).not.toHaveBeenCalled();
    expect(f.ports.request).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });
  it.each(["linearComment", "fleetActivity"] as const)("requires %s corroboration even when launch and execution match", async (missing) => {
    const f = fixture(saved());
    f.ports.observe = vi.fn(async () => ({ events: events(), execution: execution(), linearComment: missing !== "linearComment", fleetActivity: missing !== "fleetActivity" }));
    const result = await f.run();
    expect(result).toMatchObject({ state: "waiting", evidence: { phaseStarted: false } });
    expect(f.ports.message).not.toHaveBeenCalledWith("CTC-41 started in Acme/SDK.");
  });
  it("preserves a truthful requesting checkpoint when work request is rejected", async () => {
    const f = fixture();
    f.ports.request = vi.fn(async () => ({ status: "rejected", ticket: TICKET.identifier, phase: "intake", reason: "capability_mismatch" }));
    expect(await f.run()).toMatchObject({ state: "waiting", reason: "first_ticket_request_unconfirmed" });
    expect(f.state.saved).toMatchObject({ stage: "requesting", requestId: null });
    expect(f.ports.observe).not.toHaveBeenCalled();
  });
});

describe("original deadline and joined cancellation", () => {
  it("does not enter request when the requesting checkpoint settles after the original deadline", async () => {
    const f = fixture(saved("created"));
    const persist = f.ports.persist;
    f.ports.persist = vi.fn(async (receipt) => {
      await persist(receipt);
      if (receipt.stage === "requesting") f.state.clock = NOW + 120_001;
    });
    expect(await f.run()).toMatchObject({ state: "waiting", reason: "first_ticket_launch_unconfirmed" });
    expect(f.state.saved).toMatchObject({ stage: "requesting", baseline: { cursor: 10, at: NOW } });
    expect(f.ports.request).not.toHaveBeenCalled();
  });
  it("does not accept a timely launch delivered after the original observation deadline", async () => {
    const f = fixture(saved());
    f.ports.observe = vi.fn(async () => {
      f.state.clock = NOW + 120_001;
      return { events: events(), execution: execution(), linearComment: true, fleetActivity: true };
    });
    expect((await f.run()).state).toBe("waiting");
    expect(f.ports.message).not.toHaveBeenCalledWith("CTC-41 started in Acme/SDK.");
  });
  it("does not accept a future-dated report and launch within the deadline", async () => {
    const f = fixture(saved());
    f.ports.observe = vi.fn(async () => {
      const report = execution();
      return { events: events(), execution: { ...report, observedAtMs: f.state.clock + 60_000 }, linearComment: true, fleetActivity: true };
    });
    expect((await f.run()).state).toBe("waiting");
    expect(f.ports.message).not.toHaveBeenCalledWith("CTC-41 started in Acme/SDK.");
  });
  it("rechecks proof age after the final fresh authority read", async () => {
    const f = fixture(saved());
    let reads = 0;
    const fresh = f.ports.fresh;
    f.ports.fresh = vi.fn(async (signal) => {
      reads += 1;
      if (reads === 3) f.state.clock += 30_001;
      return fresh(signal);
    });
    expect((await f.run()).state).toBe("waiting");
    expect(f.ports.message).not.toHaveBeenCalledWith("CTC-41 started in Acme/SDK.");
  });
  it("checks current scope after success display before returning done", async () => {
    const f = fixture(saved());
    f.ports.message = vi.fn((text) => { if (text === "CTC-41 started in Acme/SDK.") f.state.current = false; });
    expect(await f.run()).toMatchObject({ state: "waiting", reason: "first_ticket_unavailable", evidence: { phaseStarted: false } });
  });
  it("forwards the original deadline abort but waits for entered request cleanup acknowledgement", async () => {
    vi.useFakeTimers();
    const f = fixture(saved("created"));
    const entered = deferred<void>(), abortObserved = deferred<void>(), cleanup = deferred<void>();
    f.ports.request = vi.fn(async (_payload, signal) => {
      entered.resolve();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => { abortObserved.resolve(); resolve(); }, { once: true }));
      await cleanup.promise;
      throw signal.reason;
    });
    let settled = false;
    const task = f.run().finally(() => { settled = true; });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(118_000);
    await abortObserved.promise;
    expect(settled).toBe(false);
    expect(f.state.saved).toMatchObject({ stage: "requesting" });
    cleanup.resolve();
    expect((await task).state).toBe("waiting");
    expect(f.ports.observe).not.toHaveBeenCalled();
  });
  it("forwards caller cancellation and joins entered observation before returning interrupted", async () => {
    const f = fixture(saved());
    const entered = deferred<void>(), abortObserved = deferred<void>(), cleanup = deferred<void>();
    f.ports.observe = vi.fn(async (_receipt, signal) => {
      entered.resolve();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => { abortObserved.resolve(); resolve(); }, { once: true }));
      await cleanup.promise;
      throw signal.reason;
    });
    let settled = false;
    const task = f.run().finally(() => { settled = true; });
    await entered.promise;
    f.controller.abort(new Error("fixture caller interruption"));
    await abortObserved.promise;
    expect(settled).toBe(false);
    cleanup.resolve();
    expect(await task).toMatchObject({ state: "waiting", reason: "interrupted", evidence: { phaseStarted: false } });
    expect(f.writes).toEqual([]);
  });
});
