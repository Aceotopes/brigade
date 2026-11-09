---
status: amended
---
# One phase run is judged by one frozen copy of the runner and one Brigade version

> **Amended 2026-11-09 (#31, D10):** the copy also takes `tools/doc-check.mjs`, every doc tool it
> imports and `tools/doc-check-baseline.json`. Inside a run the gates and the commit hook run the
> copy's doc-check against the repo, and `--update-baseline` is refused. A restart compares the doc
> tools as runner code; the baseline and `tools/doc-config.mjs`, like the config, stay the copy's.

A phase run is many sessions, started hours apart, and everything that judges them used to be
read live:
- the runner code in `tools/phase-run/`;
- the rules in `.claude/workflow.json`;
- Brigade's hooks, from whichever plugin version was installed when each session started.

A shell write, an edit by the owner, or a plugin auto-update between two tickets would judge the
rest of the night by other rules, and the morning report couldn't show it.

At run start the runner copies `tools/phase-run/` and `.claude/workflow.json` into the run's
folder. It sets `PHASE_RUN_RUNNER` to that copy in every ticket's settings, and while it is set,
the plugin's hooks read the copy's config and import the copy's runner code. The run-start Brigade
version goes in the copy's manifest.
- Night sessions' settings switch Brigade's auto-update off, so an update arrives at the owner's
  next fresh session.
- If a ticket would still launch under another version (an attended session elsewhere updated it),
  the run stops cleanly and says so.
- The version is shown in the morning report and on every ledger row.

## Considered options

- **`--setting-sources user,local`, as the source project does.** Its hooks are project hooks, so
  without the flag a copy of them would run beside the live ones. That same flag dropped its project
  skills, which then had to be re-wrapped as a plugin. Brigade's hooks are plugin hooks, so it has
  neither problem, and the flag would only bring in new risk: a project-scope plugin, Brigade
  itself, might not load.
- **Copy the plugin into the snapshot too, loaded with `--plugin-dir`.** That freezes the hooks
  fully, but risks Brigade loading twice, once from the project's settings and once from the copy.
- **Only stop the run on a version change.** It's simpler, but a routine update would cost the
  rest of the night. Deferring the update keeps the night and still catches the rare change.
- **Let a night edit the runner, as the source project does.** In a project the runner is
  Brigade's stamped copy, so the Edit deny on `tools/phase-run/**` and `.claude/workflow.json`
  stays, and the copy is a backstop.

## Consequences

- Hooks gain a second place to read from. Attended (no `PHASE_RUN_RUNNER`) they read the live tree,
  as before.
- The session's own check command must also run from the copy, or it would write receipts that the
  hook judges with different code.
- The night's settings carry an override of Brigade's catalog entry, so the settings writer must
  keep that entry's other keys.
