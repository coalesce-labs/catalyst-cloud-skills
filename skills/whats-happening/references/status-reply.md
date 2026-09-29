# Status

Open with takenAt, source and replica cursor/API reason. Then:

1. In flight: ticket, phase and elapsed time from running.
2. Blocked: reason and release actor.
3. Waiting on human: ranked waitingOnHuman asks, question and what each releases. Details belong to what-needs-me.
4. Closed: query issues at the contract's done stage or read the change feed for the requested window; otherwise since the last reply.
5. Next: queue order and phase.
6. Cannot see, when nonempty: unreadable facts and CLI-printed URLs. PR labels/reactions are not mirrored. Metrics such as cycle time, throughput, or how long pull requests have been open are not computed; never substitute ticket dates.

Lines use identifier, contract stage, then one clause. Age uses updated_at/lease start and expected phase duration. Omit empty blocks.

Read --board by slot. Long dispatch with nothing running: explain its first ticket. Unmoved cards may run, retry or remediate; count repair separately, never as progress. Asks wait on humans; local-lane work runs elsewhere. Comments and explain --history must agree.

Stuck: nothing offered, no automatic release, no ask or post-failure human comment/push. Otherwise name the wait. Move nothing; route requests to routing-work.md and decisions to what-needs-me.
