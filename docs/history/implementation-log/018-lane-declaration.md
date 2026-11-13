# #018 — The lane declaration: a `## Lane` holds only on a ticket with its lane's label

**Ticket:** `#32` · **Devlog:** `#33` · **ADRs:** none (D6)
**Date:** 2026-11-09

---

## The Problem

0.7.0 runs two lanes, and what lane 2 may build is data: its row in `phaseRun.lanes` `takes` either
`any` or a label the project picks (D6, #29). A ticket meant for lane 2 says so in a `## Lane`
section. Nothing checked that section. A ticket could name lane 2 without the label lane 2 reads, or
name a lane no row has, and the mistake would only show at night, when no lane takes it. D6 also asks
for a warning when a ticket's Areas name an own-file hotspot's folder but none of its files.

## The Solution

**One pure rule, `laneProblems`** (`template/tools/phase-run/ticket-size.mjs`). It takes a ticket
(`{ body, labels }`) and the loaded `lanes` and `hotspots` sections, and returns
`{ refusals, warnings }`:
- **No `## Lane`:** no refusal, as before. `## Lanes` is some other section.
- **The lane named:** the section's first line, with a list marker, backticks and a "Lane " before
  the id left off, so `- 2`, `` `2` `` and `Lane 2` all name lane 2.
- **Refused:** a section that names no lane; a lane in a project with no `phaseRun.lanes`; a lane no
  row has (the message lists the ids there are); a row that takes a label the ticket does not carry
  (the message names the label). The label is what is read, never the Areas.
- **Accepted:** the row's label on the ticket, or a row that takes `any`, which has no label to carry.
- **Warned:** an Areas entry that is an own-file row's folder with none of its files named. The
  folder is the row's parent when its last part is a file or a pattern
  (`docs/agents/gotchas/{phase}.md` → `docs/agents/gotchas`), else the row itself. A file is any other
  Areas entry the row covers, `{phase}` and `*` matching one path segment.

**The script prints and exits on it.** `ticket-size.mjs` now fetches each ticket's `labels`,
prints `refused:` and `warning:` lines under its sizes, and marks a refused ticket `✗`. It exits 1
when it refuses any ticket. A size and an own-file warning still exit 0.

**`/ticket-check` reads it** (`skills/ticket-check/SKILL.md`): §1 says the script checks the lane
declaration, §2 has "A lane declaration that does not hold", and §5 keeps `run-ready` off a ticket
whose `## Lane` is refused until the label or the section is fixed.

**The ticket template** (the template's and this repo's copy, kept identical) gains a `## Lane`
block and one rule: use it only for a lane whose row takes a label, and carry that label.

## Why This Approach

**Pure function, thin script.** The rule needs no GitHub to test: the tests hand it a body, labels
and a lane table. `main()` only fetches and prints. In an interview: "I kept the decision pure and
the I/O at the edge, so every acceptance criterion is a unit test with fixed inputs."

**The rule's data is the lane table, not a size row.** `ticketSize` rows are counts against a max;
a lane declaration is a cross-check against `phaseRun.lanes`. A new `RULE_KIND` would have dragged
`config.mjs`'s size-rule parser in for nothing.

**`ANY_TICKET` is passed in.** `config.mjs` imports `RULE_KINDS` from `ticket-size.mjs`, so a static
import the other way would be a cycle. The script already imports `config.mjs` lazily in `main()`.

**A refusal exits 1, a warning 0.** A refused `## Lane` keeps a ticket from `run-ready`, so it
should read as a failure. An own-file warning is a lead, as a size is.

## Alternatives turned down

- **A new `ticketSize` rule kind for the lane.** Above: wrong data, more parser.
- **Refusing a `## Lane` on the `any` lane.** D6 asks for the label "it stands for"; `any` stands
  for none, and any ticket is that lane's anyway.
- **Reading Areas to decide a ticket's lane.** D6 rules it out: the label decides.
- **Testing `main()`.** It calls `gh`; the rule it prints is the tested function.

Both code reviews (standards and spec, against #32) ran after the first commit. These fixes are in
the same commit:
- **The unknown-lane refusal named no fix**, as the others do: it now says "name one of them, or
  take the section out".
- **`ownFolder` misread two row shapes.** A `{phase}` above the file (`docs/{phase}/notes.md`) gave
  a literal folder no Areas entry could equal; the folder is now a pattern too. A folder row with a
  dot (`docs/v1.2`) read as a file; only a `name.ext` last part does now.
- **`laneSection` copied `section()`**: both now share `sectionLines`.
- **Areas read only `-` bullets**, where `run.mjs` `ticketAreas` also reads `*`: both count now.
- **The skill said a ticket with no `## Lane` "is not checked"**, next to a warning that applies to
  every ticket. It now says "never refused", and that the warning is for any ticket.

These findings were turned down:
- **`ownFolder`'s pattern repeats `numbering.mjs` `rowMatcher`'s shape.** Importing it would close
  a cycle (`numbering.mjs` imports `config.mjs`, which imports this file); a shared module would be a
  new runner file to register in the snapshot and the stop-test lists, for one line.
- **`ticket-size.mjs` now changes for two reasons** (sizes and lanes). Both are what `/ticket-check`
  runs, in one script; splitting it is a rename for a later ticket, not this one.
- **Passing `{ lanes, hotspots }` rather than the whole config.** The narrow shape keeps the tests'
  fixtures small.
- **"A ticket with no `## Lane` behaves as today" against the own-file warning.** D6 scopes the
  warning to "a ticket", not a lane ticket, and it fires only once a project has own-file rows. Kept
  as an assumption (below), easy to reverse.
- **The template's `- 2` example could be copied in unedited.** Its comment says when it applies, as
  the `## Screen` block's does.

## Real bugs found along the way

None.

## What This Concretely Unblocks

- #34 (a lane choosing which ticket to build) reads the same `takes` label. `laneProblems` is
  exported if it wants the same reading of `## Lane`.
- #40 (setup asking for lane 2's label) writes the `takes` this checks.
- This repo's own `tools/` is the stamped 0.6.2 copy; it picks this up on the next
  `/update-workflow`.

## Run by hand

None. Backend-only (a script, a skill and a template), so no browser check.

## Assumptions made

Each is a small choice, easy to change:
- **`## Lane`'s format:** the lane's id on its first line, a list marker, backticks or "Lane " allowed
  before it. To loosen it, widen `laneNamed`.
- **The `any` lane needs no label.** To refuse a `## Lane` there, add a branch in `laneProblems`.
- **The own-file warning is for every ticket**, not only one with a `## Lane`: it can only fire once
  a project has own-file rows, and those rows exist for lanes. To limit it, check `lines !== null`.
- **A refused ticket exits 1.** To keep the script warn-only, return 0 in `main()`.
- **A `{phase}` or `*` above an own-file row's file matches any one folder there**, so with
  `docs/{phase}/notes.md` an entry `docs/agents/` warns unless it names `notes.md` under it. To
  narrow it, fill `{phase}` when the script knows the phase.

## Common Questions

**Does a ticket without `## Lane` change?** Its sizes print as before. It is never refused. It warns
only if its Areas name an own-file folder bare, which needs own-file hotspot rows.

**Why "none of its files", not "any folder above"?** `docs/` is always in scope and holds the
gotchas folder; warning on it would warn on most tickets. Only the own-file folder itself counts.

## References

- `docs/discovery/05-brigade-0.7.0.md` D6; spec #27; #29's lane table.
- Code: `template/tools/phase-run/ticket-size.mjs` `laneProblems` / `laneNamed` / `ownFolder`,
  `skills/ticket-check/SKILL.md`, `template/docs/agents/ticket-template.md`.
- Tests: `template/tools/phase-run/measure.test.mjs` (the ticket-size section).
