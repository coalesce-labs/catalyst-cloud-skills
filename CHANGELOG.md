# Changelog

## 0.2.0

Eight skills named from your seat (whats-happening, what-needs-me, run-this-project, am-i-set-up, catalyst-linear, catalyst-github, how-catalyst-works, join) replace the six; reads and the live event stream go through the Catalyst Cloud SDK and writes through the tenant's agent proxy, all behind catalyst-skills verbs (me, contract, query, replica, explain, running, queue, watch, write, ask, ready, accounts), with every stage id, label id, threshold and route read from the tenant contract; Node 22 is now required; login is accepted as another name for join; your existing customer.json is still read unchanged and gains the CLI path the next time you run catalyst-skills join, which also caches the tenant contract; run catalyst-skills ready to confirm.

## 0.1.1

The bundle now lives and publishes from its own public repository, coalesce-labs/catalyst-cloud-skills, so every skill can be read before it is installed; the README leads with the CATALYST_CLOUD_TOKEN form of join, and join's output no longer names an internal ticket.

## 0.1.0

First published customer skill bundle: vendored customer editions of concierge, steward, ask and linearis plus the new join and setup skills, one-command tenant discovery via GET /api/v1/me, config written to ~/.config/catalyst-cloud/customer.json, and a placeholder 0.x tenant contract range (CTC-1924 in flight).
