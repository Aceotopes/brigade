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

**`#35` — the fingerprint, `template/tools/phase-run/fingerprint.mjs` `takeFingerprint` / `compareFingerprint`, `run.mjs` `browserCheckVerdict` / `runGates` / `finishBuilt` (built 2026-11-10):**
- The fingerprint is taken from the same `screenshotsSince` count that passed the gate. A second scan could count other files. pinned: `template/tools/phase-run/run.test.mjs` (the fingerprint section).
- A hash is of the working tree's bytes, not the git blob: compare on a tree checked out with the same line-ending settings. pinned: none.
- It holds only the files the ticket changed: a rebase that edits a shared source file the ticket never touched still says "carry" (D12's scope). pinned: none.
- `projectGates`' `browserCheck` callback still returns a string or null; the fingerprint leaves `runGates` by closure. Keep both of its passing returns `{ ok: true, fingerprint }`. pinned: the same section (a source pin that counts both).
- Screenshot paths are stored with `/`: `readdirSync`'s recursive names use `\` on Windows. pinned: the same section (a subfolder shot).

**`#36` — Landing, `template/tools/phase-run/landing.mjs` `landingPlan` / `land` / `lastNumbers` / `commandStep`, `numbering.mjs` `hotspotKind` (built 2026-11-10):**
- The plan writes only what differs from the lane's text. Writing `numberLane`'s whole output would put a no-row file back to the lane's version and drop the other lane's merged edits. pinned: `tests/phase-run-landing.test.mjs` (the plan test).
- `land` works in a scratch worktree at the tip and moves the branch with `update-ref <new> <old>`. It never checks out the phase branch: the lock, undo-detach and the hand-back stay #37's. pinned: the same file (the primary is still on `main`).
- Landing never forces. A source pin refuses `--force`, a `+` refspec and an `update-ref` without its old value, so the worktree is removed by `rmSync` and `git worktree prune`, never `worktree remove --force`. pinned: the same file.
- The fingerprint's screenshots are compared in `shotsRoot` (the lane's worktree), and its sources on the landed tree. Leave `shotsRoot` out and every shot reads "gone": a needless re-check, never a false carry. pinned: the same file (the fingerprint test).
- The last devlog number counts the tip's `devlog #N` citations too: a devlog rotated empty still numbers past them. pinned: the same file (`lastNumbers`).
- A test repo sets `core.autocrlf false`: the fingerprint hashes checkout bytes (gotcha #35).
- A park keeps the lane's commit, unnumbered, never the numbered attempt (`attempt`): with the numbers baked in, a second landing's devlog conflict is no longer Landing's. A taken parked name is passed over (`-2`), never overwritten. pinned: the same file.
- `readLast` matches the tip's files with `hotspotKind`, never a git pathspec: `ls-tree` does not expand a row's `*`, and the log number would restart. pinned: the same file (the pattern-row test).
- `land` never throws: an error of its own parks at its step, and a scratch worktree it cannot remove comes back as `cleanup`. A throw after the fast-forward would hide a moved branch. pinned: the same file (the numbering refusal).

**`#37` — the landing lock, `template/tools/phase-run/landing-lock.mjs` `underLandingLock` / `handBack` / `keepUnlanded` / `unlandedCommits`, `claim.mjs` `lockTaker` / `releaseClaim`, `lane.mjs` `resetWorktree`, `run.mjs` `landPass` / `landUnlanded` (built 2026-11-10):**
- The landing lock waits by `await`, never `withClaimLock`'s sync loop: that loop releases its lock when `fn` returns, which for an async landing is at once. Both share `lockTaker`'s one attempt. pinned: `tests/phase-run-landing-lock.test.mjs` (two real processes).
- Detach the primary only when its HEAD is the phase branch: an `update-ref` under a checked-out branch leaves its index on the old commit. The lock records the detach, so the next taker of a hard-killed lane's lapsed lock undoes it. pinned: the same file.
- The landing's exit handler is `prependListener`ed, and run.mjs's lane lock is released before `handBack` runs: the hand-back must find the checkout attached and no lock of its own. pinned: the same file (source pins).
- The re-gate runs in the lane's worktree, checked out detached at the landed commit, which has the install; `landPass` then resets it with `resetWorktree`. Code after a landing must not assume the worktree is on the lane's branch until that reset. pinned: none.
- A restart keeps its unlanded commits on `refs/phase-run/unlanded/<lane branch>` before `prepareWorktree` resets the branch: never a branch, and never overwritten while it holds an unlanded commit. pinned: the same file.
- Only a commit with a recorded pass (`status: "built"`, `landed: false`, its `commit`) lands on a restart, and under a claim taken first: the other lane may have rebuilt it. One without a pass is kept on a parked branch, never landed. pinned: the same file (`restartSteps`).
- `undoDetach` acts only on a checkout still detached at the recorded commit: a dead lane's record may be stale (handed back, or the owner's checkout). pinned: the same file.
- A parked ticket's claim goes into the claim file's `parked` list: the other lane read its labels at its own start. The list is cleared only by a lane that starts with no other lane live. pinned: the same file.
- A lane's result is changed in place after Landing (`saveResults`), never recorded twice: a second `recordResult` would write a second night row to the ledger.

**`#38` — findings and the lane reading, `template/tools/phase-run/findings.mjs` `recordFindings` / `branchResults` / `laneState` / `laneStatus`, `run.mjs` `recordFound` / `nightOf` / `report` / `ensurePullRequest`, `status.mjs` (built 2026-11-10):**
- A lane report reads its night by `night`, the shared copy's `runId`: never a lane's own `runId`, nor `reported`, which each lane sets for itself. A result from before #38 has no `night` and is in no lane report. pinned: `tests/phase-run-findings.test.mjs`.
- `branchResults` tags each lane's result with its folder's lane: a session's park has no `lane` key on disk. Code that names a result's lane reads it through `branchResults`. pinned: the same file.
- The record is written under the claim lock, which is synchronous: keep its body free of `await` (gotcha #37). A record it can't read refuses the write, never reads as empty. pinned: the same file.
- The one-lane report is pinned word for word by `tests/fixtures/report-one-lane.txt`. A change you mean to make there rewrites the fixture in the same commit. pinned: the same file.
- A Landing park is `status: "failed"` with `landing`: `laneState` calls it "parked at Landing", and a lane report lists it under Parked. pinned: the same file.
- The other lane reads a lane's `results.json`: `saveResults` writes it whole and renames it into place. A plain write can be read half-done, as no results. pinned: the same file (source pin).
- At its end, a lane releases its own lock before it reads `othersLive`. Release it after, and two lanes stopping together each see the other: neither posts the report. pinned: the same file (source pin).
- `measure.test.mjs`'s status fixture copies a fixed list of runner files: a new import in `status.mjs` or `findings.mjs` goes on that list. pinned: `template/tools/phase-run/measure.test.mjs`.

**`#39` — the listed-code rule, `template/tools/phase-run/unread-scan.mjs` `testNamedPaths` / `listedCode` / `withListedCode` / `listRows`, `receipt.mjs` `listedGroups`, `run.mjs` `gatePlan` / `testNamedIn`, `hooks/workflow-config.mjs` `testFiles`, `hooks/stop-gate.mjs` `perCheckReceipts` (built 2026-11-10):**
- `receipt.mjs` now imports `unread-scan.mjs`: every test that copies the receipt code copies it too (`RECEIPT_CODES` and `STOP_TESTS_FILES` in `tests/stop-gate.test.mjs`, `STOP_TESTS_FILES` in `measure.test.mjs`). Miss one and the hook's import fails, and every check quietly runs. `unread-scan.mjs` never imports `receipt.mjs`: the runner imports it. pinned: `template/tools/phase-run/run.test.mjs` (the import walk).
- `withListedCode` returns the owner's list itself when nothing is listed, so a receipt from before the rule still holds. Never append put-backs for unlisted names: every old receipt would go void. pinned: `tests/stop-gate.test.mjs` (the recorded `unread`).
- The scan fails closed: a read error other than ENOENT throws, `listedGroups` then keys on an empty list, and `gatePlan` refuses the skip. Never catch it as "nothing named". pinned: the same file and `run.test.mjs`.
- `gatePlan`'s `testNamed` is read only when every changed path is on a list, and once. Both call sites pass `testNamedIn(work)`, never `ROOT`: in a lane the gates run in the worktree. pinned: `run.test.mjs` (a source pin on both calls).
- The hooks' loader returns `testFiles` (`[]` from `noRules`); `tamperingRules` itself is unchanged, since both loaders hold it word for word (gotcha #20).
- Gotcha #22's fixture noise (a path a test writes into a temp repo) now voids a receipt instead of only warning. A project whose tests write `"docs/…"` fixtures and whose tests row leaves `docs/**` out reruns its tests on such a doc's change.

**`#40` — setup's lane checklist, `scripts/setup.mjs` `proposeLanes` / `docPaths` / `hotspotRows` / `buildPlan` `proposed` / `refresh`'s hotspot offers, `skills/setup-workflow/SKILL.md`, `template/docs/guides/phase-run.md` (built 2026-11-10):**
- With no `answers.lanes`, the plan's written config and `proposeWorkflow` stay today's, byte for byte: the pinned propose test and `OFFERS_052` rely on it. The proposal lives in the plan's `proposed` and its summary, never in `propose`. pinned: `tests/setup.test.mjs`.
- `docPaths` imports doc-config in a child process: `plan` and `refresh` stay synchronous, and a doc-config edited since is read as it is. Never swap in `import()`, which caches the module. pinned: the same file (refresh after an edit).
- No `generated` row for a `GENERATED` entry with `config` (the Stack block in `CLAUDE.md`). Landing keeps a generated row's whole file from the tip, so a lane's hand edit to `CLAUDE.md` would be lost. pinned: the same file (`hotspotKind("CLAUDE.md")` is null).
- Refresh offers hotspot rows only when `phaseRun.hotspots` exists. Offering them to a one-lane project would put a dozen offers in every `update`. A path any of the owner's rows covers, a folder row of another kind included, is never offered: an exact row would override it. pinned: the same file.
- On a yes, the plan runs the runner's own `parseRunConfig` on the config it would write, so a refusal comes before `apply`, not at `verify`. Setup imports the plugin's `config.mjs`, never the project's (gotcha #22).
- A lane row's `qa`, `ports` and `testDbPrefix` are never proposed (D2). With `phaseRun.qa` set, two rows without their own `qa` are refused, so the walk's values go in `answers.workflow` and are kept there. pinned: the same file (both loaders).
- `worktreeSetup.copy` proposes only untracked files that exist, because `lane.mjs` refuses an absent one at a lane's start.
- The template guide is at 647 of 760 lines. Its examples are sketches with `<…>` for every port and database, and they cite no file path a project's own `PATH_ROOTS` could turn into a missing-path failure.

**`#27`, attended (devlog #42) — a phase's new gotchas file and a lane's block, `template/tools/doc-lib.mjs` `foldBlock` / `LANE_DIR`, `numbering.mjs` `numberLane`, `doc-check.mjs` `laneBlocks` (built 2026-11-13):**
- One fold rule, `foldBlock`, which Landing and doc-check both call. Never give either its own copy: the check would pass a file that Landing writes another way. It sits in doc-lib because doc-check imports doc-lib, so the run's copy carries it (`snapshot.mjs` `docTools`).
- With no file on the tip, the base is the lane's own copy (`files[target]`); the tip's copy wins whenever it has one. pinned: `tests/phase-run-numbering.test.mjs`, `tests/phase-run-landing.test.mjs` (both lanes make the file).
- doc-check reads `.lane/` only while `PHASE_RUN_LANE` is set; outside a lane the tree is judged byte for byte as before. pinned: `template/tools/doc-tools.test.mjs`.
- doc-check's own `read` and `exists` shadow doc-lib's, so every check sees a block's file as it will land. A new check that reads docs must call them, not `readFile` or `existsSync`.
