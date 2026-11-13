# #029 — Landing's minutes

**Ticket:** `#27` (attended, before #41) · **Devlog:** `#44` · **ADRs:** 0008 (applied), none new
**Date:** 2026-11-13

---

## The Problem

A lane ticket's minutes were measured when its session ended, before Landing. Landing can take as
long as the ticket's own gates: it replays the commit, rebuilds the indexes, runs the real gates
again on the new tip, and pushes. It can also wait for the other lane's landing first. None of
that reached the Scoreboard's Min and Gates columns, so a two-lane night looked faster than it
was. The source fixed the same gap in its trials.

## The Solution

- **`metrics.mjs` `withLanding(metrics, { waitedMs, landingMs })`**, a pure function. It adds the
  lock wait to `waiting` (shown as Slept) and the landing to `gates`, and both to `total`.
  `claude`, the remainder, is unchanged. It returns a new object.
- **`run.mjs` `landPass`** times the call: `askedAt` before it asks for the lock, `heldAt` once it
  holds it (the first line of the landing's callback), `endedAt` after. It applies `withLanding`
  before any outcome is saved, so a landed, parked or unlanded result all carry it. A lock that is
  never freed counts as waiting only.

## Why This Approach

- **Wait and work are kept apart.** Waiting for the other lane is a two-lane cost (Slept): it says
  the lanes queued up. The re-gate is work (Gates).
- **`claude` stays the rest of the session.** Landing happens after the session, so it is never
  "what is left after every measured wait".

## Alternatives turned down

- **A Landing column of its own.** It would widen a table both reports and `status.mjs` share, for
  a number the Gates column already means.

## Real bugs found along the way

None beyond the gap itself.

## What This Concretely Unblocks

- **#41:** its morning report shows each landing in its ticket's Gates.

## Run by hand

None. The sum is pinned in `measure.test.mjs`, and its place in `landPass` by a source pin.

## Assumptions made

- **A restart's landing of an earlier pass adds its own time to that pass's result.** It is real
  time spent landing that ticket.

## Common Questions

**Why is my lane ticket's Slept above zero?** It waited for the other lane's landing: one lane
lands at a time.

## References

- `docs/discovery/05-brigade-0.7.0.md`, the 2026-11-13 addendum; ADR 0008.
- Code: `template/tools/phase-run/metrics.mjs` (`withLanding`), `template/tools/phase-run/run.mjs`
  (`landPass`).
- Tests, written first: `template/tools/phase-run/measure.test.mjs` (the sum), and
  `template/tools/phase-run/run.test.mjs` (the source pin).
