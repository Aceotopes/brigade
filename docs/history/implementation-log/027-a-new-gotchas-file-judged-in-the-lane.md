# #027 — A phase's new gotchas file, judged in the lane

**Ticket:** `#27` (attended, before #41) · **Devlog:** `#42` · **ADRs:** 0006 (applied), none new
**Date:** 2026-11-13

---

## The Problem

A lane may not write its gotchas block into the phase's gotchas file. The other lane may be
writing the same file, so the block waits in `.lane/<file>`, and Landing adds it when the commit
lands. Two cases broke that.

- **A phase's first landing lost the file's header.** With no gotchas file on the tip, Landing
  wrote the lane's block alone. It dropped the copy the lane had made from the template. The file
  then had no frontmatter, and the re-gate's doc-check refused it (every doc in `docs/` needs a
  header). So the ticket parked. #41's trial phase has no gotchas file, so both of its tickets
  would have parked at Landing.
- **A block's faults showed up only at Landing.** doc-check reads `LIVE_DOCS` and
  `HEADER_REQUIRED`, and `.lane/` is in neither. A stale word or a missing path in a block passed
  the lane's own gates. It failed only at the re-gate, and that parks the ticket instead of
  spending a fix round.

The source project hit the same two in its trials, in its own shape: an add/add conflict when two
lanes each made the new file, and a block that passed its lane and failed at Landing.

## The Solution

- **One fold rule, `foldBlock` in `template/tools/doc-lib.mjs`** (with `LANE_DIR`). It appends the
  block to a file's text, in that file's line endings, or gives the block alone when there is no
  text. Landing and doc-check both use it. doc-check imports `doc-lib`, so the run's copy carries it
  (`snapshot.mjs` `docTools`).
- **`numbering.mjs` `numberLane`:** a block is folded onto the tip's file. When the tip has none,
  it is folded onto the lane's own copy (the file the lane made from the template). When the tip
  has one, the lane's copy gives way to the tip's, as before. When two lanes both made the file,
  the replay's add/add conflict falls on an own-file path, which Landing owns, so it is settled:
  the tip's copy plus the block.
- **`doc-check.mjs`, in a lane only** (`PHASE_RUN_LANE` set):
  - `laneBlocks()` reads every `.lane/<file>.md` and judges `<file>` with its block folded in.
  - `read`, `exists` and the file lists see that text: the stale phrases, the missing paths, the
    header and the budgets.
  - A problem in such a file says that the lane's block was folded in, and names the block's file.
  - Outside a lane, `.lane/` is never read.
- **The lane prompt** (`run.mjs` `laneNumbers`): if the gotchas file does not exist yet, make it
  from the template with no block, in this commit. The other lane may make it too.

## Why This Approach

- **The lane writes the head, because only the session knows it.** The template's head has
  placeholders (`<PHASE>`, `<name>`) that the session fills. A Landing that started the file from
  the template would land those placeholders unfilled.
- **Judging in the lane turns a park into a fix round.** Landing's re-gate is the last word (ADR
  0008), but a fault caught there costs the whole ticket. doc-check in the lane sees the file as
  it will land, so the session fixes it while it still holds the ticket.
- **One fold rule in one place.** If Landing and doc-check each had their own, they could drift
  apart, and the check would pass a file that Landing writes differently.

## Alternatives turned down

- **Landing starts a missing file from a template path on the hotspot row.** Its placeholders
  would land unfilled. The owner chose the lane's copy (2026-11-13).
- **Exempt gotchas files from the header check.** That hides the symptom and leaves a headless doc
  on the branch.
- **Read `.lane/` outside a lane too.** A one-lane run never writes there, and today's verdicts
  must stay byte for byte (05's goal 5).

## Real bugs found along the way

The two above, both in 0.7.0's own code before release. The test that used to pin "no file on the
tip: the block starts it" still holds, for the case where the lane made no copy. That case now
fails in the lane, with "has no header".

## What This Concretely Unblocks

- **#41:** its phase has no gotchas file. The first landing now starts it with the lane's head, and
  the second lands on that copy.

## Run by hand

None. Landing is proven on throwaway repos, and doc-check on scratch repos with `PHASE_RUN_LANE`
set.

## Assumptions made

- **Every `.lane/<file>.md` is a block for `<file>`.** doc-check does not read the hotspot rows,
  which live in `.claude/workflow.json`. A lane only writes `.lane/` files for own-file rows.
- **The judged text is the lane's checkout plus the block, not the tip's.** A lane's branch is cut
  from the tip, so the two differ only by what the other lane landed since. Landing's re-gate
  judges the real result.

## Common Questions

**Why did doc-check pass my block and Landing park it?** It can't happen now: in a lane, doc-check
judges the file with the block in it.

**What if both lanes make the file?** Whichever lands first keeps its copy. The second lands its
block on that copy.

## References

- `docs/discovery/05-brigade-0.7.0.md`, the 2026-11-13 addendum; D7, D13; ADR 0006, ADR 0008.
- Code: `template/tools/doc-lib.mjs` (`LANE_DIR`, `foldBlock`), `template/tools/phase-run/numbering.mjs`
  (`numberLane`), `template/tools/doc-check.mjs` (`laneBlocks`, `read`, `exists`, `laneNote`),
  `template/tools/phase-run/run.mjs` (`laneNumbers`).
- Tests, written first:
  - `tests/phase-run-numbering.test.mjs`: the lane's copy keeps its head, the tip's copy wins, and
    the prompt's line;
  - `tests/phase-run-landing.test.mjs`: both lanes make the file, and the tip has none;
  - `template/tools/doc-tools.test.mjs`: a stale phrase and a missing path in a block, the missing
    header, and `.lane/` unread outside a lane.
