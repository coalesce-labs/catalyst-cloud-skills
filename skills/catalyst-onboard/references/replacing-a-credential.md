# Replacing a coding account's credential

When the script prints "<provider> account <slot> needs a new credential", replace that account's credential on its own page. Do not enroll a second account. A second account is a duplicate, and the dead one stays in place.

## Why an account needs one

The script flags an account in three cases:

- it is quarantined;
- it is expired or revoked;
- its last polls failed on the credential itself, such as `no_access_token`, three or more times in a row. The script can see this only when the cloud reports each account's polls.

Other accounts can be healthy at the same time. The contract can still say `enrolled`, so that line alone never proves every account works.

## Who does it

A workspace owner or admin, in the browser. The person copies the credential and pastes it. You never read it, print it, or paste it. The script prints the page link; use it, and never type a host.

## Codex

The person runs these steps on their own machine:

1. Run `codex login` and choose "Sign in with ChatGPT".
2. The login writes `~/.codex/auth.json`. If `CODEX_HOME` is set, the file is `$CODEX_HOME/auth.json`. On macOS, `pbcopy < ~/.codex/auth.json` copies it.
3. In the browser, open Settings → AI accounts, then open that Codex account.
4. Paste the file into "Replacement auth.json contents", then press Replace credential.

Then you run `node scripts/where-am-i.mjs` again and read back the `coding accounts` part.

Say these two things plainly:

- Do not enroll a second account. Replace the credential on the one the script named.
- Catalyst takes over this login. Its refresh token is single-use, so the copy on this machine stops working once Catalyst uses it. To use Codex locally, sign in to Codex again, separately, after the replacement.

## Claude

The same page takes a Claude account's new credential. Its field is "Replacement setup token". `claude setup-token` mints a token for whichever Claude account the terminal is logged into, not for the slot. So first match them: read the slot's account on the AI accounts page (its label or email), then have the person run `claude` and `/status` to see the email the terminal is logged into. If they differ, stop, and log in to the slot's account first. Only then run `claude setup-token`, paste the token into that field, and press Replace credential. Then re-run the script.

## A cancelled or ended account

An account whose subscription is cancelled, or which has ended, is not a credential problem, and no token revives it. It stays enrolled for reporting, is not used, and is not something to retire or delete. Never replace its credential with a token from another account: that puts a working account's login onto a dead slot. If the subscription is live again, the person reactivates it on its own page.

## Any other provider

Replace its credential on the same page, with the credential that page asks for.

## What Replace credential does

It stores the new credential and clears the account's quarantine in the same step. A workspace owner or admin can do it. An operator is not needed.

A failed poll is recorded until the account is polled again. If the script still names the account right after the replacement, wait for the next poll and read it again. If it still names it, report both: what the page said, and what the script says.
