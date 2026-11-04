---
job: The timeline of this phase, one entry per commit, newest first.
kind: log
max-entry-lines: 15
---
# Devlog

Each commit's entry goes on top, in the shape of `docs/_templates/devlog-entry.md`, and the commit
message cites it (`devlog #N`). At each phase end, `node tools/doc-rotate.mjs` moves the closed
entries into `docs/history/devlog/`.

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
