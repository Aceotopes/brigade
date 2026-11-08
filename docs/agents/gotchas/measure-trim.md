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
