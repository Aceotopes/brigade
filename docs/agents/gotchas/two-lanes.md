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

**`#33` — the worktree, `template/tools/phase-run/lane.mjs`, `run.mjs` `work` / `sessionState` / `runVariables` / `main`, `config.mjs` `laneQaUrl` (built 2026-11-10):**
- Two roots: run state (lock, results, logs, the copy, trust, the Brigade version, `.env`) reads `ROOT`/`STATE`; the session's files and commands read `work`/`sessionState()`. A new path must pick one (ADR 0007). pinned: `template/tools/phase-run/run.test.mjs` (the lane section).
- A lane's branch starts with `phase-` (`<branch>-lane-<id>`): the guard refuses a commit on any other. pinned: `tests/guard-shell.test.mjs`.
- `runVariables`' lane names are literal keys: `tests/env-contract.test.mjs` finds them by `PHASE_RUN_X:`. `PHASE_RUN_FAKE_NOW` is reserved there, and no runner file may name it.
- Both lanes share the branch's copy: only the last lane out may mark it finished (`mayFinishCopy`), or a third start wipes it under a live lane. pinned: the lane section.
- The lane lock is `.phase-run/lane-<id>.lock`, never under the branch's folder: the branch join reads it to learn the branch.
- `prepareWorktree` refuses a lane branch ahead of the phase branch: a reset would lose an unlanded pass. #37 lands them first instead, and must reset the lane branch after a replay, or the new hashes keep refusing.
- A lane's runner copy is taken from its worktree at the phase tip, never the primary's working tree, which a lane leaves on any branch. The lane's database is `laneDatabase` only (gotcha #29).
- In a lane, `./` in a permission rule is the worktree. The run's folder in the primary is denied by its absolute `//` form (`//d/…` on Windows). pinned: the lane section.

**`#34` — the claim and the frontier, `template/tools/phase-run/claim.mjs` `withClaimLock` / `takeClaim` / `laneChoice` / `claimNext` / `builtOn`, `run.mjs` `nextTicket` / `builtRef` (built 2026-11-10):**
- The choice runs inside the lock (`takeClaim`'s `choose`): read the claims, choose, write. A choice made before the lock lets two lanes take one ticket. pinned: `template/tools/phase-run/run.test.mjs` (two real processes).
- Nothing releases a claim yet: it lives until its lane's process exits. #37 releases it on land or park, and must do it under `withClaimLock`. pinned: none.
- A claim lapses on `pidAlive` alone. A reused pid keeps a dead lane's claim alive until that process exits. pinned: none.
- "Built" in a lane is `main..<phase branch>` (`builtRef`); a one-lane run keeps `main..HEAD`. Code that reads "built" goes through `builtOnBranch`, never its own `git log`. pinned: the claim section (source pin).
- A lane waits on another live lane's takes, not only its claims: a blocker that lane 1 may take next keeps lane 2 waiting. The loop ends when the other lane stops and exits. pinned: the claim section.
- A waiting lane is listed in the claim file's `waiting`, in the same locked write as its look, and the other lane counts neither its claims nor its takes (`idle`). Drop that and two lanes holding each other's blockers wait forever. pinned: the claim section ("never wait on each other").
- The lock is broken when its pid is gone, is the caller's own, or it stays empty past `UNREADABLE_GRACE_MS`. A live lock moved aside by mistake is written back by `wx`, never `linkSync`, which some file systems lack. pinned: the claim section (the lock test).
- The source pins in `run.test.mjs` normalize CRLF first: a Windows checkout of `run.mjs` has CRLF, and `"\n}\n"` never matches there.
