# The one path

Ten steps, in this order. Connect the tenant's Linear workspace before starting personal Linear consent. Install the tenant's GitHub App and register its repository before starting personal GitHub consent.

Walk them **one at a time**. Before each step say what you are about to do and why; after it, show what actually came back. `node scripts/where-am-i.mjs --next` decides which step you are on — never your memory of the last turn.

Each step below states: what it is for, what you run or hand over, **what you read back to prove it landed**, and **who owns it**.


## 0 — Where are we

**For:** starting from the truth instead of from an assumption. A person arrives here having done anything from nothing to most of it.

**You run:** `node scripts/where-am-i.mjs`

**Read back:** the whole thing, as it printed. Then say in one sentence which part is unfinished and whose it is.

**Owner:** you.

## 1 — Connect this machine

**For:** giving this machine a credential, so every later read is the person's own.

**You run:** `catalyst-skills login`. It prints a short code and a URL. The person approves it in a browser — from a phone, if this machine has none.

**Read back:** the `Connected to …` and `Connected as …` lines the command printed, then `node scripts/where-am-i.mjs` again so the machine part flips.

**Owner:** you run it; **the approval is the person's, in a browser, and always will be.** Wait for them. Do not re-run the command while a code is outstanding — that invalidates the code they are typing.

If it refuses, stop here and use the `connect-me` skill; it owns every failure mode of this step.

## 2 — Who you are

**For:** the person grain. A connected machine does not mean an active seat, and an active seat does not mean their Linear identity is matched.

**You run:** it is already in the step 0 script's `person` line.

**Read back:** their label and role, and whether their Linear identity is matched.

**Owner:** a personal Linear connection normally matches the person's Linear identity automatically. If it remains unmatched after personal consent, run `catalyst-skills identity linear status`, then `catalyst-skills identity linear options`. Let the member select their own listed identity and run `catalyst-skills identity linear set <linearUserId>`. The command reads the result back. An automatically resolved identity cannot be replaced; an existing claim conflict needs a tenant owner or admin. An inactive seat also needs an owner or admin. Say which finding the instrument reported.

## 3 — Connect Linear

**For:** the account grain. Nothing about a project can be read or mapped until the tenant's Linear workspace is connected.

**You hand over:** `<their cloud>/settings/connections`, and say: connect Linear.

**Read back:** after they say it is done, re-run `node scripts/where-am-i.mjs` and read them the `account` line. A resolved workspace is proof. If it still reads unresolved, say the contract may be cached and run `catalyst-skills contract --refresh`, then read it again.

**Owner:** a tenant owner or admin, in a browser. **This is a browser step by construction** — it is an authorization grant, and no key can perform one.

## 3a — Connect your personal Linear account

**For:** giving this person's agent its own provider access. The tenant's Linear connection and GitHub App serve the tenant; they do not prove that this member has approved personal grants.

**You run:** `catalyst-skills connections personal linear start`. It gives a short-lived URL and tries to open it. The person approves in their own browser. If the browser does not open, give them the URL printed by the command. Never paste a provider token into a prompt.

**Read back:** after approval, run `catalyst-skills connections personal linear status`. `node scripts/where-am-i.mjs` also reads the personal grant statuses. A URL opening is not proof that a grant landed.

**Owner:** you start and check; the member approves in a browser. A usable personal Linear grant normally binds its viewer automatically. If identity remains unmatched, use `catalyst-skills identity linear options` for supported self-service recovery. Never choose a roster entry on the member's behalf. An already-resolved or already-claimed refusal needs an owner or admin to inspect the conflict.

## 4 — Pick one project, and map its stages

**For:** the project grain. A project is one Linear team. Until a project's stages are mapped, a card moved into it does nothing at all — this is the single most common reason a new tenant sees no activity.

**You hand over:** `<their cloud>/settings/linear-teams`. They pick one project and press **Map my stages**, or **Adopt the Catalyst workflow** if they want Catalyst's own stages created for them.

**Read back:** re-run the script and read the `projects` line. A project that now appears with a readiness verdict is proof it was saved. Read them the verdict and any failing checks by name.

**Owner:** a tenant owner or admin. ⛔ **Listing the projects and saving a mapping are settings-page work today** — a key cannot do either yet, and a key-callable path is being built. Say that plainly; it is a gap in the product, not something they did wrong.

⭐ **One project at a time is safe, and lead with this.** Mapping one project changes no other project's stages and moves no other project's tickets. Encourage a pilot: pick the project they care least about breaking.


## 5 — Install the GitHub App

**For:** the account grain again. Without it Catalyst can read tickets but cannot touch code.

**You hand over:** `<their cloud>/settings/connections`, and say: install the GitHub App, and grant it the repository they want worked.

**Read back:** it is confirmed by step 6 succeeding — a repository cannot be registered through an app that is not installed. Say that is what you are waiting for rather than claiming you verified it here.

**Owner:** a tenant owner or admin, in a browser. **Browser by construction**, same reason as step 3.


## 6 — Register the repository

**For:** the repository grain. Registering is what makes a repository something a project can dispatch work into.

**You hand over:** `<their cloud>/settings/repositories`, and say: add the repository, **and attach it to the project you mapped in step 4**.

**Read back:** re-run the script and read the `repositories` line. The repository appearing there is proof it was registered — and **only that**. It is not proof it can be dispatched to; see `references/who-fixes-what.md` for what registration does and does not prove.

**Owner:** a tenant owner or admin. ⛔ **Registering is settings-page work today**; a key-callable path is being built. ⛔ A repository registered without a project attached is the trap here: the call succeeds, the repository is listed, and nothing can ever dispatch into it. Make sure they attach the project in the same form, and say why.


## 6a — Connect your personal GitHub account

**For:** letting Catalyst act as you in GitHub. This grant is separate from the tenant's GitHub App installation.

**You run:** `catalyst-skills connections personal github start` after the GitHub App is installed and the repository is registered. The command gives a short-lived URL and tries to open it. The person approves in their own browser. If the browser does not open, give them the printed URL. Never paste a provider token into a prompt.

**Read back:** run `catalyst-skills connections personal github status`. A connected result confirms the personal grant; repository registration earlier confirmed the tenant App is available.

**Owner:** you start and check; the member approves in a browser.


## 7 — Declare what the containers need

**For:** the environment a phase runs in — the names of the variables and secrets the person's code needs. Names leave the machine; values are entered once, by them, in the app.

You can read, propose, and approve the account-wide declaration through the CLI if this member has an admin or owner seat. Personal connection initiation and status are also CLI actions; the provider approval remains in the browser.

**You run:** `catalyst-skills environment` first, to read what the tenant already declares — the current revision, whether it is approved, and which revision a phase's checkout actually carries. Those last two are different things more often than people expect: a proposal that nobody approved changes nothing.

To change it, write the declaration to a JSON file and propose it:

```sh
catalyst-skills environment propose --file declaration.json
```

Add `--approve` to approve exactly the revision that propose just returned, which is the one-command form and the one to prefer — it is a compare-and-set, and nothing gets copied between two commands by hand. `catalyst-skills environment approve` on its own reads the current revision and approves that.

**Read back:** the revision and hash the command printed, and whether it says the declaration is now what a phase's checkout carries. If it prints `referenced but not set on this tenant yet`, read those names out: the declaration names them and the tenant has no value for them, so a phase that needs one will fail on it until someone adds it in the app.

**Owner:** you can read it from any active seat; proposing and approving need an admin or owner seat, and the cloud refuses with that sentence if the person does not have one — read the refusal to them rather than retrying.

⛔ **Values never pass through you.** The declaration carries the *names* a build needs. The values are entered by the person, once, in the app, and nothing you run ever sees them. Say that plainly; a person asked for a secret by an agent is right to be suspicious.

⛔ **Repository scope is still a page.** Anything only one repository needs lives in that repository's environment section under `<their cloud>/settings/repositories`, and the route behind it takes a browser session, not a key. Account scope is the half that is a command.

If they do not know what their build needs yet, skip this step. It blocks nothing until a phase needs a secret.


## 8 — Verify, then run the first ticket

**For:** the only thing that proves setup worked.

**You run:** `catalyst-skills ready`. Read them the verdict and every failing line, each with its own fix and owner. If it says NOT READY, go to `references/who-fixes-what.md` before you touch anything — a project check failing is not something re-running anything on this machine can fix.

**Then:** have them move one card into the project's dispatch stage, and watch. `catalyst-skills explain <ticket>` says why it is or is not about to run.

**Read back:** what `explain` actually said. If it says the ticket cannot start, the reason it names is the answer — read it to them and use the `how-catalyst-works` skill for what the reason means, then `unstick` if something is holding it.

**Owner:** the card move is theirs. The verdict is the tenant's.


## When you are done

Say what is set up, name anything still unfinished with its owner, and tell them the standing question "am I set up?" now belongs to the `catalyst-setup` skill, and "what's happening?" to `whats-happening`. You do not need to be invoked again.
