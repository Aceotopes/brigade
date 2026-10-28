---
name: roadmap
description: Keep the project's roadmap (docs/status/roadmap.md) in step with GitHub and publish the roadmap page, the visual of where the project stands. Use when the owner asks to see or update the roadmap, at a phase's end (doc-sync's phase-end tier), or after a phase's pull request merges. Proposes every roadmap.md change as a diff and writes it only on the owner's yes.
---

The roadmap is the one record of where the project stands: its modules in build order and their
phases, in fixed tables in `docs/status/roadmap.md`. The roadmap page is a view of it, drawn by
Brigade's page template, never edited by hand: to change the page, change the file.

`node "${CLAUDE_PLUGIN_ROOT}/scripts/roadmap.mjs"` does the work (its header lists the commands);
`<dir>` is the project's root. Work files go in `.git/brigade/`, never committed.

## 1. The roadmap file

`node "${CLAUDE_PLUGIN_ROOT}/scripts/roadmap.mjs" check <dir>`.

- **`converted` false**: the roadmap predates the tables (a free-form `roadmap.md`). Offer to convert
  it: read it, draft the two tables in the format of the scaffold's `docs/status/roadmap.md`
  (Modules `| # | Module | Depends on | Stands |`, Phases `| Phase | Module | Spec | Branch | Stands |`,
  between `<!-- brigade:roadmap -->` and `<!-- /brigade:roadmap -->`, then `## Noted for later`),
  keeping every fact it had, and show the diff. Write it on a yes; otherwise stop here.
- **`problems`**: the format is broken (a status word, a missing module). Show them and fix them
  with the owner; doc-check refuses a commit until they are fixed.

## 2. Bring it in step with GitHub

`changes` lists the Stands each row would get from GitHub: a phase is building while its pull request
is open and merged once it merges; a module is building once a phase is under way and delivered when
every phase is merged. A `blocked` row is never changed: it is the owner's call. Show each change as
a line of the diff, with its reason. On a yes:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/roadmap.mjs" apply <dir> --accept all` (or the ids the owner
picked, `--accept 1,3`). Nothing to change: say so and go on.

`waitingOnYou` lists tickets a phase run parked (`needs-info`, `ready-for-human`): they show on the
page; they are not a status change.

## 3. Publish the page

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/roadmap.mjs" render <dir> --out <dir>/.git/brigade/roadmap.html`.
2. Publish it with the Artifact tool, `file_path` that file, `description` "Where <project> stands:
   its modules in build order and their phases."
   - `.claude/workflow.json` has `roadmap.artifact`: publish with that `url`, so the page keeps its
     link (an artifact from an earlier conversation: `read` it first, as the tool requires). Omit
     `icon`.
   - It has none: publish a new page with `icon` "map", then record its link as `roadmap.artifact`
     in `.claude/workflow.json` (one key; show the change) so the next run updates the same page.
3. **No Artifact tool** here (not signed in, a cloud run): say the page is at
   `.git/brigade/roadmap.html` to open in a browser, and that running `/roadmap` where Artifacts work
   publishes it. Leave `roadmap.artifact` as it was.

Never publish the page from `roadmap.md` itself or hand-edit the rendered HTML: the template is
Brigade's (`skills/roadmap/page.html` in the plugin), and the data comes only from the files.

## 4. Stop

Changes to `roadmap.md` or `.claude/workflow.json` are left for the owner's commit, with a devlog
entry like any other (`## #N · docs · update the roadmap`), unless this runs inside a finish ticket
that commits them. Give the page's link.
