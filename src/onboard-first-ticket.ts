import { createHash } from "node:crypto";
import type { OnboardStepResult } from "./onboard.js";

export interface FirstTicketBinding {
  account: string;
  person: string;
  origin: string;
  teamId: string;
  teamKey: string;
  repoId: string;
  repoName: string;
  dispatchStateId: string;
  starter: "contributing-tests";
}
export interface FirstTicketIntent extends FirstTicketBinding {
  schema: 1;
  operationKey: string;
  phase: "intake";
  title: string;
  description: string;
  hash: string;
}
interface Ticket { id: string; identifier: string; url: string | null }
export interface FirstTicketReceipt {
  schema: 1;
  intent: FirstTicketIntent;
  stage: "creating" | "created" | "requesting" | "requested";
  ticket: Ticket | null;
  baseline: { cursor: number; at: number } | null;
  requestId: number | null;
}
export interface FreshFirstTicketContext {
  binding: FirstTicketBinding;
  checkedAt: number;
  expiresAt: number;
  readiness: "pass";
  capacity: "available" | "full";
  defaultRepository: "active-and-exact";
  principal: "service";
  role: "owner" | "admin";
}
/** Implementations must join actual entered IO, including response-body cancellation, before
 * settling. persist must acknowledge an atomic durable write under the current onboarding owner.
 * An unavailable default, readiness, feed or corroboration stays unavailable in these ports. */
export interface FirstTicketPorts {
  now(): number;
  assertCurrent(intent: FirstTicketIntent): void;
  fresh(signal: AbortSignal): Promise<FreshFirstTicketContext | null>;
  readReceipt(): unknown;
  persist(receipt: FirstTicketReceipt): Promise<void>;
  approve(intent: Readonly<FirstTicketIntent>, signal: AbortSignal): Promise<boolean>;
  create(payload: Readonly<{ teamId: string; stateId: string; title: string; description: string; idempotencyId: string }>, signal: AbortSignal): Promise<unknown>;
  baseline(signal: AbortSignal): Promise<{ cursor: number; at: number } | null>;
  request(payload: Readonly<{ issueId: string; phase: "intake" }>, signal: AbortSignal): Promise<unknown>;
  observe(receipt: Readonly<FirstTicketReceipt>, signal: AbortSignal): Promise<{
    events: unknown;
    execution: unknown;
    linearComment: boolean;
    fleetActivity: boolean;
  } | null>;
  explain(identifier: string, signal: AbortSignal): Promise<{ reason: string; action: string } | null>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  message(text: string): void;
}
const title = "Document how to run repository tests";
const description = "Update only CONTRIBUTING.md to document existing test commands from repository configuration. Do not change executable code, configuration, dependencies, or credentials. If the test commands cannot be established from source, stop and report the missing information.";
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const exact = (r: Record<string, unknown>, keys: readonly string[]) => Object.keys(r).length === keys.length && keys.every(k => Object.hasOwn(r, k));
const token = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(v);
const repositoryId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(v);
const number = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Z][A-Z0-9]{0,7}-[0-9]+$/.test(v);
const fields = ["account", "person", "origin", "teamId", "teamKey", "repoId", "repoName", "dispatchStateId", "starter"] as const;
function parseBinding(value: unknown): FirstTicketBinding | null {
  const r = object(value);
  if (!r || !exact(r, fields) || !token(r.account) || !token(r.person) || !token(r.teamId) || !repositoryId(r.repoId) || !token(r.dispatchStateId) ||
      typeof r.teamKey !== "string" || !/^[A-Z][A-Z0-9]{0,7}$/.test(r.teamKey) || typeof r.repoName !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(r.repoName) || r.starter !== "contributing-tests" || typeof r.origin !== "string") return null;
  try { const u = new URL(r.origin); if (u.protocol !== "https:" || u.origin !== r.origin || u.username || u.password) return null; } catch { return null; }
  return { account: r.account, person: r.person, origin: r.origin, teamId: r.teamId, teamKey: r.teamKey, repoId: r.repoId, repoName: r.repoName, dispatchStateId: r.dispatchStateId, starter: r.starter };
}
const bindingKey = (r: FirstTicketBinding) => JSON.stringify(fields.map(k => k === "repoName" ? r.repoName.toLowerCase() : r[k]));
function digest(r: Omit<FirstTicketIntent, "hash">): string {
  return createHash("sha256").update(JSON.stringify([r.schema, ...fields.map(k => r[k]), r.operationKey, r.phase, r.title, r.description])).digest("hex");
}
export function firstTicketIntent(binding: FirstTicketBinding, operationKey: string): Readonly<FirstTicketIntent> | null {
  const parsed = parseBinding(binding); if (!parsed || !token(operationKey)) return null;
  const r = { ...parsed, schema: 1 as const, operationKey, phase: "intake" as const, title, description };
  return Object.freeze({ ...r, hash: digest(r) });
}
export function parseFirstTicketReceipt(value: unknown): FirstTicketReceipt | null {
  const r = object(value), i = object(r?.intent);
  if (!r || !exact(r, ["schema", "intent", "stage", "ticket", "baseline", "requestId"]) || r.schema !== 1 || !i ||
      !exact(i, [...fields, "schema", "operationKey", "phase", "title", "description", "hash"]) || i.schema !== 1) return null;
  const b = parseBinding(Object.fromEntries(fields.map(k => [k, i[k]])));
  if (!b || !token(i.operationKey)) return null;
  const intent = firstTicketIntent(b, i.operationKey);
  if (!intent || i.phase !== intent.phase || i.title !== intent.title || i.description !== intent.description || i.hash !== intent.hash ||
      (r.stage !== "creating" && r.stage !== "created" && r.stage !== "requesting" && r.stage !== "requested")) return null;
  let ticket: Ticket | null = null;
  if (r.ticket !== null) {
    const t = object(r.ticket);
    if (!t || !exact(t, ["id", "identifier", "url"]) || !token(t.id) || !identifier(t.identifier) || !t.identifier.startsWith(b.teamKey + "-") ||
        !(t.url === null || typeof t.url === "string" && safeIssueUrl(t.url))) return null;
    ticket = { id: t.id, identifier: t.identifier, url: t.url };
  }
  let baseline: FirstTicketReceipt["baseline"] = null;
  if (r.baseline !== null) {
    const p = object(r.baseline); if (!p || !exact(p, ["cursor", "at"]) || !number(p.cursor) || !number(p.at)) return null;
    baseline = { cursor: p.cursor, at: p.at };
  }
  if (r.stage === "creating" ? ticket !== null || baseline !== null : ticket === null) return null;
  if (r.stage === "created" && baseline !== null || (r.stage === "requesting" || r.stage === "requested") && baseline === null) return null;
  if (r.stage === "requested" ? !number(r.requestId) || r.requestId < 1 : r.requestId !== null) return null;
  return { schema: 1, intent: { ...intent }, stage: r.stage, ticket, baseline, requestId: r.requestId as number | null };
}
function safeIssueUrl(value: string): boolean {
  try { const u = new URL(value); return u.protocol === "https:" && u.hostname === "linear.app" && !u.username && !u.password && !u.port && value.length <= 2048; } catch { return false; }
}
function created(value: unknown, teamKey: string): Ticket | null {
  const r = object(value);
  if (!r || (r.outcome !== "succeeded" && r.outcome !== "reused") || !number(r.attempts) || !token(r.id) || !identifier(r.identifier) ||
      !r.identifier.startsWith(teamKey + "-") || !(r.url === null || typeof r.url === "string" && safeIssueUrl(r.url))) return null;
  return { id: r.id, identifier: r.identifier, url: r.url };
}
/** A coordination sequence alone proves ordering, not causation by one request under concurrency. */
export function firstTicketLaunch(receipt: FirstTicketReceipt, events: unknown, execution: unknown): { nonce: number; at: number; cursor: number } | null {
  if (!receipt.ticket || !receipt.baseline || !Array.isArray(events) || events.length > 10_000) return null;
  const report = object(execution);
  if (!report || report.ticket !== receipt.ticket.identifier || report.attemptHistory !== "latest-per-phase" ||
      !number(report.observedAtMs) || report.observedAtMs < receipt.baseline.at || !Array.isArray(report.unreadable) || report.unreadable.length ||
      !Array.isArray(report.phases) || report.phases.length > 8 || !Array.isArray(report.lease)) return null;
  const phases = report.phases.map(object).filter(p => p?.phase === receipt.intent.phase);
  if (phases.length !== 1) return null;
  const phase = phases[0];
  if (!phase || !number(phase.startedAtMs) || !Array.isArray(phase.attempts) || !phase.attempts.length || phase.attempts.length > 1_000) return null;
  let generation = 0, startedAt = 0;
  for (const value of phase.attempts) {
    const a = object(value);
    if (!a || !number(a.generation) || a.generation <= generation || !number(a.startedAtMs)) return null;
    generation = a.generation; startedAt = a.startedAtMs;
  }
  if (startedAt < receipt.baseline.at || startedAt > report.observedAtMs || phase.startedAtMs !== startedAt) return null;
  const leases = report.lease.map(object).filter(l => l?.phase === receipt.intent.phase);
  if (leases.length > 1 || leases.some(l => l?.generation !== generation)) return null;
  let cursor = receipt.baseline.cursor, accepted = false;
  let launch: { nonce: number; at: number; cursor: number } | null = null;
  for (const value of events) {
    const e = object(value), a = object(e?.attributes);
    if (!e || !number(e.seq) || e.seq !== cursor + 1) return null;
    cursor = e.seq;
    if (!a) return null;
    if (e.event_name === "work.request.accepted" && a.ticket === receipt.ticket.identifier && a.phase === receipt.intent.phase &&
        number(a.requestId) && a.requestId > 0 && (receipt.requestId === null || a.requestId === receipt.requestId)) accepted = true;
    if (e.event_name !== "phase.dispatch.launched" || !accepted) continue;
    const expected = `lease:${receipt.ticket.identifier}/${receipt.intent.phase}#${generation}`;
    if (a.ticket !== receipt.ticket.identifier || a.phase !== receipt.intent.phase || a.nonce !== generation || e.caused_by !== expected ||
        e.event_id !== `phase-dispatch-launched.${receipt.ticket.identifier}.${receipt.intent.phase}.${generation}` ||
        a.repository_id !== receipt.intent.repoId || typeof a.repository_name !== "string" || a.repository_name.toLowerCase() !== receipt.intent.repoName.toLowerCase() || a.repository_rule !== "team_default" ||
        typeof e.ts !== "string" || !Number.isFinite(Date.parse(e.ts)) || Date.parse(e.ts) < receipt.baseline.at || Date.parse(e.ts) > report.observedAtMs) continue;
    launch = { nonce: generation, at: Date.parse(e.ts), cursor: e.seq };
  }
  return launch;
}
const wait = (reason: string, r?: FirstTicketReceipt): OnboardStepResult => ({ state: "waiting", reason,
  ...(r?.ticket ? { evidence: { ticket: r.ticket.identifier, repository: r.intent.repoName, phaseStarted: false } } : {}) });

/** One explicit Q5 approval, one frozen keyed create, durable intent before every write boundary.
 * Requests with lost responses are reconciled by evidence; they are never blindly issued again. */
export async function runFirstTicket(input: { binding: FirstTicketBinding; operationKey: string; ports: FirstTicketPorts; signal: AbortSignal }): Promise<OnboardStepResult> {
  const p = input.ports, intent = firstTicketIntent(input.binding, input.operationKey);
  let signal = input.signal, deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  if (!intent) return wait("first_ticket_context_unverified");
  let receipt: FirstTicketReceipt | null = null;
  try {
    const raw = p.readReceipt(); receipt = raw === null ? null : parseFirstTicketReceipt(raw);
    if (raw !== null && !receipt || receipt && receipt.intent.hash !== intent.hash) return wait("first_ticket_saved_intent_changed");
    if (receipt) {
      Object.freeze(receipt.intent); if (receipt.ticket) Object.freeze(receipt.ticket); if (receipt.baseline) Object.freeze(receipt.baseline); Object.freeze(receipt);
    }
  } catch { return wait("first_ticket_receipt_unavailable"); }
  const current = async (requireCapacity = true) => {
    if (signal.aborted) return false;
    p.assertCurrent(intent);
    const f = await p.fresh(signal); p.assertCurrent(intent);
    const now = p.now();
    return !signal.aborted && !!f && bindingKey(f.binding) === bindingKey(intent) && number(f.checkedAt) && number(f.expiresAt) &&
      f.checkedAt <= now && now - f.checkedAt < 30_000 && f.expiresAt > now && f.readiness === "pass" && (!requireCapacity || f.capacity === "available") &&
      f.defaultRepository === "active-and-exact" && f.principal === "service" && (f.role === "owner" || f.role === "admin");
  };
  const save = async (r: FirstTicketReceipt) => {
    const copied = parseFirstTicketReceipt(r);
    if (!copied) throw new Error("first_ticket_receipt_invalid");
    Object.freeze(copied.intent); if (copied.ticket) Object.freeze(copied.ticket); if (copied.baseline) Object.freeze(copied.baseline);
    Object.freeze(copied);
    await p.persist(copied); receipt = copied; p.assertCurrent(intent);
  };
  const startDeadline = (r: FirstTicketReceipt) => {
    if (!r.baseline || deadlineTimer) return;
    const stop = new AbortController();
    signal = AbortSignal.any([input.signal, stop.signal]);
    deadlineTimer = setTimeout(() => stop.abort(new Error("first_ticket_observation_deadline")), Math.max(0, r.baseline.at + 120_000 - p.now()));
  };
  try {
    if (!await current()) return wait("first_ticket_readiness_unverified", receipt ?? undefined);
    if (!receipt) {
      if (!await p.approve(intent, signal) || signal.aborted) return { state: "skipped", reason: signal.aborted ? "interrupted" : "first_ticket_not_selected" };
      if (!await current()) return wait("first_ticket_readiness_changed");
      await save({ schema: 1, intent: { ...intent }, stage: "creating", ticket: null, baseline: null, requestId: null });
    }
    if (!receipt) return wait("first_ticket_receipt_unavailable");
    if (receipt.stage === "creating") {
      if (!await current()) return wait("first_ticket_readiness_changed", receipt);
      const ticket = created(await p.create(Object.freeze({ teamId: intent.teamId, stateId: intent.dispatchStateId, title: intent.title, description: intent.description, idempotencyId: intent.operationKey }), signal), intent.teamKey);
      if (!ticket) return wait("first_ticket_create_unconfirmed", receipt);
      await save({ ...receipt, stage: "created", ticket });
    }
    if (!receipt?.ticket) return wait("first_ticket_create_unconfirmed");
    if (receipt.stage === "created") {
      if (!await current()) return wait("first_ticket_readiness_changed", receipt);
      const baseline = await p.baseline(signal);
      if (!baseline || !number(baseline.cursor) || !number(baseline.at) || baseline.at > p.now() || p.now() - baseline.at >= 30_000 || !await current()) return wait("first_ticket_observation_unavailable", receipt);
      await save({ ...receipt, stage: "requesting", baseline: { ...baseline } });
      startDeadline(receipt);
      if (input.signal.aborted) return wait("interrupted", receipt);
      if (signal.aborted || p.now() >= baseline.at + 120_000) return wait("first_ticket_launch_unconfirmed", receipt);
      p.assertCurrent(intent);
      const answer = object(await p.request(Object.freeze({ issueId: receipt.ticket.identifier, phase: intent.phase }), signal));
      if (answer?.status !== "queued" || answer.ticket !== receipt.ticket.identifier || answer.phase !== intent.phase || !number(answer.requestId) || answer.requestId < 1) return wait("first_ticket_request_unconfirmed", receipt);
      await save({ ...receipt, stage: "requested", requestId: answer.requestId });
    }
    startDeadline(receipt);
    const deadline = receipt.baseline!.at + 120_000;
    while (!signal.aborted && p.now() < deadline) {
      if (!await current(false)) return wait("first_ticket_readiness_changed", receipt);
      const proof = await p.observe(receipt, signal);
      p.assertCurrent(intent);
      const report = object(proof?.execution), observedNow = p.now();
      const launched = proof && report && number(report.observedAtMs) && report.observedAtMs <= observedNow && observedNow - report.observedAtMs < 30_000
        ? firstTicketLaunch(receipt, proof.events, proof.execution) : null;
      if (proof && launched && launched.at < deadline && p.now() < deadline && !signal.aborted && proof.linearComment && proof.fleetActivity && await current(false) &&
          p.now() < deadline && report && number(report.observedAtMs) && report.observedAtMs <= p.now() && p.now() - report.observedAtMs < 30_000) {
        p.message(`${receipt.ticket.identifier} started in ${intent.repoName}.`);
        p.assertCurrent(intent);
        if (signal.aborted || p.now() >= deadline) return wait(input.signal.aborted ? "interrupted" : "first_ticket_launch_unconfirmed", receipt);
        return { state: "done", evidence: { ticket: receipt.ticket.identifier, repository: intent.repoName, cursor: launched.cursor, phaseStarted: true, linearComment: true, fleetActivity: true, checkedAt: p.now() } };
      }
      await p.sleep(Math.min(2_000, Math.max(0, deadline - p.now())), signal);
    }
    if (input.signal.aborted) return wait("interrupted", receipt);
    const explanation = await p.explain(receipt.ticket.identifier, input.signal); p.assertCurrent(intent);
    if (explanation && /^[a-z][a-z0-9_]{0,63}$/.test(explanation.reason) && /^[a-z][a-z0-9_]{0,63}$/.test(explanation.action))
      p.message(`${receipt.ticket.identifier} has not been confirmed started. Reason: ${explanation.reason}. Next action: ${explanation.action}.`);
    return wait("first_ticket_launch_unconfirmed", receipt);
  } catch { return wait(input.signal.aborted ? "interrupted" : "first_ticket_unavailable", receipt ?? undefined); }
  finally { if (deadlineTimer) clearTimeout(deadlineTimer); }
}

/** Resume is a current read, never a second request. A saved request may be corroborated later
 * than its original polling window; this single check is bounded by its concrete IO adapter.
 * Capacity becoming full after a launch is expected and cannot negate that observed launch. */
export async function checkFirstTicket(input: { binding: FirstTicketBinding; operationKey: string; ports: FirstTicketPorts; signal: AbortSignal }): Promise<OnboardStepResult> {
  const p = input.ports, intent = firstTicketIntent(input.binding, input.operationKey);
  if (!intent) return wait("first_ticket_context_unverified");
  let receipt: FirstTicketReceipt | null;
  try {
    const raw = p.readReceipt();
    if (raw === null) return { state: "pending" };
    receipt = parseFirstTicketReceipt(raw);
    if (!receipt || receipt.intent.hash !== intent.hash) return wait("first_ticket_saved_intent_changed");
    Object.freeze(receipt.intent); if (receipt.ticket) Object.freeze(receipt.ticket);
    if (receipt.baseline) Object.freeze(receipt.baseline); Object.freeze(receipt);
    if (receipt.stage === "creating" || receipt.stage === "created") return { state: "pending" };
    const current = async () => {
      if (input.signal.aborted) return false;
      p.assertCurrent(intent);
      const f = await p.fresh(input.signal); p.assertCurrent(intent);
      const now = p.now();
      return !input.signal.aborted && !!f && bindingKey(f.binding) === bindingKey(intent) && number(f.checkedAt) && number(f.expiresAt) &&
        f.checkedAt <= now && now - f.checkedAt < 30_000 && f.expiresAt > now && f.readiness === "pass" &&
        f.defaultRepository === "active-and-exact" && f.principal === "service" && (f.role === "owner" || f.role === "admin");
    };
    if (!await current()) return wait("first_ticket_readiness_unverified", receipt);
    const proof = await p.observe(receipt, input.signal); p.assertCurrent(intent);
    const report = object(proof?.execution), now = p.now();
    const launched = proof && report && number(report.observedAtMs) && report.observedAtMs <= now && now - report.observedAtMs < 30_000
      ? firstTicketLaunch(receipt, proof.events, proof.execution) : null;
    if (!launched || !proof?.linearComment || !proof.fleetActivity || !await current() || input.signal.aborted ||
        !report || !number(report.observedAtMs) || report.observedAtMs > p.now() || p.now() - report.observedAtMs >= 30_000)
      return wait(input.signal.aborted ? "interrupted" : "first_ticket_launch_unconfirmed", receipt);
    p.assertCurrent(intent);
    return { state: "done", evidence: { ticket: receipt.ticket!.identifier, repository: intent.repoName,
      cursor: launched.cursor, phaseStarted: true, linearComment: true, fleetActivity: true, checkedAt: p.now() } };
  } catch { return wait(input.signal.aborted ? "interrupted" : "first_ticket_unavailable"); }
}
