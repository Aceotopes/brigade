# Changelog

What changed in each version, for `/update-workflow` to show a project before it re-copies the
template. Newest first. A version that changes a config file's format says so, and ships its
migration in `scripts/migrations.mjs`.

## 0.2.1 — 2026-10-27
Fixes from the first trial run (an empty repo, one ticket).
- The phase runner no longer crashes when a background session ends: one call still named the
  helper step 7 renamed (`stopStray`). A new plugin test fails on any call to a name nothing defines.
- The report points at the pull request only when there is one, and holds the finish ticket as
  "built attended" instead of sending it to `/ticket-check`.
- Gotchas files are flat by default (`docs/agents/gotchas/<phase>.md`). A project that groups
  phases into modules sets `GOTCHAS_FILE` in `tools/doc-config.mjs`; without it, the flat path.
  No migration: the export is optional.
- doc-check no longer prints git's "exists on disk, but not in 'HEAD'" for each new doc.
- `/ticket-check` says its `spec-issues.json` commit needs a devlog entry, and drafts the message.

## 0.2.0 — 2026-10-27
- `/setup-workflow` and `/update-workflow`: set a project up (new, overwrite or merge) and keep its
  template files current. Each project carries a stamp, `.claude/workflow-version.json`.
- The phase runner reads the project's `phaseRun` section of `.claude/workflow.json` (README step 7).
- doc-check: the baseline can list docs accepted without a header (`headers`), written once by
  `--adopt`; `--update-baseline` only shrinks that list.

## 0.1.0 — 2026-10-27
- The workflow lifted from its first project: the hooks, the doc tools, `doc-sync`, `ticket-check`
  and the phase runner, made generic (README steps 1–6).
