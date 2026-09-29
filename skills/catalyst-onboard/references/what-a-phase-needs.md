# What a phase needs to run

A phase needs the `coding accounts` and `host` parts of `node scripts/where-am-i.mjs`, however much else is finished. Say a phase can run only when the script's last line says nothing is left; otherwise name the unfinished part and its owner, and say no work will start yet.

## Coding accounts

One coding account is enough to start. A second, on another provider or plan, gives the router somewhere to go at a limit; offer it later.

### The kinds, and enrolling

| they say | kind | the page asks for |
| -- | -- | -- |
| "Claude Pro or Max", "I use Claude Code" | Claude setup token | what `claude setup-token` prints, after `/status` in `claude` shows the account they mean |
| "ChatGPT", "Codex" | Codex auth file | `~/.codex/auth.json` after `codex login` (steps in `references/replacing-a-credential.md`) |
| "a GLM key", "Z.ai" | GLM API key | the key from the provider's console |
| "a Qwen key", "Alibaba Model Studio" | Qwen API key | the key from the provider's console |

A plain Anthropic or OpenAI API key cannot be enrolled; say so and ask whether they have one of these. Before a Codex paste, say Catalyst takes over that login: its refresh token is single-use, so they sign in to Codex again locally afterwards.

Enrolling is a browser step by construction: on Settings → AI accounts, an owner or admin picks the provider, labels the account, and pastes the credential into a write-only field. Call an account by its label, else its email, else its slot (`displayName` in `catalyst accounts --json`).

### The states

**Instrument:** `codingAccounts` in `catalyst contract`; with `enrolled`, the script also reads `catalyst accounts` for each credential. With no `codingAccounts` (an older cloud) it reads `catalyst accounts` alone, and the owner is an owner or admin at `<their cloud>/settings/coding-accounts`.

| state | what it says | what to do |
| -- | -- | -- |
| `enrolled` | one is active; another can still have a dead credential | "<provider> account <slot> needs a new credential" is the next step: `references/replacing-a-credential.md`. `unreadable` detail: read again later |
| `none_enrolled` | none enrolled | hand over the page to the enroller the contract names |
| `inactive` | every account is out of rotation | reactivate one on its page, never enrol another |
| `unread` | the cloud could not read them | it is not "no accounts"; read again later |

**A cancelled or ended account** stays for reporting, unused, and does not hold setup up; say so in one clause. It keeps its own login: a token from another login would put a live account onto a dead slot. It stays enrolled rather than retired or deleted, and a returning subscription reactivates it on its page.

## Host

The `hosts_current` check reads the same on every project, because it is about the whole account. `pass` means nothing waits on a host, including an account that runs none. `no_host_connected`, `hosts_unreported` (clears when the host reconnects) and `hosts_behind` each mean: name the owner and stop. `unreadable` means no project has been checked yet. The owner and where they act (`fixedWhere`) come from `catalyst contract --path readinessChecks`; when `fixedWhere` is null, name the owner with no page.

⛔ `catalyst ready` treats this check as a note, so it can print READY while no host is connected. The `host` part, not READY, says whether a phase can run.
