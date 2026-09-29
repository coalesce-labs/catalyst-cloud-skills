# The one path

The steps run in the order a person can act on them, each the cheapest place to catch what the next would hide. The script prints each step's owner and link; this page adds why it matters, what to ask, and its trap. Browser handovers follow `references/what-the-browser-owns.md`.

## 0. Where are we

Run `node scripts/where-am-i.mjs --next` and say which step is next and whose it is.

## 1. Connect this machine

Only when the script says the machine is not connected: ask "Shall I start the login now?", then follow `references/connecting-this-machine.md`.

## 1b. Leftovers of the old local runtime

Only when the script notes them (from the CLI's fixed list; current jobs are never on it); left in place they can start old jobs or shadow current commands. Ask once, recommending it: "Shall I remove the old runtime's leftovers now? It keeps your data folders." On a yes, run `catalyst legacy --remove --yes` and read back its `removed:` and `re-checked:` lines; offer `--data` separately. On a no, the note stays.

## 2. A coding account

Each stage of a ticket runs on an account the person owns, at their own rate, under their own name; with none, nothing ever starts. It needs nothing else, so it comes first. Ask "Do you already have a coding account you want Catalyst to run on?", then follow `references/what-a-phase-needs.md`.

## 3. Connect the Linear integration

The one Linear connection the whole workspace shares, made once by an owner or admin on `<their cloud>/settings/connections`; no project can be read without it.

## 4. Pick one project, and map its stages

A card moved into an unmapped project does nothing, the most common reason a new workspace sees no activity. Lead with the pilot: one project changes no other (`references/reading-ready.md`, "Setting up one team at a time", which also says Map or Adopt).

`catalyst team list` shows the teams without checking readiness; the person picks one key. `catalyst team map <KEY>` or `catalyst team adopt <KEY>` prints a preview to approve before `--yes --plan-hash <hash>` (exit 3 applied nothing). Run `catalyst team check <KEY>` only for the selected team. `team migrate <KEY>`, its `--retire`, and `team adopt <KEY> --undo` each preview and need their own approval. `catalyst capabilities` says which verbs this cloud serves.

A `blocked` project is not set up. Change Linear's own Git automation rules in Linear for now (Settings → Teams → the team → Workflow → Workflows & automations → Pull request and commit automations → No action); hand that over, then re-check.

## 5. Install the GitHub App

Without it Catalyst cannot touch code. On the same page, the owner or admin installs the App and grants it the repository plus `<org>/thoughts`, where cloud phases write their notes (`<org>` owns the code repository). If it does not exist, they create a private repository named `thoughts`, initialized with a README, then on the App's installation page for that org choose All repositories or add `thoughts`. The script notes whether `gh` can see that repository, never that the App can reach it. Step 6 succeeding is the proof the App is installed.

## 6. Register the repository

On `<their cloud>/settings/projects`, add the repository **and attach it to the project from step 4** in the same form. A repository registered without a project is listed and never receives work.

## 7. Connect your own accounts

The person's own logins, so work done for them is attributed to them and their asks can be told apart. Run `catalyst connections personal linear start` (hand over the URL if no browser opens), then `catalyst connections personal linear status`. Do GitHub the same way, only after the GitHub App is installed and the repository is registered. An unmatched Linear identity is in `references/connecting-this-machine.md`.

## 8. The repository's settings file

Ask "Shall I draft it from your repository's own build files?", then follow `references/declaring-a-repository.md`. Mention the approval after the merge as context, not a second task. A workspace-wide declaration goes through `catalyst environment` (read, propose, `--approve`).

Once you know the checkout path, rerun `node scripts/where-am-i.mjs --next --repo <path>` (a read) and follow `references/repository-agent-setup.md` for the offers it notes.

## 9. Verify, then run the first ticket

Run `catalyst ready`; READY covers neither the coding account nor the host, which the script reads. On NOT READY, read `references/reading-ready.md` before touching anything.

Then ask one thing: "Move one ticket into ENG's start stage (usually Todo) and tell me its id." Nothing else that turn. `catalyst explain <ticket>` says why it is or is not about to run, and the agent's first comment on the ticket confirms it started. With local sync on, use the optional first-event check in `references/local-sync.md`. A reason it cannot start goes to the `whats-happening` skill, then `unstick`.

## When you are done

Say what is set up and name anything unfinished with its owner; work can run only when the `coding accounts` and `host` parts are finished.
