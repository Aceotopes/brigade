# #024 — Findings and the reports' lane reading

**Ticket:** `#38` · **Devlog:** `#39` · **ADRs:** 0007, 0005 (applied, none new)
**Date:** 2026-11-10

---

## The Problem

With two lanes, each lane wrote its results to its own folder, `.phase-run/<branch>/lane-<id>/`
(#33). The morning report, the pull request's body and `status.mjs` still read one folder each. So a
lane's report showed only its own tickets, a lane never rewrote the pull request's body (#37 left
that to this ticket), and `status.mjs` said "no phase run" for a branch whose results were only in
lane folders.

A session's `foundElsewhere` (a problem it saw in another ticket's code) only lived in that ticket's
result. D14 asks for one findings record per phase branch, with each finding given an outcome:
fixed, ticketed, taken or dropped. The record, the morning report and `status.mjs` should read every
lane's results, and a run without lanes should report exactly as before.

## The Solution

**A new module, `template/tools/phase-run/findings.mjs`.**

- **The record**, `.phase-run/<branch>/findings.json` in the primary checkout (ADR 0007), as
  `{ findings: [...] }`. `recordFindings` adds one row per finding, `{ id, ticket, lane, night,
  finding, outcome, at }`.
  - It writes under the claim lock (`claims.lock`), then `.part` and a rename, so two lanes writing at
    once keep each other's rows.
  - A finding already recorded for that ticket, with the same words, is skipped. A new one gets the
    next number (`<ticket>-<k>`).
  - A record it can't read is never treated as empty: the write is refused.
- **The outcome.** A verdict item may be a plain string, which is recorded open (`outcome: null`).
  It may also be `{ finding, outcome }` with one of the four outcomes. Any other outcome is recorded
  open, with its words kept.
- **The night across lanes.**
  - `branchResults` reads the branch folder's own `results.json`, then each `lane-<id>/results.json`.
    Each lane's results are tagged with the lane their folder names.
  - `laneState` says where a result stands: built, landed, unlanded, parked, parked at Landing, or
    failed.
  - `onBranch` drops unlanded passes.
  - `laneStatus` gives `status.mjs` its lane lines.

**`run.mjs`.**

- `recordResult` stamps a lane's result with its `night`, which is the shared runner copy's `runId`
  (ADR 0005). `recordFound` then writes the result's findings to the record: `run.claims` in a lane,
  `run.dir` without one. A failed write leaves a note on the result and never stops the run.
- **The report**, in a lane, reads every lane's results of that night (`nightOf`):
  - the header lists the lanes and counts landed, unlanded, parked and failed;
  - the scoreboard has a Lane column;
  - the tickets are listed under **Landed**, **Unlanded**, **Parked** (a Landing park included) and
    **Failed**, each naming its lane;
  - the action lists say `#N (lane X)`;
  - a **Findings** section lists the night's findings with their outcomes, in place of "Found in
    other tickets' code";
  - an earlier lane's report says which lanes are still running.

  Without a lane, every line is as before.
- **The pull request.** In a lane, its body lists every lane's landed tickets, checked against the
  phase branch, each with ` · lane N`. A lane now edits the body too (owed by #37). At the end, a lane
  finds an existing pull request, and only the last lane out posts its report there.

**`status.mjs` and `display.mjs`.**

- `status.mjs` finds a branch whose results are only in lane folders, and reads every lane's results
  into its table.
- A row says `· lane N`, and an unlanded pass reads `◇ unlanded`.
- Below the table it lists each lane: live (its pid) or not running, the live claims and unlanded
  passes it holds, and its progress and current ticket from its `live.json`.
- A ticket's card names its lane and state.

**`ticket-prompt.md`** tells the session the four outcomes, and the object form for a finding whose
outcome it already knows.

## Why This Approach

- **The night is the shared copy's run.** Each lane has its own `runId`, and `reported` is set per
  lane, so neither of them can say which results belong to one night. The copy is taken once a night
  by the first lane, and a restart reuses it (ADR 0005), so its `runId` is the same in both lanes.
- **The last lane out posts.** Its report is the only one that sees the whole night. An earlier
  lane's report is kept in its folder, and says which lanes are still running.
- **The claim lock for the record.** Its write is short and synchronous, which the claim lock is built
  for (gotcha #37 is about async work). A second lock would add a second set of rules for breaking a
  crashed holder's lock.
- **A pinned one-lane report.** "Reports exactly as today" is checked against the report as it was
  before this ticket, word for word (`tests/fixtures/report-one-lane.txt`).

## Alternatives turned down

- **One record per lane, merged on read.** D14 says one record per phase branch, and a merge would
  need its own rules for two lanes reporting the same finding.
- **Reading the night by `reported: false`.** The first lane out marks its own results reported, so
  the last lane's report would leave them out.
- **A command to set an outcome.** No criterion asks for one. The record is plain JSON, and the
  finish or the owner sets `outcome` by hand.
- From the code review, turned down:
  - **Writing no record in a run without lanes.** D14 says one record per phase branch, and the
    criterion is about the report, which is unchanged. This is listed under the assumptions below.
  - **Recording a parked session's findings.** Only a built result reads its verdict's
    `foundElsewhere`, as before #38. A park's verdict has a question, not findings.
  - **Showing a finding seen again on a later night in that night's report.** It is recorded once,
    under the night it was first seen. Seeing it again would take a second pass of the same ticket,
    which is built only once.
  - **Ordering the pull request's body by time.** A ticket lands once (its `Closes #N`), so the
    order of the folders never picks the wrong hash.
  - **Listing a live lane that has no result yet in the header.** The "still running" line already
    names it.
  - **Three small ones.**
    - `status.mjs` looks for lane locks at `join(dir, "..")`. `--dir` names a branch folder under
      `.phase-run/`, as its usage line says.
    - `actionLines` runs `findingText` over every list, not only `foundElsewhere`. A string passes
      through it unchanged.
    - `report()` reads `new Date()` for its header. That was there before this ticket, and the test
      strips the time from the report; the test itself never reads the clock.
  - **The smells:** the two report modes in one `report`; the lane tag written in five places;
    `display.mjs` deciding "unlanded" itself, because importing `laneState` would make a circular
    import; the lane reading kept in `findings.mjs`. Each is a few lines. Splitting them would
    reshape #33's and #37's code without changing anything it does.

## Real bugs found along the way

None in shipped code. The code review found these in this ticket's first commit, fixed before it
landed:
- **The other lane could read a half-written `results.json` as no results.** It would then write a
  pull request body, or a report, without that lane's tickets. `saveResults` now writes the whole
  file and renames it into place.
- **Two lanes stopping together could each see the other live, so neither posted the report** (and
  neither marked the copy finished). A lane now releases its own lock before it looks for the other.
  At worst both post; neither posting no longer happens.

## What This Concretely Unblocks

- **#41**: the release night's morning report is the last lane out's
  `.phase-run/<branch>/lane-<id>/report-*.md`, which is also posted on the pull request. It shows
  both lanes and the night's findings.
- **Handed forward to #42**: the phase-run guide should describe `findings.json`, the four outcomes,
  and how the night is read across lanes.

## Run by hand

None. Backend-only (the runner, `status.mjs` and their tests), so no browser check: no screen
changes.

## Assumptions made

Each is a small choice, easy to change:
- **What the outcomes mean, and who sets them.** fixed: the code was put right. ticketed: an issue
  tracks it. taken: a named later ticket takes it on. dropped: looked at, not worth acting on. The
  session sets one in its verdict; otherwise the finding is open until the owner or the finish sets
  it. To change this, edit `OUTCOMES` and `findingOf`.
- **A run without lanes writes the record too**, in its branch folder, though its report is
  unchanged. To stop it, return early in `recordFound` when `run.night` is unset.
- **The night is the shared runner copy's `runId`.** To change it, change `run.night` in `main()`.
- **Only the last lane out posts the report.** A lane releases its own lock first, so if two lanes
  stop at the same instant both may post. To change it, drop `lastOut` from the comment's condition.
- **A finding is the same finding when its ticket and words match.** The check is in
  `recordFindings`.
- **A Landing park is listed and counted as parked** in a lane report (it is `failed` in the
  results). To change it, edit `atLanding` in `report`.
- **`status.mjs` lists a lane that is not running when it has a folder**, so its unlanded passes
  show. To change it, list only the live locks in `laneStatus`.
- **The pull request's body names each lane's ticket's lane** (` · lane N`). To drop it, edit
  `pullRequestBody`.
- **Two lanes may edit the body one after the other**, each from its own read, so the later edit can
  miss the other lane's landing of a moment before. The next landing, or the next night, writes it
  again.

**Found elsewhere, not fixed:** nothing new. #37's note on a crashed lane's own lock still stands.

## Common Questions

**Does a run without lanes change?** Its report doesn't: a test compares it to the report from
before this ticket, word for word. It now also writes `findings.json` in its branch folder.

**Where do I see the whole night?** In the last lane out's report, posted on the pull request. While
lanes run, `node tools/phase-run/status.mjs` shows every lane's tickets and what each lane holds.

**How do I give a finding its outcome?** Set its `outcome` in `.phase-run/<branch>/findings.json`.

## References

- `docs/discovery/05-brigade-0.7.0.md` D14; spec #27; ADRs 0005, 0007.
- Code: `template/tools/phase-run/findings.mjs`; `run.mjs` (`recordResult`, `recordFound`,
  `nightOf`, `report`, `scoreboardSection`, `actionLines`, `pullRequestBody`, `ensurePullRequest`,
  `main`); `status.mjs`; `display.mjs` (`resultLines`); `ticket-prompt.md`.
- Tests: `tests/phase-run-findings.test.mjs` (written first, red on the missing module), the
  one-lane fixture `tests/fixtures/report-one-lane.txt`, and two `status.mjs` tests in
  `template/tools/phase-run/measure.test.mjs`.
