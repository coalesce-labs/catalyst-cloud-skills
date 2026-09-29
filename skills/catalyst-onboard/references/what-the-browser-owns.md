# What the browser owns

## Browser by construction

Each is an authorization a person grants in their own session, so no command will ever do it. Say **by construction**; a person told "not supported yet" waits for a feature that will never come.

| step | where |
| -- | -- |
| approving the login | the URL and short code `catalyst login` printed |
| enrolling a coding account, or replacing its credential | the AI accounts page the script printed |
| connecting the Linear integration, installing the GitHub App | `<their cloud>/settings/connections` (Settings → Integrations) |
| creating `<your GitHub org>/thoughts` and letting the App reach it | GitHub, then the App's installation page for that org: All repositories, or add `thoughts` (step 5 of `references/the-one-path.md`) |
| connecting personal Linear, then personal GitHub | the URL `catalyst connections personal <linear\|github> start` printed |

## Not a command yet

Their routes take a browser session, not a key. Call them gaps, route the person through the browser, and never guess at a route.

| step | where |
| -- | -- |
| registering a repository and attaching it to a project | `<their cloud>/settings/projects` (Settings → Your projects) |
| approving one repository's declaration, and entering its values | that repository's Environment page (`references/declaring-a-repository.md`) |

`catalyst environment` handles a workspace-wide declaration. ⛔ Only the CLI makes requests; if you find yourself building a URL for one of these, stop.

## The link to hand over

Use the links `node scripts/where-am-i.mjs` prints, built from the `API:` line of `catalyst status`, never a host from memory: the wrong account's settings page costs more than none.

## Handing over, and coming back

Hand over one link, one action named the way the page names it, and what you will check when they are back. Then wait, without running anything.

When they come back, read the part again (step 5 of a turn in `SKILL.md`). The contract is cached, so a page can be seconds ahead of it: refresh once before reporting a disagreement, then ask what they saw. A step is done when the instrument reads done.
