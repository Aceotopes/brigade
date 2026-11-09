---
job: Phase two-lanes (Brigade 0.7.0, two lanes): the traps a session must know before touching its files.
kind: living
max-lines: 800
---
# Gotchas — Phase two-lanes: Brigade 0.7.0, two lanes

Read only the blocks your ticket names, or whose files you will touch. Every phase's file is
listed in the gotchas index, `docs/agents/gotchas/README.md`.

## The blocks

**`#29` — the lane table, `template/tools/phase-run/config.mjs` `parseLanes` / `parseLane` / `parsePorts` / `parseHotspots` (built 2026-11-09):**
- Only the runner's loader checks `lanes`, `hotspots` and a port's `name`; the hooks' loader passes
  over them on purpose (owner, 2026-11-09). pinned: `tests/phase-run-config.test.mjs`.
- `lanes` and `hotspots` are parsed last, after `ledger`, so a config without them is refused, if
  at all, by the same check as before. Keep a new section's parse after the old ones.
- A row's QA database is its `qa`, else `phaseRun.qa.name`, for every row. Code that puts a lane's
  database into the url must use the same rule, or it disagrees with the refusal. pinned: the same test.
- `assert.throws(fn, /^…/)` never matches: Node tests a RegExp against `String(error)`, which starts
  `Error: `. The lane tests use a `refusal()` helper that returns the message.

**`#30` — hotspots and unnumbered entries, `template/tools/phase-run/numbering.mjs` `numberLane` / `scratchFor`, `template/tools/doc-check.mjs` `unnumberedProblems`, `run.mjs` `laneNumbers` / `runVariables` (built 2026-11-09):**
- One-lane prompts use `NNN` as a placeholder; in a lane it is literal text. pinned: `tests/phase-run-numbering.test.mjs`.
- Two counters, one token: a log's file name, its `# #NNN` title and a bare `NNN` take the log's number. pinned: the same test.
- `NUMBER_TOKEN` and `HOTSPOT_TOKEN` cannot import each other once installed; `laneToken` refuses a lane token doc-check won't accept. pinned: the same test.
- `numberLane` imports only from `tools/phase-run/`: the runner copy holds nothing else until #31.

**`#31` — the snapshot carries doc-check, `template/tools/phase-run/snapshot.mjs` `docTools` / `runnerCode`, `template/tools/doc-lib.mjs` `TOOLS_ROOT` / `checkedRoot`, `run.mjs` `docCheck`, `hooks/guard-shell.mjs` (built 2026-11-09):**
- The copy now holds `tools/doc-check.mjs`'s import closure and its baseline; runner code may import those from the copy, and nothing else of `tools/`. pinned: `template/tools/phase-run/run.test.mjs`.
- doc-lib has two roots: the baseline is read beside the file (`TOOLS_ROOT`), the docs and git from `ROOT`. A new doc-tool path must pick the right one. pinned: `template/tools/doc-tools.test.mjs` (`withCopy`).
- `PHASE_RUN_ROOT` redirects doc tools only when `PHASE_RUN_RUNNER` names their folder; never widen it to "whenever set", or a test's fixture doc-check checks the real repo. pinned: the same test.
- The runner's process has no `PHASE_RUN`: a refusal doc-check must make at the gate keys on its `IN_RUN` (`PHASE_RUN` or `IN_COPY`). pinned: `template/tools/phase-run/run.test.mjs` (the budget raise).
- `doc-config.mjs` is copied but not compared on a restart (config a ticket may edit); every other doc tool is. The manifest's `docCheck` lets the hook block a copy that lost its doc-check. pinned: the same test, `tests/guard-shell.test.mjs`.

**`#32` — the lane declaration, `template/tools/phase-run/ticket-size.mjs` `laneProblems`, `skills/ticket-check/SKILL.md`, the ticket template (built 2026-11-09):**
- `ticket-size.mjs` never imports `config.mjs` at the top: config imports its `RULE_KINDS`. Values it needs from config (`ANY_TICKET`) are passed in, from `main()`'s lazy import. pinned: `template/tools/phase-run/measure.test.mjs` (the lane tests pass `anyTicket`).
- A refused `## Lane` exits 1; a size or own-file warning exits 0. `/ticket-check` keeps `run-ready` off on the 1. pinned: none (`main()` calls `gh`).
- `## Lane` is matched exactly (`## Lanes` is another section), and the label decides, never the Areas. pinned: the same test.
- The two `ticket-template.md` copies are kept identical, and the template's sits at 105 of 108 lines (90% of its budget, `tests/template.test.mjs`): a further line there needs one taken out.
