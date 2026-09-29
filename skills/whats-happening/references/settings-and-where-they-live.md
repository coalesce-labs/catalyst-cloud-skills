# Settings

Use live values and the person's cloud prefix. Owner/admin acts unless stated. Name screen, route, rule.

| screen and route | rule |
| -- | -- |
| Integrations, /settings/connections | Connecting Linear needs admin browser session, which chooses the account. A workspace binds to exactly one account and vice versa; a conflict needs a decision, not retry. |
| Profile, /settings/profile, then Connections | The personal GitHub grant comes first; missing identity or another person's installation refusal means grant personal GitHub first. |
| Connections | Removing the App on GitHub self-heals the registry; Catalyst unlink uninstalls upstream; neither needs support. |
| Your projects, /settings/projects | Each Catalyst project pairs one Linear team with its registered GitHub repositories. Manage the project, attach repositories, and choose the team's default repository here. |
| Merging, /settings/projects/$projectId/repositories/$repoId/merging | Merge policy is changed here; contract merge gives value/source; catalyst-github only reads. |
| Code reviews, /settings/projects/$projectId/repositories/$repoId/code-reviews | Post review requests as selects a connected member. Strict policy without reviewer never earns ready label; configure reviewer or change policy. |
| Merge queue, no Catalyst page | After ready label, the merge itself is whatever the repository's own setup does with it; the repo admin owns this. This bundle cannot identify its queue vendor; never guess. |
| Repositories | Shows operator-set runner cap, default 20, paused effective zero; see what-runs-next.md. |
| Secrets /settings/secrets and Environment /settings/environment, plus repository sections | Secrets write-only, variables readable; names are never both. Repository values override account values. Variables may reference vault secrets, expanded only in container. |
| Repositories | Without a registered team nothing reaches a runner, and the failure is silent; raise admin/operator fix as ask. |
| Routing, no settings page for this | Global stage defaults and empty per-account table select default provider; never promise Codex-first. |
