---
job: The shape every ticket follows, so each one stands alone for a fresh session.
kind: living
max-lines: 120
---
# Ticket template — for a ticket an unattended phase run can build

**Its one job:** the shape `/to-tickets` gives every ticket in this repo, so a fresh session with
nobody to ask can build it. It extends that skill's own issue template (Parent, What to build,
Acceptance criteria, Blocked by); the added sections are what the phase runner
(`tools/phase-run/run.mjs`) and its sessions read. `/ticket-check` verifies a ticket against this
shape before it gets the `run-ready` label.

A ticket must stand alone. Its session has no memory of the grilling, the spec conversation or the
tickets before it; it reads the issue, the files the issue names, and the code.

```md
## Parent

Part of #<spec>.            <!-- never "closes" or "fixes" beside a spec's number -->

## What to build

The end-to-end behaviour this ticket makes work, from the person's side. Not a layer-by-layer list.

## Acceptance criteria

- [ ] Each one checkable by a test or by walking the screen as a named cast member.
- [ ] Say who: "Lea (manager) sees…", "Amy (staff) cannot…".

## Not in this ticket

- What a session might reasonably build here but must not, and which ticket owns it instead.

## Decisions already made

- Every choice the grilling, the spec or `/ticket-check` settled that this ticket depends on, each
  in one line, with its source (spec D-number, ADR, owner + date).
- `/ticket-check` appends the owner's answers here.

## Handed forward

- What an earlier ticket of the phase left for this one, and what this one leaves for a named later
  ticket (#N), each in one line. "None" when there is none. A session that finds something owed
  writes it into its verdict's `handedForward` too, and the morning report lists it.

## Prototype screen                     <!-- a `frontend` ticket only -->

- The prototype file and the screen or state in it this ticket builds.
- Its surface brief, in a project that keeps them (with Impeccable, `.impeccable/surfaces/<slug>.md`).

## Areas

- `src/app/checkout/`                    <!-- folders or simple globs the change should stay inside -->
- `src/lib/checkout*.ts`
- `db/migrations/`

## Read first

- Gotcha blocks: `docs/agents/gotchas/README.md` → `#NNN`, `#NNN`.
- ADRs: `adr/NNNN`.

## Run by hand

- Any step only a person can do once this ships (a secret to set, a script to run, a check on a
  real phone). "None" when there is none.

## Blocked by

- #<ticket>, or "None — can start immediately".
```

## Rules for filling it in

- **Labels:** `ready-for-agent`, the module label, and `backend` and/or `frontend`. The `frontend`
  label is what sends a ticket through the browser check's screenshot gate and the design review,
  so put it on every ticket that changes what a screen shows. `run-ready` is added only by
  `/ticket-check`.
- **Blocked by** is also set as a native GitHub dependency (`docs/agents/issue-tracker.md`), and the
  ticket is attached to its spec as a sub-issue. The runner reads both; the text is for people.
- **Areas** are folders, not file lists. The morning report flags a changed file outside them, so a
  missing area produces a false flag and an over-wide one hides over-building. `docs/`,
  `CLAUDE.md` and `GLOSSARY.md` are always in scope, and so is whatever the project lists in
  `phaseRun.alwaysInScope` (`.claude/workflow.json`): its tests, its design files, and the shared
  registries nearly every ticket touches.
- **Handed forward** is written when the tickets are drafted, from what each ticket's "Not in this
  ticket" sends on; a session adds to it through its verdict, never by editing the issue.
- **One schema ticket per migration.** A ticket that adds a migration says so in What to build; the
  runner applies it to the migration target after the ticket's checks pass.
- **The mid-run rule is not repeated in the ticket.** Every session gets it from
  `tools/phase-run/ticket-prompt.md`: small, easily changed choices are taken and recorded under
  "Assumptions made"; a money rule, privacy, who may see or do something, or a
  hard-to-reverse schema choice parks the ticket with its question.
- **The finish ticket** (the phase's last, blocked by every other) is built attended, not by the
  runner: leave `run-ready` off it. It carries the finish review, the phase-end docs and the
  deletion of the prototype.
