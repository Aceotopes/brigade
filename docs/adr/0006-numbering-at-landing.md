---
status: accepted
---
# A lane writes its devlog entry, log and commit message unnumbered, and Landing numbers them

Every commit in a phase run takes the next devlog number, names its implementation log after it,
and cites it in its message. With one runner, the next number is simply the last one plus one. With
two lanes building at once, both would read the same last number and take it, and whichever landed
second would collide with the first. Decided in 0.7.0's grill (2026-11-09,
`docs/discovery/05-brigade-0.7.0.md` D7), as a port of one real project's runner, where it was
built and proven on two lanes.

## Decision

- A lane writes the token `NNN` wherever a number goes: its devlog entry, its implementation log's
  file name, and its commit message. Its gotchas block goes into a scratch file in `.lane/`.
- Landing reads the last numbers off the phase branch's tip, fills them in, and rebuilds every
  generated index on the numbered tree before the re-gate (ADR 0008).
- Which file gets which treatment is data: `phaseRun.hotspots` rows of four kinds (log, generated,
  own file, left to git). Setup writes the first rows from doc-config's paths.
- doc-check accepts `NNN` only while `PHASE_RUN_LANE` is set. Outside a lane it is still refused.

## Considered and rejected

- **Reserve a block of numbers per lane** (lane 2 takes 500 and up). This gives no conflicts, but
  the devlog then reads out of order, and a gap is left when a lane parks a ticket.
- **Take the number at commit time, under the landing lock.** That holds the lock for a whole
  build. The two lanes would then run one after the other, which defeats the purpose.
- **Let git settle it as a merge conflict.** Every ticket's commit would conflict on the devlog, and
  the "resolution" would renumber by hand at night.

## Consequences

- A lane branch's commit is not a finished commit: its message says `devlog #NNN`. Only the landed
  commit on the phase branch is final. A reader looking at a lane branch must not "fix" the token.
- A run without lanes never writes `NNN`, so nothing changes for it.
- Every new file that commits write at a fixed spot needs a hotspot row, or Landing leaves it to
  git. Refresh offers a row when doc-config gains a path.
