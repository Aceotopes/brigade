# #022 — Landing: the plan and the executor

**Ticket:** `#36` · **Devlog:** `#37` · **ADRs:** 0008, 0006, 0003 (applied, none new)
**Date:** 2026-11-10

---

## The Problem

A lane's gates ran on the tip it cut its branch from. By the time its ticket passes, the other lane
may have landed something, so the code that passed is not the code that would reach the branch
(ADR 0008, which extends ADR 0003 from "a ticket" to "a ticket on the tip it lands on"). The lane
also wrote `NNN` wherever a number goes (ADR 0006), so its commit is not a finished commit.

D13 settles what Landing does, in order: replay the lane's commit onto the newest tip, settle the
hotspot conflicts Landing owns, number the unnumbered entries, rebuild every generated file, re-gate
with the real gates (the migration last), then fast-forward by compare-and-swap and push. Anything
else parks the ticket, and nothing is ever forced. This ticket builds that, tested on throwaway
repos with no lane running. Running it from a live lane under the landing lock is #37's.

## The Solution

**A new module, `template/tools/phase-run/landing.mjs`**, split at the seam the spec names.

**`landingPlan(…)`, pure.** It takes the tip's hash and last numbers, the lane's commit as data
(`files`, its changed hotspot files as `{ path: text }`, and `message`), the tip's text of those
files, the hotspot rows, the migrations the commit adds and its fingerprint. It returns
`{ ticket, numbers, steps }`, plain data:

| Step | What it holds |
| --- | --- |
| `replay` | the lane's commit and the tip it goes onto |
| `settle` | what Landing writes for the `generated` and `own-file` rows: the tip's index (rebuilt next), the gotchas block folded into the tip's file, the `.lane/` scratch file removed |
| `number` | what it writes for the `log` rows: the entry numbered on top of the tip's devlog, the log renamed `NNN-` to the next number; and the numbers taken |
| `rebuild` | every generated row (left out when there is none) |
| `commit` | the numbered message |
| `re-gate` | the real gates, the migration left out |
| `browser-check` | the fingerprint (only when there is one) |
| `migrate` | the migrations' names (only when there are some), always last of the gates |
| `fast-forward` | the branch and the tip it expects to move from |
| `push` | the branch (only with a remote) |

`settle` and `number` hold only what Landing writes over the replay: a path git merged cleanly is
left as git left it. The plan composes #30's `numberLane`, and splits its output by the row kind of
each path, through a new `numbering.mjs` export, `hotspotKind(path, hotspots, phase)`.

**`lastNumbers({ entries, logNames, messages })`, pure.** The tip's last devlog number is the
highest `## #N` heading in the log rows' files *or* `devlog #N` cited in the tip's commit messages. The
messages matter: the devlog is rotated at each phase end, and a devlog emptied that way still
counts. The last log number is the highest `NNN-<slug>.md` name in the log rows' folders.

**`land(…)`, the executor.** It reads the inputs with git (the lane commit's changes against its
parent, the tip's text, the last numbers), calls the plan, and carries out each step in a **scratch
worktree** detached at the tip. It removes the worktree on every way out, so no checkout is ever
detached or left for #37 to hand back.

- **replay:** `git cherry-pick --no-commit`. On a conflict, every conflicted path must be one the
  plan writes, or the ticket parks.
- **settle, number:** writes the plan's files, then `git add -A`.
- **rebuild, re-gate, browser check, migrate:** injected callbacks, each returning null or
  `{ gate, output }`, so #37 can pass the runner's real gates. `commandStep(label, commandLine)`
  turns a shell command into one; the tests' gates are tiny `node -e` jobs.
- **commit:** keeps the lane commit's author and date.
- **browser check:** the sources are compared on the landed tree. The screenshots are compared
  where the check saved them (`shotsRoot`, the lane's worktree), since they are never committed. An
  unchanged fingerprint carries, with a note on what it vouches for. A changed one calls
  `browserCheck(dir, why)` again.
- **fast-forward:** `git update-ref refs/heads/<branch> <landed> <tip>`. Git refuses atomically when
  the branch is no longer at `<tip>`: the compare-and-swap.
- **push:** a plain `git push <remote> refs/heads/<branch>:refs/heads/<branch>`, once the branch
  has moved. Nothing after the fast-forward parks.

It returns `{ status: "landed", commit, numbers, migrations, browserCheck, pushed }`, or
`{ status: "parked", step, detail, keptOn, attempt, branchMoved, numbers }`. A park keeps the lane's
commit as it passed, unnumbered so it can land again, on `<branch>-parked-<N>`. It never overwrites
an earlier park's branch: a name already holding other work is passed over for `-2`, `-3` and so on.
`attempt` names the numbered commit that was tried, when there was one. `branchMoved` is true only
when the branch really is somewhere else; a compare-and-swap that failed for another reason (a held
ref lock) says so instead. An error of Landing's own, such as numbering refusing two unnumbered
entries, parks the ticket at the step it was on. The phase branch is never moved by a park. When
the scratch worktree cannot be removed (a gate's process still holding it on Windows), the result
gains `cleanup` instead of throwing over it.

## Why This Approach

- **A pure plan and an interpreter.** The spec's testing decision. The plan's test needs no git, and
  the order (the migration last, the fast-forward after every gate) is a fact of the data, which
  the executor follows step by step.
- **A scratch worktree, not the primary checkout.** Landing never has to detach a checkout and
  restore it. That is the most fragile part of the source's version, and it is #37's (undo-detach,
  the hand-back). The branch is moved by `update-ref`, which needs no checkout at all.
- **`update-ref` with the old value is the compare-and-swap.** Git checks and moves the ref in one
  locked step. A check-then-move in JavaScript would leave a gap for the other lane's landing.
- **Callbacks for the gates, not an import of `run.mjs`.** `run.mjs` holds module state and will
  import `landing.mjs` in #37; an import the other way would be circular. The callbacks keep the
  executor testable with real jobs.
- **Only the hotspot files are read as text.** A file on no row is git's to settle, so the plan never
  reads it, and a binary or large file is never decoded.

## Alternatives turned down

- **Overwrite every file the lane touched with `numberLane`'s output.** For a file on no row, that
  output is the lane's whole text. It would drop the other lane's clean, merged edits to the same
  file. Only what differs from the lane's text is written.
- **Rebase the lane branch itself** (`git rebase <tip>` in the lane's worktree). It moves the lane
  branch, which #33's `prepareWorktree` then refuses, and a conflict would leave a half-rebased
  worktree in the lane's way.
- **Retry the fast-forward on a moved tip.** The owner decided at `/ticket-check` (2026-11-09) that
  a failed compare-and-swap parks the ticket, like a conflict.
- **Park on a failed push.** The branch has already moved past a full re-gate by then, so parking
  would undo nothing. The push is reported (`pushed: false`, `pushOutput`), never forced.
- From the code review, turned down:
  - **One `targetOf(path)` for the three places that strip `.lane/`**, and a type bundling
    `hotspots` and `phase`. Each is a one-line repeat; a shared helper would reshape #30's
    `numberLane` for no change in behaviour.
  - **The plan returning the set of paths it owns.** The executor reads it off the `settle` and
    `number` steps in one line, and the plan stays the list the spec asks for.
  - **Rename `branchMoved` to `tipMoved`.** The spec's words are "the branch moved during landing".
  - **Run the re-gate somewhere with the project's `node_modules` and `.env`.** A real gate does need
    them. But which tree Landing uses, and its `worktreeSetup`, belong with the lock and the live lane
    in #37, which passes the real gates. Handed forward below.

## Real bugs found along the way

None in shipped code. The code review found these in this ticket's first commit, fixed before it
landed:
- A park used `git branch -f`, so a second park of the same ticket overwrote the first one's work.
- `readLast` handed a row's path to `git ls-tree` as a pathspec, and a `*` row found no files there,
  so the log number restarted at 1. It now matches the tip's files with numbering's own rule.
- A failed compare-and-swap always said the branch moved, even with the branch still at the tip.
- The scratch worktree's removal ran in a `finally` and could throw over the result, after the
  fast-forward and before the push.
- A park after the commit kept the numbered attempt, and its message said the ticket "lands again".
  It can't: with the numbers baked in, the devlog conflict is no longer Landing's. It now keeps the
  lane's commit.
- An error of Landing's own (a git step, numbering's refusal) threw instead of parking.
- The plan's `push` step did nothing: the push read `remote`. It now follows the step.
- A log numbered 1000 or more was not counted.

## What This Concretely Unblocks

- **Ticket #37 (the landing lock)** calls `land` under its lock from a live lane, with
  `regate` built from the runner's real gates (`projectGates` and doc-check, through the runner
  copy), `rebuild` running `tools/doc-index.mjs` from the copy, and `migration` from
  `phaseRun.migrations` (`added` and an `apply` that records `migrationsApplied`).
- **Owed to ticket #37:**
  - release the ticket's claim on land or park, under `withClaimLock` (gotcha #34);
  - reset the lane branch to the phase tip after a landing, or `prepareWorktree` keeps refusing it
    as ahead of the tip (gotcha #33);
  - turn a park result into run.mjs's park: the issue comment, the label and the result. `land`
    makes the parked branch and moves nothing else;
  - log the carried pass's `browserCheck.note` (D12's scope, owed by #35) and a failed push's
    `pushOutput`;
  - pass `shotsRoot` as the lane's worktree, or every screenshot reads "gone" and the check re-runs;
  - give the re-gate a tree its real gates can run in. Landing's scratch worktree has only tracked
    files, with no `node_modules` and no `.env`. Either run `worktreeSetup` there, or land in the
    lane's own worktree;
  - report a result's `cleanup` (a scratch worktree left behind) and a park's `attempt`.

## Run by hand

None. Backend-only (the runner and its tests), so no browser check: no screen changes.

## Assumptions made

Each is a small choice, easy to change:
- **Landing does not comment on the issue or label it.** `run.mjs`'s `park` does that, and #37 wires
  it in. To change it, add a callback to `land`.
- **A failed push after the fast-forward is reported, not parked.** Change the `push` handling in
  `land` to park.
- **The parked branch holds the lane's commit as it passed**, and the numbered attempt is only
  named (`attempt`, unreferenced, so git may collect it in time). To keep the attempt, give it a
  branch of its own in `land`'s park.
- **A taken parked name is passed over for `-2`, `-3`…**, never overwritten. run.mjs's own park
  still uses `branch -f`; to match it, drop `keepParked`'s search.
- **The last devlog number counts the tip's commit messages too**, so a rotated devlog never restarts
  the count. Drop `messages` from `readLast` to count the devlog's entries alone.
- **A thrown callback is a failed step**, and parks the ticket with its stack, like a failed gate.

## Common Questions

**Does a run without lanes change?** No. Nothing calls `land` yet; #37 wires it in for lanes only.

**What does Landing count as its own conflict?** A path the plan writes: a hotspot file whose text
Landing settles or numbers. A conflict in a log file with no unnumbered entry, or in any file on no
row, parks the ticket.

**Can the migration run and the ticket still park?** Yes, if the tip moves after it. ADR 0008 puts
the migration as the re-gate's last step so that a *failed* migration leaves the branch unmoved. A
park after a passing migration leaves it applied to the target, as a one-lane park after its
migration does. #37's report names what was applied.

## References

- `docs/discovery/05-brigade-0.7.0.md` D12, D13; spec #27; ADRs 0003, 0006, 0008.
- Code: `template/tools/phase-run/landing.mjs`; `numbering.mjs` (`hotspotKind`).
- Tests: `tests/phase-run-landing.test.mjs`, written first, red on the missing module; four more
  pin the code review's fixes.
