---
name: update-workflow
description: Bring a set-up project's template files up to the installed Brigade plugin's version. Use when the owner types /update-workflow after updating the plugin. Shows what changed since the project's stamp and every file it would replace, never overwrites a file the project edited or its config, and stops before the commit.
disable-model-invocation: true
---

A plugin update reaches the skills and hooks by itself, but not the template files already copied
into this repo (the doc tools, the phase runner, the workflow docs). This re-copies them. It is safe
because a project never edits a template file: its own details live in config, which this never
touches.

`node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs"` does the work; `<dir>` is the project's root.

1. A dirty tree: list it and stop until the owner commits or stashes, so the update is its own diff.
2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" update <dir>`: a report, nothing written. No stamp
   (`.claude/workflow-version.json`): the project was never set up; point at `/setup-workflow`.
3. Tell the owner, plainly:
   - "This project is on `<from>`; the plugin is `<to>`." The same version: nothing to do; stop.
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
4. On a yes: the same command with `--apply` (and `--remove` if agreed). It stages what it changed.
5. `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" verify <dir>`. A failure is fixed, never by
   loosening a check.
6. Add the devlog entry this commit needs, on top of `docs/history/devlog.md`
   (`## #N · chore · update the workflow to <to>`, the files that changed), and draft the message
   `chore: update the workflow to <to> — devlog #N`. **Stop**: the owner says when to commit.
