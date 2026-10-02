import { describe, expect, it } from "vitest";
import { firstTicketReadinessChecks } from "../src/onboard-first-ticket-http.js";

// Actual READINESS_CHECK_IDS in cloud packages/types/src/workflow-readiness.ts.
// Expectations below preserve its measured-empty and informational exceptions.
const ids = [
  "oauth_scope", "token_live", "team_visible", "mapped_states_exist", "mapping_total", "types_compatible", "labels_present",
  "writes_land", "webhook_covers_team", "hosts_current", "environment_declared", "tools_resolvable", "required_values",
  "reviewer_required", "reviewer_configured", "reviewer_answering", "linear_automation_pr_open", "linear_automation_pr_review",
  "linear_automation_pr_ready", "linear_automation_pr_merge", "merge_queue_configured", "coding_account_enrolled", "github_app_installed", "thoughts_reachable",
];
const checks = () => ids.map(id => ({ id, state: "pass" }));
const changed = (id: string, change: Record<string, unknown>) => checks().map(check => check.id === id ? { ...check, ...change } : check);
const waitingPairs = [
  { id: "webhook_covers_team", reason: "delivery_window_empty" },
  { id: "writes_land", reason: "no_write_observed" },
  { id: "hosts_current", reason: "no_host_connected" },
  { id: "reviewer_answering", reason: "reviewer_not_yet_answered" },
];

describe("first-ticket actual readiness verdict exceptions", () => {
  it("accepts every measured pass without inferring missing evidence", () => {
    expect(firstTicketReadinessChecks(checks())).toBe(true);
  });
  it("accepts the actual set in another order", () => {
    expect(firstTicketReadinessChecks(checks().reverse())).toBe(true);
  });
  it.each(waitingPairs)("preserves measured-empty $id/$reason", ({ id, reason }) => {
    expect(firstTicketReadinessChecks(changed(id, { state: "unknown", reason }))).toBe(true);
  });
  it.each(waitingPairs)("does not turn unreadable $id into its measured-empty exception", ({ id }) => {
    expect(firstTicketReadinessChecks(changed(id, { state: "unknown", reason: "liveness_unchecked" }))).toBe(false);
  });
  it.each(waitingPairs)("requires the measured-empty reason for $id", ({ id }) => {
    expect(firstTicketReadinessChecks(changed(id, { state: "unknown" }))).toBe(false);
  });
  it("preserves the actual informational no-reviewer failure", () => {
    expect(firstTicketReadinessChecks(changed("reviewer_configured", { state: "fail", reason: "no_reviewer_configured" }))).toBe(true);
  });
  it("does not pardon an unreadable reviewer configuration", () => {
    expect(firstTicketReadinessChecks(changed("reviewer_configured", { state: "unknown", reason: "reviewer_activity_unread" }))).toBe(false);
  });
  it("does not pardon an unrecognized reviewer failure reason", () => {
    expect(firstTicketReadinessChecks(changed("reviewer_configured", { state: "fail", reason: "reviewer_activity_unread" }))).toBe(false);
  });
  it("rejects contradictory pass-with-failure-reason wire", () => {
    expect(firstTicketReadinessChecks(changed("token_live", { reason: "token_dead" }))).toBe(false);
  });
  it.each(ids.filter(id => id !== "reviewer_configured"))("refuses a failed %s even under a claimed ready envelope", id => {
    expect(firstTicketReadinessChecks(changed(id, { state: "fail", reason: "measured_failure" }))).toBe(false);
  });
  it.each(["linear_automation_pr_open", "linear_automation_pr_review", "linear_automation_pr_ready", "linear_automation_pr_merge"])("optional unbuilt automation management cannot clear unreadable %s", id => {
    expect(firstTicketReadinessChecks(changed(id, { state: "unknown", reason: "automation_unreadable" }))).toBe(false);
    expect(firstTicketReadinessChecks(changed(id, { state: "fail", reason: "automation_conflict", count: 1 }))).toBe(false);
  });
  it.each(["required_values", "environment_declared"])("does not confuse an unreadable %s probe with nothing required", id => {
    expect(firstTicketReadinessChecks(changed(id, { state: "unknown", reason: "liveness_unchecked" }))).toBe(false);
  });
  it.each([undefined, null, "ready", true])("refuses malformed token-live state %j", state => {
    expect(firstTicketReadinessChecks(changed("token_live", { state }))).toBe(false);
  });
  it("rejects a missing check", () => {
    expect(firstTicketReadinessChecks(checks().filter(check => check.id !== "token_live"))).toBe(false);
  });
  it("rejects a duplicate replacing a missing check despite unchanged count", () => {
    const value = checks().filter(check => check.id !== "token_live");
    value.push({ id: "oauth_scope", state: "pass" });
    expect(firstTicketReadinessChecks(value)).toBe(false);
  });
  it("rejects a new unsupported check replacing a required ID", () => {
    expect(firstTicketReadinessChecks(checks().map(check => check.id === "token_live" ? { id: "future_check", state: "pass" } : check))).toBe(false);
  });
  it("rejects an extra unknown check rather than silently trimming it", () => {
    expect(firstTicketReadinessChecks([...checks(), { id: "future_check", state: "pass" }])).toBe(false);
  });
  it.each([null, {}, [], true, "ready"].map(value => ({ value })))("refuses malformed check collection %j", ({ value }) => {
    expect(firstTicketReadinessChecks(value)).toBe(false);
  });
  it.each([null, [], 0].map(row => ({ row })))("refuses a malformed row %j in a full-length list", ({ row }) => {
    expect(firstTicketReadinessChecks([...checks().slice(0, -1), row])).toBe(false);
  });
});
