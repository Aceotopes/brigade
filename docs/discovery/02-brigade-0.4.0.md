# Discovery: Brigade 0.4.0, the runner's night

> **Addendum 2026-10-30:** 0.4.0 is released, after a throwaway trial night.
> - **The trial:** a fresh repo with a tiny library and one spec, two run tickets (one blocked by
>   the other) and the finish ticket. Both tickets were built and none parked, for $5.60 at API
>   rates; the pull request's checks ran green.
> - **Seen live:** the table redrawn in place with its dim detail lines and colours; the tab title
>   following the run; `status.mjs` in a second terminal printing the same table. Read from the
>   run's files: a stop check with `"testsSkipped": true`, and a Scoreboard with "Slept" at 0 and a
>   cost and time split per ticket.
> - **Not seen:** the Windows notification, because the owner's Do Not Disturb was on. The same
>   script ran without an error, so nothing was changed.
> - **Found:** the receipt only helps when the session tests last. One session wrote its devlog
>   and logs after its last test pass, and a docs-only edit is still a new tree, so the hook ran
>   the tests again. Left for 0.4.1, to be decided first.
>
> **Changes:** Goals 1 and 3 are met. Goal 2 is met for fixed sleeps, and in part for test runs.

**Rounds:** 2026-10-28. A handoff from one real project's session that profiled a 14-ticket phase
run, with five fixes and a new terminal display the owner had already approved there, then built
and committed there. Brigade ports them, and the owner settled how they become generic in one
round of questions. **Status:** built, not released; released only after a live trial night.
The receipt's trust decision has an ADR: [the stop check trusts a receipt](../adr/0003-stop-check-trusts-a-receipt.md).

Like any discovery doc, this one is never rewritten: a later fact is added as a dated addendum at
the top.

## Goals

1. The owner sees a night at a glance: how many tickets are done and left, when it will end, and
   what each finished one cost and where its time went.
2. Each ticket stops repeating work: one test run per state of the code, no fixed-length sleeps.
3. Each ticket is measured, so the next change to the workflow is chosen from numbers.

## Problems (what happens today)

Measured on the profiled night (14 tickets, about 85 minutes and about $22.50 at API rates each):

| Problem | Today |
|---|---|
| No count, no ETA, no cost | The terminal is a wall of five-minute lines; the owner counts tickets by hand and digs `run.log` for each ticket's time. A background session reports no cost of its own |
| The same tests three times | The session's changed-tests run, the Stop hook's identical re-run, then the gates' full suite: about 20 minutes a ticket |
| Fixed sleeps | A session can't end its turn to wait for a reviewer (that sets off the Stop hook), so it slept for set times: 1.6 hours across the night, mostly after the reviewer had finished |
| Context re-read | 57% of the cost was the model re-reading its own context, which grew from 64k tokens to 480–720k; long test logs and whole-file reads fed it |
| Ticket size unchecked | A 400-step ticket cost three times a 100-step one |

## Requirements and stack

Node only, no dependencies, as before. Nothing project-specific in the template: a project's own
commands, patterns and limits are config ([ADR 0001](../adr/0001-no-stack-recipes.md)).

## Decisions

1. **Measure every ticket** (`tools/phase-run/metrics.mjs`, `prices.json`). After a ticket the
   runner reads its transcript: tokens once per response, priced per model at API list price (a
   usage gauge, not a bill); each tool call's wait, sorted into tests, checks, browser, slept and
   reviews; the Stop hook's minutes from a log it now writes; the gates' from the runner's clock.
   "Claude" is the remainder. All of it goes into `results.json` and a Scoreboard at the top of
   the report.
2. **Step kinds are data.** A fixed set of kinds; the rows that sort a command come from the
   project's `phaseRun.steps`, then its stop checks (the receipt row is testing, the others
   checking), then Brigade's generic rows.
3. **The night as a table** (`display.mjs`, `status.mjs`): a row per finished ticket with dim
   detail lines, a live progress line and ticket row redrawn in place, colours only on a terminal
   and never under `NO_COLOR`, the tab title, a Windows notification (`PHASE_RUN_NOTIFY=0` turns it
   off), an end-of-run scoreboard. `run.log` stays plain. `status.mjs` prints it from any terminal.
4. **A tests-passed receipt** (`receipt.mjs`, `stop-tests.mjs`, ADR 0003), marked on the stop
   check's row with `"receipt": true`; setup marks its tests row. The hook imports the project's
   receipt code, so a project without it runs every check.
5. **Quiet test output.** A receipt row may carry `"quiet": { "totals", "failures" }`, two patterns
   naming the lines a session needs. Without them, the last lines of a pass and the tail of a
   failure. Setup never fills them in: that would be a per-runner recipe table.
6. **Wait on the thing, not the clock.** `wait-subagents.mjs` returns when Claude Code marks every
   subagent of the ticket's session finished; `wait-url.mjs <url>` when a server answers. The
   ticket prompt forbids fixed-length pauses, and a test holds it.
7. **A size budget** (`ticket-size.mjs`, run by `/ticket-check` as a warning): `phaseRun.ticketSize`
   rows of three kinds (`checkboxes`, `bullets`, `words`), defaulting to 8 criteria, 8 Areas
   entries and 800 words.
8. **Read in parts.** The ticket prompt says grep first, then read only the part of a large file
   that is needed.
9. **The version.** A minor release, because a stop check row gains a key that 0.3.0's hooks
   refuse. Released only after a throwaway trial night shows the table, a skipped hook test run,
   "slept" near zero and the notification.

## Out of scope

- A fresh review session per ticket, and size budgets on the gotchas docs: discussed, not picked.
- Parallel tickets (worktrees, a database each, a dependency list, usage limits).
- A cheaper model for helper subagents.
- Phone notifications; notifications off Windows.

## Open questions

None for the build. The trial night may show the live table needs tuning.
