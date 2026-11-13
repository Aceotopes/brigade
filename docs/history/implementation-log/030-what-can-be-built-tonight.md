# #030 — What can be built tonight

**Ticket:** `#27` (attended, before #41) · **Devlog:** `#45` · **ADRs:** none
**Date:** 2026-11-13

---

## The Problem

A lane with nothing ready waits while another live lane may still land a ticket it waits on. Two
cases waited for nothing, and a third let a ticket be built twice:

- **A ticket with two blockers, one being built and one parked.** The lane waited for the first to
  land. The ticket still couldn't start, so the wait was wasted time.
- **A ticket whose blocker waits on a parked ticket.** The lane waited on the other lane, which
  could never build that blocker tonight.
- **The night's count** included both kinds, so "6 of 10" overstated the night.
- **A ticket failed by the runner's own error was never listed as parked.** The lane stops, its
  claim lapses when it exits, and the other lane, still live, could build the ticket again. That
  ignores the failure's own "look before running again".

The source fixed the first three in its trials, with one rule for the wait and the count. The
fourth sits next to its "a park let go of its claim" fix.

## The Solution

- **`claim.mjs` `buildableTonight({ byNumber, hold, done, claimed })`** gives a function: can this
  ticket still be built tonight? It can when it is ready, or when every blocker is done, claimed
  (being built), or can be built tonight in turn. A parked, not run-ready or done ticket can't, nor
  an unbuilt blocker outside the spec, nor a loop of blockers. The function remembers each answer,
  so a diamond of blockers is read once each, and a real loop is caught by the path it is on.
- **`laneChoice`** waits only for tickets that can be built tonight.
- **The count** (`reachable` in `run.mjs`): in a lane, the tickets its row takes that can be built
  tonight. A run without lanes counts as before.
- **`run.mjs` `releaseParked`**, one way to let go of a claim as parked. It is used by `park()` and
  now by the runner-error catch, in a lane.

## Why This Approach

- **One rule for the wait and the count.** Two rules would drift: the count would promise a ticket
  that the wait already knows is out of reach.
- **Memoized, so it stays cheap.** Each ticket is read once per choice, however many paths reach it.

## Alternatives turned down

- **Count the other lane's tickets out of an `any` lane's count.** Lane 1 can build them too, so
  they are its to count.

## Real bugs found along the way

The four above, all in 0.7.0's own code.

## What This Concretely Unblocks

- Two-lane nights with parked tickets in a chain wait less, and say how many tickets are really
  left.

## Run by hand

None. The rule is pure, and the count and the catch are pinned by source pins.

## Assumptions made

- **A claimed blocker counts as one that will land.** Its landing may still park. The lane then
  finds nothing ready on its next look, and stops.

## Common Questions

**Why did my lane stop when the other lane was still building?** Nothing the other lane builds can
unblock any ticket this lane takes: each one waits on something parked, or not run-ready.

## References

- `docs/discovery/05-brigade-0.7.0.md`, the 2026-11-13 addendum.
- Code: `template/tools/phase-run/claim.mjs` (`buildableTonight`, `laneChoice`),
  `template/tools/phase-run/run.mjs` (`reachable`, `releaseParked`, the runner-error catch).
- Tests, written first, in `template/tools/phase-run/run.test.mjs`:
  - the needless waits, a diamond and a loop;
  - the count, in a lane and one-lane as before;
  - the error path.

  Also `tests/phase-run-landing-lock.test.mjs`: park's pin, now on `releaseParked`.
