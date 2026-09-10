// fixture.ts — an in-process fixture cloud: /api/v1/me as before, plus the contract route (ETag, 304,
// 403 for a workstation key), the read routes the verbs use, and every POST agent route the fixture
// contract's route table names, recorded into `writes[]`. `requests[]` records every request so a test
// can assert a header was sent; `budgetExhausted` turns the agent POSTs into 429s naming the budget.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { TenantContract } from "../src/contract-types";
import { buildFixtureContract, FIXTURE_ACCOUNT } from "./fixture-contract";

export const FIXTURE_ME_BODY = {
  account: FIXTURE_ACCOUNT,
  slug: "hagale-technologies",
  name: "Hagale Technologies",
  permissions: ["mirror:read", "mirror:feed"],
  principal: "service",
} as const;

export const FIXTURE_KEY = "fixture-key";
export const FIXTURE_USER_KEY = "fixture-user-key";
export const FIXTURE_ETAG = '"fixture-etag-1"';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface FixtureServer {
  url: string;
  port: number;
  close: () => Promise<void>;
  contract: TenantContract;
  contractVersion: string;
  headCursor: number;
  budgetExhausted: boolean;
  writes: RecordedRequest[];
  requests: RecordedRequest[];
  /** Override the issue list the read routes serve. */
  issues: Record<string, unknown>[];
}

// ── the tenant's data ─────────────────────────────────────────────────────────────────────────────

function issue(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `lin-${String(over.identifier).toLowerCase()}`,
    title: `Title of ${over.identifier}`,
    state: "Todo",
    assignee: null,
    assignee_id: null,
    assignee_name: null,
    assignee_avatar_url: null,
    priority: 3,
    estimate: null,
    project_id: null,
    cycle_id: null,
    team_id: "team-eng",
    sort_order: null,
    updated_at: 1_756_100_000_000,
    labels: [],
    relations: [],
    ...over,
  };
}

export function fixtureIssues(): Record<string, unknown>[] {
  return [
    issue({ identifier: "ENG-1", priority: 2, project_id: "proj-a" }),
    issue({ identifier: "ENG-2", state: "In Progress", priority: 1, project_id: "proj-a" }),
    issue({ identifier: "ENG-3", priority: 4 }),
    issue({
      identifier: "ENG-7",
      title: "Should we ship the widget now or after the audit?",
      labels: [{ id: "label-ask-unscoped", name: "catalyst-ask", color: null }],
      relations: [
        { type: "blocks", issue_identifier: "ENG-7", related_identifier: "ENG-1" },
        { type: "blocks", issue_identifier: "ENG-7", related_identifier: "ENG-2" },
      ],
    }),
    issue({
      identifier: "ENG-8",
      title: "Which region?",
      labels: [{ id: "label-ask-unscoped", name: "catalyst-ask", color: null }],
      relations: [{ type: "blocks", issue_identifier: "ENG-8", related_identifier: "ENG-3" }],
    }),
    issue({
      identifier: "ENG-9",
      title: "Old decision",
      state: "Done",
      labels: [{ id: "label-ask-unscoped", name: "catalyst-ask", color: null }],
      relations: [{ type: "blocks", issue_identifier: "ENG-9", related_identifier: "ENG-1" }],
    }),
    issue({ identifier: "OPS-1", team_id: "team-ops", project_id: "proj-b" }),
  ];
}

function issueDetail(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    description: `Description of ${row.identifier}`,
    project_name: row.project_id ? `Project ${row.project_id}` : null,
    project_state: row.project_id ? "started" : null,
    project_description: null,
    project_progress: null,
    project_health: null,
    cycle_number: null,
    cycle_starts_at: null,
    cycle_ends_at: null,
    delegate_id: null,
    delegate_name: null,
    delegate_avatar_url: null,
    bot_actor_name: null,
    bot_actor_type: null,
    bot_actor_sub_type: null,
    parent_id: null,
    parent_identifier: null,
    started_at: null,
    completed_at: null,
    canceled_at: null,
    created_at: 1_756_000_000_000,
    due_date: null,
    priority_label: null,
    url: `https://linear.app/hagale/issue/${row.identifier}`,
    comments: [
      { id: `c-${row.identifier}-1`, body: "first comment", author_id: "u-1", author_name: "Ana", author_avatar_url: null, is_bot: 0, parent_id: null, updated_at: 1_756_100_000_000 },
    ],
    activity: [],
    linked_pulls: row.identifier === "ENG-2" ? [{ repo_id: "repo-api", number: 41, node_id: "PR_kwDOfixture41" }] : [],
    agent_sessions: [],
  };
}

const PULLS: Record<string, unknown>[] = [
  {
    repo_id: "repo-api",
    number: 41,
    node_id: "PR_kwDOfixture41",
    title: "ENG-2: implement the thing",
    body: "",
    author_login: "catalyst[bot]",
    author_avatar_url: null,
    state: "open",
    draft: 0,
    merged: 0,
    merged_at: null,
    head_sha: "abc123",
    base_ref: "main",
    mergeable: 1,
    mergeable_state: "clean",
    auto_merge: null,
    created_at: 1_756_000_000_000,
    closed_at: null,
    comment_count: 1,
    milestone_title: null,
    updated_at: 1_756_100_000_000,
    linear_issue_identifier: "ENG-2",
    checks: [{ name: "Check", status: "completed", conclusion: "success" }],
  },
];

const WORKFLOW_STAGES = {
  teams: [
    {
      teamId: "team-eng",
      key: "ENG",
      states: [
        { id: "state-backlog-eng", name: "Backlog", type: "backlog", position: 0 },
        { id: "state-todo", name: "Todo", type: "unstarted", position: 1 },
        { id: "state-intake", name: "Intake", type: "unstarted", position: 2 },
        { id: "state-research", name: "Research", type: "started", position: 3 },
        { id: "state-plan", name: "Plan", type: "started", position: 4 },
        { id: "state-implement", name: "In Progress", type: "started", position: 5 },
        { id: "state-remediate", name: "Remediate", type: "started", position: 6 },
        { id: "state-verify", name: "Validate", type: "started", position: 7 },
        { id: "state-pr-x7", name: "In Review", type: "started", position: 8 },
        { id: "state-done", name: "Done", type: "completed", position: 9 },
        { id: "state-canceled", name: "Canceled", type: "canceled", position: 10 },
      ],
    },
    {
      teamId: "team-ops",
      key: "OPS",
      states: [
        { id: "state-backlog-ops", name: "Backlog", type: "backlog", position: 0 },
        { id: "state-ops-todo", name: "Todo", type: "unstarted", position: 1 },
        { id: "state-ops-done", name: "Done", type: "completed", position: 2 },
      ],
    },
  ],
};

const ELIGIBILITY = {
  team: "ENG",
  nowMs: 1_756_100_000_000,
  eligibility: {
    rows: [
      { position: 1, ticket: "ENG-1", status: "offered", phase: "research", advisories: [], failure: null },
      {
        position: 2,
        ticket: "ENG-2",
        status: "excluded",
        reason: "retry_backoff",
        advisories: ["human_addressed_unlabeled_ask_suspect"],
        failure: { phase: "implement", class: "vendor_5xx", attempts: 2, lastFailedAt: 1_756_099_000_000 },
      },
      { position: 3, ticket: "ENG-3", status: "excluded", reason: "frobnicate_pending", advisories: [], failure: null },
    ],
  },
};

const DISPATCH_QUEUE = { team: "ENG", source: "self-derived", rows: [{ position: 1, ticket: "ENG-1", phase: "research" }] };
const FLEET_ACTIVITY = { rows: [{ ticket: "ENG-2", phase: "implement", host: "runner-7", state: "running" }] };
const AGENT_ROSTER = { roster: [{ role: "concierge", session: "sess-1" }] };
const LEASES = { attributions: [{ ticket: "ENG-2", phase: "implement", holder: "runner-7" }] };

// ── the server ───────────────────────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (d) => (raw += String(d)));
    req.on("end", () => resolve(raw));
  });
}

const MACHINE_ONLY = new Set(["/api/v1/agent/contract", "/api/v1/work-eligibility", "/api/v1/lease/attributions"]);

export async function startMeFixture(
  handler?: (path: string) => { status: number; body: unknown },
): Promise<FixtureServer> {
  const state: FixtureServer = {
    url: "",
    port: 0,
    close: async () => {},
    contract: buildFixtureContract(),
    contractVersion: "1.0.0",
    headCursor: 10,
    budgetExhausted: false,
    writes: [],
    requests: [],
    issues: fixtureIssues(),
  };
  const postRoutes = () => new Set(state.contract.routes.filter((r) => r.method === "POST").map((r) => r.path));

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const auth = req.headers.authorization ?? null;
    const rawBody = req.method === "POST" ? await readBody(req) : "";
    let body: unknown = undefined;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    state.requests.push({ method: req.method ?? "GET", path: req.url ?? "/", headers: req.headers, body });
    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    };

    if (path.startsWith("/api/v1/me")) {
      const out =
        handler?.(req.url ?? path) ??
        (auth === `Bearer ${FIXTURE_KEY}`
          ? { status: 200, body: FIXTURE_ME_BODY }
          : auth === `Bearer ${FIXTURE_USER_KEY}`
            ? { status: 200, body: { ...FIXTURE_ME_BODY, permissions: ["mirror:read"] } }
            : { status: 401, body: { error: "unauthorized", reason: "credential-not-accepted" } });
      return send(out.status, out.body);
    }
    if (auth !== `Bearer ${FIXTURE_KEY}` && auth !== `Bearer ${FIXTURE_USER_KEY}`) {
      return send(401, { error: "unauthorized", reason: "credential-not-accepted" });
    }
    const machine = auth === `Bearer ${FIXTURE_KEY}`;
    if ((MACHINE_ONLY.has(path) || postRoutes().has(path)) && !machine) {
      return send(403, { error: "forbidden", reason: "machine-principal-required" });
    }

    if (path === "/api/v1/agent/contract") {
      const etag = FIXTURE_ETAG.replace("1", state.contractVersion === "1.0.0" ? "1" : "2");
      if (req.headers["if-none-match"] === etag) {
        return send(304, undefined, { etag, "x-catalyst-contract-version": state.contractVersion });
      }
      return send(
        200,
        { ...state.contract, contractVersion: state.contractVersion },
        { etag, "x-catalyst-contract-version": state.contractVersion, "cache-control": "private, no-cache" },
      );
    }
    if (path === "/api/v1/snapshot") {
      if (url.searchParams.get("head") === "1") return send(200, { accountId: FIXTURE_ACCOUNT, cursor: state.headCursor });
      if (url.searchParams.get("account") !== FIXTURE_ACCOUNT) return send(403, { error: "account-mismatch" });
      // The full seed: NDJSON rows, then the cursor line; the head headers ride the response.
      const lines = state.issues
        .slice(0, 2)
        .map((row) => JSON.stringify({ entity: "issues", op: "upsert", row: { id: row.id, identifier: row.identifier, title: row.title, state: row.state, team_id: row.team_id, updated_at: row.updated_at } }));
      lines.push(JSON.stringify({ cursor: state.headCursor }));
      res.writeHead(200, { "content-type": "application/x-ndjson", "x-catalyst-head-seq": String(state.headCursor), "x-catalyst-server-time-ms": String(Date.now()) });
      return res.end(`${lines.join("\n")}\n`);
    }
    if (path === "/api/v1/freshness") {
      return send(200, { account: FIXTURE_ACCOUNT, last_reconcile_ms: 1_756_100_000_000, has_error: false, unproven_legs: [], server_time_ms: Date.now() });
    }
    if (path === "/api/v1/issues") {
      let rows = state.issues;
      const team = url.searchParams.get("team");
      const project = url.searchParams.get("project");
      if (team) rows = rows.filter((r) => String(r.identifier).startsWith(`${team}-`));
      if (project) rows = rows.filter((r) => r.project_id === project);
      return send(200, { rows, total: rows.length }, { "x-mirror-total": String(rows.length) });
    }
    const issueMatch = /^\/api\/v1\/issues\/([^/]+)$/.exec(path);
    if (issueMatch) {
      const ref = decodeURIComponent(issueMatch[1]!);
      const row = state.issues.find((r) => r.identifier === ref || r.id === ref);
      return row ? send(200, issueDetail(row)) : send(404, { error: "not found" });
    }
    if (path === "/api/v1/pulls") {
      const ticket = url.searchParams.get("ticket");
      return send(200, { rows: ticket ? PULLS.filter((p) => p.linear_issue_identifier === ticket) : PULLS });
    }
    const pullMatch = /^\/api\/v1\/pulls\/([^/]+)$/.exec(path);
    if (pullMatch) {
      const pr = PULLS.find((p) => p.node_id === decodeURIComponent(pullMatch[1]!));
      return pr
        ? send(200, { ...pr, reviews: [{ review_id: "r1", reviewer_name: "reviewer-bot[bot]", reviewer_avatar_url: null, state: "APPROVED", submitted_at: 1_756_100_000_000 }], commit_statuses: [], blocked_on_ask: null })
        : send(404, { error: "not found" });
    }
    if (path === "/api/v1/projects") {
      return send(200, { rows: [{ id: "proj-a", name: "Project A", state: "started", updated_at: 1, initiatives: [] }, { id: "proj-b", name: "Project B", state: "planned", updated_at: 1, initiatives: [] }] });
    }
    if (path === "/api/v1/cycles") return send(200, { rows: [{ id: "cyc-1", number: 12, name: "Cycle 12", starts_at: "2026-09-01", ends_at: "2026-09-14" }] });
    if (path === "/api/v1/search") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      return send(200, { rows: state.issues.filter((r) => String(r.title).toLowerCase().includes(q)).map((r) => ({ kind: "issue", identifier: r.identifier, title: r.title })) });
    }
    if (path === "/api/v1/changes") {
      const since = Number(url.searchParams.get("since") ?? "0");
      return send(200, { since, head: state.headCursor, changes: since < state.headCursor ? [{ seq: since + 1, entity: "issues", entityId: "lin-eng-1", op: "upsert" }] : [] });
    }
    if (path === "/api/v1/workflow-stages") return send(200, WORKFLOW_STAGES);
    if (path === "/api/v1/work-eligibility") {
      if (!url.searchParams.get("team")) return send(400, { error: "team is required" });
      return send(200, { ...ELIGIBILITY, team: url.searchParams.get("team"), capabilities: url.searchParams.get("capabilities") });
    }
    if (path === "/api/v1/dispatch-queue/current") return send(200, DISPATCH_QUEUE);
    if (path === "/api/v1/fleet-activity/current") return send(200, FLEET_ACTIVITY);
    if (path === "/api/v1/agent-roster/current") return send(200, AGENT_ROSTER);
    if (path === "/api/v1/lease/attributions") return send(200, LEASES);

    if (req.method === "POST" && postRoutes().has(path)) {
      if (state.budgetExhausted) {
        return send(429, { error: "write-budget-exhausted", reason: "the per-host daily write budget is exhausted" }, { "retry-after": "3600" });
      }
      state.writes.push({ method: "POST", path, headers: req.headers, body });
      const name = path.split("/").at(-1);
      const id = `lin-${name}-${state.writes.length}`;
      if (name === "ask") return send(200, { id, identifier: `ENG-${100 + state.writes.length}` });
      if (name === "issue-create") return send(200, { id, identifier: `ENG-${200 + state.writes.length}` });
      return send(200, { id, ok: true });
    }
    return send(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture server has no port");
  state.port = address.port;
  state.url = `http://127.0.0.1:${address.port}`;
  state.close = () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return state;
}
