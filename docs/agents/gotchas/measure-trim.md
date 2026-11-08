---
job: Phase measure-trim (Brigade 0.6.0, measure and trim): the traps a session must know before touching its files.
kind: living
max-lines: 800
---
# Gotchas — Phase measure-trim: Brigade 0.6.0, measure and trim

Read only the blocks your ticket names, or whose files you will touch. Every phase's file is
listed in the gotchas index, `docs/agents/gotchas/README.md`.

## The blocks

**`#13` — pricing a session, `template/tools/phase-run/metrics.mjs` `sessionCost` / `sessionCostFrom` (built 2026-11-08):**
- A response that called the advisor has a top-level `usage` that leaves the advisor's pass out. Its
  requests are in `usage.iterations`: `type: "message"` at the response's model and
  `type: "advisor_message"` with its own `model`. Price the iterations, never the top-level usage
  as well, or the session's own tokens count twice. pinned: `template/tools/phase-run/measure.test.mjs`.
- The top-level `cache_creation` split does not match the iterations' (seen live: 1h 2,424 and
  5m 0 at the top, while the iterations held 2,424 at 1h and 1,936 at 5m). Read the split per
  iteration.
- Costs are whole nano-dollars (`nanoUsd`). Add those, and round only for `costUsd`: rounded
  dollars do not sum across `sessionCostFrom` steps.
- `sessionCostFrom`'s state is keyed by the resolved file path and keeps every counted response id,
  even across a rewrite. Store it as it is returned; don't trim `seen`, or a response's later line
  is counted again. pinned: `template/tools/phase-run/measure.test.mjs`.
- Edit `template/tools/phase-run/`, never the root `tools/phase-run/`: that is the pinned released
  runner, moved only by `/update-workflow`.

**`#14` — the ledger, `template/tools/phase-run/ledger.mjs` `ledgerRow` / `appendRow`, `run.mjs` `recordNight` (built 2026-11-08):**
- A row is the session's **whole** cost at `at`, never an increment: the views keep each session's
  latest row and drop the rest. A writer reading incrementally (`sessionCostFrom`) keeps running
  totals (cost, per model, tokens, peak as a max) and writes them. pinned: `template/tools/phase-run/measure.test.mjs`.
- `assert.throws(fn, /regex/)` matches against `String(error)`, `"Error: …"`: a `^` anchor fails.
- The runner writes only when `run.ledgerFile` is set, and only `main()` sets it. A test that calls
  `recordResult` must give its temp run its own `ledgerFile`, or it writes nothing (never the repo's
  real ledger).
- `config.mjs` must not import `ledger.mjs`: `measure.test.mjs`'s stop-tests project copies a fixed
  list of runner files, and `ledger.mjs` imports `config.mjs`, not the other way.
- The `ledger` section's refusals live in both loaders, word for word; change both, and
  `tests/phase-run-config.test.mjs` runs each case through both.

**`#15` — the attended ledger hook, `hooks/ledger.mjs` `record` / `readState` / `attendedOn`, `metrics.mjs` `addCost` (built 2026-11-08):**
- Import from the plugin's `../template/tools/phase-run/`, never a project's `tools/phase-run/`:
  the project's copy may be 0.5.x, with no `sessionCostFrom`. pinned: `tests/ledger-hook.test.mjs`.
- Every import beyond `node:` builtins is a dynamic `await import` after the `PHASE_RUN` check and
  inside the try. A static import is hoisted above the check, and one that throws prints a stack.
  pinned: `tests/ledger-hook.test.mjs` (a marker module in a plugin copy).
- The state file holds the offsets **and** the running totals; save them together, after the row.
  Splitting them, or saving before the append, can lose or double an increment. A state of the
  wrong shape must be dropped (`readState`), never kept: `sessionCostFrom` throws on an entry with
  no offset, and the session would record nothing again. pinned: `tests/ledger-hook.test.mjs`.
- A workflow.json the plugin's loader refuses still counts if it parses (a project a release
  ahead); only a file that isn't JSON, or `ledger.attended: false`, turns the hook off.
- To test a broken price list, copy the plugin (`pluginCopy`) and alter the copy;
  `runHook(..., { plugin })` runs the copy. Never add an env override for the path.
- Claude Code may print the hook's stdout: it must stay empty on every path, warnings included.

**`#16` — the runner snapshot, `template/tools/phase-run/snapshot.mjs`, `hooks/workflow-config.mjs` `judgeRoot` / `loadJudgeConfig` (built 2026-11-08):**
- Only what *judges* reads the copy (the rules, the checks, `receipt.mjs`); what is *judged*
  (git, the tree key, the receipt file, a check's cwd, the verdict) stays the repo's. Mixing them
  keys or records the copy instead of the work. pinned: `tests/stop-gate.test.mjs`, `measure.test.mjs`.
- A named copy that is missing, or has no `workflow.json`, must be an error: `loadWorkflowConfig` on
  a missing file is "no rules", which waves every stop and command through. So `takeSnapshot`
  always writes a config into the copy. pinned: `tests/stop-gate.test.mjs`, `tests/guard-shell.test.mjs`.
- The runner's `config` global is set twice: by `preflight` from the live file, then by `main()`
  from the copy. Code that runs before the snapshot (preflight's ports and commands) reads the live
  one.
- A test that spawns a runner script must drop every `PHASE_RUN*` name from the child's env: a
  suite run inside a night inherits `PHASE_RUN_ROOT`, which points a test project's
  `stop-tests.mjs` at the real repo. `tests/helpers.mjs` does it for the hooks; `measure.test.mjs`
  has `outsideRun`.
- A new `PHASE_RUN_*` name must be a `KEY:` entry in `run.mjs` (`runVariables`), or
  `tests/env-contract.test.mjs`'s regex never sees it set.
- The restart check compares `.mjs` content, tests left out, never times or `workflow.json`: the
  copy keeping the old config is the point.

**`#17` — per-check receipts, `template/tools/phase-run/unread.mjs` `unreadMatcher`, `receipt.mjs` `treeKeys` / `receiptGroups`, `hooks/stop-gate.mjs` (built 2026-11-08):**
- The matcher lives in `unread.mjs`, never `receipt.mjs`: the runner (and #19's suite skip) may
  import the matcher but must never reach the receipt reader. pinned: `template/tools/phase-run/run.test.mjs`
  (it walks `run.mjs`'s import graph).
- `receipt.mjs` imports `./unread.mjs`. A test that copies the receipt code into a project must
  copy both (`RECEIPT_CODES` in `tests/stop-gate.test.mjs`, `STOP_TESTS_FILES` in `measure.test.mjs`),
  or the hook's import fails and every check quietly runs.
- The hook tells 0.6.0 receipt code from 0.5.x by `treeKeys`. Keep 0.5.2's path (`sharedReceipt`)
  as it is: a project's `receipt.mjs` can lag the plugin. pinned: `tests/stop-gate.test.mjs`, run
  under `tests/fixtures/receipt-0.5.2.mjs` too. Never update that fixture.
- Rows without a `name` share `test-receipt-<ticket>.json`, so the loaders still refuse two of them
  with different lists; named rows may differ. Both loaders hold the refusals word for word.
- Matched paths go to `git update-index --force-remove -z --stdin`, never as arguments: Windows'
  command line is 8,191 characters.
- A `/** … */` comment can't hold `**/*.md`: its `*/` ends the comment. Write `**\/*.md` there.

**`#19` — gates side by side, `template/tools/phase-run/run.mjs` `gatePlan` / `gateGroup` / `projectGates` / `startJob`, `config.mjs` `gateReferences` / `gateOrder` (built 2026-11-08):**
- `gateReferences` lives in both loaders, word for word; change both. The hooks one must stay
  narrow: a refusal there is `noRules(error)`, which blocks every shell command in a session, so it
  fires only on an `after` or `unreadOf` that names nothing, and skips any other shape. pinned:
  `tests/phase-run-config.test.mjs` (it compares the two messages).
- `gatePlan` takes the diff as `git diff --name-status -M -z` prints it. Without `-z` a path with a
  tab or quote comes back quoted, and without `-M` a rename is a delete and an add, depending on
  the owner's `diff.renames`. pinned: `template/tools/phase-run/run.test.mjs`.
- Off Windows a gate job is `detached` so `process.kill(-pid)` reaches what the shell started; a
  plain `child.kill()` (as `killTree` does) leaves the real test runner going. pinned: `run.test.mjs`
  (the long job's pid must be gone). A detached group no longer hears the terminal's Ctrl-C, so
  `startJob`'s `openJobs` are killed on the runner's `exit`; decide a kill on `close`, never on the
  shell's exit, or a child holding the pipe hangs `stop()`. pinned: `run.test.mjs`.
- A `node -e "…"` gate in a test runs through `cmd.exe` on Windows: no inner double quotes, no `%`,
  no `$` (sh), and no `{word}` (the loader reads it as a placeholder). Pass paths through `env`.
- Prove side by side with a rendezvous (each job waits for the other's flag), never a stopwatch.
- `{cache}` is emptied once per gate run, never per gate: the group shares the folder.

**`#18` — update's offers, `scripts/setup.mjs` `ROW_OFFERS` / `rowOffers` / `refresh` `onlyAccepted`, `update` `offers` (built 2026-11-08):**
- The 0.6.0 keys live in `ROW_OFFERS`, never in `proposeWorkflow`: #22 pins its output, and a new
  project's lists are a checklist question (D17).
- A row's offered keys go as one item. A receipt with its own list needs its name, or two nameless
  lists are refused. A gate's `unreadOf` needs its check's name, so the gate's yes names it.
  pinned: `tests/setup.test.mjs` (each accepted file through both loaders).
- Refresh's shared list is the **nameless** receipt rows'. Read from any receipt row, a named
  Typecheck's `**/*.md` lands on the tests row. pinned: `tests/setup.test.mjs`.
- `refresh(dir).items` is no longer `[]` right after setup: the offers are there until #22 writes
  the keys. Filter `op !== "offer"` in a test that means "nothing else to do".
- An `unread` list is offered only with the `receipt` it belongs to. A row's own `receipt: false`
  refuses a list, and a row's own receipt gets its list from 0.4.1's `add`; offering it there too
  makes two items for one key. pinned: `tests/setup.test.mjs`.
- `update` must never throw over the config: the offers are read in a try, and a failure is a note.
- The prompt's `STOP_CHECKS` (`run.mjs` `stopCheckLine`) names `stop-tests.mjs` once, since it runs
  every receipt row. Splitting it per row repeats the command. pinned: `measure.test.mjs`.
- The runner loader's `error` is `null` on success, never `undefined`: assert `!error`.

**`#20` — the tampering gate, `template/tools/phase-run/tampering.mjs` `tamperingVerdict` / `patchFiles` / `namesPath`, `config.mjs` and `hooks/workflow-config.mjs` `tamperingRules` (built 2026-11-08):**
- `tamperingRules` is one text in both loaders, compared whole by `tests/phase-run-config.test.mjs`.
  Edit both alike; config.mjs exports it with a separate `export { tamperingRules }` line so the
  function's text stays the hooks'. `hooks/workflow-config.mjs` is CRLF; config.mjs is LF.
- Unlike #19's narrow rule, the hooks refuse **any** fault in `phaseRun.tampering`: a broken rule
  must never read as "no rules". It blocks every shell command in a session until fixed. That is by
  design.
- The run's config (the snapshot) only switches the gate on; the rules are read at the base through
  `readAt`. Never judge with `config.tampering`'s own patterns. pinned: `run.test.mjs` ("the rules
  are the base commit's").
- `git diff -U0` headers: git adds a tab after a path with a space and C-quotes an unusual one
  (`"a/tests/\303\274.test.mjs"`). Always diff with `PATCH_ARGS` (pinned prefixes, no colour, no
  external driver), or an owner's `diff.noprefix` breaks the parse. pinned: `run.test.mjs` (real git).
- The runner's `exec` trims stdout. Harmless for the patch and for `git show` of JSON, but don't
  compare raw file text through `atCommit`.
- A refused commit-message reason lives on `run.tamperingNotes` (a Map, not saved), and joins the
  result only in `recordResult` (`withTamperingNote`): `notes` when built, `detail` otherwise, since
  parked and failed results render no notes. Never add it at a call site. pinned: `run.test.mjs`.
- A pure rename has no `---`/`+++` lines, only `rename from`/`rename to`: read those, or a test file
  renamed out of `testFiles` drops its assertions uncounted. pinned: `run.test.mjs`.

**`#21` — trim, `template/tools/phase-run/trim.mjs` `readTrim` / `trimEntries` / `withTrim`, `run.mjs` `trimmedSettings` / `printArgs` / `backgroundArgs` (built 2026-11-08):**
- A `--bg --resume` takes **no** flag, trim's included: any flag quietly starts a copy (point 5 in
  `run.mjs`). The flags go on the first launch only; a `-p` resume is a new process and repeats
  them. pinned: `run.test.mjs` ("trim's flags go on a session's first launch").
- Trim wraps the settings writer (`trimmedSettings`), never `sessionSettings` itself: #25 changes that
  function, and the merged-settings test compares the two field for field.
- Only `run.mjs` may import `trim.mjs`: a hook or setup script reading it would trim attended
  sessions. pinned: `run.test.mjs` ("only the runner reads trim").
- A test passes its own home and root (`trimPath({}, home)`, `trimmedSettings(…, root, …)`); never
  read the real `~/.claude/brigade/trim.json` or this repo's `.claude/settings.json`.
- The hooks' loader must not check `phaseRun.keep`: a refusal there blocks every shell command, and
  keep judges nothing. The runner's `parseKeep` checks it.
- A project settings file that can't be read must never read as "nothing enabled": that trims what
  the project needs. Strip a BOM (PowerShell 5.1 writes one); otherwise throw, and a ticket then
  trims nothing. pinned: `run.test.mjs` ("read through a BOM").

**`#22` — setup's tool rows, `scripts/setup.mjs` `roleMatcher` / `unreadWarnings`, `template/tools/phase-run/unread-scan.mjs` `unreadScan` / `pathOf` (built 2026-11-08):**
- Match a row to a stack role with `roleMatchers`, never `run ===`: refresh's lists, the tests-row
  adds, `rowOffers` and the scan's tests row all go through it. A name counts only with the
  suggested command as the row's prefix (flags after it): a name alone would hide a package-manager
  switch, since every gate has a label. pinned: `tests/setup.test.mjs` ("a name never hides a stack change").
- `proposeWorkflow` stays 0.5.x-shaped; its whole output for `existing()` is pinned. A new key goes
  in the checklist (the skill), or in `ROW_OFFERS` for a project set up before it.
- Setup imports the **plugin's** `template/tools/phase-run/unread-scan.mjs`, never the project's:
  a project a release behind has none.
- The scan's warnings are `refresh`'s `warnings`, never an item, and `verify`'s `warn` line is
  `ok: true`: a test asserting "nothing to do" filters items, and the CLI test asserts `^ok`.
- The scan flags fixture paths a test writes into a temp repo (`tests/setup.test.mjs` is full of
  `"docs/…"`). That is the warning's known noise, not a bug to fix in `pathOf`.
- The template's phase-run guide is CRLF; `unread-scan.mjs` is LF, as `unread.mjs` is.

**`#25` — one run, one Brigade version, `template/tools/phase-run/brigade.mjs` `brigadeCatalog` / `withAutoUpdateOff` / `installedBrigade` / `versionStop`, `run.mjs` `sessionSettings` / `main`, `snapshot.mjs` `takeSnapshot` (built 2026-11-08):**
- `run.brigade` is the **installed plugin** version, as the attended hook's rows are, never the
  project's stamp (`run.stamp`, shown in the report only when it differs). Night and attended rows
  must say the same thing.
- Never write a catalog entry without the project's `source`: a `--settings` entry stands in for
  the project's, and one with only `autoUpdate` is a catalog with nowhere to come from. No project
  entry means no override, and the report says why. pinned: `run.test.mjs`.
- The catalog is read from `enabledPlugins`' `brigade@<catalog>` key, never a literal: a fork's
  catalog has another name.
- Test the version pick through `installedBrigade(rows, root, { platform })`, never by spawning
  `claude`: a night session's allow list refuses `claude plugin list`, and its output on another
  machine is not a fixture.
- A version that can't be read before a ticket stops the run (`versionStop`): it can't prove the next
  ticket's hooks are the run's. A reused manifest with no `brigade` key is the one case let through.
- Fixtures under `template/` name no real catalog or owner (`market`, `owner/brigade`), and a
  template doc names no project file in backticks: `tests/no-project-specifics.test.mjs` and the
  template's day-one doc-check refuse both.

**`#23` — the compose scan, `scripts/setup.mjs` `parseCompose` / `composeLines` / `COMPOSE_FILES`, `detect` `compose`, `refresh`'s `compose` (built 2026-11-08):**
- A compose database's port never goes in `phaseRun.ports`: the runner checks that list right after
  preflight starts the container, so it would refuse every run. It goes in the database's address
  (`phaseRun.qa`, `sessionEnv`); the preflight hint covers another project's container on the port.
- `parseCompose` is no YAML parser: it reads `services:` names, `image:` and `ports:`, and throws
  with a line on any shape it can't place (tabs, a flow-map `services:`, an unclosed quote).
  `detect` turns the throw into `error: "could not read: …"`; never let it escape detect.
- A port with no fixed host port (`"6543"`, `${PG_PORT:-5432}:5432`, a long form without
  `published`) is listed in `skipped`, never guessed. pinned: `tests/setup.test.mjs`.
- `COMPOSE_FILES` is in `docker compose`'s own pick order (`compose.yaml` first). An override file
  beside it (`compose.override.yaml`) is merged by Docker but never read here: the skill asks.
- Refresh only reports `compose`; the preflight row and the address are the skill's to propose,
  never an item (the stack's rows stay stack-shaped, ADR 0001).
