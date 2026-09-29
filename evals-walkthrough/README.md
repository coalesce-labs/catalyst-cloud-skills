# Onboarding walkthrough evals

Seven `claude plugin eval` cases, one per starting state a new member can be in, each asking `/catalyst-onboard set me up` against a stand-in CLI that answers from that state. They grade what the guide says next: the right step for the state, one question or one page, the reason in a sentence, no report of every part's status. The routing suite under `evals/` proves the skill fires; this suite proves the walk.

This is its own eval directory, not `evals/`, because its cases need Bash and a scaffold. `scripts/run-evals.mjs` and `test/evals-suite.test.ts` read `evals/` only and never see these cases.

## Starting states

| case | HOME holds | the guide should |
| -- | -- | -- |
| nothing-connected | no credential | ask to connect this machine, and nothing else |
| claude-only | one active Claude account ("Work laptop"), nothing else | say the coding account is done and hand over the Linear integration |
| api-key-only | one active Qwen account ("Qwen coding plan") | the same, never asking for the key |
| cancelled-account | a cancelled Claude account beside a healthy one | say to retire the cancelled one, never re-token it, and move to Linear |
| no-project | Linear connected, no project mapped | hand over one project to map, one at a time |
| project-no-toml | a mapped project whose default repository has no `.catalyst/catalyst.toml` | offer to draft the settings file |
| all-ready | everything finished | run `ready` and ask for one ticket to move |

`scaffold/install-state.mjs <state> --home <dir>` builds the state: a stand-in `catalyst-skills.mjs`, the customer config that points the skill's scripts at it, and a `bin/` with a `gh` that sees no thoughts repository. Each case's `fixture.sh` calls it for the run's HOME.

## Running it

Run it in a Linux sandbox, not on a laptop: every case needs Bash, which `claude plugin eval` runs under its OS sandbox (`bubblewrap` and `socat` on Linux), and a Docker credential store with a symbolic link in it makes the command refuse Bash-granting cases on macOS.

```sh
sudo apt-get install -y bubblewrap socat
sh evals-walkthrough/scaffold/install-shim.sh            # a `catalyst-skills` on PATH that runs the run's stand-in
claude plugin eval . --eval-dir evals-walkthrough --trust-plugin --scaffold \
  --allow-tools "Bash(node *)" "Bash(catalyst-skills *)" \
  --model claude-sonnet-5 --judge-model claude-haiku-4-5-20251001 \
  --no-publish --json evals-walkthrough/results/last.json
```

One state at a time: add `--case onboard-project-no-toml --runs 1 --ablation none`.

## Reading a failure

- `names-the-next-step` failed: the guide named a different step. Read the reply against `skills/catalyst-onboard/references/the-one-path.md`; the order is the product's.
- `does-not-say-the-wrong-thing` failed: it said something the state rules out, such as asking for a token from a cancelled account.
- `no-status-dump` failed: it pasted the raw report. The skill says to read the report, not paste it.
- `one-step-warmly` failed: the judge's explanation in the report names which of the five conditions broke.
- `read-the-instrument` failed: the guide answered without running `where-am-i.mjs`; the skill says the script decides where you are, never memory.
