# #009 — The tampering gate

**Ticket:** `#20` · **Devlog:** `#14` · **ADRs:** 0005 (the runner snapshot), 0004 (each stop check keeps its own receipt)
**Date:** 2026-11-08

---

## The Problem

An unattended session is judged by the tests it can edit. It can pass a gate by switching a test
off (`test.skip`, `{ only: true }`), by hollowing a test out, or by loosening what runs the tests (a
test config, the `test` script, `.claude/workflow.json` itself). Nothing stopped that. D15 in
discovery doc 04 settles the gate: project data in `phaseRun.tampering`, read from the ticket's base
commit, never failing open. A planned removal passes only by a line the owner wrote in the ticket.

## The Solution

- **The section**, `phaseRun.tampering`: `{testFiles, markers: [{name, pattern}], assertions:
  {pattern, maxNetRemoved}, guarded, guardedScripts: [{file, script}], override: {heading}}`. Every
  key is optional. Both loaders check it with one function, `tamperingRules`, the same text in
  `template/tools/phase-run/config.mjs` and `hooks/workflow-config.mjs`. A test compares the two
  texts and each refusal's words. A bad regex is refused. So are markers or assertions with no
  `testFiles`, which would match nothing (a gate that quietly passes everything). No section is
  `tampering: null`, so no gate.
- **The verdict**, `template/tools/phase-run/tampering.mjs` `tamperingVerdict`, called from
  `gatePlan`, the one decision function (#19). It reads `git diff -U0 -M` (`PATCH_ARGS`, with the
  prefixes, colour and drivers pinned) into added and removed lines per file:
  - a marker matched on an **added** line of a test file fails, naming the marker and the file;
  - assertion matches are counted over **all** the diff's test files together, removed minus added,
    and more than `maxNetRemoved` net fails. A test moved between files nets zero, and a pure
    rename has no lines;
  - any changed path on `guarded` fails, both sides of a rename counted;
  - a `guardedScripts` row fails when `scripts[script]` differs between the base and HEAD. A
    missing file, a missing script or JSON that can't be parsed counts as a change.
- **The rules come from the base.** The run's own config (the snapshot) only says the gate is on.
  The rules that judge are `readAt(base, ".claude/workflow.json")`'s section, through the same
  `tamperingRules`. A file missing at the base, unparsable JSON, a missing section or a refused one
  fails the gate with `problem` set. So does a missing reader. The reader is passed in (the runner's
  `atCommit` wraps `git show <rev>:<path>`), so `gatePlan` stays testable on fixtures.
- **The test override:** a line under the override heading (a markdown heading of any level, a
  colon allowed, never inside a code fence) in the ticket body as fetched at run start, naming the
  path as a whole word. It lets that path through: its markers, its guarded change, and the
  assertions it loses. `namesPath` refuses a near miss: `a.test.mjs.bak`, `src/tests/a.test.mjs`,
  or a bare file name for a full path.
- **A reason only in the commit message** (the heading's words, then the path named after them) is
  refused. The verdict says so, and its `refusedNote` is kept on the run per ticket. `recordResult`
  adds it to a built ticket's notes, or to a parked or failed ticket's detail, even when a later fix
  round failed on another gate. Both reach the morning report.
- **Renames:** a test file renamed out of the test globs counts its whole base text as removed.
  The suite no longer runs it.
- **First of the gates:** `projectGates` returns `{ gate: "tampering" }` before `{cache}` is
  emptied, before any job starts, and before the browser check. The runner's own prerequisites
  (one commit, a clean tree, an implementation log) still come first: they are its checks on the
  commit's shape, not project gates, and the verdict needs the one commit they confirm.
- **Skip reasons as a map** (`SKIP_REASONS`, owed by #19): runGates' log line looks the reason up,
  so a third skip can't be logged as the suite skip.
- **Docs:** the template's phase-run guide gains the section and the gate's place in the order.

## Why This Approach

**Existence from the snapshot, rules from the base.** The ticket says both "no section means no
gate" and "a missing section at the base fails the gate". These only fit together if the two
questions are read from different places. Whether the night has the gate is the frozen copy's
answer (ADR 0005), which no ticket can edit. What the rules are is the base commit's answer, which
the ticket's own diff can't reach. A ticket that deletes the section from `workflow.json` is caught
by `guarded` on its own night, and the next ticket's base then lacks the section, which fails.

**A pure decision function with a reader.** The verdict takes the diffs, the body, the message and a
`readAt(rev, path)`. Every case in the ticket is a fixture: no repo, no clock. One test runs real
`git` output through it (a C-quoted non-ASCII path, a path with a space and git's trailing tab, a
pure rename) so the parser is checked against what git really prints.

**The gate's rules live in data.** Markers, the assertion call, the guarded files: the code knows
four rule kinds (marker, assertion balance, guarded path, guarded script) and nothing about any test
runner. Setup (#22) writes a project's rows.

Interview version: "The tests are the judge, and the session being judged can edit them. So the
rules that catch weakening (skip markers, a net loss of assertions, edits to the test config) are
data the project owns. I read them from the commit the ticket started on, so the ticket can't
rewrite its own rules. And every failure to read them fails the ticket rather than passing it.
The only way through is a line the owner wrote in the ticket before the night began. A reason the
session writes in its own commit message is refused and reported."

## Alternatives turned down

- **Always guarding `.claude/workflow.json` in code** while the gate is on. D15 says `guarded`
  includes it: that is what the list holds, and the owner's rule is rules as data, not a path
  hard-coded. The loader can't enforce it either, since the hooks' copy has no glob matcher to ask.
  Handed to #22, which writes the rows.
- **Reading the rules from the snapshot.** It is frozen too, but the spec names the base commit.
  The base is also what a later ticket's rules really are, if an earlier ticket changed them.
- **The override in a commit trailer or a file in the diff.** Either is written by the session
  being judged.
- **Counting assertion lines rather than matches.** A line with two `assert.` calls loses two. The
  ticket says "assertion matches are counted".
- **A loader refusal when `guarded` lacks `.claude/workflow.json`.** The same matcher problem as
  above, and a project may legitimately leave the gate off its config.
- **(Review) Clear the refusal note when a later round passes.** The session did try to excuse
  itself in its commit message, and that is what the owner wants to hear about. It is kept on
  purpose, and the comment by `withTamperingNote` says so.
- **(Review) A commit-message reason without the heading's words** ("drop the flaky assert in
  tests/a.test.mjs"). Naming a file is what every commit message does. Treating that as a refused
  reason would flag nearly every ticket that touches a test, so the owner would learn to ignore it.
- **(Review) An override line must also say why** (spec #11 story 57). The ticket's criterion is
  "names the path", and the owner writes the line, so its reason is theirs to give.
- **(Review) Accept `./tests/a.test.mjs` as naming `tests/a.test.mjs`.** It errs on the strict side.
  The owner writes paths as the ticket's Areas do.
- **(Review) Take the tampering inputs out of `gatePlan`** (Middle Man: it only passes them on). The
  spec names one decision function that returns the gates' skips and the tampering verdict.
- **(Review) Drop the verdict's `problem` and `refused` fields**, which only tests read. They are
  the verdict's reasons in data, beside the prose of `output`. Without them a test would have to
  match prose.
- **Fixed from the review's smells:** the report's `if` cascade is a map of line builders
  (`FINDING_LINES`); `letThrough` is `overrideAllows`, with one lookup; a test's temp folder is
  removed in a `finally`.

## Real bugs found along the way

- **(Review) A test file renamed out of the test globs passed.** `git mv tests/a.test.mjs
  tests/a.mjs` has no `---`/`+++` lines, so none of its assertions were counted, and the suite
  stops running the file. The parser now reads `rename from`/`rename to`. A test file that leaves
  the globs counts its whole base text as removed. If that text can't be read, the file is an
  `unreadable` finding rather than a zero count. pinned: `run.test.mjs` ("assertions are counted
  over every test file together").
- **(Review) A test moved into an overridden file failed.** Overridden files were out of the count
  on both sides, so the move's added half vanished. Now only an overridden file's losses are let
  through, and every test file's gains count. pinned: the same test.
- **(Review) A guarded path written `./package.json` matched nothing**, a rule quietly off. Both
  loaders refuse a path not written from the root (`./`, `/`, `..`). pinned:
  `tests/phase-run-config.test.mjs`.
- **(Review) A `# …` line in a code fence read as a heading** in the ticket body. Fences are skipped
  now. pinned: `run.test.mjs` (the override's near misses).
- **(Review) A runner error dropped the refusal note.** The note was added in `finishBuilt` and
  `park` only. It now joins the result in `recordResult`, the one place every result passes
  through. pinned: `run.test.mjs` ("a reason only in the commit message is refused").
- **Found elsewhere, not fixed here:** none.

## What This Concretely Unblocks

- **#22** (setup asks for tool rows): the section's shape to write from the checklist: a project's
  skip and focus markers, its assertion call, its test config and `.claude/workflow.json` in
  `guarded`, its test script in `guardedScripts`, and the override heading.

## Run by hand

- None.

## Assumptions made

- **The gate exists when the run's config has the section; the rules come from the base.** To have
  the base alone decide (no section at the base, no gate): drop the "while this run has one" check
  in `baseRules` and pass the base's section as `rules`.
- **The override heading is a markdown heading line** (`#` to `######`, a trailing colon allowed).
  Its section runs to the next heading. A bold line does not count. To widen it: `sectionLines` in
  `tampering.mjs`.
- **A commit-message reason** is the heading's words anywhere in the message, then the path named
  on a later line or later on the same line. Naming a file alone is not a reason. To change it:
  `messageNames`.
- **Guarded scripts are package.json-style:** a JSON file's `scripts[name]`. To support another
  shape: `scriptText`.
- **Markers are tested per line with no flags**; assertions are counted per match (a `g` copy of the
  pattern). Removed marker lines never fail: removing a skip is fine.
- **Every key is optional**, `override` included. Without an override heading, nothing can let a
  path through and no commit-message reason can be found.
- **The hooks refuse a bad tampering section on any shape**, which blocks every shell command in a
  session until it is fixed. The spec asks both loaders to refuse alike. Never failing open is the
  point.

## Common Questions

**Can a ticket loosen the rules and pass?** No. The rules are read at the base, and the test "the
rules are the base commit's" passes a loosened run config and still fails on the base's rules.
Editing `workflow.json` also fails `guarded`, when the project lists it.

**What if the base can't be read?** The gate fails with the reason and tells the session to park.
No change in the ticket can mend the base.

**Was a browser check run?** No. Backend only: no screen changes.

**Why is `template/docs/guides/phase-run.md` touched, outside the Areas?** It is the template's
guide to `phaseRun`, and a new section without a line there is unfindable. It is the same kind of
change #19 made.

## References

- Spec #11, `docs/discovery/04-brigade-0.6.0.md` D12 and D15, ADR 0005, ADR 0004.
- `template/tools/phase-run/tampering.mjs`, `run.mjs` (`gatePlan`, `SKIP_REASONS`,
  `projectGates`, `runGates`, `atCommit`, `recordResult`, `withTamperingNote`), `config.mjs` and
  `hooks/workflow-config.mjs` (`tamperingRules`).
- Tests: `template/tools/phase-run/run.test.mjs`, `tests/phase-run-config.test.mjs`.
- Gotchas: `docs/agents/gotchas/measure-trim.md`, block `#20`.
