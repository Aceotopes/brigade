# #010 — Trim, with a project keep list

**Ticket:** `#21` · **Devlog:** `#15` · **ADRs:** 0005 (the runner snapshot)
**Date:** 2026-11-08

---

## The Problem

A night session loads every plugin, skill and MCP server the owner has installed: 113 skills on
the probe's machine. Most of them are never used at night, and every one is read again on each turn.
The probe (#12) showed that switching off one plugin, one skill and every MCP server cut a
session's cost by about half, and left Brigade's own hooks and skills alone. D16 in discovery doc 04
settles the shape: a per-machine list of what the owner's nights don't need, a project that never
loses what it enables itself, and a project keep list for the user ones it does need.

## The Solution

- **The machine's list**, `~/.claude/brigade/trim.json` (`$CLAUDE_CONFIG_DIR/brigade/trim.json` when
  that is set): `{plugins, skills, flags}`, each optional, with a `note` allowed. A missing file
  means no trim. `template/tools/phase-run/trim.mjs` `readTrim` / `parseTrim` refuses, with the
  offending name in the message:
  - a flag off `TRIM_FLAGS` (`--strict-mcp-config`, `--no-chrome`);
  - a `brigade@*` plugin row, which would switch off the night's own hooks, and a `brigade:*` skill;
  - a plugin row that isn't a plugin id (`name@marketplace`), an unknown key, a list that isn't a
    list of names, or a file that isn't JSON.
- **Read at preflight.** A refused file is one of preflight's problems, so the run stops before it
  starts, and a dry run shows it too. The parsed list is kept on `run.trim`.
- **The entries.** `trimEntries` turns the list into `enabledPlugins: {id: false}` and
  `skillOverrides: {name: "off"}`, and writes nothing for:
  - a plugin the project's own `.claude/settings.json` enables (`true`), or a skill folder in its
    `.claude/skills` (`projectKeeps`);
  - a plugin or skill named in the new `phaseRun.keep: {plugins, skills}`;
  - a skill named `<plugin>:<skill>` whose plugin is one of the two above.
- **Into each night ticket's settings.** `writeSessionSettings` (from #16) writes
  `trimmedSettings(sessionSettings(…), run.trim, ROOT, config.keep)`. `withTrim` merges the entries
  over the base settings' own. `sessionSettings` itself is untouched, so the Edit denials, the
  `env` block (`PHASE_RUN_RUNNER`, `PHASE_RUN_ROOT`) and #25's change the same night stay apart.
- **The flags.** The session object carries `flags: run.trim?.flags ?? []`. The argument lists are now
  pure functions, `printArgs` and `backgroundArgs`:
  - a `-p` call puts the flags on its first call and on every resume, since each call is a process of its own;
  - a background session gets them on its first launch only. A `--bg --resume` takes no flag at
    all (point 5 in `run.mjs`: any flag starts a copy), and the session keeps its launch flags as
    it keeps its `--settings`.
- **`phaseRun.keep`** in `config.mjs` (`parseKeep`): `{plugins, skills}`, lists of names. The hooks'
  loader passes over it, as it passes over every `phaseRun` key but the gates' references and the
  tampering section, so it was already accepted there. A test runs it through both.
- **Attended sessions get no trim**: only `run.mjs` imports `trim.mjs`. A test checks that no hook and
  no setup script does.
- **Docs:** the template's phase-run guide names `phaseRun.keep`. How to write `trim.json` is #24's.

## Why This Approach

**Trim belongs to the machine, keep belongs to the project.** What the owner never uses at night is
the same on every project on one machine, so it lives once, beside Claude Code's own config. What
one project needs is that project's business, and lives in its `workflow.json`, where the snapshot
freezes it for the run. The project's own settings win without being listed: a plugin it enables
is one it needs.

**Rules as data over a small fixed set of kinds.** The code knows three kinds (a plugin to switch
off, a skill to switch off, a flag from a closed list) and nothing about which plugins exist. The
flag list is closed because a flag can do anything, and a typo or a permissions flag in a per-machine
file would change every night without a trace in the project.

**The settings writer stays one function.** Trim wraps it instead of growing it. So the trim lines
can't clash with #25, which touches `sessionSettings` the same night, and a test can compare the
merged settings with the plain ones field for field.

Interview version: "Night sessions were paying to load a hundred skills they never used. I added a
per-machine list of what to switch off, which the runner turns into the settings Claude Code already
understands: plugins disabled and skills off, plus two flags from a fixed list. The project always
wins: anything its own settings enable, its own skills, and a keep list in its config are never
switched off. And it is night-only by construction: only the runner reads the file."

## Alternatives turned down

- **Trim in `sessionSettings`.** It would share lines with #25's change, and the function would know
  about the machine's config. A wrapper keeps the concerns apart.
- **A flat `phaseRun.keep` list** (plugins told from skills by the `@`). `{plugins, skills}`
  matches trim.json's own shape and reads plainly in a config.
- **A `flags` key in `phaseRun.keep`** (a project that needs Chrome or its MCP servers). D16 names
  plugins and skills only. It is noted for #24 below.
- **Snapshotting trim.json.** The snapshot freezes what judges a run. Trim only lightens it, and it
  is per machine, so a restart reads it again.
- **A new `trim.test.mjs`.** Every test command here is a fixed file list, and the stop check's
  lives in `.claude/workflow.json`, which a night can't edit. The seam tests are in `run.test.mjs`.
- **(Review) Test the wiring itself** (preflight's message, `writeSessionSettings`, `runTicket`'s
  `flags`). They read module globals (`config`, the live `settings.json`) and spawn nothing a test
  can reach without a run. The tests cover the pure seams those three lines call.
- **(Review) A table per trim kind** (settings key to value) in place of plugins and skills written
  out side by side. There are two kinds, and D16 names no third. A table can wait for one.
- **(Review) Share `parseTrim`'s checks with `config.mjs`'s `keys`/`list`/`text`.** `config.mjs`
  may not grow an import outside the stop-tests copy's list, and `trim.mjs` importing `config.mjs`
  for three tiny helpers ties a per-machine file to the project config's messages. The plugin-id
  regex is written out in both, with a comment.
- **(Review) Rename `projectKeeps` to `projectEnabled`.** It returns what trim keeps for the project,
  beside `phaseRun.keep`, and the name matches that use.
- **(Review) Read `.claude/settings.local.json` too.** The ticket names `.claude/settings.json`. It
  is listed under the assumptions below.

## Real bugs found along the way

- **(Review) `phaseRun.keep.plugins` took any name.** `["figma"]` was accepted and never matched
  `figma@…`, so the plugin was switched off anyway. It is now refused as trim.json's rows are.
  pinned: `tests/phase-run-config.test.mjs`.
- **(Review) An unreadable project settings file meant "the project enables nothing".** A BOM, as
  PowerShell 5.1 writes, made `JSON.parse` throw, and every plugin the project enables was trimmed
  without a word. The BOM is stripped now. A file that still isn't JSON is a preflight problem, and
  later it trims nothing for that ticket, with a log line. A dangling link in `.claude/skills` no
  longer costs the other skills their keep. pinned: `run.test.mjs` ("read through a BOM").
- **(Review) A kept plugin skill lost its plugin.** `keep.skills: ["figma:figma-use"]` kept the
  skill but still switched `figma@…` off, which takes the skill with it. A kept skill now keeps its
  plugin. pinned: `run.test.mjs` ("trim writes no entry…").
- **(Review) `phaseRun.keep: null` read as empty.** It is refused as not an object.
- **Found elsewhere, not fixed here:** none.

## What This Concretely Unblocks

- **#24** (the finish ticket): the live check of the saving, and the guide's section on writing
  `trim.json`.

## Run by hand

- The owner writes their own `~/.claude/brigade/trim.json` after release (the guide, #24, says how).

## Assumptions made

- **`phaseRun.keep` is `{plugins, skills}`**, the same shape as trim.json. To make it a flat list:
  `parseKeep` in `config.mjs` and `trimEntries`' `keep`.
- **Entry keys:** plugins by id (`name@marketplace`, as `claude plugin list` prints it), skills by
  the name Claude Code lists (`plugin:skill`, or a bare name for a user or project skill). The probe
  used these shapes. #24's live check confirms them.
- **A project skill is a folder under `.claude/skills`**, by the folder's name. To read each
  `SKILL.md`'s `name` instead: `projectKeeps`.
- **Only `true` in the project's `enabledPlugins` counts as enabled.** A plugin the project sets
  `false` may still be trimmed, which changes nothing. To change it: `projectKeeps`.
- **A `<plugin>:<skill>` row and its plugin go together**: a kept plugin keeps its skills, and a
  kept skill keeps its plugin. To drop either: `trimEntries`.
- **A `brigade:*` skill row is refused**, for the same reason as `brigade@*` (doc-sync and the other
  skills a night uses). To allow it: `parseTrim`.
- **A `--bg` resume keeps its launch flags**, as it already keeps its `--settings`. Point 5 forbids
  passing them again. #24's live check confirms it.
- **Only `.claude/settings.json` is read for the project's plugins**, as the ticket names it, not
  `.claude/settings.local.json`. To add it: `projectKeeps`.

## Handed forward

- **#24:** confirm live that a `--bg` resume keeps `--strict-mcp-config` and `--no-chrome`, and that
  the `skillOverrides` keys are skill names as listed. Also say in the guide that
  `--strict-mcp-config` drops the project's own `.mcp.json` servers too, since no `--mcp-config` is
  passed. A project that needs them leaves that flag out of trim.json for now.
- **#24:** the template's phase-run guide is now at 504 of its 560 lines, the 90% that
  `tests/template.test.mjs` allows. The guide's trim section needs room made first (a `max-lines`
  raise or a cut), or that test fails.

## Common Questions

**Does an attended session ever see the trim?** No. Only the runner reads trim.json, and it writes
the entries into the per-ticket settings file it hands to `--settings`.

**What if trim.json is broken mid-run?** It was read once at preflight, so the run keeps the list it
started with. A broken file stops the next run's preflight.

**Was a browser check run?** No. Backend only: no screen changes.

**Why is `template/docs/guides/phase-run.md` touched, outside the Areas?** It lists every `phaseRun`
key, and a new key without a line there can't be found. #19 and #20 made the same kind of change.

## References

- Spec #11, `docs/discovery/04-brigade-0.6.0.md` D16 and the probe's addendum (#12), ADR 0005.
- `template/tools/phase-run/trim.mjs`, `run.mjs` (`preflight`, `writeSessionSettings`,
  `trimmedSettings`, `printArgs`, `backgroundArgs`, `runTicket`), `config.mjs` (`parseKeep`).
- Tests: `template/tools/phase-run/run.test.mjs`, `tests/phase-run-config.test.mjs`.
- Gotchas: `docs/agents/gotchas/measure-trim.md`, block `#21`.
