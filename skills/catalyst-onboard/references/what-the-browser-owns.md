# What the browser owns

Some steps you cannot do, and the honest thing is to say which and why. There are two kinds, and they deserve different sentences.

## Kind one: browser by construction

These will never be a command, on any release. Each is an authorization a person grants in their own session; a credential that could perform one would defeat the point of it.

| step | where | what you say |
| -- | -- | -- |
| approving the login | the URL and short code that `catalyst-skills login` printed | "I have started the login. It printed this code and this URL — approve it in your browser, or on your phone, and tell me when it is done." |
| connecting Linear | `<their cloud>/settings/connections` | "Open this page and connect Linear. It will send you to Linear to authorize it and bring you back." |
| installing the GitHub App | `<their cloud>/settings/connections` | "Open the same page and install the GitHub App, granting it the repository you want worked." |

Say **by construction**, not "not supported yet". A person who thinks it is a missing feature will wait for it.

## Kind two: not a command yet

These are settings pages today because the routes behind them take a browser session and not a key. A key-callable path is being built. They are gaps, and you should say so in those words — but you must still route the person through the browser, and you must not guess at a route. Trying one and being refused wastes their time and teaches them the tool is unreliable.

| step | where | what you say |
| -- | -- | -- |
| seeing every project they could set up | `<their cloud>/settings/linear-teams` | "I can read the projects that are already mapped, but the full list is only on this page today. Open it and tell me the ones you see." |
| checking a project's readiness, or re-checking it | the same page | "I can read the verdict your tenant last stored, from the contract. Asking for a fresh check is on that page." |
| mapping stages, or adopting the workflow | the same page, per project | "Pick one project, then **Map my stages** — or **Adopt the Catalyst workflow** if you want Catalyst's stages created for you." |
| registering a repository | `<their cloud>/settings/repositories` | "Add the repository here, and attach it to the project you just mapped, in the same form." |
| declaring the environment **for one repository** | that repository's environment section under `<their cloud>/settings/repositories` | "The names only this repository needs go here. Values are entered once, by you — nothing I run ever sees them." (Account-wide names are **not** on this list: `catalyst-skills environment` does those.) |

⛔ **Do not compose a request for any of these.** A skill script never makes a request of its own; only the CLI does, and the CLI has no verb for them. If you find yourself constructing a URL, stop.

## The URL to hand over

Never type a host from memory. `catalyst-skills status` prints the API it is connected to on its `API:` line, and `node scripts/where-am-i.mjs` prints ready-made links built from it. Use those. A person pointed at the wrong tenant's settings page has a worse afternoon than one pointed at no page at all.

## Handing over, and coming back

The shape is always the same three parts, and all three matter:

1. **What to open.** One link, and what they will see on it.
2. **What to do there.** One action, named the way the page names it.
3. **What you need back.** Not "let me know when you are done" — say what you will check and how. "When you have saved it, say so and I will re-read your tenant and tell you what it now says."

Then **wait**. Do not run anything while they are mid-flow, do not narrate, and do not move to the next step.

When they come back:

- Re-run `node scripts/where-am-i.mjs` and read them the part that should have changed.
- If it changed, say what it now says and move on.
- If it did not, refresh the contract once (`catalyst-skills contract --refresh`) and read it again — the contract is cached, and a page can be ahead of it by a few seconds.
- If it still did not, report both: what the page told them, and what the instrument says. Ask what they saw. **Never mark a step done because the person said a page worked** — the instrument is the record, and this is exactly where a confident false "all set" costs them an hour later.
