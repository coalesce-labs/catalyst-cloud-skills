import { configPathFor, loadConfig, normalizeBaseUrl, readManifest, type Ctx } from "./config.js";
import { contractVersionInRange } from "./contract.js";
import { onboardFileSnapshot } from "./onboard-file-snapshot.js";
import { selectedOnboardTeam } from "./onboard-existing.js";
import { selectedOnboardRepositories } from "./onboard-repositories.js";
import { observeOnboardWorkflow } from "./onboard-workflow.js";
import { ownedFetch } from "./owned-fetch.js";
import { loadHttpSdk } from "./sdk.js";
import { checkFirstTicket, runFirstTicket, type FirstTicketBinding, type FirstTicketIntent, type FirstTicketPorts } from "./onboard-first-ticket.js";
import { firstTicketCorroboration } from "./onboard-first-ticket-evidence.js";
import type { OnboardAdapter, OnboardCheckpoint, OnboardJournal, OnboardStepResult } from "./onboard.js";

const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(v);
const waiting = (reason: string): OnboardStepResult => ({ state: "waiting", reason });
const teamDefault = "/api/v1/me/team-repository";
const capacityPath = "/api/v1/me/runner-capacity";
const workflowPath = "/api/v1/agent/team-workflow";
const readinessPath = "/api/v1/agent/tenant/readiness";
const feedPath = "/api/v1/coordination/changes";
const createPath = "/api/v1/agent/issue-create";
const requestPath = "/api/v1/agent/work/request";
const readinessIds = ["oauth_scope", "token_live", "team_visible", "mapped_states_exist", "mapping_total", "types_compatible", "labels_present", "writes_land", "webhook_covers_team", "hosts_current", "environment_declared", "tools_resolvable", "required_values", "reviewer_required", "reviewer_configured", "reviewer_answering", "linear_automation_pr_open", "linear_automation_pr_review", "linear_automation_pr_ready", "linear_automation_pr_merge", "merge_queue_configured", "coding_account_enrolled", "github_app_installed", "thoughts_reachable"];

// Mirrors the current wire contract's verdict exceptions: a measured empty window is
// waiting, and reviewer configuration is informational. Unreadable checks never pass.
export function firstTicketReadinessChecks(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== readinessIds.length) return false;
  const seen = new Set<string>();
  const waitingPairs: Readonly<Record<string, string>> = {
    webhook_covers_team: "delivery_window_empty", writes_land: "no_write_observed",
    hosts_current: "no_host_connected", reviewer_answering: "reviewer_not_yet_answered",
  };
  for (const candidate of value) {
    const check = object(candidate);
    if (!check || typeof check.id !== "string" || !readinessIds.includes(check.id) || seen.has(check.id)) return false;
    seen.add(check.id);
    if (check.state === "pass") { if (check.reason !== undefined) return false; continue; }
    if (check.state === "unknown" && waitingPairs[check.id] === check.reason && typeof check.reason === "string") continue;
    if (check.state === "fail" && check.id === "reviewer_configured" && check.reason === "no_reviewer_configured") continue;
    return false;
  }
  return true;
}

function capacity(value: unknown, repoId: string, teamKey: string, now: number): "available" | "full" | null {
  const r = object(value);
  if (r?.status !== "ok" || r.scope !== "mapped-team-defaults" || !integer(r.observedAtMs) || r.observedAtMs > now || now - r.observedAtMs >= 30_000 || !Array.isArray(r.buckets) || r.buckets.length > 500) return null;
  const selected = r.buckets.filter(v => object(v)?.repoId === repoId);
  const b = object(selected[0]);
  if (selected.length !== 1 || !b || !integer(b.effectiveLimit) || !integer(b.occupiedUnits) || !Array.isArray(b.teams) || !b.teams.length || b.teams.length > 500) return null;
  let minimum = Number.MAX_SAFE_INTEGER, selectedRemaining: number | null = null;
  const seen = new Set<string>();
  for (const value of b.teams) {
    const t = object(value);
    if (!t || !id(t.teamKey) || seen.has(t.teamKey) || !integer(t.defaultLimit) || t.defaultLimit < 1 ||
        !(t.configuredLimit === null || integer(t.configuredLimit) && t.configuredLimit > 0) || typeof t.paused !== "boolean" || typeof t.admissionEnabled !== "boolean" || !integer(t.effectiveTeamLimit)) return null;
    seen.add(t.teamKey);
    const configured = t.configuredLimit === null ? t.defaultLimit : t.configuredLimit;
    if (t.source !== (t.configuredLimit === null ? "default" : "configured") || t.effectiveTeamLimit !== (t.paused ? 0 : configured)) return null;
    minimum = Math.min(minimum, t.effectiveTeamLimit);
    const remaining = t.admissionEnabled ? Math.max(0, b.effectiveLimit - b.occupiedUnits) : null;
    if (t.remainingUnits !== remaining) return null;
    if (t.teamKey === teamKey) selectedRemaining = remaining;
  }
  return minimum !== b.effectiveLimit || selectedRemaining === null ? null : selectedRemaining > 0 ? "available" : "full";
}

/** Concrete HTTP adapter. HTTP calls use the central SDK loader and one frozen credential;
 * the coordination NDJSON read uses its documented numeric cursor and actual lane headers.
 * Every entered request/body is joined before a port or adapter settles. No token rotation,
 * replica, provider fallback, host service, or automatic Q5 approval is performed here. */
export function onboardFirstTicketAdapter(hooks: {
  approve?: (intent: Readonly<FirstTicketIntent>, signal: AbortSignal) => Promise<boolean>;
  message?: (text: string) => void;
} = {}): OnboardAdapter {
  const perform = async (ctx: Ctx, journal: OnboardJournal, external: AbortSignal | undefined, action: boolean, checkpoint?: OnboardCheckpoint): Promise<OnboardStepResult> => {
    const cfg = loadConfig(ctx.home), teamId = selectedOnboardTeam(journal), repos = selectedOnboardRepositories(journal);
    if (!cfg?.user || cfg.principal !== "service" || (cfg.user.role !== "owner" && cfg.user.role !== "admin") ||
        cfg.account !== journal.account || cfg.user.id !== journal.membershipId || !journal.baseUrl ||
        normalizeBaseUrl(cfg.baseUrl) !== normalizeBaseUrl(journal.baseUrl) || !teamId || repos.length !== 1 || repos[0]!.teamId !== teamId)
      return waiting("first_ticket_context_unverified");
    const origin = normalizeBaseUrl(cfg.baseUrl), person = cfg.user.id, role = cfg.user.role, repo = Object.freeze({ ...repos[0]! });
    try { const u = new URL(origin); if (u.protocol !== "https:" || u.origin !== origin || u.username || u.password) return waiting("first_ticket_context_unverified"); }
    catch { return waiting("first_ticket_context_unverified"); }
    const expiry = cfg.key ? Number.MAX_SAFE_INTEGER : cfg.auth ? Date.parse(cfg.auth.expiresAt) : 0;
    const bearer = cfg.key ?? cfg.auth?.accessToken;
    if (!bearer || !Number.isFinite(expiry) || expiry - ctx.now().getTime() <= 30_000) return waiting("first_ticket_login_refresh_required");
    const before = onboardFileSnapshot(configPathFor(ctx.home));
    const selection = JSON.stringify([teamId, repos]);
    const operationKey = journal.operations?.["first-ticket"] ?? `${journal.runId}:first-ticket`;
    const bindingTuple = JSON.stringify([journal.account, journal.membershipId, journal.baseUrl]);
    const stop = new AbortController(), signal = external ? AbortSignal.any([external, stop.signal]) : stop.signal;
    // Q5 may wait for explicit input. Each entered network operation has its own original30s
    // bound; the core's request observation has its separate120s bound.
    const timer = setTimeout(() => stop.abort(), action ? 600_000 : 30_000);
    const current = () => {
      const now = loadConfig(ctx.home);
      return !signal.aborted && ctx.now().getTime() < expiry && now?.account === cfg.account && now.user?.id === person && now.user.role === role &&
        now.principal === cfg.principal && normalizeBaseUrl(now.baseUrl) === origin && onboardFileSnapshot(configPathFor(ctx.home)) === before &&
        JSON.stringify([selectedOnboardTeam(journal), selectedOnboardRepositories(journal)]) === selection &&
        JSON.stringify([journal.account, journal.membershipId, journal.baseUrl]) === bindingTuple &&
        (journal.operations?.["first-ticket"] ?? `${journal.runId}:first-ticket`) === operationKey;
    };
    const assertCurrent = () => { if (!current()) throw new Error("first_ticket_binding_changed"); };
    try {
      assertCurrent();
      const sdk = await loadHttpSdk();
      assertCurrent();
      let supported = false;
      const rpc = async (path: string, parent: AbortSignal, method: "GET" | "POST" = "GET", body?: unknown): Promise<unknown> => {
        assertCurrent();
        if (parent.aborted || method === "POST" && (!supported || !action)) throw new Error("first_ticket_request_stopped");
        const ownedStop = new AbortController(), operationSignal = AbortSignal.any([signal, parent, ownedStop.signal]);
        const deadline = setTimeout(() => ownedStop.abort(), 30_000);
        const transport = ownedFetch(ctx.fetch, operationSignal, { maxBodyBytes: 2_097_152 });
        const target = new URL(origin + path), expectedBody = body === undefined ? undefined : JSON.stringify(body);
        const scoped: typeof fetch = (request, init) => {
          assertCurrent();
          const url = new URL(request instanceof Request ? request.url : String(request));
          const verb = init?.method ?? (request instanceof Request ? request.method : "GET");
          if (operationSignal.aborted || url.href !== target.href || verb !== method || (method === "POST" && init?.body !== expectedBody))
            return Promise.reject(new Error("first_ticket_request_scope"));
          return transport.fetch(request, { ...init, signal: init?.signal ? AbortSignal.any([operationSignal, init.signal]) : operationSignal, redirect: "error" });
        };
        try {
          const client = sdk.createTenantClient({ baseUrl: origin, key: bearer, fetch: scoped, timeoutMs: 30_000, now: () => ctx.now().getTime() });
          const reply = await client.request({ path, method, ...(body === undefined ? {} : { body }) });
          assertCurrent();
          if (operationSignal.aborted || reply.outcome !== "ok" || reply.status !== 200) throw new Error("first_ticket_read_unavailable");
          return reply.json;
        } finally { try { await transport.settle(); } finally { clearTimeout(deadline); } }
      };
      const live = async (parent: AbortSignal) => {
        const me = object(await rpc("/api/v1/me", parent)), user = object(me?.user);
        if (me?.account !== cfg.account || me.principal !== cfg.principal || user?.id !== person || user.role !== role) throw new Error("first_ticket_identity_unverified");
        assertCurrent();
      };
      const support = async (parent: AbortSignal) => {
        const c = object(await rpc("/api/v1/agent/contract", parent)), onboarding = object(c?.onboarding);
        if (onboarding?.schema !== 1 || object(c?.account)?.id !== cfg.account || typeof c?.contractVersion !== "string" || !contractVersionInRange(c.contractVersion, readManifest().tenantContractRange)) throw new Error("first_ticket_contract_unavailable");
        const has = (values: unknown, method: string, path: string, personal = false) => Array.isArray(values) && values.length <= 500 &&
          values.filter(value => { const row = object(value); return row?.method === method && row.path === path && (!personal || row.personalBearer === true); }).length === 1;
        if (!has(onboarding?.routes, "GET", teamDefault, true) || !has(onboarding?.routes, "GET", capacityPath, true) ||
            ![workflowPath, readinessPath].every(path => has(c.routes, "GET", path)) ||
            ![createPath, requestPath].every(path => has(c.routes, "POST", path)) ||
            !has(c.feeds, "GET", feedPath) ||
            !["/api/v1/issues/{identifier}", "/api/v1/issues/{identifier}/execution", "/api/v1/fleet-activity/current"].every(path => has(c.reads, "GET", path)))
          throw new Error("first_ticket_capability_unavailable");
        supported = true;
        assertCurrent();
      };
      const fresh: FirstTicketPorts["fresh"] = async parent => {
        await support(parent); await live(parent);
        const d = object(await rpc(`${teamDefault}?teamId=${encodeURIComponent(teamId)}`, parent)), repository = object(d?.repository);
        const now = ctx.now().getTime();
        if (d?.status !== "ok" || d.account !== cfg.account || d.personId !== person || d.teamId !== teamId || typeof d.teamKey !== "string" || !/^[A-Z][A-Z0-9]{0,7}$/.test(d.teamKey) ||
            !integer(d.observedAtMs) || d.observedAtMs > now || now - d.observedAtMs >= 30_000 || repository?.repoId !== repo.repoId || repository.status !== "active" || repository.rule !== "team_default" ||
            typeof repository.fullName !== "string" || repository.fullName.toLowerCase() !== `${repo.owner}/${repo.name}`.toLowerCase()) return null;
        const workflow = await rpc(`${workflowPath}?team=${encodeURIComponent(teamId)}`, parent), observed = observeOnboardWorkflow(workflow, teamId, ctx.now().getTime());
        const rows = object(workflow)?.rows;
        const dispatch = Array.isArray(rows) ? rows.filter(value => object(value)?.slot === "dispatch") : [];
        const dispatchStateId = object(dispatch[0])?.linearStateId;
        const ready = object(object(await rpc(`${readinessPath}?team=${encodeURIComponent(teamId)}`, parent))?.readiness);
        if (!observed || dispatch.length !== 1 || !id(dispatchStateId) || ready?.teamId !== teamId || ready.teamKey !== d.teamKey || ready.status !== "ready" ||
            ready.workflowRev !== observed.readinessRevision || !integer(ready.checkedAt) || ready.checkedAt > ctx.now().getTime() || ctx.now().getTime() - ready.checkedAt >= 300_000 ||
            !firstTicketReadinessChecks(ready.checks)) return null;
        const capacityReport = await rpc(capacityPath, parent);
        const capacityAt = object(capacityReport)?.observedAtMs;
        const cap = capacity(capacityReport, repo.repoId, d.teamKey, ctx.now().getTime());
        if (!cap) return null;
        await live(parent);
        const last = await rpc(`${teamDefault}?teamId=${encodeURIComponent(teamId)}`, parent);
        const final = object(last), finalRepo = object(final?.repository);
        if (final?.status !== "ok" || final.account !== d.account || final.personId !== d.personId || final.teamId !== d.teamId || final.teamKey !== d.teamKey ||
            finalRepo?.repoId !== repo.repoId || finalRepo.status !== "active" || finalRepo.rule !== "team_default" ||
            typeof finalRepo.fullName !== "string" || finalRepo.fullName.toLowerCase() !== repository.fullName.toLowerCase() ||
            !integer(final.observedAtMs) || final.observedAtMs > ctx.now().getTime() || ctx.now().getTime() - final.observedAtMs >= 30_000) return null;
        const finalWorkflowReply = await rpc(`${workflowPath}?team=${encodeURIComponent(teamId)}`, parent);
        const finalWorkflow = observeOnboardWorkflow(finalWorkflowReply, teamId, ctx.now().getTime());
        const finalReadiness = object(object(finalWorkflowReply)?.readiness);
        if (!finalWorkflow || finalWorkflow.mappingHash !== observed.mappingHash ||
            finalWorkflow.mappingRevision !== observed.mappingRevision || finalWorkflow.readinessRevision !== observed.readinessRevision ||
            finalReadiness?.teamId !== teamId || finalReadiness.teamKey !== d.teamKey || finalReadiness.status !== "ready" ||
            finalReadiness.workflowRev !== observed.readinessRevision || !integer(finalReadiness.checkedAt) ||
            finalReadiness.checkedAt > ctx.now().getTime() || ctx.now().getTime() - finalReadiness.checkedAt >= 300_000 ||
            !firstTicketReadinessChecks(finalReadiness.checks)) return null;
        assertCurrent();
        const finalNow = ctx.now().getTime();
        if (!integer(capacityAt) || capacityAt > finalNow || finalNow - capacityAt >= 30_000 ||
            d.observedAtMs > finalNow || finalNow - d.observedAtMs >= 30_000 ||
            ready.checkedAt > finalNow || finalNow - ready.checkedAt >= 300_000 ||
            observed.checkedAt > finalNow || finalNow - observed.checkedAt >= 300_000 ||
            final.observedAtMs > finalNow || finalNow - final.observedAtMs >= 30_000) return null;
        return { binding: { account: cfg.account, person, origin, teamId, teamKey: d.teamKey, repoId: repo.repoId,
          repoName: repository.fullName, dispatchStateId, starter: "contributing-tests" },
          checkedAt: Math.min(d.observedAtMs, capacityAt, final.observedAtMs),
          expiresAt: Math.min(expiry, d.observedAtMs + 30_000, capacityAt + 30_000, final.observedAtMs + 30_000,
            ready.checkedAt + 300_000, observed.checkedAt + 300_000, finalWorkflow.checkedAt + 300_000),
          readiness: "pass", capacity: cap, defaultRepository: "active-and-exact", principal: "service", role };
      };
      const feed = async (since: number, parent: AbortSignal, headProbe = false): Promise<{ head: number; at: number; rows: unknown[] } | null> => {
        assertCurrent();
        if (!supported || parent.aborted) return null;
        const controller = new AbortController(), operationSignal = AbortSignal.any([signal, parent, controller.signal]);
        const deadline = setTimeout(() => controller.abort(), 30_000), transport = ownedFetch(ctx.fetch, operationSignal, { maxBodyBytes: 2_097_152 });
        try {
          const response = await transport.fetch(`${origin}${feedPath}?since=${since}`, { signal: operationSignal, redirect: "error", headers: { authorization: `Bearer ${bearer}`, accept: "application/x-ndjson", "cache-control": "no-cache" } });
          const rawHead = response.headers.get("x-catalyst-coordination-head-seq"), rawAt = response.headers.get("x-catalyst-server-time-ms");
          const text = await response.text(); assertCurrent();
          if (operationSignal.aborted || !rawHead || !/^\d+$/.test(rawHead) || !rawAt || !/^\d+$/.test(rawAt)) return null;
          const head = Number(rawHead), at = Number(rawAt), now = ctx.now().getTime();
          if (!integer(head) || !integer(at) || at > now || now - at >= 30_000) return null;
          if (response.status === 409 && headProbe) {
            const refusal = object(JSON.parse(text));
            return refusal?.error === "cursor_underflow" && refusal.resync === true ? { head, at, rows: [] } : null;
          }
          if (response.status !== 200 || head < since) return null;
          const lines = text === "" ? [] : text.endsWith("\n") ? text.slice(0, -1).split("\n") : null;
          if (!lines || lines.length > 1_000) return null;
          const rows: unknown[] = []; let cursor = since;
          for (const line of lines) {
            const value: unknown = JSON.parse(line), row = object(value);
            if (!row || !integer(row.seq) || row.seq !== ++cursor || row.seq > head || !object(row.attributes) || typeof row.ts !== "string" || !Number.isFinite(Date.parse(row.ts))) return null;
            rows.push(value);
          }
          return { head, at, rows };
        } finally { try { await transport.settle(); } finally { clearTimeout(deadline); } }
      };
      const first = await fresh(signal);
      if (!first) return waiting("first_ticket_readiness_unverified");
      const binding: FirstTicketBinding = Object.freeze({ ...first.binding });
      const ports: FirstTicketPorts = {
        now: () => ctx.now().getTime(), assertCurrent,
        fresh,
        readReceipt: () => {
          const value = journal.steps.find(step => step.id === "first-ticket")?.evidence?.firstTicket;
          return value === undefined ? null : typeof value === "string" ? JSON.parse(value) : value;
        },
        persist: async receipt => { assertCurrent(); if (!action || !checkpoint) throw new Error("first_ticket_checkpoint_unavailable"); checkpoint(JSON.stringify(receipt)); assertCurrent(); },
        approve: async (intent, parent) => { assertCurrent(); if (!hooks.approve) return false; const answer = await hooks.approve(intent, parent); assertCurrent(); return !parent.aborted && answer; },
        create: async (payload, parent) => { await support(parent); await live(parent); return rpc(createPath, parent, "POST", payload); },
        baseline: async parent => {
          const initial = await feed(0, parent, true); if (!initial) return null;
          const confirmed = await feed(initial.head, parent); return confirmed ? { cursor: confirmed.head, at: confirmed.at } : null;
        },
        request: async (payload, parent) => { await support(parent); await live(parent); return rpc(requestPath, parent, "POST", payload); },
        observe: async (receipt, parent) => {
          if (!receipt.ticket || !receipt.baseline) return null;
          const events: unknown[] = []; let cursor = receipt.baseline.cursor, target: number | undefined;
          for (let page = 0; page < 10; page++) {
            const next = await feed(cursor, parent); if (!next) return null;
            target ??= next.head;
            for (const event of next.rows) { const row = object(event)!; if (Number(row.seq) <= target) { events.push(event); cursor = Number(row.seq); } }
            if (cursor >= target) break;
            if (!next.rows.length || page === 9) return null;
          }
          const ticket = encodeURIComponent(receipt.ticket.identifier);
          const execution = await rpc(`/api/v1/issues/${ticket}/execution`, parent);
          const issue = await rpc(`/api/v1/issues/${ticket}`, parent);
          const fleet = await rpc("/api/v1/fleet-activity/current", parent);
          const corroborated = firstTicketCorroboration({ receipt, events, execution, issue, fleet, now: ctx.now().getTime() });
          assertCurrent();
          return { events, execution, ...corroborated };
        },
        explain: async () => null,
        sleep: async (ms, parent) => {
          if (parent.aborted) return;
          await new Promise<void>(resolve => { const done = () => { clearTimeout(wait); parent.removeEventListener("abort", done); resolve(); }; const wait = setTimeout(done, ms); parent.addEventListener("abort", done, { once: true }); if (parent.aborted) done(); });
        },
        message: text => { assertCurrent(); hooks.message?.(text); assertCurrent(); },
      };
      return await (action ? runFirstTicket : checkFirstTicket)({ binding, operationKey, ports, signal });
    } catch { return waiting(external?.aborted ? "interrupted" : "first_ticket_unavailable"); }
    finally { clearTimeout(timer); }
  };
  return { check: (ctx, journal, signal) => perform(ctx, journal, signal, false),
    act: (ctx, journal, signal, checkpoint) => perform(ctx, journal, signal, true, checkpoint) };
}
