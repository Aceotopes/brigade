# #003 — The ledger: night rows and views

**Ticket:** `#14` · **Devlog:** `#8` · **ADRs:** none
**Date:** 2026-11-08

---

## The Problem

The runner priced each ticket (#13) into one branch's `results.json`, and nothing kept those
numbers once a phase was merged and its folder cleared. So the owner could not answer "did 0.6.0
make nights cheaper than 0.5.2?" or "what did this week cost?". Discovery doc 04 (D2) puts every
session's cost in one per-project **ledger**, a file that outlives the runs, with the Brigade
version on every row (D8, D14). This ticket builds the ledger, the night rows the runner writes,
and the two views.

## The Solution

- **`template/tools/phase-run/ledger.mjs`** (new). A row is `{at, sessionId, transcript, kind,
  ticket, branch, brigade, costUsd, tokens, peakContext, byModel}`, one JSON line in
  `.phase-run/ledger.jsonl`, which setup already gitignores.
  - `ledgerRow(...)` builds a row from a session's cost; `appendRow(file, row)` appends it, and
    throws when it can't; `readLedger(file)` reads every line that parses.
  - `stampVersion(root)` is the project's `.claude/workflow-version.json` version, `null` without one.
  - `latestPerSession(rows)` keeps each session's latest row by `at`. `kindGroup(row)` is `night`,
    `attended`, or `other` for any other label.
  - `weekOf(at, weekStarts)`, `weeklyView`, `ledgerText` (by kind, by model) and `ledgerCsv`.
- **`metrics.mjs`**: a session's cost gains `byModel`, `{model: {requests, nanoUsd, costUsd}}`,
  each request under the model it was priced at, so an advisor pass counts under the advisor's.
  The ledger row keeps all three.
- **`run.mjs`**: `runTicket` keeps the ticket's live session on `run.ticketSession`. `recordResult`
  is the one place every ending goes through (built, parked, failed, and `main()`'s catch for the
  runner's own error), so it calls `recordNight` first. That prices the session's transcript whole
  and appends a `night` row. A failure there sets `ledger: "not written"` and `ledgerError` on the
  result; the report shows "⚠ ledger: not written (…)", and the run carries on. `main()` gives the
  run its `ledgerFile` and its `brigade` (the stamp, read once at run start).
- **Both config loaders** (`hooks/workflow-config.mjs` and `template/tools/phase-run/config.mjs`)
  accept a top-level `ledger: {attended?, weekStarts?}` with the same refusals: not an object, an
  unknown key, a non-boolean `attended`, a `weekStarts` that isn't a lowercase day name. The
  defaults are `{attended: true, weekStarts: "monday"}`.
- **`status.mjs`**: `--ledger` prints the weekly view, and `--csv [file]` writes the CSV to the
  file or prints it (no file, or `-`). The weeks come from the `ledger` section alone, so a mistake
  in `phaseRun` doesn't move them. It now sets `process.exitCode` instead of calling `process.exit`, so a long
  CSV piped elsewhere is flushed first.

## Why This Approach

**A row is the session's whole cost, not what it added.** The ticket says the report keeps each
session's latest row. That only adds up if every row carries the session's total so far: then a
session read three times (a ticket's fix rounds, or #15's hook on every Stop) has three rows, and
the newest replaces the others. Rows that each held only an increment would need summing, and one
lost row would make the total wrong for good.

**One write point.** Every way a ticket ends already calls `recordResult`, including the runner's
crash catch. Putting the ledger write there, instead of in each of the four places, means a new
ending added later can't forget it. The night row prices the transcript itself rather than reusing
the result's metrics, because a crash has none.

**Ledger file on the run, not a module constant.** Tests call `recordResult` with a temp run. If
the path came from the runner's `STATE`, every test run would append rows to this repo's real
ledger. A run with no `ledgerFile` keeps no ledger, and only `main()` sets one.

**Weeks on the local date.** The owner reads "this week" in their own time zone; a UTC cut would
put Monday morning in Asia into the previous week. Tests build times at local noon, so a day is the
same in any zone.

Interview version: "I made the ledger an append-only JSONL file of cumulative snapshots. Each
session can be written many times, and readers keep the newest snapshot per session, so a lost or
duplicated write never corrupts a total. The runner writes at its single result-recording point,
so every way a ticket can end, including a crash, gets a row, and a failed write is marked on the
result instead of stopping the night."

## Alternatives turned down

- **Reuse `result.session.metrics` for a measured result.** That would skip one transcript read,
  but a crash has no metrics, so there would be two code paths. One read of a transcript is cheap.
- **Sum rows per session (delta rows).** Turned down above: a lost row breaks the sum.
- **Accept `"Monday"` or `"mon"`.** A day name is checked by two loaders that can't share code;
  one exact spelling (lowercase, full) keeps their refusals identical. To loosen it, lowercase the
  value in both loaders.
- **A new `ledger.test.mjs` file.** The phase's gates and stop check name the runner's test files,
  so a new file would need a config change in this repo and in every project. The ledger tests sit
  in `measure.test.mjs` (the views, the row) and `run.test.mjs` (the night rows).
- **(Review) Drive `runTicket` and `main()`'s catch in a test.** The night-row tests call
  `recordResult` with the two result shapes those paths record (a measured result, and a crash's
  `session: null`). `main()` isn't exported, and `runTicket` needs git, `gh` and a session. The
  wiring is three lines: `ticketSession` set at `runTicket`'s top, updated on a new session id, and
  every ending calling `recordResult`.
- **(Review) Reuse the result's metrics instead of pricing the transcript again.** Turned down
  above: a crash has none.
- **(Review) A status value instead of the string `"not written"`.** It is the ticket's own wording,
  and one field the report checks in one place.
- **(Review) Guard `latestPerSession` against a row whose `at` doesn't parse.** Only the runner and
  #15's hook write rows, both through `ledgerRow`, which always writes an ISO time.
- **(Review) Clear `run.ticketSession` after each ticket.** `recordNight` matches it by ticket
  number, so a stale one is never used for another ticket.

## Real bugs found along the way

- None in shipped code. The first test draft's built result had a `session` without `denials`,
  which `report()` reads; real session facts always carry it, so the fixture was fixed.
- The code review (standards and spec axes) found four in this ticket's first draft, all fixed and
  tested:
  - The two loaders' unknown-key refusal listed different allowed keys (the runner's left out
    `note`). The test now matches the whole message.
  - The weekly view's by-model figures added rows already rounded to cents, so many small sessions
    could read $0.00. Rows now keep each model's `nanoUsd`, and the view sums those.
  - `status --ledger` fell back to Monday when any unrelated `phaseRun` key was wrong. It now reads
    the `ledger` section on its own; and `--csv -` prints instead of writing a file named `-`.
  - A session that never wrote a transcript (a crash right after `runTicket` started) got a $0 row
    that counted as a session. It is now "ledger: not written (no transcript was found …)".
- **Found elsewhere, not fixed here:**
  - In shipped `run.mjs`, a throw inside `finishBuilt` after its `recordResult` (say
    `ensurePullRequest`) reaches `main()`'s catch, which records a second "failed" result for the
    same ticket. The ledger survives it (the same session, latest row wins), but the report lists
    the ticket twice.
  - This phase's own nights leave no ledger rows: the root `tools/phase-run/` judging them is the
    pinned 0.5.2 runner until `/update-workflow` copies this template in.

## What This Concretely Unblocks

- **#15 (the attended hook)** imports `ledgerRow`, `appendRow` and `stampVersion` from
  `ledger.mjs`, and writes `kind: "attended"` with the plugin's own version. Its rows must be the
  session's **whole** cost so far. `sessionCostFrom` returns only the added part and its state
  holds no totals, so #15 keeps running totals beside that state (`nanoUsd`, each model's
  `requests` and `nanoUsd`, the token counts, and `peakContext` as a maximum) and writes the totals
  each time, never the increment. No helper for adding two costs exists yet; #15 writes it.
- The config's `ledger.attended` switch is read by both loaders now; #15 acts on it.

## Run by hand

- None.

## Assumptions made

- **Weeks are cut on the machine's local date.** To reverse: use `getUTCDay` and UTC dates in
  `weekOf`.
- **`weekStarts` is a lowercase full day name** (`"monday"` … `"sunday"`). To reverse: lowercase the
  value in both loaders before checking it.
- **A ticket that ends before its session was set** (the runner failing in `runTicket`'s first
  line) writes no row and is marked "ledger: not written (no session was started for this ticket)".
- **A night whose transcript can't be found** writes no row and is marked "ledger: not written",
  so a session that never ran isn't counted (changed after the code review). To reverse: drop the
  transcript check in `recordNight`, and a $0 row is written.
- **`byModel` rows hold `{requests, nanoUsd, costUsd}`.** A week's total adds its rows' `costUsd` in
  whole cents, so it is the sum of what its rows show; each model's figure sums `nanoUsd`, then
  rounds, so the models can differ from the total by a cent.
- **`--csv -` prints the CSV**, as `--csv` with no file does.
- **The CSV's `kind` is the group** (`night`, `attended`, `other`) and `label` the row's own kind.
- **The template's phase-run guide** gains a paragraph on the ledger and its two commands.

## Common Questions

**Where is the ledger, and is it committed?** `.phase-run/ledger.jsonl` in the project. Setup puts
`.phase-run/` in `.gitignore`, so it never reaches a commit (D2).

**Why does a night row carry the stamp's version and not the plugin's?** The stamp is the runner
copy in the project, which is what judged the night. An attended row (#15) carries the plugin's
own. They match when the project is in step.

**What does "other" mean in the weekly view?** Any row whose kind isn't `night` or `attended`, such
as a probe's label. It is counted apart so experiments don't skew the real totals, and the CSV keeps
the label.

**Was a browser check run?** No. This is a backend-only ticket: no screen changes.

## References

- Spec #11, `docs/discovery/04-brigade-0.6.0.md` D2, D8, D14.
- `template/tools/phase-run/ledger.mjs`, `metrics.mjs`, `run.mjs`, `status.mjs`, `config.mjs`;
  `hooks/workflow-config.mjs`.
- Tests: `template/tools/phase-run/measure.test.mjs`, `run.test.mjs`, `tests/phase-run-config.test.mjs`.
- Gotchas: `docs/agents/gotchas/measure-trim.md`, block `#14`.
