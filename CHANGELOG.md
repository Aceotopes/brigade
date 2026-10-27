# Changelog

What changed in each version, for `/update-workflow` to show a project before it re-copies the
template. Newest first. A version that changes a config file's format says so, and ships its
migration in `scripts/migrations.mjs`.

## 0.2.0 — 2026-10-27
- `/setup-workflow` and `/update-workflow`: set a project up (new, overwrite or merge) and keep its
  template files current. Each project carries a stamp, `.claude/workflow-version.json`.
- The phase runner reads the project's `phaseRun` section of `.claude/workflow.json` (README step 7).
- doc-check: the baseline can list docs accepted without a header (`headers`), written once by
  `--adopt`; `--update-baseline` only shrinks that list.

## 0.1.0 — 2026-10-27
- The workflow lifted from its first project: the hooks, the doc tools, `doc-sync`, `ticket-check`
  and the phase runner, made generic (README steps 1–6).
