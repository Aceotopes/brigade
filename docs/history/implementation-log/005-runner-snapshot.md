# #005 — The runner snapshot: the frozen copy

**Ticket:** `#16` · **Devlog:** `#10` · **ADRs:** 0005
**Date:** 2026-11-08

---

## The Problem

A phase run is many sessions started hours apart, and everything that judged them was read live:
the runner code in `tools/phase-run/` and the rules in `.claude/workflow.json`. A shell write, an
owner's edit or an `/update-workflow` between two tickets would judge the rest of the night by
other rules, and the morning report couldn't show it. Discovery doc 04 (D7) and ADR 0005 settle
the answer: one frozen copy of the runner and its config, from the first ticket to the last. The
probe (#12) left D7 unchanged.

## The Solution

- **`template/tools/phase-run/snapshot.mjs`** (new):
  - `takeSnapshot({ root, runDir, runId, commit, at })` copies `tools/phase-run/` and
    `.claude/workflow.json` to `.phase-run/<branch>/runner/`, laid out as the repo is, and writes
    `manifest.json` `{takenAt, commit, runId, finished: false}`.
  - An unfinished copy is reused (a restart after a crash). `runnerChanges` compares every `.mjs`
    under `tools/phase-run/`, its `*.test.mjs` left out, by content and in both directions
    (changed, added, removed). Any difference refuses the restart, naming the files and the folder
    to delete for a fresh start.
  - `finishSnapshot(dir)` sets `finished: true`; the next run removes the old copy and takes a
    fresh one.
- **`run.mjs`**:
  - `main()` takes the copy once the run's folder and log exist, after the lock's exit handler, so
    a refusal (`die`) releases the lock. It then reads the runner's own config (the gates, the
    prompt's checks) from the copy, and marks the copy finished once the report is saved.
  - A project with no `.claude/workflow.json` gets one with no rules in its copy, so a copy that
    has lost its config can be refused.
  - `runVariables` (new, exported) builds the run's variables, now with
    `PHASE_RUN_RUNNER=<copy, absolute>` and `PHASE_RUN_ROOT=<repo>`.
  - `promptValues` takes `RUNNER` (the copy, from the repo's root, with `/`), so the prompt's check
    command reads `node .phase-run/<branch>/runner/tools/phase-run/stop-tests.mjs`. It falls back
    to the live path.
- **`stop-tests.mjs`**: reads its config beside itself (the copy's or the repo's). It keys,
  records and runs the repo's code at `PHASE_RUN_ROOT` when that is set.
- **`hooks/workflow-config.mjs`**: `judgeRoot` and `loadJudgeConfig`, used by both hooks. With
  `PHASE_RUN_RUNNER` set they read the copy; without it, the live tree. A copy that is named but
  missing, or has lost its `workflow.json`, is an error, never "no rules".
- **`hooks/stop-gate.mjs`**: the checks and the imported `receipt.mjs` come from the copy. Git,
  the verdict, the receipt file, the marker, the log and each check's working folder stay the
  repo's.
- **`hooks/guard-shell.mjs`**: the rules come from the copy. `spec-issues.json` and `doc-check.mjs`
  stay live, since neither is in the copy.
- **`tests/env-contract.test.mjs`**: `hooks/workflow-config.mjs` joins the readers, and the runner
  must set both new names.
- The night's Edit deny on `tools/phase-run/**` and `.claude/workflow.json` is unchanged, and
  pinned again beside the new variables. The copy sits under the already-denied
  `.phase-run/<branch>/**`.

## Why This Approach

**The copy mirrors the repo.** `<copy>/.claude/workflow.json` and `<copy>/tools/phase-run/` mean
the hooks' loader, `stop-tests.mjs`'s own `resolve(HERE, "..", "..")`, and the receipt import
all work on the copy with no path rewriting. One variable decides which tree judges the session.

**Judge from the copy, work on the repo.** Only what *judges* moves to the copy: the rules, the
checks, the receipt code. What is *judged* (the tree, git, the receipt file) stays the repo's.
`PHASE_RUN_ROOT` is how the copy's `stop-tests.mjs` finds its way back.

**Fail closed on a missing copy.** `loadWorkflowConfig` treats a missing file as "no rules", which
is right for a project that hasn't set up yet. For a named copy that vanished, it would wave every
stop and every command through, so that case is an error.

**Compare code, not config, on restart.** The ticket asks for a refusal when the runner's code
changed. A changed `workflow.json` is exactly what the copy protects against, so the restart keeps
the copy's version. Tests aren't the judge, so they are left out too.

Interview version: "It's a snapshot-isolation pattern for a long batch job. At run start I freeze
the judge (the runner code and its config) into the run's own folder, and pass its path to every
session through one environment variable. The hooks then read the rules from the frozen copy but
check the live repo's work. A restart reuses the snapshot only if the code it would replace is
byte-identical. Otherwise it refuses and names the files, because silently judging half a night by
new code is the bug we're removing. And a snapshot that's named but missing fails closed, never
open."

## Alternatives turned down

- **`--setting-sources`, or wrapping project skills as a plugin.** Decided against (D6, ADR
  0005): Brigade's hooks are plugin hooks.
- **Compare file times instead of content.** `cpSync` doesn't promise to keep times, and a
  checkout rewrites them without changing a byte.
- **Refuse a restart on a changed `workflow.json` too.** The ticket names code only. The copy
  already shields the run from a config edit, so refusing would only cost the owner the night.
- **Read `PHASE_RUN_RUNNER` only when `PHASE_RUN=1`.** The stop gate is inert outside a run anyway,
  and nothing else sets the variable. One rule ("set means the copy") is simpler to test.
- **Mark the copy finished when the run stops early** (the internet, a runner error). It still
  counts as finished, because `main()` reaches its report either way. Only a crash or Ctrl+C leaves
  it unfinished, and those are what a restart is for.
- **(Review) Put the copy's absolute path in the prompt**, in case a session runs the command from
  a subfolder. Every other command the prompt names is relative to the project folder, where the
  prompt tells a session to run them. An absolute Windows path would also need its slashes and
  any spaces handled for Bash.
- **(Review) Block shell writes into the copy.** The guard matches command text; it is a guard
  rail, not a sandbox, and the ADR makes the copy a backstop against writes to the *live* files.
  A copy that loses its config is refused, but one edited in place is not caught.
- **(Review) Warn when a died run's manifest can't be read.** It is written once, in one small
  write, at the take; a fresh copy is then the safe default, and the code check still applies to
  every later restart.
- **(Review) Drop `promptValues`' live-path fallback.** `main()` always sets the copy, but the
  prompt tests and any caller without a run use it.
- **(Review) Smaller renames** (`CONFIG_ROOT` in `stop-tests.mjs`, the two path arguments of
  `runnerChanges`). Taken: `RUNNER_FOLDER`, `snapshot` in `main()`, one `noRules`, one
  `writeManifest`, one `STOP_TESTS_FILES` list in the tests.

## Real bugs found along the way

- **A test that would have hit the real repo.** `measure.test.mjs`'s stop-tests project passed
  `process.env` through to the child. A suite run inside a 0.6.0 night inherits `PHASE_RUN_ROOT`,
  so the test project's `stop-tests.mjs` would key and record the real repo. Its child env now
  drops every `PHASE_RUN*` name (`outsideRun`).
- **(Review) One config on a restart, not two.** `preflight` loads the live `workflow.json`, and the
  first draft kept it. On a restart with an edited config, the prompt's checks and the runner's
  gates followed the live file while the hooks followed the copy: a session could be told to run a
  check the stop gate never ran. `main()` now reads `config` from the copy right after taking it.
  Preflight still checks the live file first, and its project prose is still read once, live
  (the prompt file is Edit-denied too).
- **(Review) A copy without its config failed open.** Its folder was checked, not its
  `workflow.json`, so a shell delete of that file gave "no rules". The copy now always holds one.
- **Found elsewhere, not fixed here:** none.

## What This Concretely Unblocks

- **#25** (one Brigade version): the manifest gains the run-start version, and the per-ticket
  settings writer gains the auto-update override. `takeSnapshot`'s manifest and `runVariables` are
  where they go.
- **#17** (per-check receipts): the copy's path is `PHASE_RUN_RUNNER`. The hooks import the copy's
  `receipt.mjs`, and the session runs the copy's `stop-tests.mjs`.
- **#21** (trim): the same per-ticket settings file (`writeSessionSettings`), untouched here.

## Run by hand

- None.

## Assumptions made

- **The copy lives at `.phase-run/<branch>/runner/`**, under the Edit deny the run's folder
  already has. To move it: `SNAPSHOT_FOLDER` in `snapshot.mjs`.
- **"Finished" means `main()` reached its report**, an early stop included. To narrow it: move the
  `finishSnapshot` call.
- **The whole `tools/phase-run/` folder is copied** (prompts, `settings.json`, prices, tests), not
  just the `.mjs`. That way the copy runs exactly as the live tree would. Only `node_modules` is
  skipped.
- **A named but missing copy blocks every shell command** in the guard and fails the stop gate. The
  session is told to write its verdict and stop. To soften it: `loadJudgeConfig`.
- **A manifest that can't be read counts as no copy**, so a fresh one is taken.

## Common Questions

**Does this change an attended session?** No. Without `PHASE_RUN_RUNNER` the hooks read the live
tree, as before.

**What happens on this repo's nights today?** Nothing yet. They run the released 0.5.2 runner at
the root `tools/phase-run/`, which sets no `PHASE_RUN_RUNNER`. The copy starts with the first run
on a runner `/update-workflow` copies from this template.

**Was a browser check run?** No. Backend only: no screen changes.

## References

- Spec #11, `docs/discovery/04-brigade-0.6.0.md` D7 and D9, ADR 0005.
- `template/tools/phase-run/snapshot.mjs`, `run.mjs` (`runVariables`, `promptValues`, `main`),
  `stop-tests.mjs`; `hooks/workflow-config.mjs`, `hooks/stop-gate.mjs`, `hooks/guard-shell.mjs`.
- Tests: `template/tools/phase-run/run.test.mjs`, `measure.test.mjs`, `tests/stop-gate.test.mjs`,
  `tests/guard-shell.test.mjs`, `tests/env-contract.test.mjs`.
- Gotchas: `docs/agents/gotchas/measure-trim.md`, block `#16`.
