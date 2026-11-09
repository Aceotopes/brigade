# #019 — The worktree: `run.mjs --lane <id>` builds in a lane's own worktree and keeps each pass unlanded

**Ticket:** `#33` · **Devlog:** `#34` · **ADRs:** 0005, 0007, 0008 (applied, none new)
**Date:** 2026-11-10

---

## The Problem

0.7.0 runs two lanes side by side (D8, D13). #29 gave the lane rows (a worktree path, ports, a QA
database, a test prefix, an env) and #31 a runner copy that carries doc-check. Nothing ran a lane.
The runner had one root for everything: the git and shell commands, the session's folder, its
verdicts and receipts, and the run's own state all sat in the repo the runner lives in. A lane needs
two (ADR 0007): its run state in the primary checkout, where both lanes see it, and its session's
files in its own worktree, where the other lane can't touch them.

## The Solution

**A new module, `template/tools/phase-run/lane.mjs`**, holds what a lane does before its first
ticket. Each piece takes its roots and throws a refusal that names what to fix:
- `laneRow`, `laneRoots`, `laneBranch`: the row `--lane` names; its worktree (the row's path, from
  the primary), its results folder `.phase-run/<branch>/lane-<id>/`, the branch folder whose runner
  copy both lanes share, and its own branch `<phase branch>-lane-<id>`.
- `writeLaneLock`, `liveLanes`, `joinBranch`, `mayFinishCopy`: a lane's lock is
  `.phase-run/lane-<id>.lock` (JSON: lane, pid, branch, start), found before the branch is known. A
  lane started without `--branch` on a detached checkout joins the branch a live lane's lock names.
  A lock whose process died names no live lane.
- `prepareWorktree`: makes the worktree at the row's path on the lane's branch, cut from the phase
  branch's tip. A second start reuses it: `checkout --force -B` to the tip, then `clean -fd`, so a
  dead session's edits go and the ignored install stays. A folder there that is not one of the
  repo's worktrees is refused.
- `setupWorktree`: `worktreeSetup.copy` from the primary, `commands` run in the worktree, then every
  `leaves` file checked, the missing ones named.
- `ignoredImports` / `ignoredImportsProblem`: tracked scripts' relative imports (`from`, bare
  `import`, `import()`, `require()`), each tried as written, with an extension, as a folder's index,
  and a `.js` as TypeScript. A candidate that is tracked, or that `copy`/`leaves` names, is fine. The
  rest go to one `git check-ignore --stdin`, and each script is named with the file it imports.
- `lanePortProblems`, `laneValues`, `afterPass`: the row's ports checked free; what the session's
  env takes; and that a lane neither pushes nor migrates.

**`run.mjs` gains `--lane <id>` and a second root.** `ROOT`/`STATE` stay the primary checkout: the
lock, the run's folder, the snapshot, the trust and Brigade-version reads (#28's addendum), `.env`,
the ledger. A new `work` is the session's root: the lane's worktree, else `ROOT`. It takes the cwd of
`exec`, `shell`, the gate jobs and `claude`, plus the verdict, the stop-check marker and log, the
prompt file, the gate cache (`gateCache()`, one per lane now), screenshots, migrations' files, the
spec list and the stray-process path. With no `--lane`, `work === ROOT` and every path is as before.
- **Preflight**, with a lane: the row is loaded and its QA url tried; the branch join; the row's
  ports checked instead of `phaseRun.ports`; its own lock and the one-lane lock refused; a phase
  branch that doesn't exist yet refused. The "you are on X" check is skipped, since a lane never
  checks a branch out in the primary checkout.
- **`main()`**, with a lane: the lane lock; `run.dir` is the lane's folder. The worktree is made or
  reset first, and the snapshot is taken from it (the phase branch's tip, never what the primary has
  checked out) into the branch's folder. So the second lane reuses the first lane's copy and is
  refused, naming the files, when the live runner differs (`takeSnapshot`'s restart rule). The
  copy's row is then read again (a worktree path that differs from the live row's is refused), the
  imports checked and the setup run under the copy's config, and `work` moves to the worktree. Only
  the last lane out marks the copy finished.
- **A ticket in a lane:** its env carries the row's `env`, then `PHASE_RUN_ROOT` (the worktree),
  `PHASE_RUN_LANE`, `PHASE_RUN_QA_PORT`, `PHASE_RUN_QA_DATABASE` and `PHASE_RUN_TEST_DB_PREFIX` (each
  only when the row gives it). Its `{qaUrl}` is the lane's (`config.mjs` `laneQaUrl`). Its prompt
  gets `LANE`, so #30's numbering paragraph shows. Its settings add an Edit deny on the run's folder
  by its absolute path (`//d/…`), since `./` now names the worktree.
- **The gates in a lane:** the docs gate takes the number token as a log's number
  (`implementationLogAdded`); doc-check runs in the worktree with `PHASE_RUN_LANE` set; the migration
  is logged and not applied (ADR 0008). On a pass, nothing is pushed and no pull request is opened;
  the result records `lane`, `laneBranch` and `landed: false`.

**`config.mjs`:** `laneDatabase` is the one rule for a lane's database (`row.qa ?? qa.name`), read by
the loader's refusal, the url and the env. `laneQaUrl` swaps the url path's last segment, which must
be `qa.name`, for it. The path is found from the url's end, never
by searching for its text, which may also be the user name. `sessionEnv` takes the lane. A row's
`env` naming a `PHASE_RUN_*` variable is refused (owed by #29's log).

## Why This Approach

**Two roots as two variables, not a rewrite.** The runner is 2,500 lines that read one root. Moving
only the session-side reads to `work`, and keeping everything else on `ROOT`, is ADR 0007's
consequence line made literal. In an interview: "I split the root in two and moved each read to the
side it belongs to; with no lane both are the same folder, so the old path is byte for byte
unchanged."

**The start's pieces in their own module.** Each is tested on a throwaway repo with real git: the
worktree made, reused and reset; setup; the import check. `run.mjs` only strings them together.

**The lane's branch starts with `phase-`.** `guard-shell.mjs` lets a session commit only on a
`phase-*` branch, and a detached worktree reads as `""`. So `phase-x-lane-2`, not `lane-2`. Park's
`-parked-<N>` branch and the guard work unchanged.

**A restart refuses unlanded commits rather than resetting over them.** A lane keeps each pass on its
branch for Landing. Resetting that branch to the tip would make the commit unreachable. Until #37
lands them first, the start names them.

**The copy is taken from the worktree, and setup runs under the copy's config.** A lane leaves the
primary checkout wherever it is, so the primary's working tree may hold `main`'s runner. The
worktree, reset to the phase tip, holds the branch's. Setup then follows the rules the night is
judged by (ADR 0005), not the live file.

## Alternatives turned down

- **Lane 1 in the primary checkout.** D4 and ADR 0007 give every lane a row with a worktree, and the
  landing lock (#37) detaches the primary. Every row keeps `worktree`, as #29 left it.
- **Creating the phase branch from a lane.** A lane refuses one that doesn't exist; a run without
  `--lane` already makes it, with its `main` = `origin/main` check.
- **The lane lock under `.phase-run/<branch>/`.** The branch join reads the lock to learn the branch.
- **A JS-only "stack recipe" for the import check.** ADR 0001 keeps Brigade free of per-tool code;
  the check reads what Node and a TypeScript build load, the runner's own language, and lets a project
  account for a file through `worktreeSetup`.
- **A shared `{cache}` for both lanes.** It is emptied before each gate run, so one lane's gates
  would clear the other's cache mid-run.

Both code reviews (standards and spec, against #33) ran after the first commit. These fixes are in
the same commit:
- **The runner copy came from the primary's working tree**, which a lane may leave on `main` or
  detached, while its manifest named the phase tip. It is now taken from the worktree at the tip.
- **The worktree path came from the live row** after the copy's row replaced it: a mismatch is refused.
- **The lane-database rule sat in three places** (gotcha #29): now `laneDatabase`.
- **Trim read the primary's project settings**; a lane session loads the worktree's, so it reads `work`.
- **runGates lost its doc comment** to `implementationLogAdded`; **`prepareWorktree`'s `lane`** was a
  branch name (now `ownBranch`); **`finishBuilt`'s placeholder push** is now `null`.
- **No test reached `runGates`' migration skip or `finishBuilt`'s push**: a source pin now checks both
  read `afterPass(lane)`, as the `docCheck` calls are pinned.
- **A worktree folder deleted by hand** stayed registered, so the start took the reuse path in a
  missing folder: `prepareWorktree` now prunes before it looks (found in the last check).
- **The `//` deny form was unverified**: Claude Code's permissions page gives `//path` as absolute, and
  a Windows path in POSIX form (`C:\Users` → `/c/Users`).

These findings were turned down:
- **"The five names", with two left unset when the row has no value.** The fifth, `PHASE_RUN_FAKE_NOW`,
  is reserved (the criterion says so); a QA port or prefix the row doesn't give has no value to set.
- **A row's `env` can replace a `sessionEnv` pin.** On purpose: the row is the lane's own resources
  (D4), so lane 2's cache index must win over the project-wide one. Only `PHASE_RUN_*` is refused.
- **A lane that starts after the other lane finished takes a fresh copy.** Their runs don't overlap,
  so each is its own run, as two nights are.
- **The ~20 `lane ? … : …` sites and the module-level `work`.** The runner already keeps `config` that
  way; threading a root through 2,500 lines is a rewrite this ticket doesn't need.
- **`lane.mjs`'s own `git` helper, the second port loop, the inline regex escape, `afterPass`'s two
  equal flags.** `lane.mjs` is tested alone, without `run.mjs`'s globals; the one-lane port message is
  kept as it was; the escape is one line; `afterPass` names the decision #36 changes.
- **Driving preflight's detached-checkout path in a test.** It calls `gh`, `claude` and the network;
  `joinBranch` is the decision, tested.
- #30's numbering test passed `lane` as a bare id; it now passes the lane's values, the new shape.

## Real bugs found along the way

None in shipped code. One near miss in the new code: the Edit deny's absolute form was first written
with one slash too many (`///…` on POSIX); the settings test pins the right one.

## What This Concretely Unblocks

- **#34** gets a running lane. `builtOnBranch` reads `main..HEAD`, which in a lane is the lane's
  branch, so a lane's unlanded pass counts as built for its own run. #34 reads "built" off the phase
  branch.
- **#36 and #37** get the unlanded commits on `<branch>-lane-<id>`, and each result's `lane`,
  `laneBranch`, `landed: false` and `migrations` (not applied). #37 replaces `prepareWorktree`'s
  unlanded refusal with "land them first", and owns the primary checkout's hand-back. The refusal
  compares commits (`<branch>..<lane branch>`), so once Landing replays a commit under a new hash,
  Landing must also reset the lane's branch, or every restart is refused. A run without `--lane`
  does not yet refuse while a lane's lock is live.
- **#38** gets each lane's results in `.phase-run/<branch>/lane-<id>/results.json`. A lane's report
  is written there and not posted to the pull request.
- **#40**: setup should write `worktreeSetup`, and with lane databases a `phaseRun.qa.url` whose path
  ends in `/<qa.name>`.
- This repo's own `tools/` is the stamped 0.6.2 copy; it picks this up on the next `/update-workflow`.

## Run by hand

None. Backend-only (the runner and its tests), so no browser check. The runner and hook seams are
tested on throwaway repos; a real two-lane night is the release gate (D18, #41).

## Assumptions made

Each is a small choice, easy to change:
- **The lane's branch is `<phase branch>-lane-<id>`.** To rename it, change `laneBranch` (keep `phase-`).
- **A lane branch ahead of the phase branch refuses the start.** #37 lands them instead.
- **The lane lock is `.phase-run/lane-<id>.lock`, JSON, live while its pid answers.** `lane.mjs`.
- **The shared copy is marked finished only when no other lane's lock is live.** `mayFinishCopy`.
- **The import check reads `.mjs .cjs .js .jsx .ts .mts .cts .tsx`**, and a file that
  `worktreeSetup.copy` or `leaves` names (or a folder holding it) passes. `SCRIPT` and `ignoredImports`.
- **A `copy` file missing from the primary checkout refuses the start.** `setupWorktree`.
- **`worktreeSetup.commands` run with the runner's env**, not the session's lane values.
- **Preflight's own commands run in the primary checkout**, with the lane's `{qaUrl}`.
- **A lane value the row leaves out is left unset** (no QA port, no prefix): the project's defaults apply.
- **The absolute Edit deny uses Claude Code's `//` form**, a Windows drive as `/d/`. `sessionSettings`.
- **A lane's report is not posted to the pull request.** `main()`; #38 reads every lane.
- **A row's `env` wins over a `sessionEnv` pin of the same name.** Swap the spread order in `runTicket`.
- **A lane started after the other lane finished takes a fresh copy.** `mayFinishCopy`.
- **Start a lane from the phase branch, or a detached primary at its tip.** Preflight reads the live
  config from the primary's working copy: on `main` without `phaseRun.lanes`, it refuses with "no
  phaseRun.lanes". The one-lane run's "you are on X" check used to guarantee this.

## Common Questions

**Does a run without `--lane` change?** No path does: `work` is `ROOT`, `runVariables` and
`sessionSettings` return what they did (their tests are unchanged), and `sessionEnv`'s url is
`qaUrl`'s.

**Where do I look when a lane misbehaves?** Two places (ADR 0007): its run state in the primary's
`.phase-run/<branch>/lane-<id>/` (results, run.log, transcripts' JSON), and its session's files in
the worktree's `.phase-run/` (prompts, verdicts, receipts, the stop check's log).

**Why does the guard need no change?** `judgeRoot` resolves an absolute `PHASE_RUN_RUNNER` to
itself, and the commit rule reads the worktree's branch. The new hook-seam test pins both.

## References

- `docs/discovery/05-brigade-0.7.0.md` D2, D4, D8, D13 and #28's addendum; spec #27; ADRs 0005,
  0007, 0008.
- Code: `template/tools/phase-run/lane.mjs`, `run.mjs` (`work`, `sessionState`, `runVariables`,
  `implementationLogAdded`, preflight, `main`), `config.mjs` `laneDatabase` / `laneQaUrl` / `parseLane`.
- Tests: `template/tools/phase-run/run.test.mjs` (the lane section), `tests/guard-shell.test.mjs`,
  `tests/stop-gate.test.mjs`, `tests/env-contract.test.mjs`.
