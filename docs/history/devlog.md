---
job: The timeline of this phase, one entry per commit, newest first.
kind: log
max-entry-lines: 15
---
# Devlog

Each commit's entry goes on top, in the shape of `docs/_templates/devlog-entry.md`, and the commit
message cites it (`devlog #N`). At each phase end, `node tools/doc-rotate.mjs` moves the closed
entries into `docs/history/devlog/`.

## #12 · feat · gates side by side, with the suite skip

**Built:**
- Gate rows gain `after` and `unreadOf`; `{cache}` joins the gate placeholders. Both loaders refuse
  a name that names nothing, word for word; the runner also refuses `after` circles and `alone` links.
- `gatePlan`: one decision function over a rename-aware name-status diff (both sides count). The
  suite skip needs a non-empty diff wholly on a check's list.
- The gates run side by side: `after` waits for a pass; same-tick failures are all reported; the
  rest are tree-killed and awaited. `alone` gates run after, then the browser check.
**Verified:** real `node -e` jobs for parallel, `after`, `alone`, first-failure kill and same-tick
failures; the suite skip on docs-only, mixed, empty and renamed diffs; `{cache}` emptied; full
stop-check suite. Backend only.
**Next:** #20, the tampering verdict in `gatePlan`. **Record:** implementation log 007.

## #11 · feat · each stop check keeps its own receipt

**Built:**
- `unread.mjs`: one JS matcher for `unread` lists (`*`, `?`, `**/`, `!`, last match wins).
- `receipt.mjs`: a key per check from one `git add -A`; `<name>-receipt-<ticket>.json`, nameless
  rows keep `test-receipt-<ticket>.json`; the command recorded with `{base}` filled in.
- `stop-tests.mjs` runs every uncovered receipt check past a failure, one cap on the failures. The
  stop gate runs only uncovered checks, writes nothing, logs `skipped`; 0.5.2's path beside an old
  `receipt.mjs`. Both loaders: `name`, per-row lists, the shared-list rule gone.
**Verified:** loader refusals through both loaders; old-vs-new keys on ten lists; hook seams under
0.6.0 and frozen 0.5.2 receipt code, three checks after a real stop-tests pass; the runner's imports
never reach the receipt reader; full stop-check suite; review (5 fixes). Backend only.
**Next:** the next ticket of #11. **Record:** implementation log 006.

## #10 · feat · the runner snapshot: one frozen copy judges a run

**Built:**
- `snapshot.mjs`: at run start, `tools/phase-run/` and `.claude/workflow.json` are copied to
  `.phase-run/<branch>/runner/` with a manifest. A crashed run restarts on that copy, refused,
  naming the files, when the runner's `.mjs` changed. A finished run's copy is taken fresh.
- Each ticket's env carries `PHASE_RUN_RUNNER` and `PHASE_RUN_ROOT`. The stop gate and the guard
  read the copy's config and receipt code, and fail closed on a missing copy. The prompt's check
  command runs the copy's `stop-tests.mjs`.
**Verified:** hook seams with and without the copy (stop-gate, guard-shell), five snapshot tests,
stop-tests from a copy layout, env contract, prompt render; full stop-check suite. Backend only:
no browser check.
**Next:** the next ticket of #11. **Record:** implementation log 005.

## #9 · feat · the attended ledger hook

**Built:**
- `hooks/ledger.mjs`, a Stop group of its own: each reply in a set-up project appends the
  session's running total as an `attended` row, at the plugin's version.
- Off with `ledger.attended: false` or no workflow.json; a config from a later release still
  counts. `PHASE_RUN=1` exits before any import. Silent, exit 0 on every path.
- Plugin-local pricing; reads only the bytes added, its state in `.phase-run/ledger-state/`, saved
  after the row with a rename. `metrics.mjs` gains `addCost`.
**Verified:** `tests/ledger-hook.test.mjs` 12/12 through the real hook process (a 0.5.x project,
a broken price list, a marker proving no load under PHASE_RUN); stop-check suite; review (5 fixes).
Backend only: no browser check.
**Next:** the next ticket of #11. **Record:** implementation log 004.

## #8 · feat · the ledger: night rows and views

**Built:**
- `ledger.mjs`: the row shape, append, read, each session's latest row, weeks, by kind and model, CSV.
- The runner writes a priced `night` row through `recordResult`, so built, parked, failed and a
  crash each leave one; a failed append marks the result "ledger: not written" and the run goes on.
- `brigade` is the project's stamp version, `null` without one; cost gains `byModel`.
- Both loaders accept `ledger: {attended?, weekStarts?}` with the same refusals (Monday default).
- `status.mjs --ledger` (weekly view) and `--csv [file]`.
**Verified:** the new ledger, runner and loader tests; the stop-check suite; code review (4 fixes).
Backend only: no browser check.
**Next:** #15, the attended hook. **Record:** implementation log 003.

## #7 · feat · pricing: five rates, three models, each request on its own

**Built:**
- `prices.json`: `checkedOn`, Opus fallback, five rates for Opus 5.5, Sonnet 5.5, Fable 5.1 (no Haiku).
- `loadPrices` refuses a row or `above` tier short of a rate, and a fallback with no row.
- `requestCost`: 5m/1h writes at their own rates, an unsplit write at 1h, the `above` tier, fallback.
- `sessionCost` / `sessionCostFrom`: transcript and subagents, advisor passes at their own model,
  incremental from a saved state, in whole nano-dollars; the report and `status.mjs` use them.
**Verified:** `measure.test.mjs` 43/43 (refusals, tiers, advisor, subagents, 3-step = whole, a
rewrite); the stop-check suite; code review (2 fixes). Backend only: no browser check.
**Next:** #14, the ledger. **Record:** implementation log 002.

## #6 · research · the 0.6.0 probe, Brigade under the night's flags

**Built:**
- Discovery doc 04's addendum: the four answers, from real sessions in scratch repos with the
  installed plugin.
- (a) Brigade's hooks and skills load under the night's flags, and trim works.
- (b) No `-p`, `--bg` or interactive session auto-updated a plugin; a manual update moves the next
  session.
- (c) moot; (d) `claude plugin list --json`, matched on `projectPath`.
**Decided:** D8 stands, with the override kept as insurance and the stop's job proven (owner).
**Verified:** debug logs of 9 sessions, plus 2 interactive ones run by the owner; probe installs,
catalog and cache removed afterwards.
**Next:** the phase run on #11. **Record:** #12; #25 now names the version read.

## #5 · docs · 0.6.0 grilled and specced: measure and trim

**Built:**
- Discovery doc 04: the port of one real project's runner upgrade, D1–D21, a 12-ticket slicing.
- ADR 0004 (each stop check keeps its own receipt), ADR 0005 (one run, one judge); 0003 amended.
- GLOSSARY: Receipt and Unread paths per check; Suite skip, Tampering gate, Test override, Runner
  snapshot, Ledger, Kind, Trim, Keep list.
- Spec #11 published and listed in `.claude/spec-issues.json`; the handoff rewritten.
**Decided:** tool rows stay checklist items, not recipes (ADR 0001); setup reuses a compose file.
**Verified:** doc-check clean; `node --test tests/*.test.mjs` 94/94. No code changed.
**Next:** `/to-tickets` on #11, probe first. **Record:** adr/0004, adr/0005.

## #4 · chore · /update-workflow to 0.5.2, the pinned runner moves forward

**Built:**
- The root `tools/doc-tools.test.mjs` re-copied from the 0.5.2 template (the `PHASE_RUN` fix); the
  stamp `.claude/workflow-version.json` now says 0.5.2. The only change the update listed.
**Verified:** the update run from the installed 0.5.2 plugin; `PHASE_RUN=1 node --test
tools/doc-tools.test.mjs` 26/26; `setup.mjs verify` all ok; doc-check clean.
**Next:** Block23GymV2 setup. **Record:** devlog #3.

## #3 · chore · release 0.5.2, Brigade on itself

**Built:**
- `plugin.json` 0.5.2; CHANGELOG's Unreleased dated as 0.5.2 (Node test gates, the `PHASE_RUN` fix).
- README Status and `docs/development.md` entry 13: Brigade is set up on itself, `tools/` pinned.
**Decided:** the run's assumption 2 is kept (a lockfile without `package.json` keeps its rows, the
Node tests row after them). Owner, 2026-11-04.
**Verified:** the three suites and doc-check before the commit.
**Next:** update the plugin here and run `/update-workflow`. **Record:** PR #10, devlog #2.

## #2 · feat · setup proposes Node test gates for a repo without package.json

**Built:**
- A repo with Node tests in a top-level `test/` or `tests/` and no `package.json` now gets them
  proposed as the tests row (`node --test tests/*.test.mjs`), receipt and `alone` included.
- `detect`'s new `nodeTests` (`nodeTestGlobs`); `stackChecks` appends the row; a `package.json`
  repo is proposed what it was before.
- `skills/setup-workflow/SKILL.md` §3 and `CHANGELOG.md`'s `## Unreleased` say so.
- Fix: the suite no longer fails inside a phase run (test files strip `PHASE_RUN*`).

**Verified:** three new tests in `tests/setup.test.mjs`, the full suite via `stop-tests.mjs`, and
`setup.mjs propose .` on Brigade itself. No browser check: no screen.
**Next:** the next ticket of phase dogfood. **Record:** implementation log 001.

## #1 · chore · adopt the workflow
- 2026-11-04: the Brigade workflow set up by `/setup-workflow` (merge mode): the doc tools, the phase
  runner, the workflow docs and this repo's config in `.claude/workflow.json`.

---
