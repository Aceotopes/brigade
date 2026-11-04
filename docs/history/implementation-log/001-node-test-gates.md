# #001 — Setup proposes Node test gates for a repo without package.json

**Ticket:** `#9` · **Devlog:** `#2` · **ADRs:** `adr/0001`
**Date:** 2026-11-04

---

## The Problem

`/setup-workflow` proposes a project's stop checks and phase-run gates from its `package.json`
scripts. A repo that runs its tests on Node's own test runner and has no `package.json` (Brigade
itself: `tests/*.test.mjs`) got nothing proposed, so the owner had to type the gates by hand, and
the skill's only hint was a bare `node --test`, which in a set-up project also runs the template's
`tools/*.test.mjs` in every gate.

## The Solution

- `detect(dir)` returns a new field, `nodeTests`: the files directly inside a top-level `test/` or
  `tests/` folder named `*.test.mjs`, `*.test.js` or `*.test.cjs`, turned into one glob per folder
  and extension (`tests/*.test.mjs`), each once, sorted. The small exported helper
  `nodeTestGlobs(files)` does the matching, on the file list `detect` already builds.
- `stackChecks(det)`, when `det.packageJson` is false and `nodeTests` is not empty, adds one row
  `{ key: "test", label: "Tests", run: "node --test <globs>" }`. Because its key is `"test"`,
  `proposeWorkflow` gives it the receipt and `unread` list in the stop gate and `alone: true` in
  the gates with the code it already had: no new branch there.
- `skills/setup-workflow/SKILL.md` §3 says such a repo now gets its tests proposed, and warns off a
  bare `node --test`; `CHANGELOG.md` has an `## Unreleased` entry.

Run on Brigade itself, `node scripts/setup.mjs propose .` now gives `node --test tests/*.test.mjs`
as the Tests stop check (receipt, `unread: ["docs/**", "*.md"]`) and the `tests` gate (`alone`).

## Why This Approach

It reads files the repo has, the same way the `package.json` proposal reads scripts the repo has,
so it stays inside ADR 0001 (no per-tool recipes): it is not a "Node" recipe row, it is the
project's own test files, listed. Keeping the row's key `"test"` meant the receipt, `unread` and
`alone` came for free and stay identical in shape to the `package.json` tests row.

Interview version: "Setup used to infer gates only from `package.json` scripts. I added a second
source, the test files themselves, but only when there is no `package.json`, so the existing source
of truth wins and nothing changes for those projects. I fed it through the same row shape, so the
downstream code didn't change at all."

## Alternatives turned down

- **An early return in `stackChecks` for a repo without `package.json`.** Simpler, but a repo with a
  lockfile and `tsconfig.json` and no `package.json` gets a typecheck row today, and would have lost
  it. The Node row is appended instead.
- **A bare `node --test`.** Short, but Node then finds every `*.test.*` in the tree, including the
  template's `tools/*.test.mjs` in a set-up project. The ticket rules it out.
- **Reading the disk instead of `detect`'s file list.** The file list skips gitignored and
  `node_modules` files already; the disk would not.

From the code review (Standards and Spec reviewers), turned down:
- **Drop the second `## Unreleased` line (the `PHASE_RUN` fix): the ticket asks for "one short
  entry".** Kept: a template file that projects receive changed, and `/update-workflow` shows the
  changelog to them; in a project the file is `tools/doc-tools.test.mjs`, the path the line names.
- **Drop `?.` from `det.nodeTests?.length`, since `detect` always sets it.** Kept: `stackChecks`
  and `proposeWorkflow` are exported, and a `det` built by hand without the field must not throw.
- **The root `tools/doc-tools.test.mjs` now differs from the template's copy.** Left: it is the
  released copy doing the building, re-copied by `/update-workflow` after the next release;
  reported for the owner instead.
- **The `{ key: "test", label: "Tests", run }` literal now appears twice in `stackChecks`.** Too
  small to extract; a helper would hide the two rows' different sources.

## Real bugs found along the way

**The suite failed when run from inside a phase run.** The stop check and the gates run the tests
with this session's `PHASE_RUN`, `PHASE_RUN_BASE` and `PHASE_RUN_TICKET` set. Five tests spawn
doc-check "attended" with the inherited environment, so doc-check behaved as inside a phase run and
refused (a raised budget, `--adopt`, a merged repo's header-less docs): 188 of 193 passed, with
nothing of this ticket's code involved. `tests/helpers.mjs`' `runHook` already stripped `PHASE_RUN*`
for this reason; these paths didn't. The fix strips them at the top of `tests/helpers.mjs` (which
`setup.test.mjs` imports) and of `template/tools/doc-tools.test.mjs`, so a suite run inside a phase
run sees an attended session unless a test sets the variables itself, as the "inside a phase run"
tests already do. `template/tools/doc-tools.test.mjs` is outside the ticket's Areas: changed
because the ticket cannot pass its own stop check without it, kept to three lines. The released
root copy, `tools/doc-tools.test.mjs`, still has the leak (no gate runs it; `/update-workflow`
re-copies it after the next release).

## What This Concretely Unblocks

Setting up Brigade (or any `node --test` repo without `package.json`) proposes its tests gate
instead of none. `refresh` calls `proposeWorkflow`, so an already set-up repo of this kind is offered
the row on its next refresh.

## Run by hand

None.

## Assumptions made

- `nodeTests` reads `detect`'s existing file list, so a gitignored test file is not counted. To
  reverse: match against `walk(dir)` instead of `files` in `detect`.
- The Node row goes after any `package.json`-path rows (only a typecheck can come before it, from a
  lockfile plus `tsconfig.json`). To reverse: put `nodeTests` first in `stackChecks`' return.
- The test files strip `PHASE_RUN*` from their own process at load, rather than `apply`/`verify`
  scrubbing the environment they pass doc-check (that would change shipped behaviour to fix a
  test harness). To reverse: remove the loop at the top of `tests/helpers.mjs` and
  `template/tools/doc-tools.test.mjs`.
- Only top-level `test/` and `tests/` count, as the ticket says: Brigade's own
  `template/tools/*.test.mjs` gates are still the owner's to name (its `.claude/workflow.json` keeps
  them).

## Common Questions

**Why not also look at `src/**/*.test.js`?** The ticket limits it to the conventional top-level
folders; anything else is a choice the owner makes, and a wrong guess would look authoritative.

**What if a repo has both a `package.json` and `tests/*.test.mjs`?** It is proposed exactly what it
was before; the `package.json` scripts stay the source of truth (pinned by a test).

**Does the phase run allow `node --test` without a package manager?** Yes: the runner's own
settings allow `Bash(node *)`.

## References

- Ticket #9; `scripts/setup.mjs` (`nodeTestGlobs`, `detect`, `stackChecks`, `proposeWorkflow`).
- Tests: `tests/setup.test.mjs`, the three "Node test(s)" tests.
- `docs/adr/0001-no-stack-recipes.md`; gotchas: `docs/agents/gotchas/dogfood.md` block `#9`.
- No browser check: a backend-only ticket (setup's script, no screen).
