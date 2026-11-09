# #020 — The claim and the frontier: two lanes never build the same ticket

**Ticket:** `#34` · **Devlog:** `#35` · **ADRs:** 0007 (applied, none new)
**Date:** 2026-11-10

---

## The Problem

#33 gave a running lane: `run.mjs --lane <id>` builds in its own worktree and keeps each pass
unlanded on `<branch>-lane-<id>`. But each lane still picked tickets the way a one-lane run does:
the first ready ticket, in order. Two lanes started together would both pick the same one. Nothing
said which tickets a lane's row `takes`, either.

And "built" was read off `main..HEAD`. In a lane's worktree HEAD is the lane's own branch, so a
lane's unlanded pass counted as built, but only for that lane. The other lane read the same ticket
as not built.

## The Solution

**A new module, `template/tools/phase-run/claim.mjs`**, holds the claim and the frontier. `run.mjs`
calls it only under `--lane`.

- **The claim file** is `.phase-run/<branch>/claims.json` in the primary checkout, shared by both
  lanes (ADR 0007), and `run.claims` names its folder. It is read and written only inside
  `withClaimLock`, which runs a function holding `claims.lock`. That lock is made by an exclusive
  create (`writeFileSync(…, { flag: "wx" })`), so two processes never hold it at once.
  - The lock records its holder's pid and a random token.
  - The lock is broken if its holder's process is gone, or if the holder is this very process (a
    take never nests). It is also broken if it stays empty past `UNREADABLE_GRACE_MS`, which means
    its maker died before writing it. A live holder is waited on for `LOCK_WAIT_MS` by the injected
    clock, then refused, naming the lock and the pid.
  - The lock is released in `finally`, and only if it is still this caller's token.
  - The file is written to a `.part` file and renamed into place. An unreadable claims file is
    refused, never read as "nothing claimed".
- **A claim** is `{ ticket, lane, pid, at }`. `liveClaims` keeps those whose pid still answers, so a
  dead process's claims lapse (glossary: Claim). `takeClaim` drops lapsed claims from the file on its
  next write.
- **`takeClaim({ dir, lane, choose, pid, at, alive })`** reads the live claims under the lock and
  asks `choose(claims)` for a ticket number. It writes the claim and returns `{ ticket, claims }`.
  Because the choice happens inside the lock, of two lanes claiming at once the second chooses
  with the first's claim already in view.
- **The frontier, `laneChoice`.** It is pure: it takes `hold` (the runner's `holdReason`), `done`,
  the live claims and the other live lanes' rows. A lane's frontier is its tickets in order that
  - its row `takes` (`takesTicket`: `any`, or the label),
  - no live claim holds,
  - and `hold` passes (ready, blockers built).

  The first such ticket is taken.
- **The wait.** With an empty frontier, `laneChoice` follows the blocker chain of each ticket the
  lane takes that is "waiting on #N", and lists what could still unblock it:
  - an unbuilt ticket another live lane has claimed (`claimed: true`);
  - or an unbuilt, not-parked ticket that another live lane's row takes (`claimed: false`).

  `claimNext` loops: claim, else wait `CLAIM_POLL_MS` through the injected `sleep` while that list
  is non-empty, else return `{ ticket: null }`.
  - A lane never waits on its own claim, because it can't land one while it waits.
  - It never waits past a parked or unlabelled ticket: no lane builds those tonight.
  - While it waits, the claim file lists it under `waiting`, written in the same locked write as
    its look. The other lane passes these lanes in as `idle`, and an idle lane's claims and takes
    don't count. So two lanes never wait on each other: whichever looks second sees the first
    waiting, and stops.
- **"Built" off the phase branch.** `builtOn(git, ref, number)` is the old `git log main..<ref>
  --grep Closes #N`. `run.mjs` passes `builtRef`, which is `HEAD` in a one-lane run (today's command,
  byte for byte) and the phase branch in a lane (`if (lane) builtRef = branch`).
- **`run.mjs` `nextTicket`.** With no lane it is today's
  `inScope.find((ticket) => holdReason(ticket, byNumber) === null)`. In a lane it calls `claimNext`:
  - `others` comes from `liveLanes(STATE)`: the live lane locks on this branch, mapped to their
    rows in the copy's config.
  - a wait is logged once per change ("waiting on lane 1's #5", "#6, which lane 1 may take").
  - a stop is logged as a routine line.
  - a claim file or lock that refuses stops the loop with `run.stopped`, so the run still writes
    its report.
- The "6 of 10" progress count, in a lane, counts only the tickets its row takes.

## Why This Approach

- **Choose inside the lock.** A claim file read, then a choice, then a write would let two lanes
  both read "unclaimed" and both write. With the choice inside the exclusive lock, it can't happen,
  and the real two-process test shows it: two children wait for one "go" file, then take at once.
- **The process check is the lapse.** The glossary decides a claim lapses when its process dies, not
  after a timeout. A lane's ticket can take hours, so any timeout would be a guess. `pidAlive` is
  #33's, the same check the lane locks use.
- **Breaking a dead lock by rename.** Two lanes could both see a dead holder. If both deleted the
  lock, the second could delete the first's fresh lock. Instead each moves the lock to a name of its
  own and checks it moved the dead one. If it moved a live one, it writes it back by exclusive
  create, which works on any file system (a hard link would not on exFAT or some shares).
- **A synchronous take.** The lock is held for a few git reads. A sync `Atomics.wait` pause keeps
  `takeClaim` a plain function, so the choice can't interleave with anything else in the runner.
- **Waiting on a lane's takes, not only its claims.** The first wait test showed why. Once lane 1's
  #5 lands, #6 is ready for lane 1 but not yet claimed. A rule reading only claims would stop lane 2
  while lane 1 is about to build its blocker. The wait still ends: a lane with nothing ready stops,
  its process exits, and it drops out of `others`.

## Alternatives turned down

- **A claim timeout.** Turned down by the glossary's rule; see above.
- **Cross-checking a claim's pid against its lane's lock** (to guard against pid reuse). It would
  tie claims to #33's lock format for a rare case. Noted in the gotchas.
- **Reading "built" off the phase branch in a one-lane run too.** In a one-lane run it is the same
  commit, except in a dry run started off the branch, which would then list different tickets.
  Goal 5 keeps a one-lane run as it is.
- **An async lock with `setTimeout`.** It would let another piece of the runner run between the read
  and the write. Not needed for a hold this short.
- From the code review, turned down:
  - **Test "a run without lanes picks as today" by running the pick.** `main()` needs GitHub and
    git. The source pin follows #33's precedent for `runGates` and `finishBuilt`.
  - **Set `run.stopped` when a lane runs out of work.** `run.stopped` is the report's line for a
    run that stopped early. A lane with nothing left isn't one: the report's remaining list gives
    each ticket's hold reason. The plan comment said otherwise; this is the change.
  - **A ticket a dead lane built, unlanded, can be built again by the other lane.** That is the
    decided lapse rule. A restart of the dead lane is refused while its branch holds unlanded
    commits (#33), so it never rebuilds its own. Handed to #37.
  - **Typed hold reasons instead of matching "waiting on #".** `main()`'s progress count already
    reads the string. Changing `holdReason`'s shape is outside this ticket.
  - **Tests that call `takeClaim` without a fake clock.** The clock there only stamps the lock and
    bounds a wait that never happens. No expectation reads it, and each claim's `at` is fixed.

## Real bugs found along the way

None in shipped code. The code review found four in this ticket's own first commit, fixed before
it landed:
- An empty lock, left by a maker that died before writing it, was spun on forever.
- Putting a live lock back used a hard link, which fails silently on file systems without them.
- Two lanes could wait on each other forever, each holding a built ticket the other's next one
  needs.
- A claim file or lock that refused escaped the main loop, so no report was written.

## What This Concretely Unblocks

- **#37 releases a claim** once its ticket lands or parks. Until then a claim lives as long as its
  lane's process. A lane waiting on a blocker that the other lane built but hasn't landed waits until
  that lane exits, then stops, since the blocker is still not on the phase branch.
- **#37 and lapsed claims.** A lapsed claim's ticket can be claimed again. If the dead lane had
  passed it, the pass is unlanded on its branch, and the other lane may build it again. #37's
  "a restart lands its own unlanded tickets first" is what keeps that rare.
- **#36 and #37** can take `claims.lock`'s pattern (`withClaimLock`) for the landing lock in the same
  folder.

## Run by hand

None. Backend-only (the runner and its tests), so no browser check. The claim's race is tested with
two real processes; a real two-lane night is the release gate (D18, #41).

## Assumptions made

Each is a small choice, easy to change:
- **`phaseRun.lanes.claims` keeps no keys.** The lapse is the process's death. Add a key in
  `config.mjs` `KEYS.claims` if a project ever needs one.
- **The waiting lane looks again every 30 s** (`CLAIM_POLL_MS`), **a live lock holder is waited
  on for 60 s** (`LOCK_WAIT_MS`), and **an empty lock is broken after 2 s**
  (`UNREADABLE_GRACE_MS`). All are constants in `claim.mjs`.
- **The claim file also lists the waiting lanes** (`waiting`), so a lane never waits on one that is
  waiting itself.
- **A lane waits on a ticket another live lane's row takes**, not only on one it has claimed. Drop
  the `taker` branch in `laneChoice` to wait on claims alone.
- **The claim file is JSON, `{ "claims": [...], "waiting": [...] }`**, with each claim's `at`
  from the injected clock.
- **A wait is logged once per change of what it waits on; the stop is a routine line.** `nextTicket`.
- **A lane's progress count includes only the tickets its row takes.** `main()`'s `reachable`.

## Common Questions

**Does a run without `--lane` change?** No. `nextTicket` returns today's pick before any claim code,
and `builtOnBranch` runs the same `git log main..HEAD`. The new test pins both in the source.

**Where is the claim file?** In the primary checkout's `.phase-run/<branch>/claims.json`, beside the
shared runner copy. It is never in a worktree (ADR 0007).

**What if a lane crashes mid-take?** Its lock names a pid that no longer runs, so the next take
breaks the lock. The `.part` file it may leave is overwritten by the next write from that pid, and
the folder is git-ignored run state.

## References

- `docs/discovery/05-brigade-0.7.0.md` Goals 3, D6, D13, ticket 6; spec #27; ADR 0007; glossary:
  Claim.
- Code: `template/tools/phase-run/claim.mjs`; `run.mjs` (`builtRef`, `builtOnBranch`, `nextTicket`,
  `main`).
- Tests: `template/tools/phase-run/run.test.mjs` (the claim and frontier section).
