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

**You ask:** "Shall I start the login now?" On a yes, run `catalyst login`. It prints a short code and a URL. The person approves it in a browser, from a phone if this machine has none. Do not offer the key form; it exists for a person who already holds a personal key and says so.

**Read back:** the `Connected to …` and `Connected as …` lines, then the script again so the machine part flips.

**Owner:** you run it; the approval is the person's, in a browser, and always will be. Do not re-run the command while a code is outstanding. If it refuses, `references/connecting-this-machine.md` names each refusal and its fix.

## 1b. Leftovers of the old local runtime

**For:** a machine set up under the old local Catalyst runtime still carries its plugin, jobs, commands or state. They are unsupported now, and left in place they can start old jobs or shadow current commands. The script notes them (`note: this machine still carries …`) from the CLI's own fixed list; current jobs are never on it.

**You ask:** once, strongly recommending it: "Shall I remove the old runtime's leftovers now? It keeps your data folders." On a yes, run `catalyst legacy --remove --yes` and read back its `removed:` and `re-checked:` lines. Then, as a separate question, offer `--data` for the data folders. On a no, move on; the note stays until they decide.

**Owner:** you run it; the yes is theirs.

## 2. A coding account

**For:** what the work runs on. Catalyst runs each stage of a ticket on an account the person owns, at their own rate, under their own name. With none enrolled, every later step can be finished and nothing will ever start.

**You ask:** "Do you already have a coding account you want Catalyst to run on?" Then `references/choosing-a-coding-account.md`: the four kinds, what each asks for, how to enrol one, and what to do with an account that is out of rotation, needs a new credential, or has ended.

**Read back:** the `coding accounts` part: an enrolled, active account, named by its label. A cancelled or ended one is kept for reporting, not used, never re-tokened, and does not hold this step up.

**Owner:** a workspace owner or admin, in a browser, on the AI accounts page. Nothing you run ever sees the credential.

## 3. Connect the Linear integration

**For:** the workspace. Until the workspace's Linear connection exists, no project can be read or mapped. Say that this is the one connection the whole workspace shares, made once by an admin.

**You hand over:** `<their cloud>/settings/connections` (the Integrations page; Settings labels it Connections today), and say: connect Linear. It sends them to Linear to authorise and brings them back.

**Read back:** after they say it is done, re-run the script and read them the `account` line. A resolved workspace is proof. If it still reads unresolved, run `catalyst contract --refresh` and read it again.

**Owner:** a workspace owner or admin, in a browser. **Browser by construction**: it is an authorization grant, and no key can perform one.

## 4. Pick one project, and map its stages

**For:** the project. A project is one Linear team plus the repositories registered to it. Until a project's stages are mapped, a card moved into it does nothing at all; this is the single most common reason a new workspace sees no activity.

**You run:** `catalyst team list` to see the teams without checking readiness. Have the person choose one team key. Then `catalyst team map <KEY>`, or `catalyst team adopt <KEY>` if they want Catalyst's stages created for them: each prints a preview; show it, and pass `--yes --plan-hash <hash>` only after they approve that exact plan. Run `catalyst team check <KEY>` only for the selected team when you need its verdict. The same steps exist on `<their cloud>/settings/linear-teams` (**Map my stages**, **Adopt the Catalyst workflow**) for a person who prefers the page.

**Read back:** re-run the script and read the `projects` line: the verdict and any failing checks by name. A project that reads `blocked` is not set up whatever its gate says; the script names the blocking checks and their owner. Three of them are Linear's own Git automation rules (in Linear: Settings → Teams → the team → Workflow → Git automation, set the named rule to No action). No Catalyst key can change those, so say so, hand it over, and afterwards run `catalyst team check <KEY>`.

For manual setup, `catalyst team checklist <KEY>` prints the same lines as the browser. If it cannot read the live stages, fix the Linear connection and retry. Moving tickets out of old stages is a separate decision: preview with `team migrate <KEY>`, review source and destination ids and counts, then confirm with `--yes --plan-hash <hash>` from that preview. Retiring emptied source stages requires a later `team migrate <KEY> --retire` preview and a separate approval using its preview hash. `team adopt <KEY> --undo` likewise previews the exact stages previously created by Adopt before asking for confirmation.

**Owner:** a workspace owner or admin, with their own login. You run the commands; the person picks the team and approves each write after seeing its preview. A run that exits 3 stopped before applying anything.

⭐ **One project at a time is safe, and lead with this.** Mapping one project changes no other project's stages and moves no other project's tickets. Encourage a pilot: the project they care least about breaking.

## 5. Install the GitHub App

**For:** the workspace's GitHub integration. Without it Catalyst can read tickets but cannot touch code.

**You hand over:** the same Connections page, and say: install the GitHub App, and grant it the repository they want worked and `<org>/thoughts`. Catalyst's cloud phases write their notes to `<org>/thoughts`, where `<org>` owns the code repository. If it does not exist, they create a private repository named `thoughts`, initialized with a README, and then on the App's installation page for that org choose All repositories, or add `thoughts` to the selected repositories. The script's `repositories` part notes whether `gh` can see that repository, never that the App can reach it, so do not claim that.

**Read back:** it is confirmed by step 6 succeeding. A repository cannot be registered through an App that is not installed. Say that is what you are waiting for.

**Owner:** a workspace owner or admin, in a browser. Browser by construction, same reason as step 3.

## 6. Register the repository

**For:** the repository. Registering, attached to a project, is what makes a repository something that project can dispatch work into.

**You hand over:** `<their cloud>/settings/repositories`, and say: add the repository, **and attach it to the project you mapped in step 4**, in the same form.

**Read back:** re-run the script and read the `repositories` line. The repository appearing there proves it was registered, and only that; see `references/reading-ready.md` for what registration does not prove.

**Owner:** a workspace owner or admin. ⛔ Registering is settings-page work today. ⛔ A repository registered without a project attached is the trap: the call succeeds, the repository is listed, and nothing can ever dispatch into it.

## 7. Connect your own accounts

**For:** the person. The integrations serve the whole workspace; a connected account is this person's own Linear or GitHub login, so that what Catalyst does for them is attributed to them, and asks assigned to them can be told apart from everyone else's.

**You run:** `catalyst connections personal linear start`. It prints a short-lived URL and tries to open it; if the browser does not open, hand them the URL. Then `catalyst connections personal linear status`. Do GitHub the same way, with `github`, only after the GitHub App is installed and the repository is registered: `catalyst connections personal github start`, then `status`.

**Read back:** each `status`, and the script's `person` part: their label and role, whether their Linear identity is matched, and each grant. A URL opening is not proof a grant landed. If Linear identity stays unmatched after consent, `catalyst identity linear status`, then `options`; the person picks their own listed identity and you run `catalyst identity linear set <linearUserId>`. An already-resolved or claimed identity, and an inactive seat, need an owner or admin.

**Owner:** you start and check; the person approves in a browser.

## 8. The repository's settings file

**For:** the repository's own settings, in `.catalyst/catalyst.toml` on its default branch: the Linear team it belongs to, the names of the variables and secrets its build needs, and its setup commands. Names leave the machine; values are entered once, by them, in the app.

**You ask:** one thing at a time. First: "Shall I draft it from your repository's own build files?" On a yes, ask where the repository is checked out on this machine; if it is not, write the file here for them to add. Then `references/declaring-a-repository.md`: the inventory, the file's shape, the pull request. Say what happens after the merge as context, not as a second task for now. After the merge, an owner or admin approves the revision on the repository's Environment page (Settings → Repositories → the repository → Environment → Setup declaration → Approve this revision) and enters the values on the same page. A workspace-wide declaration, if they want one, goes through `catalyst environment` (read, propose, `--approve`), the one setup write you can perform.

**The moment you know the checkout path** (they may name it before you ask), rerun the script with it, `node scripts/where-am-i.mjs --next --repo <path>`: a read, nothing changes, and the report gains a `repository agent setup` part with a `note:` naming the offers. Say in one clause what it found ("CLAUDE.md carries your guidance, there is no AGENTS.md, and `.claude/skills` is a real directory"), then carry on with the settings file. The Catalyst block for AGENTS.md (`catalyst repo agents-block <path> --write`) and, when the verdict is convertible, the portable layout (`--apply`) go into the same pull request as the settings file, each after its own yes; `references/repository-agent-setup.md` says how to read the report and what each write does. Skip the agent setup when `catalyst capabilities` lacks the `repo` verbs, and say the CLI is older.

**Read back:** the script's `repository declarations` part, read from each project's `environment_declared` check: no file yet, invalid, awaiting approval, or in effect, per repository. Names only, never a value. For the agent setup: the verdict line of `repo agent-setup` after the write.

**Owner:** the person, with you, in the repository; a workspace owner or admin for the approval.

## 9. Verify, then run the first ticket

**For:** the only thing that proves setup worked.

**You run:** `catalyst team check <KEY>` first when the script's next step names it (an owner or admin whose CLI has the verb), then `catalyst ready`. Its READY does not cover the coding account or the host; the script does. Read them the verdict and every failing line with its own fix and owner. If it says NOT READY, go to `references/reading-ready.md` before you touch anything.

**Then:** one question, worded like this: "Move one ticket into ENG's start stage (usually Todo) and tell me its id." Nothing else in that turn: no offer to explain the pipeline, to look at the board, or to pick one for them. Then watch. `catalyst explain <ticket>` says why it is or is not about to run. If they opted into local sync, use the optional first-event check in `references/local-sync.md`.

**Read back:** what `explain` actually said, and the first comment the agent leaves on the ticket. If `explain` says the ticket cannot start, the reason it names is the answer; use the `whats-happening` skill for what it means, then `unstick` if something is holding it.

**Owner:** the card move is theirs. The verdict is the workspace's.

## When you are done

Say what is set up, name anything still unfinished with its owner, and never say work can run while the `coding accounts` or `host` part is unfinished. Tell them they can ask "am I set up?" again at any time, and "what's happening?" goes to `whats-happening`.
