# Changelog

What changed in each version, for `/update-workflow` to show a project before it re-copies the
template. Newest first. A version that changes a config file's format says so, and ships its
migration in `scripts/migrations.mjs`.

## 0.2.2 — 2026-10-27
Fixes from the trials' finish review and the two existing-repo trials (overwrite, merge).
- Setup writes `.github/workflows/checks.yml`: the stop gate's checks on every push and pull
  request (install, a Prisma client if there is one, each check), so a green pull request means
  the project's own tests ran. It is project config: update never touches it, so a project set up
  before 0.2.2 does not get one from an update and writes its own.
- `/update-workflow` lists a starting file (`scaffold/`) whose plugin copy changed, as `review`,
  and never writes it. The stamp now records the starting files; an older stamp says it cannot
  list earlier changes, and the next update records them.
- A `CLAUDE.md` or `AGENTS.md` one folder down (a `docs/CLAUDE.md`) is found: overwrite names its
  archived copy for the rules carry-over (`oldRules`); merge points the new `CLAUDE.md` at it.
- The phase runner refuses plainly when the repo has no GitHub remote, and a dry run stops there
  instead of failing on a stack trace.
- `CLAUDE.md`'s commands list the dev server and the build too.
- The CI template no longer names another project's devlog entries.

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
- The phase runner reads the project's `phaseRun` section of `.claude/workflow.json` (build step 7, docs/development.md).
- doc-check: the baseline can list docs accepted without a header (`headers`), written once by
  `--adopt`; `--update-baseline` only shrinks that list.

## 0.1.0 — 2026-10-27
- The workflow lifted from its first project: the hooks, the doc tools, `doc-sync`, `ticket-check`
  and the phase runner, made generic (build steps 1–6, docs/development.md).
