# #016 — Hotspots and unnumbered entries: a lane writes NNN, a pure step numbers it

**Ticket:** `#30` · **Devlog:** `#31` · **ADRs:** none new (0006's numbering at Landing, built)
**Date:** 2026-11-09

---

## The Problem

Every commit in a phase run takes the next devlog number, names an implementation log, and cites
the number in its message. With one runner, "next" is just the last number plus one. With two lanes
building at once, both would read the same last number, and the second to land would collide with
the first. ADR 0006 settles it. A lane writes the token `NNN` wherever a number goes, and Landing
fills the numbers in from the phase branch's tip. Before any lane runs, three things must be true:
doc-check has to accept an unnumbered entry inside a lane (and only there), a lane session has to
be told to write the token, and there has to be a function that does the numbering.

## The Solution

**The token, in two places, pinned equal.** `config.mjs` exports `HOTSPOT_TOKEN = "NNN"`, the
default for `phaseRun.hotspots.token`. `doc-config.mjs` mirrors it as `NUMBER_TOKEN`. The doc tools
and the runner end up in different places once installed, so neither can import the other. A test in
`tests/phase-run-numbering.test.mjs` keeps the two equal.

**doc-check, inside a lane only.** While `PHASE_RUN_LANE` is set, three things pass:
- a devlog entry headed `## #NNN · <type> · <title>` counts as the open top entry. Its type is still
  checked. `devlogEntries` takes an optional `{ token }` for this, and with no token it behaves as before.
- a log file `NNN-<slug>.md` needs no header, as a numbered one does. doc-check finds the log folder
  from `GENERATED`'s `implementation-log` row, so no new path is needed.
- a commit message may cite `devlog #NNN`.

Outside a lane, `unnumberedProblems` names each one: the devlog line, the log file, and the message.
That is one problem per spot, not a token problem plus a missing-header problem.

**The lane prompt.** `ticket-prompt.md` gains one `{{LANE_NUMBERS}}` marker, at the end of a
paragraph. `promptValues` fills it only when the ticket values carry `LANE`, so a one-lane prompt is
the same, byte for byte. The lane's paragraph:
- warns that the prompt uses `NNN` above to mean "your number", but here it is literal text;
- lists every spot the token goes;
- sends the gotchas block to `.lane/<the gotchas file's path>`.

`runVariables` sets `PHASE_RUN_LANE` when it is given a lane. Nothing passes one yet.

**The numbering function.** `template/tools/phase-run/numbering.mjs` `numberLane` is pure. It takes
the lane commit's changed files, its message, the tip's text of the hotspot files, the tip's last
numbers `{ devlog, log }`, the loaded `hotspots`, and the phase name. A row's path may be a file, a
folder, or a pattern with `*` and `{phase}`. An exact path wins, then the longest row that covers
the file. By kind:
- **`log`**: a file of entries (the devlog) gets the lane's one `## #NNN` entry, numbered, put on
  top of the tip's file in the tip's line endings. A file named `NNN-<slug>.md` is renamed to the
  next log number, padded to three digits.
- **`generated`**: the tip's text is kept. Every generated row is listed in `rebuild` for #36.
- **`own-file`**: the block in `.lane/<path>` is appended to the tip's file, and the scratch file
  goes (`null`).
- **no row**: left exactly as the lane wrote it, even with `NNN` in it.

The result says, for each path, what the tip gets (`null` means the path must not exist there),
plus the numbered message, the two numbers taken, and the rebuild list.

## Why This Approach

**A pure function at the seam.** Numbering is the risky part of Landing, and a function that reads
no files and runs no git can be tested with plain strings: given a tip at devlog 41 and log 15, the
lane's entry becomes #42 and its log `016-…`. #36 does the I/O (replay, rebuild, re-gate) around it.
In an interview: "I split the decision from the side effects. The decision is a pure function of the
lane's diff and the tip's state, so it's cheap to test exhaustively; the git plumbing is a thin shell."

**Two counters, routed by position.** This repo numbers the implementation log separately from the
devlog (log 015 was devlog #30). One token has to stand for both. So the spot decides:
- the log's file name, its `# #NNN` title, and a bare `NNN` take the log number;
- every other `#NNN` takes the devlog number.

The token stays a single word, and a lane only has to know one rule: "write NNN".

**Acceptance gated by an environment variable.** doc-check already switches on `PHASE_RUN`. A lane
is a run that cannot number, so `PHASE_RUN_LANE` is the honest signal. Outside a lane, a stray `NNN`
is still refused. The env-contract test made the runner the one place that sets it.

## Alternatives turned down

- **Filling `token`'s default into the loaded config.** #29 pinned `token: null` when it is left out.
  The default is read where it is used (`?? HOTSPOT_TOKEN`), so the loader's test stands.
- **A new `IMPLEMENTATION_LOG` constant in doc-config.** `GENERATED`'s `implementation-log` row
  already names the folder in every project's doc-config, and an older doc-config has no new constant.
- **Numbering both counters with one number** (the ticket's "N+1 everywhere", read literally). It
  would rename this repo's logs out of sequence. To switch, pass the same number as `devlog` and `log`.
- **Running doc-index inside the function.** Rebuilding is #36's. The function only lists what to
  rebuild, and it lists every generated row, because a lane's run of doc-index skips its `NNN` log.

Both code reviews (standards and spec, against #30) ran after the first commit. These fixes are in
the same commit:
- **A lane token doc-check would refuse.** The prompt used `phaseRun.hotspots.token`, while doc-check
  knows only doc-config's `NUMBER_TOKEN`. `laneToken` now refuses a lane prompt when the two differ.
- **`devlog #nnn` read as `#NaN`.** The message match ignores case, so a lowercase token is now
  mapped back to the token.
- doc-check reuses doc-lib's new `escapeRegExp` instead of keeping its own copy.
- The gotchas block is trimmed to one line per pinned trap, and the bullet that repeated
  measure-trim's env-contract trap is dropped.

These findings were turned down:
- **A bare `NNN` in the message or a block becomes the log number.** That is the routing rule (it is
  how "implementation log NNN" is filled), and a lane is told to write the token only where a number
  goes.
- **A CRLF `\r` in `unnumberedProblems`' quoted line.** doc-lib's `read` already turns CRLF into LF.
- **The heading regex built in three places, and `(token, numbers)` travelling together.** The copy
  in numbering.mjs has to stay: it may not import the doc tools. Sharing a matcher between doc-lib
  and doc-check would save one line.
- **`ticket.LANE` and `runVariables({ lane })` have no caller yet.** The env-contract test needs the
  second, and both are handed forward.
- **`numberLane` takes `last` instead of reading it off the tip.** The ticket says it "takes … the
  tip's last numbers". #36 reads them.

## Real bugs found along the way

None in shipped code. One near miss: `tests/env-contract.test.mjs` refuses any `PHASE_RUN_*` name
that doc-check reads but the runner never sets. Reading `PHASE_RUN_LANE` meant `runVariables` had to
gain its lane switch in this ticket, not later.

## What This Concretely Unblocks

- #36 calls `numberLane` with the lane commit, the tip's devlog, gotchas and generated files, and
  `{ devlog, log }` read off the tip. It then replays the rest with git and rebuilds `rebuild`.
- **Owed to the ticket that gates a lane (#36, or whichever runs gates in a lane):**
  - `run.mjs`'s docs gate requires a `\d{3}-` implementation log, so a lane commit with `NNN-…` would
    fail it.
  - That ticket also passes `lane` to `runVariables` and `LANE` to the ticket values.
  - It may also refuse a numbered devlog entry inside a lane (see Common Questions).
- #31: inside a run, a lane's `NNN` acceptance should come from the runner copy's doc-check (D10).
  This ticket changed only the template's doc tools; this repo's own `tools/` copy picks them up on
  the next update.
- #40 writes the first rows. A row may be exact, a folder, or a `*` pattern, and `{phase}` is filled.
  So the gotchas row can be `docs/agents/gotchas/{phase}.md`, and the implementation log a folder.

## Run by hand

None. Backend-only (doc tools and a runner module), so no browser check.

## Assumptions made

Each is a small choice, easy to change:
- **Two counters** `{ devlog, log }`, routed by where the token stands. To use one, pass the same
  number for both.
- **The scratch file is `.lane/<the own file's full path>`** (`scratchFor`), so a pattern row and
  `{phase}` both work. To use a flat name, change `scratchFor` and the target lookup in `numberLane`.
- **The lane commits `.lane/`.** It is not ignored, so the block reaches Landing in the commit. The
  numbering removes it.
- **One unnumbered entry per log file and one unnumbered log per lane commit.** More is refused by
  name. Lift the checks in `withEntry` and `numberLane` if a lane ever lands two tickets as one.
- **A log number is padded to three digits**, as doc-index and the docs gate read it.
- **A log file with no unnumbered entry is left to git.** doc-check inside the lane already refuses
  a commit without one.

## Common Questions

**Why is the lane's change to a generated index thrown away?** The lane built its index without its
own log (doc-index skips an `NNN` file), and the tip's index has entries the lane never saw. Neither
is right, so both are rebuilt on the numbered tree.

**What stops a lane from forgetting the token and writing `#31`?** Nothing yet. doc-check in a
lane still accepts a numbered entry, and `numberLane` leaves a devlog with no `## #NNN` entry to git,
which would then conflict on the tip. Refusing a numbered entry inside a lane is a one-line check, left
for #36 to decide, since #36 owns what happens on the tip.

## References

- ADR 0006; `docs/discovery/05-brigade-0.7.0.md` D7 and D10; spec #27.
- Code: `template/tools/phase-run/numbering.mjs` `numberLane` / `scratchFor`, `config.mjs`
  `HOTSPOT_TOKEN`, `run.mjs` `promptValues` / `laneNumbers` / `laneToken` / `runVariables`,
  `template/tools/doc-check.mjs` `unnumberedProblems` / `checkDevlogAgainst`, `doc-lib.mjs`
  `devlogEntries`, `doc-config.mjs` `NUMBER_TOKEN`.
- Tests: `tests/phase-run-numbering.test.mjs`, `template/tools/doc-tools.test.mjs` (the lane tests).
