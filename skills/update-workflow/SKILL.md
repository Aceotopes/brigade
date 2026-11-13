---
name: update-workflow
description: Bring a set-up project's template files up to the installed Brigade plugin's version. Use when the owner types /update-workflow after updating the plugin. Shows what changed since the project's stamp and every file it would replace, never overwrites a file the project edited, writes the config only for the offers the owner accepts row by row, and stops before the commit.
disable-model-invocation: true
---

A plugin update reaches the skills and hooks by itself, but not the template files already copied
into this repo (the doc tools, the phase runner, the workflow docs). This re-copies them. It is safe
because a project never edits a template file: its own details live in config, which the copy never
touches. A newer release's keys for the config's rows are offered at the end, one yes per row.

`node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs"` does the work; `<dir>` is the project's root.

1. A dirty tree: list it and stop until the owner commits or stashes, so the update is its own diff.
2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" update <dir>`: a report, nothing written. No stamp
   (`.claude/workflow-version.json`): the project was never set up; point at `/setup-workflow`.
3. Tell the owner, plainly:
   - "This project is on `<from>`; the plugin is `<to>`." The same version, no `setting` and no
     `offers`: nothing to do; stop.
   - What changed: the `changelog` sections, as they read.
   - `replace` and `add`: the files that will be rewritten or added.
   - `conflict`: a template file the project edited (or deleted, or setup never wrote). It is left
     alone. Show the difference: `git diff --no-index -- <file> "${CLAUDE_PLUGIN_ROOT}/template/<file>"`.
     The fix is to move the project's change into its config and take the plugin's file; ask, file
     by file, and do only what the owner picks.
   - `gone`: files the plugin no longer ships. Kept unless the owner says remove (`--remove`, and only
     the unedited ones go).
   - `review`: a starting file (`scaffold/`: `CLAUDE.md`, the devlog, the status docs, the index
     heads) whose plugin copy changed. The project owns its copy, so update never writes it. Show
     `git diff --no-index -- <file> "${CLAUDE_PLUGIN_ROOT}/scaffold/<file>"` and point at the lines the
     changelog names (the rest of the diff is the project's own writing); carry a change over only if
     the owner picks it, by hand. A new starting file is added only if the owner wants it.
   - `notes`: say each one (an older stamp cannot list earlier starting-file changes).
   - `migrations`: config format changes this update makes, one line each.
   - `setting`: auto-update for Brigade's catalog is off in `.claude/settings.json`. Turned on, a new
     release reaches the project by itself. Ask; it is a separate yes. A note saying "by hand"
     means a rewrite would reformat the file: show the line to add instead.
   - `offers`: keys a newer release gives the config's rows (say how many; step 5 asks about each).
4. On a yes: the same command with `--apply` (and `--remove`, `--auto-update` if agreed). It stages
   what it changed. The config is never touched here.
5. The offers, after the template copy, one yes per row (AskUserQuestion, up to 4 per call, each
   offer's `summary` as its question). Each adds keys to a row the stack suggests; a hand-written
   row never gets one, and a row's own values are never changed. An offer of a stop check's
   `"unread"` list is the files that check never reads: say so, and that a list too wide only skips
   the stop check's courtesy rerun (the runner's gates still run everything). On any yes:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" refresh <dir> --apply --only-accepted --accept <the ids>`,
   which writes those rows and nothing else, and stages them. A declined offer is asked again on the
   next update.
6. Then the project's own tools: walk `/setup-workflow`'s §3 items under "Then the project's own
   tools" (the plugin's `skills/setup-workflow/SKILL.md`) for each key the config still lacks: a
   name, the tests' `{base}` command, the tampering rows, the build gate's `when` and `after`, each
   `{cache}` flag and `unread` list, and each lint and typecheck hygiene piece. One yes each; write
   the yeses into `.claude/workflow.json` (and the tool's own config for hygiene) by hand, never
   changing a hand-written row's own values. A flag goes after the row's command, and the row keeps
   its name, so refresh and the next update still know it.
7. `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" verify <dir>`. A failure is fixed, never by
   loosening a check. A `warn` line (the listed-code rule's scan) is said, never a failure.
8. Add the devlog entry this commit needs, on top of `docs/history/devlog.md`
   (`## #N · chore · update the workflow to <to>`, the files that changed and the offers taken), and
   draft the message `chore: update the workflow to <to> — devlog #N`. **Stop**: the owner says when
   to commit.
