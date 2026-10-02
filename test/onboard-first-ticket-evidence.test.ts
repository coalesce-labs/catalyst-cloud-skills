import { describe, expect, it } from "vitest";
import { firstTicketIntent, type FirstTicketBinding, type FirstTicketReceipt } from "../src/onboard-first-ticket.js";
import { firstTicketCommentId, firstTicketCorroboration } from "../src/onboard-first-ticket-evidence.js";

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

const OUTCOME_ID = "phase-outcome.fixture.CTC-41.intake.7";
// Fixed vector from the real fanout's UTF-8 SHA-256, tenant-length-prefixed input.
// Do not generate this comment ID with the function under test.
const OUTCOME_COMMENT_ID = "906398ac-4667-499d-83a5-df0d634ee949";
function outcome(status: "complete" | "failed" = "complete") {
  return { seq: 13, host: "node-a", event_id: OUTCOME_ID,
    event_name: `phase.intake.${status}`, ts: new Date(NOW + 2_000).toISOString(),
    caused_by: "lease:CTC-41/intake#7", attributes: { ticket: TICKET.identifier, nonce: 7, summary: "Updated the test documentation" }, resource: {} };
}
function evidence(status: "complete" | "failed" = "complete") {
  return {
    receipt: saved(),
    events: [accepted(), launched(), outcome(status)],
    execution: execution(),
    issue: { id: TICKET.id, identifier: TICKET.identifier, team_id: binding.teamId, comments: [{
      id: OUTCOME_COMMENT_ID,
      body: `${status === "complete" ? "✅ **Phase complete**" : "🛑 **Phase FAILED**"}\n\n**Phase**: \`intake\`\n\nUpdated the test documentation`,
      created_at: NOW + 2_500, updated_at: NOW + 2_500, author_id: null, author_name: "Catalyst intake", author_avatar_url: null, is_bot: 1, parent_id: null,
    }] },
    fleet: [{ host_id: "node-a", ticket: TICKET.identifier, phase: "intake", status: status,
      last_event_ts: NOW + 2_000, started_at: NOW + 1_000, disposition: status }],
    now: NOW + 3_000,
  };
}
const BOTH = { linearComment: true, fleetActivity: true };
const NONE = { linearComment: false, fleetActivity: false };

describe("real phase-outcome deterministic comment ID", () => {
  it("matches fanout fixed vector 1", () => { expect(firstTicketCommentId("account-1", "phase-outcome.fixture.CTC-41.intake.7")).toBe("906398ac-4667-499d-83a5-df0d634ee949"); });
  it("matches fanout fixed vector 2", () => { expect(firstTicketCommentId("a:b", "c")).toBe("cb600fd6-a019-4fd3-a7d5-672901f57926"); });
  it("matches fanout fixed vector 3", () => { expect(firstTicketCommentId("a", "b:c")).toBe("f6ef836b-3dd5-4acb-ae6c-16859337d15a"); });
  it("matches fanout fixed vector 4", () => { expect(firstTicketCommentId("tenant-🧪", "event.1")).toBe("3b2cac4c-703e-461f-a63c-bcae8086fdef"); });
  it("separates tenant/event pairs that would collide with a bare colon", () => {
    expect(firstTicketCommentId("a:b", "c")).not.toBe(firstTicketCommentId("a", "b:c"));
  });
  it("changes identity across tenants and across events while replay remains stable", () => {
    expect(firstTicketCommentId("account-1", OUTCOME_ID)).toBe(OUTCOME_COMMENT_ID);
    expect(firstTicketCommentId("account-2", OUTCOME_ID)).not.toBe(OUTCOME_COMMENT_ID);
    expect(firstTicketCommentId("account-1", `${OUTCOME_ID}.other`)).not.toBe(OUTCOME_COMMENT_ID);
  });
});

describe("actual mirrored outcome and fleet corroboration", () => {
  it.each(["complete", "failed"] as const)("corroborates the real %s comment rather than pretending the phase succeeded", status => {
    expect(firstTicketCorroboration(evidence(status))).toEqual(BOTH);
  });
  it("does not invent a start comment from launch alone", () => {
    const f = evidence();
    expect(firstTicketCorroboration({ ...f, events: events(), issue: { ...f.issue, comments: [] } })).toEqual({ linearComment: false, fleetActivity: true });
  });
  it("keeps independent evidence flags when the fleet or comment has not mirrored", () => {
    const f = evidence();
    expect(firstTicketCorroboration({ ...f, fleet: [] })).toEqual({ linearComment: true, fleetActivity: false });
    expect(firstTicketCorroboration({ ...f, issue: { ...f.issue, comments: [] } })).toEqual({ linearComment: false, fleetActivity: true });
  });
  it.each([
    { id: "another-issue" }, { identifier: "OTHER-41" }, { team_id: "another-team" },
  ])("refuses comment evidence on foreign issue detail %j", change => {
    const f = evidence();
    expect(firstTicketCorroboration({ ...f, issue: { ...f.issue, ...change } }).linearComment).toBe(false);
  });
  it.each([
    { id: "another-comment" }, { body: "✅ **Phase complete**\n**Phase**: `plan`" },
    { body: "Phase started: intake" }, { body: "🛑 **Phase FAILED**\n**Phase**: `intake`" },
    { created_at: NOW + 1_999 }, { created_at: NOW + 3_001 }, { created_at: null },
    { created_at: new Date(NOW + 2_500).toISOString() }, { body: "x".repeat(100_001) },
  ])("refuses mismatched or unreadable mirrored comment %j", change => {
    const f = evidence();
    expect(firstTicketCorroboration({ ...f, issue: { ...f.issue, comments: [{ ...f.issue.comments[0], ...change }] } }).linearComment).toBe(false);
  });
  it.each([
    { event_name: "phase.plan.complete" }, { event_name: "phase.intake.started" },
    { event_id: "bad event id" }, { ts: "not-a-date" },
    { ts: new Date(NOW + 999).toISOString() }, { ts: new Date(NOW + 3_001).toISOString() },
    { attributes: { ticket: "OTHER-41", nonce: 7 } },
    { attributes: { ticket: TICKET.identifier, nonce: 3 } },
  ])("does not correlate an outcome from another phase/generation/time %j", change => {
    const f = evidence();
    expect(firstTicketCorroboration({ ...f, events: [accepted(), launched(), { ...outcome(), ...change }] }).linearComment).toBe(false);
  });
  it("binds the comment ID to the actual outcome event rather than the launch", () => {
    const f = evidence();
    expect(firstTicketCorroboration({ ...f, issue: { ...f.issue, comments: [{ ...f.issue.comments[0], id: firstTicketCommentId(binding.account, launched().event_id) }] } }).linearComment).toBe(false);
  });
  it("accepts equal timestamp boundaries after the strictly later sequence", () => {
    const f = evidence(); const at = NOW + 1_000;
    expect(firstTicketCorroboration({ ...f, now: at, execution: { ...f.execution, observedAtMs: at }, events: [accepted(), launched(), { ...outcome(), ts: new Date(at).toISOString() }],
      issue: { ...f.issue, comments: [{ ...f.issue.comments[0], created_at: at }] },
      fleet: [{ ...f.fleet[0], last_event_ts: at }] })).toEqual(BOTH);
  });
  it.each([
    { ticket: "OTHER-41" }, { host_id: "node-b" }, { last_event_ts: NOW + 999 },
    { last_event_ts: NOW + 3_001 }, { last_event_ts: null }, { phase: "plan", started_at: NOW - 1 },
    { phase: "plan", started_at: NOW + 2_001 }, { phase: "plan", started_at: null },
  ])("refuses unrelated or temporally impossible fleet rows %j", change => {
    const f = evidence();
    expect(firstTicketCorroboration({ ...f, fleet: [{ ...f.fleet[0], ...change }] }).fleetActivity).toBe(false);
  });
  it("allows a same-ticket same-host successor row only with a current start witness", () => {
    const f = evidence();
    expect(firstTicketCorroboration({ ...f, fleet: [{ ...f.fleet[0], phase: "plan", started_at: NOW + 1_500 }] }).fleetActivity).toBe(true);
  });
  it("uses the lease generation, never the phase attempt counter, for outcomes", () => {
    const f = evidence();
    expect(f.execution.phases[0]?.attempt).toBe(3);
    expect(firstTicketCorroboration(f)).toEqual(BOTH);
    expect(firstTicketCorroboration({ ...f, events: [accepted(), launched(), { ...outcome(), attributes: { ticket: TICKET.identifier, nonce: 3 } }] }).linearComment).toBe(false);
  });
  it.each([
    { page: [launched(), accepted(), outcome()] },
    { page: [accepted(), { ...launched(), seq: 13 }, { ...outcome(), seq: 14 }] },
    { page: [accepted(), launched(), outcome(), { seq: 14, attributes: null }] },
  ])("requires the entire ordered dense coordination page, including its tail", ({ page }) => {
    expect(firstTicketCorroboration({ ...evidence(), events: page })).toEqual(NONE);
  });
  it("refuses wrong request, repository, unreadable report or conflicting generation before corroboration", () => {
    const f = evidence();
    expect(firstTicketCorroboration({ ...f, receipt: { ...f.receipt, requestId: 18 } })).toEqual(NONE);
    expect(firstTicketCorroboration({ ...f, events: [accepted(), launched({ attributes: { ...launched().attributes, repository_id: "other-repo" } }), outcome()] })).toEqual(NONE);
    expect(firstTicketCorroboration({ ...f, execution: { ...f.execution, unreadable: [{ table: "relay_attempts", error: "unreadable" }] } })).toEqual(NONE);
    expect(firstTicketCorroboration({ ...f, execution: { ...f.execution, lease: [{ ...f.execution.lease[0], generation: 8 }] } })).toEqual(NONE);
  });
  it.each([null, {}, "node-a", 5_000, false])("does not treat malformed fleet %j as an empty positive", fleet => {
    expect(firstTicketCorroboration({ ...evidence(), fleet }).fleetActivity).toBe(false);
  });
  it("rejects oversized comment and fleet collections while retaining each independent flag", () => {
    const f = evidence();
    expect(firstTicketCorroboration({ ...f, issue: { ...f.issue, comments: Array.from({ length: 1_001 }, () => f.issue.comments[0]) } }).linearComment).toBe(false);
    expect(firstTicketCorroboration({ ...f, fleet: Array.from({ length: 5_001 }, () => f.fleet[0]) }).fleetActivity).toBe(false);
  });
  it.each([NaN, Infinity, -1, NOW + 0.5, NOW])("refuses invalid or pre-launch current time %s", now => {
    expect(firstTicketCorroboration({ ...evidence(), now })).toEqual(NONE);
  });
  it("refuses a launch with no bounded concrete host", () => {
    const f = evidence();
    for (const host of [null, "", "x".repeat(257)]) {
      expect(firstTicketCorroboration({ ...f, events: [accepted(), launched({ host }), outcome()] })).toEqual(NONE);
    }
  });
});
