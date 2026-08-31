---
name: catalyst-onboarding
description: Walk a Catalyst Cloud tenant from invite email to first merged ticket — connect Linear and GitHub, set up team stages and mapping, register repositories, configure merge policy and Mergify, connect coding accounts. Idempotent — detects finished steps and skips them. Use when the user says "set up Catalyst", "onboard me to Catalyst Cloud", pastes a Catalyst invite prompt, or wants to add another team or repository to an existing tenant.
---

# Catalyst Cloud onboarding

You are helping a human finish (or extend) their Catalyst Cloud tenant setup. The whole flow is
**resumable and idempotent**: before doing anything, detect what's already done and say so — never
redo a completed step, never assume a fresh start.

Base URL: `https://staging.catalystcloud.dev` (ask the user if their invite names a different host).
The human does every browser step themselves — your job is precise direction, verification after
each step, and diagnosis when something looks wrong. You never need their password.

## Phase 0 — Detect current state

Ask the user to sign in and read you their Settings → Connections state, or have them screenshot
it. Determine: Linear connected? GitHub installed? Any repository registered? Any team Ready?
Announce the plan as "already done: X, Y — remaining: Z" and only execute the remaining phases.

**Prior-install cleanup (only if they used Catalyst before):** old app authorizations make
"Connect" flows dead-end at "already connected". Have them revoke Catalyst apps in Linear
(Settings → Applications) and uninstall the Catalyst GitHub App from their org BEFORE reconnecting.

## Phase 1 — Account & sign-in

- Invite email → Accept → create password → they land signed in.
- **Password-manager trap:** managers often save the credential under an `authkit` domain entry.
  If a later sign-in rejects a "correct" password, check the manager for an AuthKit entry and have
  them rename it to `catalystcloud.dev`.
- If sign-in fails twice: `/login` → "Forgot password?" → branded reset email → new password.

## Phase 2 — Connect Linear (two grants, not one)

1. **Workspace app install**: Connect Linear → make sure they're in the RIGHT workspace (the
   picker defaults to the last-used one). **Private teams must be ticked manually** in Linear's
   grant screen — and any private team created later must be re-granted the same way. Granting all
   teams is safe: Catalyst only works in teams explicitly chosen later.
2. **Personal grant** (act-as-them): offered during team setup. This is what lets Catalyst create
   workflow stages and account-level labels as them. Both grants are needed; "already connected"
   after only the first is expected, not done.

After connecting: the team list fills from a mirror backfill (seconds to ~2 min). An empty picker
right after OAuth means *wait and refresh*, not broken.

## Phase 3 — Team setup (stages + mapping)

Pick ONE team to start ("you can add the rest later from Settings → Linear teams").

The blessed stage set (create-only — existing stages and in-flight work are never touched):

| Stage | Linear state type |
| -- | -- |
| Triage | triage (Linear creates it when Triage is enabled — cannot be created by API) |
| Backlog | backlog |
| Todo, Research | unstarted |
| Plan, Implement, Remediate, Validate, PR | started |
| Done | completed |
| Canceled | canceled |

Flow: team card → **Adopt the recommended stages** (creates only what's missing, under their
personal grant) → **Map my stages** → review the proposed slot→stage rows → **Save** → **Re-check**.
Ready = done. Two lines legitimately stay pending until first use: Labels (created on first use)
and Fleet mapping (confirmed when the first runner picks up work).

Fallbacks that have been needed in the field:
- Adoption reports "already there" while stages are missing → have them create the missing stages
  by hand in Linear (team settings → Workflow), names and types EXACTLY as the table, then Re-check.
- A setup **ask ticket** may appear in their team (and in the app's Waiting-on-me). Answers must be
  a bare option letter (`A`), the option text verbatim, or `DECIDED: <text>` — or a tap in the app.
- Old stages with WIP: leave them. "Migrate stages" (appears once the mapping is saved) sweeps
  old-stage tickets into the new ladder later, with a preview.

## Phase 4 — GitHub App + repository

1. Install the Catalyst GitHub App on their org (needs org owner/admin). All-repositories is fine.
2. Register a repository: it pairs ONE GitHub repo with ONE Linear team — **the pairing is
   permanent** (archive-and-re-add to change). Pair with the team from Phase 3.
3. Mirroring starts within seconds; the reconcile sweep catches anything missed within ~5 min.

## Phase 5 — Merge policy + Mergify

1. If the repo has no Codex-style automated reviewer: repo → Configure environment → add
   `CATALYST_MERGE_EVIDENCE_POLICY` = `checks-and-threads` (green checks + zero unresolved review
   threads become the merge bar; both stay mandatory, fail-closed).
2. Mergify: install the app, activate the merge queue on the repo, turn OFF "require branches up
   to date" (strict mode silently caps the queue at 1), keep required checks, commit the
   `.mergify.yml` from Catalyst's mergify onboarding guide with `check-success` set to their CI
   check's exact name, then live-probe with `@Mergifyio queue` on any PR — config errors are
   silent until an explicit queue command.

Catalyst enters PRs by applying `queue:ready` when a PR is genuinely done.

## Phase 6 — Coding account

Settings → Coding accounts → connect **Claude** (browser OAuth; mints a durable ~12-month token).
Honest scope: Claude-only in the UI today; other providers are coming. Until their account is
connected, runs use the platform's pooled accounts.

## Phase 7 — Skip what isn't needed

- **Worker key: skip.** Cloud runners authenticate with the platform's own key. A worker key only
  matters for browser-less local access (host replica, SDK). "This account doesn't need a worker
  key" completes the wizard.

## Phase 8 — First ticket

Write one small real ticket in the team; moving it to **Todo** is the go signal. The cloud claims
it and walks Research → Plan → Implement → Validate → PR. If it needs the human, it files an ask
ticket, blocks itself on it, and frees its worker — their queue is **Waiting on me**. Done =
a Catalyst-authored PR goes green, gets `queue:ready`, and Mergify merges it.

## Verification discipline

After every phase, verify from an independent surface before moving on (Connections page state, the
team card's check list, an arriving email, a Mergify status comment). Never declare a phase done on
the strength of having clicked the button.
