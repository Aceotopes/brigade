# #025 — The listed-code rule

**Ticket:** `#39` · **Devlog:** `#40` · **ADRs:** 0004 (an addendum), none new
**Date:** 2026-11-10

---

## The Problem

A stop check's `unread` list names files that check never reads, such as `docs/**` for the tests.
An edit there keeps the check's receipt (ADR 0004), and a gate's `unreadOf` skips the whole suite
when every changed file is on the list (the suite skip). The list is the owner's guess. When a test
does read a listed file (a JSON fixture under `docs/`, a helper it imports), a change to that file
kept the receipt and skipped the suite, though the tests read what changed.

0.6.0 (D19, #22) only warned about this: setup's verify and refresh scanned the test files for
quoted paths on the tests row's list and printed each one. The warning changed nothing at the stop
check or the gates, and it only read the tests row. D11 turns it into a rule.

## The Solution

**One scan, in `template/tools/phase-run/unread-scan.mjs`, used in three places.**

- `testNamedPaths` lists every repo path a test file names: a quoted string from the root, or from
  the test's own folder when it starts `./` or `../` (a relative import). It reads only the files
  `phaseRun.tampering.testFiles` matches, through the existing `pathOf`. A test file that is gone
  (deleted, still in the index) names nothing. Any other read error is thrown, so a caller can fail
  closed.
- `listedCode(named, unread, files)` picks the named paths a list leaves out. That is a named path on
  the list, a named folder with a listed file under it, or a name without an extension (`../src/x`)
  whose file (`src/x.ts`) is listed.
- `withListedCode(unread, listed)` gives back the list with each listed path put back by a `!`. The
  matcher already has that rule: the last glob that matches wins. With nothing listed it returns the
  owner's list itself.

**The receipts (`receipt.mjs`, `stop-tests.mjs`, `hooks/stop-gate.mjs`).**

- `listedGroups(root, checks, testFiles)` is `receiptGroups` with each group's list widened. A
  file a test names is now part of the check's key, so a change to it changes the key and voids that
  check's receipt. With no hit, the list (and so the key) is today's, byte for byte.
- `stop-tests.mjs` keys and records each receipt with that list. The Stop hook does the same when
  the project's receipt code has `listedGroups`. A 0.6.x `receipt.mjs` is read as before.
- The hooks' loader already checked the tampering section. It now also returns its `testFiles`
  (`[]` with no section), for the hook.
- A scan that fails keys every group on its whole tree (an empty list). No receipt holds on a list
  that could not be checked.

**The gates (`run.mjs` `gatePlan`).** The suite skip is judged by the same widened list. `gatePlan`
takes a `testNamed()` reader. It is called only when every changed file is on the list, and at most
once per plan. A reader that throws refuses the skip. Both plans, the ticket's (`runGates`) and
Landing's re-gate (`regateLanded`), pass `testNamedIn(work)`, which reads the test files in the
checkout the gates run in. The clean-tree gate runs first, so those files are the commit's.

**Setup (`scripts/setup.mjs`).**

- The scan reads every row with a list, not only the tests row. A named row stands alone, and the
  nameless rows share one list, as the receipts group them (`listRows`).
- Each hit now says what happens: a change there voids that check's receipt and any suite skip that
  points at it.
- With no `testFiles`, verify and refresh print one line saying there is no listed-code rule.
- Verify's line is now "the unread lists (the listed-code rule)".

`unreadWarnings` no longer looks for the tests row by the stack's role, since every row is read.
Setup's file list (`projectFiles`) and `repoFiles` both use `git ls-files -z`, so a test file with a
non-ASCII name is read (see the bugs below).

**Outside the ticket's Areas, wording only.** `skills/setup-workflow/SKILL.md`,
`skills/update-workflow/SKILL.md`, `template/docs/guides/phase-run.md` and the `#22` block of
`docs/agents/gotchas/measure-trim.md` each said the scan was a warning only, or read only the tests
row. This ticket made that false, so only those lines changed.

## Why This Approach

- **One matcher, one list.** ADR 0004 chose one JS matcher so the receipt's key and the suite skip
  can never judge a path differently. Putting the named paths back on the list, with the matcher's
  own `!`, keeps that. The key, the skip and the recorded list all come from the same widened list.
- **Keying, not a separate "changed since" check.** A named file in the key voids the receipt only
  when it changes after the pass. A change before the pass was tested anyway.
- **The owner's list stays as written.** The rule widens the list in memory. It never rewrites the
  config, and a project with no hits sees no change at all.
- **Fail closed.** A rule that can't run must never read as "nothing named": that would keep a
  receipt the rule meant to void.

## Alternatives turned down

- **The source's fix: running its runner tests as a gate.** Brigade never ported that gate (0.6.0
  D9), and D11 replaces it.
- **A separate list of named files beside `unread`, checked by its own code.** That would give two
  matchers that could disagree, which is what ADR 0004 turned down.
- **Putting back every named path, listed or not.** The matcher would give the same answer, but the
  recorded list would change on every project with test files. Receipts written before this ticket
  would then all go void, and a list would grow with paths it never left out.
- **Reading the test files at the base commit, as the tampering gate reads its rules.** The rule is
  about what the ticket's tests read, which is the ticket's own tree. `testFiles` itself comes from
  the run's frozen config (ADR 0005), so a session cannot switch the rule off mid-night.

- **From the code review, turned down:**
  - *An import naming `.js` for a `.ts` file* (`import "../src/x.js"` under Node's ESM resolution)
    puts back only `src/x.js`. Mapping extensions across languages is a guess the scan doesn't
    make, and source files rarely sit on an unread list. The rule may void too little (the
    module's header says so), and the gates still run what a skip leaves.
  - *Smells:* the extensionless rule is written twice (`namedTest`, `withListedCode`), a reader is
    built beside `repoFiles` in four places, and `{ testFiles, files, read }` travels together.
    Each copy is one line and reads plainly where it is. `gatePlan` puts back every named path,
    where `listedGroups` filters through `listedCode` first. That is the same answer from the
    matcher, and the skip records no list, so it need not stay minimal.

## Real bugs found along the way

None in shipped code. The code review found these in this ticket's first commit, fixed before it
landed:
- **A failed scan ran again for every `unreadOf` gate.** The plan cached the failure as `null`,
  which `??=` reads as "not yet". It now caches `{ named: null }`.
- **A test file with a non-ASCII name was never read.** `git ls-files` without `-z` C-quotes such a
  name, and no glob matches the quoted form, so the rule quietly failed open. `repoFiles` and
  setup's `projectFiles` now use `-z`. The code predates this ticket, but only now does it feed
  receipts and skips.
- **With no test files the runner still ran `git ls-files`**, and a git failure there would have
  refused a skip with no rule behind it. `testNamedIn` now returns at once.

## What This Concretely Unblocks

- **#40** (setup's lane checklist and the guide's examples) can point at the rule when it asks
  about `unread` lists, and at the new verify line.
- **#42** (the finish): the template's phase-run guide already says the new rule. This repo's own
  installed copy (`tools/phase-run/`, `docs/guides/phase-run.md`) still says 0.6.2's, until it is
  updated to the release.

## Run by hand

None. Backend-only (the runner, the hooks, setup and their tests), so no browser check: no screen
changes.

## Assumptions made

Each is a small choice, easy to change:
- **A named folder counts its files.** A test naming `docs/fixtures` voids the receipt when a file
  under it changes. This means more reruns, never fewer. To drop it, take the `startsWith(path/)`
  case out of `namedTest`, and the folder put-back out of `withListedCode`.
- **A name without an extension counts any extension** (`../src/x` covers `src/x.ts`, put back as
  `!src/x.*`). To drop it, remove the `HAS_EXTENSION` case from `namedTest` and `withListedCode`.
- **The scan's hits stay warnings in verify and refresh**, reworded to say what the rule does. They
  are never failures and never items. To make them quieter, return `[]` from `scanLines` for hits.
- **The no-rule line's words.** "no listed-code rule: set phaseRun.tampering.testFiles, …" is
  `NO_TEST_FILES`.
- **A failed scan fails closed.** Receipts are keyed on the whole tree (an empty list), and
  `gatePlan` refuses the skip. To fail open instead, return the plain groups in `listedGroups`'
  catch, and treat a throw as `[]` in `gatePlan`.
- **Where the rule reads from.** `testFiles` comes from the run's frozen config (ADR 0005). The test
  files are read from the tree the gates run in, never the base commit. To read them at the base,
  give `testNamedIn` a reader through `atCommit` and the base's file list.
- **A fixture path a test writes into a temp repo counts as named** (gotcha #22's noise). It now
  voids a receipt instead of only warning. This repo's own tests row has no `unread` list, so it is
  not affected here.

**Found elsewhere, not fixed:** nothing.

## Common Questions

**My project has no `phaseRun.tampering`. What changes?** Nothing. There is no listed-code rule.
Verify and refresh say so in one line, and the receipts and skips behave as before.

**Why did my stop check rerun the tests after I only edited a doc?** A test file names that doc. Run
`node tools/phase-run/unread-scan.mjs` to see which test, and which line.

**Can a test opt a file out?** Not by a marker. Build the path from pieces (`join(dir, "a.json")`):
the scan only reads whole quoted paths.

## References

- `docs/discovery/05-brigade-0.7.0.md` D11 and "For the spec"; `docs/discovery/04-brigade-0.6.0.md`
  D19, D9; spec #27; ADR 0004 (with this ticket's addendum), ADR 0005.
- Code: `template/tools/phase-run/unread-scan.mjs` (`testNamedPaths`, `listedCode`,
  `withListedCode`, `listRows`, `unreadScan`); `receipt.mjs` (`listedGroups`); `stop-tests.mjs`;
  `run.mjs` (`gatePlan`, `testNamedIn`, `runGates`, `regateLanded`); `hooks/workflow-config.mjs`
  (`testFiles`); `hooks/stop-gate.mjs` (`perCheckReceipts`); `scripts/setup.mjs`
  (`unreadWarnings`, `verify`).
- Tests, written first: `tests/stop-gate.test.mjs` (the hook seam: five tests, after a real
  `stop-tests.mjs` pass), `template/tools/phase-run/run.test.mjs` (the runner seam: the scan, the
  skip, every `unreadOf`, both call sites), `tests/setup.test.mjs` (the no-rule line in refresh and
  verify, and every row's hits), `tests/workflow-config.test.mjs` (the loader's `testFiles`).
