# Routing work

This reference restates an invariant: what this skill does when the person asks for something to be done rather than known, and where a decision goes. Nothing here is tenant-specific.

## Three kinds of request

A message from the person is one of three things, and you decide which in the first sentence of your reply:

1. **A question.** "Where is X? Why is Y stuck? What closed today?" Answer it in the one-reply shape (`references/status-reply.md`). No routing.
2. **A request for work.** "Get X done. Ship the Y change. Own this until it closes." Turn it into a project with an owner, in one pass, as below.
3. **A decision only they can make**, surfaced by you or by the cloud. That is never answered here; it goes to `what-needs-me`.

A request that contains a decision is both: route the work and raise the decision, and say in the reply that you did both.

## A request becomes a project with an owner, in one pass

You hold no authority over project owners. Your job is to make the work visible and hand it to a single-threaded owner, then get out of the way.

1. **Find the existing home first.** `catalyst-skills query projects` and `query search <terms>`. A request that fits an open project is a ticket in that project, not a new project. Duplicate projects split one goal's status across two places.
2. **Scaffold when there is no home.** State the outcome in one sentence, the first ticket or two, and who owns it. Tickets are created through the `catalyst-linear` skill (the app actor, the team key from the contract); a project itself is created by the person in Linear, so name what you want it called and ask them to create it if none fits.
3. **Name the owner.** The owner is a `run-this-project` session for that project, or a person. Say which, in the reply. Tell the person the one command that starts the owner session, and do not start long-running work inside this session: the desk answers questions; the owner reacts to events.
4. **Say what you did.** The reply ends with the identifiers created, the owner named, and the next thing the person will see.

Cite an identifier only after the create call returned it. A guessed number is usually a real, unrelated ticket.

## What goes to what-needs-me

Anything that gates active work on a choice only the human can make: a product call, a priority call between two things that cannot both go first, an approval, or an action only they can physically take (a click in settings, a credential). It is raised as an ask through the `what-needs-me` skill with the question, the options, the default that fires if they stay silent, and what it blocks, and it is raised **before** anyone proceeds on the default.

Not an ask: brainstorming, a design back-and-forth, a question the person asked first, a retry-or-abandon call an owner can make, a provider outage (that is one status line, not a per-ticket question).

## Three rules that bind this skill

- **Never answer as the human.** You do not pick an option on an open ask, close one, or post in their voice. When their answer arrives in chat, it is recorded on the ask through `what-needs-me` so the record is complete, and it is recorded as the app actor, never as them.
- **Escalate inward, never outward.** An instrument reports to the project owner; the owner asks the desk; the desk asks the human, as an ask. A single stuck ticket is never a page to the human. A system-level failure (provider down, out of capacity, rate-limited) is one line in the status reply, not a question per ticket.
- **One door.** If the person needs a second place to look after your reply, add the missing block to the reply next time rather than pointing them at a dashboard.
