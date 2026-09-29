# Skill routing evals (CTC-2012)

One `claude plugin eval` case per skill this bundle ships (`evals/<skill>-routing/`), proving each
skill still fires on a sentence its own `description:` promises. This is the gate the ticket asked
for: nothing before it proved a skill still triggers on the phrases it advertises, and the first
live-tenant run found six defects that packing and installing the bundle could not catch.

## Running it locally

```sh
CLAUDE_CODE_WALNUT_SPIRE=1 claude plugin eval . --no-publish --runs 1
```

`CLAUDE_CODE_WALNUT_SPIRE=1` opens the `plugin eval` early-access gate on this CLI install; without
it every run stops at `plugin eval is currently in early access`. `bun run evals` (`scripts/run-evals.mjs`)
wraps the same command with the verdict logic CI uses — see "What CI actually runs" below.

## What `coverage.json` binds

Each case directory carries a `coverage.json` alongside its `prompt.md` and grader:

```json
{
  "skill": "catalyst-github",
  "invocation": "implicit",
  "exercised_phrase": "show me the PR",
  "promised_phrases": ["show me the PR", "what are the checks saying", "…"]
}
```

`test/evals-suite.test.ts` reads this file and the skill's live `SKILL.md` on every `bun run test`,
with no model and no credential, and fails — naming the skill and the phrase — when:

- the skill's description no longer contains `exercised_phrase` verbatim (a scored case sending a
  phrase the description dropped would silently stop testing anything real);
- `promised_phrases` no longer equals every phrase the live description quotes (this is the
  zero-cost widening: all ~42 phrases across eleven skills are pinned this way, not just the eleven a
  scored case actually sends);
- the case's `invocation` no longer matches the skill's own `disable-model-invocation` frontmatter;
- a skill is added to or removed from the roster (`src/cli.ts`'s `CUSTOMER_SKILLS`) without its case
  following.

This is what delivers Tier 2 today — a description edit that drops a trigger phrase fails CI by
name, deterministically, in milliseconds, whether or not an eval credential ever exists.

## Why the six explicit cases use the slash form

Six of the eleven skills (`catalyst-linear`, `catalyst-onboard`, `connect-me`, `run-this-project`,
`unstick`, `what-needs-me`) carry `disable-model-invocation: true` — a model can never route to them
on its own. Their cases send `/<skill-name> <sentence>`, the documented user-trigger for such a
skill, instead of a bare natural-language sentence a model would have to choose to route on. If the
slash form does not route to the skill under `-p`, the case fails — and that failure is the correct,
intended outcome: a skill a user cannot trigger by name is exactly the defect class this ticket
exists to catch. There is no exemption tag for these six.

## Why every grader sets `arm: both`

A `tool_used` grader on `Skill` with no explicit `arm` is with-only by default: it is dropped from
the baseline (no-plugin) arm and excluded from the score in *both* arms, unless every grader in the
case is with-only, in which case the CLI scores them normally anyway. Relying on that fallback means
the day a second grader lands on any case, the baseline arm silently stops being scored and Tier 1a's
"at least one baseline case fails without it" quietly stops being true. `arm: both` opts the grader
back into being scored explicitly, and `test/evals-suite.test.ts` asserts it on every case so this
cannot regress unnoticed.

## Cost

Every grader here is a structural `tool_used` grader — none is an `llm` grader — so the judge cost of
running this whole suite is $0. A full run is 11 cases × `runs: 3` × 2 arms = 66 short, read-only
`claude -p` sessions, each capped at `max_turns: 6` and `timeout_seconds: 300`.

## The threshold is 1.0, and that is deliberate

`scripts/run-evals.mjs` runs the suite with `--threshold 1`. With three runs per case and a single
binary routing grader, a case that scores below 1.0 routed on some runs and not on others — a
marginal description, which is this ticket's exact subject. **The fix for a flaky case is to tighten
the skill's description, not to lower this threshold.** If a future case is provably flaky for a
reason unrelated to the description (a genuine model non-determinism unrelated to routing), lowering
the threshold requires a recorded reason added to this file, reviewed like any other gate change.

## What this suite does not cover

`skill-scanner`'s five intent-analysis phases (its agent-judgment review of each script's actual
behavior, beyond the mechanical pattern scan) need a live model session with the same credential
footprint as this eval job, and produce a markdown verdict rather than a boolean CI can gate on.
Those phases are a human/agent review step, not part of this automated gate. What CI *does* run
mechanically is `scripts/scan-skills.mjs` (`bun run skills:scan`) — the deterministic half of
`skill-scanner`, over every script in `skills/`, described in that script's own `--help`.

## What CI actually runs

`scripts/run-evals.mjs` never reports a verdict without first proving the early-access gate is open
on the runner (`--precondition-only` runs the CLI's own documented self-test — `plugin eval
--no-publish` in an empty directory). Without the two secrets the eval job needs
(`ANTHROPIC_API_KEY_FOR_EVALS`, `CLAUDE_CODE_PLUGIN_EVAL_ENABLEMENT`), the job emits a loud
`::warning` naming exactly what went unproven and exits 0 — it never reports green having evaluated
nothing, and it never fails the build over a credential nobody has minted yet. The deterministic half
above (`test/evals-suite.test.ts`) runs unconditionally either way.

When the suite does run, its verdict is measured against the roster on disk, not against whatever
the result document happens to contain: `run-evals.mjs` counts the `evals/<case>/coverage.json`
directories and fails — naming the skill behind every case that was never scored — if the run
scored fewer of them than the roster holds. An empty or short case set carries no failing case, so
without that comparison "no case failed" would print as a green build; the same non-vacuity rule is
why `scripts/scan-skills.mjs` fails when the scanner read zero skill scripts.
