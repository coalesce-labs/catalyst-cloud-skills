# Onboarding walkthrough evals

Eight `claude plugin eval` cases, one per starting state a new member can be in, each asking `/catalyst-onboard set me up` against a stand-in CLI that answers from that state. They grade what the guide says next: the right step for the state, one question or one page, the reason in a sentence, no report of every part's status. The routing suite under `evals/` proves the skill fires; this suite proves the walk.

This is its own eval directory, not `evals/`, because its cases need Bash and a scaffold. `scripts/run-evals.mjs` and `test/evals-suite.test.ts` read `evals/` only and never see these cases.

## Starting states

| case | HOME holds | the guide should |
| -- | -- | -- |
| nothing-connected | no credential | ask to connect this machine, and nothing else |
| claude-only | one active Claude account ("Work laptop"), nothing else | say the coding account is done and hand over the Linear integration |
| api-key-only | one active Qwen account ("Qwen coding plan") | the same, never asking for the key |
| cancelled-account | a cancelled Claude account beside a healthy one | say in one clause that the cancelled one is kept for reporting and not used, never retire or re-token it, and move to Linear |
| no-project | Linear connected, no project mapped | hand over one project to map, one at a time |
| project-unchecked | a mapped project never re-checked, an owner whose CLI has `team check` | run `team check ENG` itself and report what it found, never send them to the Re-check button |
| project-no-toml | a mapped project whose default repository has no `.catalyst/catalyst.toml` | offer to draft the settings file |
| all-ready | everything finished | run `ready` and ask for one ticket to move |

`scaffold/install-state.mjs <state> --home <dir>` builds the state: a stand-in `catalyst.mjs`, the customer config that points the skill's scripts at it, and a `bin/` with a `gh` that sees no thoughts repository. Each case's `fixture.sh` calls it for the run's HOME.

## Running it

Run it in a Linux sandbox, not on a laptop: every case needs Bash, which `claude plugin eval` runs under its OS sandbox (`bubblewrap` and `socat` on Linux), and a Docker credential store with a symbolic link in it makes the command refuse Bash-granting cases on macOS.

```sh
sudo apt-get install -y bubblewrap socat
mkdir -p ~/eval/bin && sh evals-walkthrough/scaffold/install-shim.sh ~/eval/bin/catalyst   # a PATH prefix under your home; a /tmp prefix breaks nested node spawns on macOS
export PATH=$HOME/eval/bin:$PATH
claude plugin eval . --eval-dir evals-walkthrough --trust-plugin --scaffold \
  --allow-tools "Bash(node *)" "Bash(catalyst *)" \
  --model claude-sonnet-5 --judge-model claude-haiku-4-5-20251001 \
  --no-publish --json evals-walkthrough/results/last.json
```

One state at a time: add `--case onboard-project-no-toml --runs 1 --ablation none`.

## Reading a failure

- `names-the-next-step` failed: the guide named a different step. Read the reply against `skills/catalyst-onboard/references/the-one-path.md`; the order is the product's.
- `does-not-say-the-wrong-thing` failed: it said something the state rules out, such as asking for a token from a cancelled account.
- `no-status-dump` failed: it pasted the raw report. The skill says to read the report, not paste it.
- `one-step-warmly` failed: the judge's explanation in the report names which of the five conditions broke.
- `does-not-say-the-old-name` failed: the reply said `catalyst-skills`. The CLI names itself `catalyst` now; the guide, the script's printed commands and the capabilities output all use that name, and the stand-in keeps a `catalyst-skills` alias on PATH only so such a reply runs to completion and is graded here instead of dying on command-not-found.
- `read-the-instrument` failed: the guide answered without running `where-am-i.mjs`; the skill says the script decides where you are, never memory. This grader is also the proof the skill ran: a `/catalyst-onboard` prompt is expanded as the user turn, so no `Skill` tool call appears in the trace to grade on.

## Last run

2026-09-29 04:20Z on mini-2, after the CLI rename, `--model claude-sonnet-5 --judge-model claude-sonnet-5 --threshold 0.8`, 1 run per arm, $1.44, 134 s. 7 of 8 cases passed; mean score 0.90; mean delta over the no-plugin baseline +0.41. The new `does-not-say-the-old-name` grader passed on all 8 with-plugin runs: no reply said `catalyst-skills`. The miss was project-unchecked: the guide asked "can you run that, or would you like me to run it?" instead of running `catalyst team check ENG`, because the script's next-step owner read "you, with your own login" and the model took "you" for the person. The owner line now says the assistant runs it without asking, and the skill's turn rule says the same for any `do:` line; three reruns of that case afterwards ($0.34) all ran `team check ENG` themselves and scored 0.86. The `one-step-warmly` judge remains the noisy grader (it dislikes an opening recap sentence), so the pass bar is 0.8, not 1.0.

| case | score | delta |
| -- | -- | -- |
| onboard-all-ready | 0.83 | +0.33 |
| onboard-api-key-only | 1.00 | +0.50 |
| onboard-cancelled-account | 1.00 | +0.50 |
| onboard-claude-only | 1.00 | +0.50 |
| onboard-no-project | 0.83 | +0.33 |
| onboard-nothing-connected | 0.83 | +0.33 |
| onboard-project-no-toml | 1.00 | +0.50 |
| onboard-project-unchecked | 0.71, then 0.86 ×3 after the owner-line fix | +0.29 |
