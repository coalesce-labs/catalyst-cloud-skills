# Settings and where they live

Live values come from the contract or a script. Prefix every route with the person's own `<their cloud>`, never an invented host. Unless a row says otherwise, an owner or admin sets it.

| what | where | the rule |
| -- | -- | -- |
| **Connecting Linear** | `<their cloud>/settings/connections` | Needs an owner or admin browser session, which also decides the account. |
| **One workspace, one account** | `<their cloud>/settings/connections` | A Linear workspace binds to exactly one account, and the reverse; a second account for the same workspace is refused. Raise it as a decision, not a retry. |
| **Installing the GitHub App** | `<their cloud>/settings/connections`, after `<their cloud>/settings/profile` | The admin's personal GitHub grant comes first: a refusal naming a missing GitHub identity or someone else's installation means "grant your personal GitHub first". |
| **Uninstalling** | `<their cloud>/settings/connections` | Removing the App on GitHub self-heals the registry; unlinking in Catalyst uninstalls upstream. Neither needs support. |
| **One team, one repository** | `<their cloud>/settings/repositories` | A Linear team maps to at most one repository per account, and a GitHub repository to at most one, case-insensitively. |
| **Neither half can be re-pointed** | `<their cloud>/settings/repositories` | A repository is one team plus one GitHub repo; the only editable field is its name, so a monorepo across two teams cannot be modelled. |
| **An archived repository holds both keys** | `<their cloud>/settings/repositories` | Re-registering the same team-plus-repo pair is refused until the archived entry is restored. |
| **Merge policy** | `<their cloud>/settings/repositories/$repoId/merging` | The effective policy and its source are on the contract's `merge` block; this page changes it (`catalyst-github` only reads it). |
| **Reviewers** | `<their cloud>/settings/repositories/$repoId/code-reviews` | "Post review requests as" names one connected member. A strict merge policy with no reviewer never earns the merge label: configure one, or change the policy. |
| **The merge queue** | no settings page; the repository's own merge automation | The merge phase's one write is the ready label; the merge itself is whatever the repository's own setup does with it. This bundle cannot see which queue runs; say so, naming no vendor the person has not named. The GitHub repository's administrator owns it. |
| **The runner cap** | `<their cloud>/settings/repositories` | 20 running phases per repository by default, which an operator changes; the page only displays it, and a paused repository resolves to zero. See `references/what-runs-next.md`. |
| **Secrets and environment variables** | `<their cloud>/settings/secrets`, `<their cloud>/settings/environment`, and each repository's sections | Secrets are write-only; variables are readable. A name is one or the other, never both; a repository value wins over an account one; a variable may reference a vault secret by name, expanded only in the container. |
| **"My secrets are not in the container"** | `<their cloud>/settings/repositories` | When a repository was registered without its team, nothing reaches a runner, and the failure is silent: a phase's build cannot find its environment. Raise the fix, an admin or operator action, as an ask. |
| **Routing** | none: there is no settings page for this | Stage defaults are global and the per-account table is empty, so routing always resolves to the default provider. A Codex-first pipeline is not something to promise (`references/what-runs-next.md`). |
