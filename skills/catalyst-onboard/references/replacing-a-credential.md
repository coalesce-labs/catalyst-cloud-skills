# Replacing a coding account's credential

When the script prints "<provider> account <slot> needs a new credential" (quarantined, expired, revoked, or three or more polls failed on the credential), replace that account's credential on its own page. Do not enroll a second account. It would be a duplicate beside the dead one. A workspace owner or admin does it in the browser, from the link the script prints; the person copies and pastes the credential, and you never read, print or paste it.

## Codex

The person runs these steps on their own machine:

1. Run `codex login` and choose "Sign in with ChatGPT".
2. The login writes `~/.codex/auth.json`, or `$CODEX_HOME/auth.json` when `CODEX_HOME` is set. On macOS, `pbcopy < ~/.codex/auth.json` copies it.
3. In the browser, open Settings → AI accounts, then that Codex account.
4. Paste the file into "Replacement auth.json contents", then press Replace credential.

Say plainly that Catalyst takes over this login: its refresh token is single-use, so the local copy stops working once Catalyst uses it, and to use Codex locally they sign in to Codex again, separately, after the replacement.

## Claude

The field is "Replacement setup token". `claude setup-token` mints a token for whichever account the terminal is logged into, not for the slot, so match them first: compare the slot's email on the AI accounts page with what `/status` in `claude` shows, and log in to the slot's account if they differ. Then run `claude setup-token`, paste the token, and press Replace credential.

## Any other provider

The same page, with the credential it asks for. A cancelled or ended account is not a credential problem, and no token revives it.

## Afterwards

Replace credential also clears the quarantine; no operator is needed. Run `node scripts/where-am-i.mjs` again. A failed poll stays on record until the next poll, so if the script still names the account, wait for that poll before reporting a disagreement.
