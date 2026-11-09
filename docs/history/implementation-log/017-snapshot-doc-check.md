# #017 — The snapshot carries doc-check: a night's docs are judged by its run's copy

**Ticket:** `#31` · **Devlog:** `#32` · **ADRs:** 0005 amended (D10)
**Date:** 2026-11-09

---

## The Problem

ADR 0005 froze what judges a phase run: at run start the runner copies `tools/phase-run/` and
`.claude/workflow.json` into `.phase-run/<branch>/runner/`, and every ticket is judged by that copy.
The docs were still judged live. The runner's gate ran `node tools/doc-check.mjs --head` from the
repo, and the commit hook ran the repo's doc-check too. So a shell write to `tools/doc-check.mjs`,
or a line accepted into `tools/doc-check-baseline.json` mid-night, would change the rules for every
later ticket's docs. D10 extends the snapshot to the docs.

## The Solution

**The copy takes the doc tools** (`snapshot.mjs`). `docTools(root)` starts at `tools/doc-check.mjs`
and follows its relative imports, however deep: today `doc-config`, `doc-index`, `doc-lib` and
`roadmap-format`. `doc-rotate` and the tests are not imported, so they stay out. `takeSnapshot`
copies those files and `tools/doc-check-baseline.json` beside the runner folder, at the same paths,
so the copy still mirrors the repo.

**The restart check counts the doc tools as runner code.** `runnerCode` adds the doc tools'
contents, so a live doc tool changed since the copy was taken refuses a restart, naming the file. The
baseline and `tools/doc-config.mjs` are config, like `workflow.json`: the copy keeps its own, and a
live change to either never refuses a restart. A ticket may edit doc-config (a doc path, an index
row), and a restart must not cost the night for it. A copy taken before this ticket has no doc
tools, so its restart is refused, naming them. The manifest records `docCheck: true` when the copy
took one.

**Two roots in the doc tools** (`doc-lib.mjs`). Run from the copy, doc-lib's old `ROOT` (the folder
above the file) would be the copy, and doc-check would scan an empty folder. Now:
- `TOOLS_ROOT` is where the tools and the baseline sit (the copy inside a run).
- `ROOT`, the tree checked, is `checkedRoot(TOOLS_ROOT)`. It is `PHASE_RUN_ROOT` only when
  `PHASE_RUN_RUNNER` names the folder these tools sit in. Otherwise it is `TOOLS_ROOT`, as before.

doc-check reads its baseline from `TOOLS_ROOT`: the repo's attended, the copy's in a run. Every
other reader of `ROOT` (doc-index's `staleIndexes`, git) gets the repo.

**The gates run the copy** (`run.mjs` `docCheck`). One helper runs the copy's doc-check with
`cwd` at the repo and `PHASE_RUN_RUNNER` / `PHASE_RUN_ROOT` set. The `--head` gate and the report's
`--report` both go through it. With no copy (a dry run), it runs the live one, as before.

**The commit hook runs the copy too** (`hooks/guard-shell.mjs`). Inside a run, the pre-commit
doc-check is `judgeRoot`'s `tools/doc-check.mjs` when the copy holds one, pointed at the project.
A copy from an older runner holds none, and the live one checks, as before. A copy whose manifest
says it took a doc-check, and has lost it, blocks the commit: the live one never judges instead.

**`--update-baseline` is refused, naming why.** doc-check's `IN_RUN` is `PHASE_RUN=1` or running
as the copy. The runner's own process has no `PHASE_RUN`, so the second half is what covers the
gate. In a run, doc-check refuses `--update-baseline` and `--adopt`, and the message says the night's
docs are judged by the baseline the run's copy took at run start. The shell guard's block says the
same. A budget raise is refused on the same `IN_RUN`, so the gate refuses it too, not only the hook.

## Why This Approach

**What judges is the copy's; what is judged is the repo's.** This is the split measure-trim's #16
made for the stop hook, applied to the docs. doc-check's code, its imports and its baseline are the
rules. The docs, git and the commit message are the work. In an interview: "I froze the judge, not
the defendant. The rules come from a snapshot taken at the start of the night; the thing being
checked is always the live working tree."

**Redirect only the copy.** `stop-tests.mjs` trusts `PHASE_RUN_ROOT` whenever it is set. For the
doc tools that would be risky: a test inside a night that spawns a fixture's doc-check inherits
`PHASE_RUN_ROOT`, and the fixture would check the real repo. `checkedRoot` redirects only when the
tools sit in the copy that `PHASE_RUN_RUNNER` names, so an inherited variable changes nothing for
any other folder's doc tools. A doc-tools test pins it.

**Walk the imports instead of listing the files.** A project's doc-check can gain an import (#30's
`NUMBER_TOKEN` came through doc-config). A fixed list would silently miss it, and the copy's
doc-check would fail to load. The walk is the same regex as the "no gate reads a receipt" test.

## Alternatives turned down

- **`PHASE_RUN_ROOT` whenever set, as stop-tests does.** It would point a fixture's doc-check at the
  real repo (above).
- **A `--root` flag on doc-check.** doc-lib's `ROOT` is read when the module loads, by doc-index too.
  A flag would have to reach every tool. The run's variables already say where the copy and the repo are.
- **Comparing the baseline on restart.** The copy keeping the old rules is the point, as with
  `workflow.json` (gotcha #16).
- **Changing the ticket prompt's "then `node tools/doc-check.mjs`" to the copy's path.** The commit
  hook and the gate both judge with the copy. A session's own run of the live one only shows it
  sooner, and the prompt stays as it is.

Both code reviews (standards and spec, against #31) ran after the first commit. These fixes are in
the same commit:
- **The hook fell back to the live doc-check silently** when a copy had lost its own (gotcha #16:
  a named copy missing a piece is an error). The manifest's `docCheck` now tells a damaged copy
  (blocked) from an older runner's (the live one checks).
- **doc-config refused a restart.** It is config a ticket may edit, so it is copied and kept but no
  longer compared.
- **The budget-raise refusal keyed on `PHASE_RUN` only**, so the gate let a raise through (below).
- `docTools` also follows a bare `import "./x.mjs"`.
- The tests got tighter. The hook test no longer sets `PHASE_RUN_ROOT` itself, so it proves the
  hook sets it. The pre-#31 test now calls the restart. A check that could never fail is gone, and
  two test names were made clearer.

These findings were turned down:
- **Two places know the copy needs `PHASE_RUN_ROOT`** (`run.mjs` `docCheck` and the hook). The hook
  is plugin code and the runner is a project's stamped code, so neither can import the other.
- **The gate is tied to `docCheck` by a test that reads `run.mjs`'s source.** `main()` can't run in a
  test. The same kind of test already guards `runnerFile`.

## Real bugs found along the way

One in shipped code, fixed here because the copy made it visible. The runner's process has no
`PHASE_RUN`, so its `--head` gate ran doc-check as if attended. doc-check's "a phase run never raises
a budget" refusal held only at the commit hook (whose session has `PHASE_RUN=1`). Run as the copy,
doc-check is in a run whatever the env says, so the gate refuses a raise too.

## What This Concretely Unblocks

- #33: a lane's runner copy is made the same way, so it carries doc-check, its imports and its
  baseline. The shell guard matching a lane's copy is #33's. **Owed:** `checkedRoot` resolves
  `PHASE_RUN_RUNNER` against `PHASE_RUN_ROOT`, and a lane's root is its worktree (ADR 0007), so a
  lane's `PHASE_RUN_RUNNER` must stay absolute, as `run.dir` makes it today. Otherwise the copy's
  doc-check does not know itself and scans the copy's folder.
- #30's handed-forward note is met: inside a run, a lane's `NNN` acceptance is the copy's doc-check.
  **Owed to #36** (the lane gate): `docCheck(runner, root, args, env)` must get `PHASE_RUN_LANE` in
  `env`, or the gate refuses the lane's unnumbered entry.
- This repo's own `tools/` is the stamped 0.6.2 copy. It picks this up on the next
  `/update-workflow`.

## Run by hand

None. Backend-only (the runner, the doc tools and a hook), so no browser check.

## Assumptions made

Each is a small choice, easy to change:
- **`--report` runs the copy too**, so one judge writes the morning's doc table. To read it live,
  call `exec` with `tools/doc-check.mjs` at that one site.
- **A copy without doc-check falls back to the live one** in the commit hook. That copy is one an
  older runner took. To refuse instead, block when `copied` is missing.
- **`--adopt` is refused from the copy too**, as `--update-baseline` is: both write the baseline.
- **doc-config is config on a restart**: kept, not compared. To refuse a restart on it, drop the
  `DOC_CONFIG` skip in `runnerCode`.

## Common Questions

**Can a session still edit the live doc tools?** Yes. The night's Edit deny covers
`tools/phase-run/**` and `.claude/workflow.json`, not `tools/doc-*.mjs`. An edit there now changes
nothing for the night: the commit hook and the gate judge with the copy. It does show in the diff.

**Why does the hook pass `PHASE_RUN_ROOT` when the session already has it?** The hook's `root` is
what the guard aims at. Passing it makes the copy check that exact tree.

## References

- ADR 0005 (amended); `docs/discovery/05-brigade-0.7.0.md` D10; spec #27.
- Code: `template/tools/phase-run/snapshot.mjs` `docTools` / `runnerCode` / `takeSnapshot`,
  `run.mjs` `docCheck`, `template/tools/doc-lib.mjs` `TOOLS_ROOT` / `checkedRoot` / `IN_COPY`,
  `template/tools/doc-check.mjs` `BASELINE_PATH` / `IN_RUN`, `hooks/guard-shell.mjs` `copyTookDocCheck`.
- Tests: `template/tools/phase-run/run.test.mjs` (the D10 block), `template/tools/doc-tools.test.mjs`
  (`withCopy`), `tests/guard-shell.test.mjs`.
