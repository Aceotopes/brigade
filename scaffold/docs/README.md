---
job: Every doc in this repo and its one job, and the rules every doc keeps.
kind: living
max-lines: 300
---
# Docs

## The rules every doc keeps

- **One job.** Each doc states its job in its header. One fact has one home; other docs link to it.
- **A living doc holds no history.** It says how things are now. What happened goes in the devlog
  (`docs/history/devlog.md`) and the implementation log.
- **Every doc has a header**: `job`, `kind`, and a budget (`max-lines`, `max-entry-lines`). doc-check
  (`node tools/doc-check.mjs`) holds each doc to it on every commit; compress before raising one.
- **Four kinds:** `living` (kept true now), `log` (added to, rotated at each phase end), `record`
  (written once, then frozen), `generated` (a tool writes it, between its markers).
- New docs start from [`_templates/`](_templates/README.md).

## Every doc

<!-- generated:start doc-map -->
<!-- generated:end doc-map -->
