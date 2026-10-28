---
name: ticket-check
description: The readiness check before an unattended phase run. Use after /to-tickets has published a phase's tickets, when the owner types /ticket-check <spec number>. Reads the spec, every ticket and the code each one touches, asks the owner every open question in one batch, writes the answers into the tickets, and labels each ready ticket `run-ready`.
disable-model-invocation: true
---

A phase run builds tickets with nobody to ask. A question that surfaces at night parks its ticket
and everything that depends on it. This check moves those questions to now, while the owner is
here, and asks them all at once.

Argument: the spec's issue number. With none, ask for it.

## 1. Read

1. The spec: `gh issue view <spec> --comments`.
2. Its tickets, in order: `gh api repos/{owner}/{repo}/issues/<spec>/sub_issues` (gh fills in
   `{owner}/{repo}` from the current repo), then each ticket in full, and each ticket's blockers
   (`…/issues/<n>/dependencies/blocked_by`).
3. For each ticket: the code its **Areas** name, the gotcha blocks and ADRs under **Read first**,
   and for a `frontend` ticket its **Screen**: its module's flow diagram (`design/flows/module-N.md`,
   or under doc-config's `DESIGN_DIR`), the screen's brief there (with Impeccable, also its surface
   brief) and `DESIGN.md`.
4. `docs/agents/ticket-template.md`, the shape each ticket must have.
5. `node tools/phase-run/ticket-size.mjs --spec <spec>`: each ticket's criteria, Areas and words
   against the size budget (`phaseRun.ticketSize` in `.claude/workflow.json`, else Brigade's
   defaults). A ticket over a limit may be two sessions' work, and a long session costs more per
   step. A warning is a lead, not a verdict: weigh it under "a ticket too large for one session"
   below, and name any you would split in the batch.

A phase of a dozen tickets is a lot to hold. Read ticket by ticket and write findings down as you
go; do not ask anything until every ticket has been read.

## 2. Look for, per ticket

- **A decision nobody made.** Something the session must choose that the spec, an ADR and the
  ticket's "Decisions already made" do not settle. Sort each one:
  - *the owner's* (a money rule, privacy, who may see or do something, a schema choice
    that is hard to reverse, anything the owner would be surprised to find decided): ask it;
  - *small* (a label, an empty state, a sort order): leave it to the session, which records it
    under "Assumptions made". Do not ask these. Asking forty small questions is its own failure.
- **A sentence that reads two ways.** An acceptance criterion two sessions would build differently.
- **A conflict** with an ADR, a rule in `CLAUDE.md`, a gotcha, another ticket, or what the code
  already does.
- **A UI-changing ticket without the `frontend` label.**
- **A `frontend` ticket the design rung has not cleared** (`docs/agents/workflow.md`, "The design
  rung"). Each of these keeps `run-ready` off it, whatever the owner answers, until it is fixed:
  - no `DESIGN.md` at the repo root: the visual system comes first (Phase 0);
  - its module's flow diagram is missing, or its `**Approved:**` line has no date: the prototype
    is not approved yet;
  - its **Screen** is not one of the flow's `###` headings, written exactly;
  - that screen has no brief under its heading (job, states, must not), or, with Impeccable, no
    surface brief in `.impeccable/surfaces/`.

  Also report a state the brief lists that no ticket builds (empty, error, a long name, the other
  role).
- **A wrong edge.** A ticket that needs another's work but is not blocked by it, or is blocked by
  one it does not need; a ticket missing from the spec's sub-issues; a cycle.
- **A manual step nobody listed** under "Run by hand" (a secret, a script, a real-phone check).
- **A missing or thin section** against the template: no "Not in this ticket", no "Handed forward"
  (what an earlier ticket owes this one, or this one a later one), Areas too wide or
  absent, acceptance criteria that name no person, a ticket too large for one session.
- **The finish ticket** exists, is blocked by every other ticket, and will not get `run-ready`.

## 3. Ask once

Put every owner question to the owner in **one batch**, grouped by ticket, plainly worded (the
owner is a new graduate, not a senior engineer: say what each choice changes for the people using
the app, not only for the code). Each question carries a recommended answer and why. Use
`AskUserQuestion` when the batch fits its limits; otherwise a numbered list the owner answers by
number.

Report the mechanical problems (edges, labels, missing sections) in the same message and say which
you will fix yourself. Do not fix a ticket's meaning without the owner's answer.

## 4. Write the answers back

For each ticket, edit the issue body (`gh issue edit <n> --body-file <file>`; fetch the body first
and change only what is needed):

- each answer goes under **Decisions already made**, one line, ending `(owner, YYYY-MM-DD,
  /ticket-check)`;
- reword an ambiguous criterion to the reading the owner chose;
- add missing sections, fix edges and labels.

An answer that is hard to reverse and would surprise a later reader also gets an ADR (the
`doc-sync` skill's ADR row), named in the ticket's "Read first".

Add the spec's number to `.claude/spec-issues.json` if it is not there, so no commit can close the
spec by keyword (Brigade's guard-shell hook reads it).

## 5. Label

Add `run-ready` to every ticket with no open question left
(`gh issue edit <n> --add-label run-ready`). Leave it off:

- a ticket whose question the owner deferred (say so in a comment on the issue);
- a `frontend` ticket the design rung has not cleared (§2): name what is missing in a comment;
- the finish ticket, which is built attended.

## 6. Report

End with a short table: each ticket, `run-ready` or why not, and the order a run would take them
(`node tools/phase-run/run.mjs --spec <spec> --dry-run --branch phase-<name>` prints it). Then the
command for the night, with `--max 4` for a phase's first night.

This skill changes issues, one JSON file and possibly an ADR. It writes no app code and makes no
commit; if it wrote an ADR or changed the JSON file, say so and leave the commit to the owner's
go-ahead. That commit needs its own devlog entry like any other (doc-check refuses one without):
write it on top of `docs/history/devlog.md` (`## #N · chore · ticket-check for spec #<spec>`, what
changed) and draft the message to cite it: `chore: ticket-check for spec #<spec> — addresses
#<spec>, devlog #N`. A phase run refuses to start until it is committed.
