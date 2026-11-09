---
status: accepted
---
# A lane's run state lives in the primary checkout; its session's files live in its worktree

A lane builds in its own git worktree beside the repo, so its session's edits, installs and test
runs never touch the other lane's files. The runner also keeps state about each lane: its claims,
its results, its logs, and the locks both lanes read. If that state lived in each worktree, the
other lane couldn't see it, and a worktree reset before setup would wipe it. Decided in 0.7.0's grill
(2026-11-09, `docs/discovery/05-brigade-0.7.0.md` D13, D19), as a port of one real project's runner.

## Decision

- **Run state has one root, the primary checkout.** A lane's results and logs are in
  `.phase-run/<branch>/lane-<id>/`. The claim file and the landing lock are in `.phase-run/<branch>/`,
  shared by both lanes.
- **A session's files follow its worktree.** `PHASE_RUN_ROOT` and `CLAUDE_PROJECT_DIR` are the
  worktree inside a lane session, and its hooks, receipts and stop check read there.
- Without lanes, both roots are the same folder, as today.

## Considered and rejected

- **Everything in the worktree.** Each lane would see only its own claims, so the other lane's
  claims would be invisible, and resetting a worktree would erase its own history.
- **Everything in the primary checkout.** The session would then write receipts and scratch files
  into the other lane's tree, which is the sharing lanes exist to stop.
- **A third folder outside the repo.** It would be one more path to configure, clean and find in
  the morning, for no gain over `.phase-run/`.

## Consequences

- When debugging a lane, look in two places: its run state in the primary checkout, and its session's
  files and transcript in its worktree.
- Code that reads run state must take the primary checkout's root, never `PHASE_RUN_ROOT`. Code that
  judges a session's work must take the session's root, never the primary checkout's.
- 0.7.0's probe (D9) must show that a project-scope Brigade's hooks run in the worktree, with
  `CLAUDE_PROJECT_DIR` set to it. If they don't, this split has nothing to stand on.
