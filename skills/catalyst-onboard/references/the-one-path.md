# The one path

The steps run in the order a person can act on them, and the order says why: the coding account first, because nothing runs without one and it needs nothing else; the Linear integration, because the project list cannot be read without it; one project; the GitHub App and the repository it will work in; the person's own connected accounts, GitHub last because a registered repository is the proof the App is usable; the repository's settings file; then the first ticket. Each step is the cheapest place to catch the failure the next one would otherwise hide.

Walk them **one at a time**. Before each step say what it is for, in a sentence, and ask one question or do one thing. After it, show what actually came back. `node scripts/where-am-i.mjs --next` decides which step you are on, never your memory of the last turn. Two or three short sentences per turn is the right size.

Each step states: what it is for, what you ask or run or hand over, **what you read back to prove it landed**, and **who owns it**.

## 0. Where are we

**For:** starting from the truth instead of an assumption. A person arrives having done anything from nothing to most of it, and the installer has usually connected the machine already.

**You run:** `node scripts/where-am-i.mjs --next`. Read the one line, then say in a sentence which step is next and whose it is. Do not paste the full report.

**Owner:** you.

## 1. Connect this machine

**For:** giving this machine a credential, so every later read is the person's own. The installer normally did this; you are here only when the script says the machine is not connected.

**You run:** `catalyst-skills login`. It prints a short code and a URL. The person approves it in a browser, from a phone if this machine has none.

**Read back:** the `Connected to …` and `Connected as …` lines, then the script again so the machine part flips.

**Owner:** you run it; the approval is the person's, in a browser, and always will be. Do not re-run the command while a code is outstanding. If it refuses, stop and use the `connect-me` skill.

## 2. A coding account

**For:** what the work runs on. Catalyst runs each stage of a ticket on an account the person owns, at their own rate, under their own name. With none enrolled, every later step can be finished and nothing will ever start.

**You ask:** "Do you already have a coding account you want Catalyst to run on?" Then `references/choosing-a-coding-account.md`: the four kinds, what each asks for, how to enrol one, and what to do with an account that is out of rotation, needs a new credential, or has ended.

**Read back:** the `coding accounts` part: an enrolled, active account, named by its label. An ended or cancelled one is retired, never re-tokened, and does not hold this step up.

**Owner:** a tenant owner or admin, in a browser, on the AI accounts page. Nothing you run ever sees the credential.

## 3. Connect the Linear integration

**For:** the workspace. Until the workspace's Linear connection exists, no project can be read or mapped. Say that this is the one connection the whole workspace shares, made once by an admin.

**You hand over:** `<their cloud>/settings/connections` (the Integrations page; Settings labels it Connections today), and say: connect Linear. It sends them to Linear to authorise and brings them back.

**Read back:** after they say it is done, re-run the script and read them the `account` line. A resolved workspace is proof. If it still reads unresolved, run `catalyst-skills contract --refresh` and read it again.

**Owner:** a tenant owner or admin, in a browser. **Browser by construction**: it is an authorization grant, and no key can perform one.

## 4. Pick one project, and map its stages

**For:** the project. A project is one Linear team plus the repositories registered to it. Until a project's stages are mapped, a card moved into it does nothing at all; this is the single most common reason a new workspace sees no activity.

**You hand over:** `<their cloud>/settings/linear-teams`. They pick one team and press **Map my stages**, or **Adopt the Catalyst workflow** if they want Catalyst's stages created for them.

**Read back:** re-run the script and read the `projects` line. A project that now appears with a readiness verdict is proof it was saved. Read them the verdict and any failing checks by name.

**Owner:** a tenant owner or admin. ⛔ Listing the projects and saving a mapping are settings-page work today; a key cannot do either yet. Say that plainly; it is a gap in the product, not something they did wrong.

⭐ **One project at a time is safe, and lead with this.** Mapping one project changes no other project's stages and moves no other project's tickets. Encourage a pilot: the project they care least about breaking.

## 5. Install the GitHub App

**For:** the workspace's GitHub integration. Without it Catalyst can read tickets but cannot touch code.

**You hand over:** the same Connections page, and say: install the GitHub App, and grant it the repository they want worked and `<org>/thoughts`. Catalyst's cloud phases write their notes to `<org>/thoughts`, where `<org>` owns the code repository. If it does not exist, they create a private repository named `thoughts`, initialized with a README, and then on the App's installation page for that org choose All repositories, or add `thoughts` to the selected repositories. The script's `repositories` part notes whether `gh` can see that repository, never that the App can reach it, so do not claim that.

**Read back:** it is confirmed by step 6 succeeding. A repository cannot be registered through an App that is not installed. Say that is what you are waiting for.

**Owner:** a tenant owner or admin, in a browser. Browser by construction, same reason as step 3.

## 6. Register the repository

**For:** the repository. Registering, attached to a project, is what makes a repository something that project can dispatch work into.

**You hand over:** `<their cloud>/settings/repositories`, and say: add the repository, **and attach it to the project you mapped in step 4**, in the same form.

**Read back:** re-run the script and read the `repositories` line. The repository appearing there proves it was registered, and only that; see `references/who-fixes-what.md` for what registration does not prove.

**Owner:** a tenant owner or admin. ⛔ Registering is settings-page work today. ⛔ A repository registered without a project attached is the trap: the call succeeds, the repository is listed, and nothing can ever dispatch into it.

## 7. Connect your own accounts

**For:** the person. The integrations serve the whole workspace; a connected account is this person's own Linear or GitHub login, so that what Catalyst does for them is attributed to them, and asks assigned to them can be told apart from everyone else's.

**You run:** `catalyst-skills connections personal linear start`. It prints a short-lived URL and tries to open it; if the browser does not open, hand them the URL. Then `catalyst-skills connections personal linear status`. Do GitHub the same way, with `github`, only after the GitHub App is installed and the repository is registered: `catalyst-skills connections personal github start`, then `status`.

**Read back:** each `status`, and the script's `person` part: their label and role, whether their Linear identity is matched, and each grant. A URL opening is not proof a grant landed. If Linear identity stays unmatched after consent, `catalyst-skills identity linear status`, then `options`; the person picks their own listed identity and you run `catalyst-skills identity linear set <linearUserId>`. An already-resolved or claimed identity, and an inactive seat, need an owner or admin.

**Owner:** you start and check; the person approves in a browser.

## 8. The repository's settings file

**For:** the repository's own settings, in `.catalyst/catalyst.toml` on its default branch: the Linear team it belongs to, the names of the variables and secrets its build needs, and its setup commands. Names leave the machine; values are entered once, by them, in the app.

**You ask:** "Shall I draft it from your repository's own build files?" Then `references/declaring-a-repository.md`: the inventory, the file's shape, the pull request. After the merge, an owner or admin approves the revision on the repository's Environment page (Settings → Repositories → the repository → Environment → Setup declaration → Approve this revision) and enters the values on the same page. A workspace-wide declaration, if they want one, goes through `catalyst-skills environment` (read, propose, `--approve`), the one setup write you can perform.

**Read back:** the script's `repository declarations` part, read from each project's `environment_declared` check: no file yet, invalid, awaiting approval, or in effect, per repository. Names only, never a value.

**Owner:** the person, with you, in the repository; a tenant owner or admin for the approval.

## 9. Verify, then run the first ticket

**For:** the only thing that proves setup worked.

**You run:** `catalyst-skills ready`. Its READY does not cover the coding account or the host; the script does. Read them the verdict and every failing line with its own fix and owner. If it says NOT READY, go to `references/who-fixes-what.md` before you touch anything.

**Then:** have them move one card into the project's start stage, and watch. `catalyst-skills explain <ticket>` says why it is or is not about to run. If they opted into local sync, use the optional first-event check in `references/local-sync.md`.

**Read back:** what `explain` actually said, and the first comment the agent leaves on the ticket. If `explain` says the ticket cannot start, the reason it names is the answer; use the `how-catalyst-works` skill for what it means, then `unstick` if something is holding it.

**Owner:** the card move is theirs. The verdict is the workspace's.

## When you are done

Say what is set up, name anything still unfinished with its owner, and never say work can run while the `coding accounts` or `host` part is unfinished. Tell them the standing question "am I set up?" now belongs to the `catalyst-setup` skill, and "what's happening?" to `whats-happening`. You do not need to be invoked again.
