---
job: The timeline of this phase, one entry per commit, newest first.
kind: log
max-entry-lines: 15
---
# Devlog

Each commit's entry goes on top, in the shape of `docs/_templates/devlog-entry.md`, and the commit
message cites it (`devlog #N`). At each phase end, `node tools/doc-rotate.mjs` moves the closed
entries into `docs/history/devlog/`.

## #1 · chore · adopt the workflow
- {{DATE}}: the Brigade workflow set up by `/setup-workflow` ({{MODE}}): the doc tools, the phase
  runner, the workflow docs and this repo's config in `.claude/workflow.json`.

---
