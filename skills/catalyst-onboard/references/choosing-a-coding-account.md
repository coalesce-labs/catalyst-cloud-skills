# Choosing a coding account

A coding account is the AI provider login the work runs on. It is the first thing to settle, because nothing else in setup produces any work without one, and because it needs nothing else in setup to be done. Read the part with `node scripts/where-am-i.mjs`; it says whether one is enrolled, whether each enrolled one can still take work, and who may enrol one.

## The first question

Ask it plainly: "Do you already have a coding account you want Catalyst to run on?" Then wait.

Say why in one line: Catalyst runs each stage of a ticket on an account you own, so you pay your own provider at your own rate and keep the usage under your own name.

## What we support today

Four kinds. Name the one they have in their words, then in the page's words.

| they say | kind | what enrolling asks for | how they get it |
| -- | -- | -- | -- |
| "a Claude subscription", "Claude Pro or Max", "I use Claude Code" | Claude, a setup token | the token `claude setup-token` prints | on their own machine: run `claude`, check `/status` shows the account they mean, then run `claude setup-token` and copy the token |
| "ChatGPT", "Codex", "a ChatGPT Plus or Pro plan" | Codex, an auth file | the contents of `~/.codex/auth.json` | run `codex login`, choose "Sign in with ChatGPT"; the login writes the file. `$CODEX_HOME/auth.json` if `CODEX_HOME` is set. On macOS `pbcopy < ~/.codex/auth.json` copies it |
| "a GLM key", "Z.ai", "a GLM coding plan" | GLM, an API key | the provider's API key | from the provider's console |
| "a Qwen key", "Alibaba Model Studio", "a Qwen coding plan" | Qwen, an API key | the provider's API key | from the provider's console |

A plain Anthropic or OpenAI API key is not something the page can enrol today. If that is what they have, say so in one sentence and ask whether they also have one of the four above. Do not improvise a way in.

Codex has one more thing to say, before they paste: Catalyst takes over that login. Its refresh token is single-use, so the copy on their machine stops working once Catalyst uses it. To keep using Codex locally, they sign in again afterwards, separately.

## Enrolling one

Enrolling is a browser step, by construction: the person pastes a credential into a write-only field, and nothing you run ever sees it.

1. Hand over the page the script printed for the part (Settings → AI accounts). Say: "Choose the provider, give the account a label you will recognise, and paste the credential the page asks for. Nothing on this side sees it."
2. Wait. Do not run anything while they are on the page.
3. When they say it is saved, run `node scripts/where-am-i.mjs` and read them the `coding accounts` part. An enrolled and active account, named by its label, is proof. If the part still says none is enrolled, refresh the contract once (`catalyst-skills contract --refresh`) and read it again.

Only a tenant owner or admin can enrol one. If the person is neither, say who can, and stop this step there.

## Naming accounts

Call an account what the page calls it: its label, else its email, else its slot. `catalyst-skills accounts --json` carries this as `displayName`. Never call one "the first account" or "account 2", and never read out a credential.

## An account that already exists

The script reads each enrolled account. Read it back in their words:

- **Active, or attested.** "Your Claude account, Work laptop, is enrolled and can take work." Move on.
- **Out of rotation.** Every account is deactivated. Reactivate one on its own page. Never enrol another.
- **Needs a new credential.** Quarantined, expired or revoked, or its last polls failed on the credential itself. Replace the credential on that account's own page, with a credential from that same login. The steps, and the login check that has to come first, are in `references/replacing-a-credential.md`. Never enrol a second account for this.
- **Ended or cancelled.** The subscription was cancelled, or the provider ended the account. This is not a credential problem, and no token brings it back. Retire it: open the account on the AI accounts page and deactivate it, or delete it from its row. Never paste a token from another login into it, which would put a live account's credential onto a dead slot. Retiring it does not hold up setup; the script does not count it as unfinished.
- **Could not be read.** Say the accounts could not be read this time and read again later. It is not "no accounts". Do not tell them to enrol one on this reading.

## When more than one is right

One account is enough to start. A second one, on a different provider or plan, gives the router somewhere to go when the first is at its limit. Offer it as a later improvement, not as a step now.
