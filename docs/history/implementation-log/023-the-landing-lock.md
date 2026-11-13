# #023 — The landing lock

**Ticket:** `#37` · **Devlog:** `#38` · **ADRs:** 0008, 0007, 0006 (applied, none new)
**Date:** 2026-11-10

---

## The Problem

#36 built Landing, which puts a lane's passing commit on the phase branch, but nothing called it.
A lane's pass stayed on its own branch all night. D13 says a lane lands its passes on its own, one
lane at a time, under one landing lock (ADR 0008). Whatever happens, the primary checkout must be
left in a good state:

- **undo-detach** on every way out, a crash and Ctrl-C included;
- the **hand-back**: the last lane out leaves the primary checkout on the phase branch's tip;
- a **restarted lane** lands its own unlanded passes before it claims new work;
- a lane's **`.lane/`** scratch files are never out of the ticket's Areas.

#36 also handed this ticket a list: release the claim, reset the lane branch after a landing, turn
a park into a real park, and give the re-gate a tree its gates can run in.

## The Solution

**A new module, `template/tools/phase-run/landing-lock.mjs`.**

- **`underLandingLock(opts, fn)`** runs one landing holding `.phase-run/<branch>/landing.lock`, in
  the primary checkout (ADR 0007).
  - **Taking it.** The lock is made by exclusive create. A live holder is waited on with an `await`,
    every few seconds, up to three hours. A dead holder's lock lapses and is taken over.
  - **Detaching.** If the primary checkout is on the phase branch, it is detached (same files) and
    the lock records the detach. Landing moves the branch with `update-ref`, which under a
    checked-out HEAD would leave the index on the old commit. Where a lane normally leaves the
    primary, on `main`, nothing is touched.
  - **Undoing the detach.** `git checkout <branch>` puts the primary back, at the new tip. It runs in
    a `finally`, and in an `exit` handler for a `process.exit` or the runner's Ctrl-C. A process
    killed outright runs neither, so the next taker of its lapsed lock reads the recorded detach and
    undoes it first.
- **`handBack`**: when no other lane of the branch is live, the primary checkout is checked out on
  the phase branch. An uncommitted edit leaves it where it is, so the owner's work is never carried
  or lost.
- **`keepUnlanded` and `unlandedCommits`**: on a restart, the lane branch's commits the phase branch
  lacks are kept on a hidden ref, `refs/phase-run/unlanded/<lane branch>`, before the worktree is
  reset. Each kept commit is then read, oldest first, as `landed` (the branch has its `Closes #N`),
  `parked` (a parked branch keeps that very commit) or `unlanded`. `restartSteps`, which is pure,
  gives each one an action against the lane's results:
  - land a recorded pass;
  - keep, on a parked branch, a commit with no recorded pass;
  - finish the record of one the last start landed or parked but died before writing;
  - or skip it.

  `dropUnlanded` removes the ref once every commit is kept elsewhere.

**`claim.mjs`.** The lock's loop is split into one attempt, `lockTaker`, shared by the claim lock
and the landing lock. `releaseClaim` drops a lane's claim under the lock. For a parked ticket it
adds an entry to a new `parked` list in the claim file, which `claimNext` hands to the runner's
hold. `clearParked` empties the list.

**`lane.mjs`.** `prepareWorktree` takes `kept`: a lane branch ahead of the tip is reset only when its
head is the one kept. `resetWorktree` puts the worktree back on the lane's branch at the new tip.

**`run.mjs`.**

- **`landPass`.** In a lane, a pass is recorded `landed: false` with its full commit, then landed
  under the lock:
  - **The re-gate** (`regateLanded`) checks the lane's worktree out at the landed commit, detached,
    and runs the project's real gates there, the tampering verdict included, and doc-check. That
    tree has the lane's install; Landing's scratch tree has only tracked files.
  - **The migration** (`migrateLanded`) runs from the same tree, as the last gate.
  - **The rebuild** runs `node tools/doc-index.mjs` on the numbered tree.
  - **A changed fingerprint** parks the ticket, since the runner can't walk screens itself.
  - **After it**, the result is changed in place:
    - landed: its new hash, its numbers, the push, a carried pass's note;
    - parked: `failed`, posted on the issue as a needs-a-person park, with the attempt and any
      migration left on the target.
    Then the worktree is reset to the tip, and the claim released. A park that could not be kept on
    a parked branch is never reset away: the lane stops, its pass still on its branch.
- **`landUnlanded`.** A restart carries out `restartSteps` before its first claim. It takes a claim
  before landing a pass: while it was down its claim lapsed, and the other lane may be building the
  ticket again. If so, its pass is kept on a parked branch instead.
- **The hand-back** is an exit handler, after the lane's own lock is released.
- **The rest.** A lane that starts with no other lane live clears the parks list. A session's park in
  a lane releases its claim, and `park`'s GitHub half is now `postPark`. A lane never rewrites the
  pull request's body. `.lane/` joins `ALWAYS_IN_SCOPE`.

A run without `--lane` takes none of these paths.

## Why This Approach

- **An async wait for the landing lock.** A landing re-gates, so it runs for minutes. The claim
  lock's sync loop releases its lock as soon as `fn` returns, which for an async landing is at once.
  Sharing one attempt (`lockTaker`) keeps the two locks' rules for breaking a crashed holder the
  same.
- **The lock records the detach.** Only the lock outlives a process killed outright, so the undo has
  to be read from there. The next landing is the first code that can act on it.
- **The re-gate in the lane's worktree.** It already has `worktreeSetup`'s install and copied files,
  and it is idle while its own pass lands. Running setup again in a scratch tree would double the
  install for every landing.
- **A hidden ref for the restart's commits.** `prepareWorktree` must reset the worktree to the tip
  before the runner copy and its config are read, and Landing needs that config. The ref keeps the
  commits through the reset without a branch the owner would have to clean up.
- **Change the result in place.** A second `recordResult` would write a second night row to the
  ledger for one session.

## Alternatives turned down

- **Run `worktreeSetup` in Landing's scratch tree.** It would be correct, but it doubles the install
  for every landing.
- **Land a restart's commits before `prepareWorktree`, with the live config.** The night is judged by
  the copy's rules (ADR 0005). The copy is read only after the reset.
- **Keep a parked ticket's claim.** The other lane would then wait on it as "claimed" until the
  parking lane exits, which the ticket's criterion rules out.
- **Re-read labels from GitHub before each claim.** That puts a network call inside the claim lock.
- **Stack a restart's several passes and land them in one go.** Numbering refuses a devlog with two
  unnumbered entries, so each lands on its own, oldest first.
- From the code review, turned down:
  - **The `parked` list as scope creep.** Releasing a parked ticket's claim without it would let the
    other lane, whose labels are from its own start, build the parked ticket again.
  - **A lane leaving the pull request's body alone, as #38's territory.** Rewriting it from one lane's
    results would drop the other lane's tickets. It is recorded below as owed to #38.
  - **Posting the restart's keep of a commit with no recorded pass to GitHub.** That ticket is not
    parked: it never passed, and is ready to be built again. The keep is logged.
  - **`resetWorktree`'s `--force`.** It forces the lane's own worktree, and only once its pass is on
    the phase branch or a parked branch; ADR 0008's "never forces" is about the phase branch.
  - **Folding the small repeats** (`resetWorktree` beside `prepareWorktree`'s reuse path, the two
    `releaseClaim` try blocks, the inline escape for `.lane`, a third `gitAt`) and splitting `landPass`.
    Each is a few lines, and merging them would reshape #33's and #36's functions for no change.
  - **Passing the tip to `migrateLanded`** instead of reading `HEAD^`. Landing's `apply(dir, names)`
    has no tip, and the re-gate has just checked the worktree out at the landed commit (gotcha #37).
  - **A run-level test of `landUnlanded`.** It needs a live run (GitHub, sessions). Its decisions
    are in the pure `restartSteps`, tested, and its order is pinned in the source.

## Real bugs found along the way

None in shipped code. The code review found these in this ticket's first commit, fixed before it
landed:
- A Landing park whose pass could not be kept on a parked branch still reset the lane's worktree,
  leaving the commit on no branch.
- A restart dropped its keep even when a commit could not be kept elsewhere.
- A restart landed its pass without a claim, so a ticket the other lane rebuilt while this lane was
  down could land twice.
- A dead landing's recorded detach was undone without checking where the checkout was, so a
  checkout the owner had since detached could be moved, and a false "attached again" note was given.
- A crash between Landing and its record left a result saying "unlanded" for good, and a park never
  posted.
- The re-gate left out the tampering gate, which ADR 0008 counts among the real gates.

## What This Concretely Unblocks

- **#41**: a full two-lane night to try, on a throwaway repo.
- **#38**: the morning report reading every lane. A lane's results now say `landed`, carry the
  landed `hash` and `commit` (the lane's own hash is `laneHash`) and the `numbers`, or carry a park's
  `landing` step.
- **Owed to #38:** the pull request's body. A lane creates the pull request if it is missing and never
  rewrites its body, since it knows only its own tickets. The body listing every lane's tickets is
  #38's reading.

## Run by hand

None. Backend-only (the runner and its tests), so no browser check: no screen changes.

## Assumptions made

Each is a small choice, easy to change:
- **The rebuild is `node tools/doc-index.mjs` on the numbered tree**, since no hotspot row names a
  command. To change it, add a `rebuild` key to the rows and read it in `rebuildGenerated`.
- **A park at Landing is a needs-a-person park** (`failed`, the failure label). To make it a
  question, pass `"question"` to `postPark` in `landPass`.
- **A changed fingerprint parks** instead of running the browser check again, which needs a
  session. To retry instead, start a fix session from `landPass`'s `browserCheck`.
- **A lane creates the pull request if it is missing, and never edits its body.** Drop the
  `if (!lane)` in `ensurePullRequest` to restore the edit.
- **The landing lock waits up to three hours**, then the lane stops with its pass unlanded, for its
  restart. Change `LANDING_WAIT_MS`.
- **The hand-back skips any uncommitted change to a tracked file**, and says so in the run's log.
  Untracked files (the run's own folder) don't count.
- **The night's parks list is cleared by a lane that starts with no other lane live.** Two lanes
  started within the same instant each see the other, so neither clears it, and a park the owner has
  answered stays held that night. Preflight's network checks make that unlikely. To change it, keep
  only the entries written since the lane's start instead of clearing.
- **The hand-back runs on any exit of a lane, a refused start included**, so a lane that stops at
  its worktree's setup still puts the primary checkout on the phase branch. To change it, gate the
  exit handler on a flag set once the lane's setup has passed.

**Found elsewhere, not fixed:** a crashed lane's own lock, `.phase-run/lane-<id>.lock` (#33),
refuses its restart until it is deleted by hand, as the one-lane `.phase-run/lock` does. So a
restarted lane lands its unlanded passes only after that step. The lock could lapse with its pid
instead, as the claim and landing locks do.

## Common Questions

**Does a run without lanes change?** No. Every new path sits behind `lane`, and a source pin holds
that. The one change outside a lane: a `.lane/` file is never out of a ticket's Areas.

**Why does undo-detach move the primary checkout's files while another lane runs?** It moves them
only when the owner left the primary on the phase branch. Re-attaching to a branch that moved means
its files follow. The hand-back is what waits for the last lane.

**What if both lanes crash?** Each lock lapses with its process. The next landing undoes a recorded
detach, and each restarted lane lands its own unlanded passes before claiming.

**Where does a parked landing's work go?** On `<branch>-parked-<N>`, unnumbered, as #36 keeps it. The
issue gets the park comment and label, and the lane goes on from the tip.

## References

- `docs/discovery/05-brigade-0.7.0.md` D13; spec #27; ADRs 0005, 0007, 0008.
- Code: `template/tools/phase-run/landing-lock.mjs`; `claim.mjs` (`lockTaker`, `releaseClaim`);
  `lane.mjs` (`prepareWorktree`'s `kept`, `resetWorktree`); `landing.mjs` (`keepParked` exported);
  `run.mjs` (`landPass`, `regateLanded`, `migrateLanded`, `rebuildGenerated`, `landUnlanded`,
  `postPark`).
- Tests: `tests/phase-run-landing-lock.test.mjs`, written first, red on the missing module, with
  two more for the code review's fixes; the `.lane/` case in `template/tools/phase-run/run.test.mjs`.
