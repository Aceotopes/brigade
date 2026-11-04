---
job: Phase dogfood (Brigade on itself): the traps a session must know before touching its files.
kind: living
max-lines: 800
---
# Gotchas — Phase dogfood: Brigade on itself

Read only the blocks your ticket names, or whose files you will touch. Every phase's file is
listed in the gotchas index, `docs/agents/gotchas/README.md`.

## The blocks

**`#9` — setup's Node test gates, `scripts/setup.mjs` `detect` / `stackChecks` (built 2026-11-04):**
- `nodeTests` is read from the file list `detect` already builds (git's tracked and
  untracked-not-ignored files, or the walk outside git), not from the disk: a gitignored test file
  does not count.
- The Node row is added *after* the `package.json` path, never instead of it: a repo with a lockfile
  and `tsconfig.json` but no `package.json` still gets its typecheck row. With a `package.json` the
  row never appears (pinned: `tests/setup.test.mjs`, "whatever Node tests it has").
- A repo with no package manager still gets no guard `wrappers` and no `phaseRun.permissions`;
  the `node --test` gate runs on the runner's own `Bash(node *)` rule
  (`template/tools/phase-run/settings.json`).
- This phase runs the suite with `PHASE_RUN*` set. A test that spawns doc-check (or anything that
  reads those variables) "attended" must not inherit them: `tests/helpers.mjs` and
  `template/tools/doc-tools.test.mjs` strip them at load. A new test file that spawns doc-check
  without importing `tests/helpers.mjs` needs the same one-line loop.
