# Discovery: Brigade 0.7.0, two lanes

**Rounds:** 2026-11-09. One grill with the owner, in four rounds, to port a runner upgrade that one
real project built and verified on its own runner: "2b, two lanes", its spec 309. Two nights built
it with nothing parked. A dry two-lane run (source #321) fixed what it found, and the owner's
capacity trial (source #322) said go. What 2b does, and why, was settled there and is not
re-decided here. This grill settled only how each piece fits a plugin that any repo adopts.
**Status:** decided, not built. **Build timing:** only after 0.6.2 (D1), and after Brigade's own
first real 0.6.x night in a project (D17). 0.7.0 builds on 0.6.0's snapshot, side-by-side gates
and tampering gate, which have not yet been seen on a real night.

**Sources.** All are from the source project's runner-upgrades discovery doc, at commit `43a31019`:
- §20, 2b as built: its one-page overview, "Read this first", and the "What Brigade must decide"
  list this grill answered;
- §20.1, one block per ticket, source #310 to #321 and its attended devlog-452 fix;
- §20.2, its porting order;
- §20.3, what it measured;
- §20.4, the capacity trial and what it exposed;
- its ADRs on numbering at Landing and on two roots.

The full pinned link goes in the spec issue, not here, because Brigade's docs name no one project
(`tests/no-project-specifics`). Numbers written "source #N" below are that project's issues, not
Brigade's. 0.6.0's decisions are cited as "0.6.0 D*N*" (`04-brigade-0.6.0.md`).

Like any discovery doc, this one is never rewritten: a later fact is added as a dated addendum at
the top.

## Goals

1. **Two tickets build at once.** A second runner, a lane, builds beside the first, so a walk-heavy
   night doesn't leave the laptop idle. At the source, two real tickets took about 54 minutes side
   by side, against about 83 one after the other.
2. **Two lanes never share anything on disk or in a database.** Each lane has its own worktree,
   ports, QA database and test databases.
3. **No ticket is built twice, and none is landed on a stale tip.** A lane's passing commit is
   replayed onto the newest tip and re-gated there before the branch moves.
4. **Two lanes never take one number.** Devlog entries, implementation logs and commit messages
   are numbered at Landing, off the tip.
5. **A run without lanes is today's run, byte for byte.**
6. Every rule a project owns is data in `workflow.json`, never a site's numbers in code.

## Problems (what happens today)

| Problem | Today |
|---|---|
| One ticket at a time | A ticket that mostly waits on a headless browser holds the whole night |
| A second runner breaks on everything shared | Ports, the QA database, the test databases, the branch, the checkout, and the files every commit writes at the same spot (the devlog, the logs, the generated indexes) |
| doc-check counts any ignore rule | `template/tools/doc-check.mjs` runs `check-ignore` without `-v`, so a machine-only ignore (`.git/info/exclude`, a global one) hides a path that CI then flags |
| The receipt's index copy drops its time | `treeKeys` copies the index without its own time, which turns off git's racy-git re-read, so a same-second edit can keep a receipt |
| A test-imported file on an unread list goes unseen | 0.6.0 D19's scan only warns, and only on the tests row. A change to such a file keeps the receipt and skips the suite that reads it |

## Requirements and stack

Node only, no dependencies, as before. The facts it builds on:
- **Where the port goes.** As for 0.6.0, `template/tools/phase-run/`. Every 2b module is absent
  there today.
- **What 2b builds on, already in Brigade:**
  - `bgIsolation: "none"` and the `EnterWorktree` deny (`run.mjs`);
  - one `phaseRun.ports` list and one `phaseRun.qa` (`config.mjs`);
  - `treeKeys` (`receipt.mjs`), doc-check with a baseline, and `tampering.mjs`.
- **The session's root.** `PHASE_RUN_ROOT` already exists (0.6.0 D4, `run.mjs`, `stop-tests.mjs`).
  The source's guide says Brigade has no root variable, which is out of date. In a lane, the root
  is the worktree.
- **Hooks.** Brigade's hooks find the project from `CLAUDE_PROJECT_DIR`. The source showed that a
  lane session's `CLAUDE_PROJECT_DIR` is the worktree, but its hooks are project hooks. Brigade's
  are plugin hooks, installed at project scope, and that install is recorded against the repo's
  path. So D9's probe asks the questions the source never had to.
- **No walk label.** The source's lane 2 takes only its `handtest-walk` tickets. Brigade has no such
  label; `frontend` is what sends a ticket through the browser check.
- **`/ticket-check` is a plugin skill** (`skills/ticket-check/`), not a file under `.claude/`, so a
  ticket can write its lane lines. At the source they were written attended.

## Decisions

**Before 0.7.0**

1. **0.6.2 comes first**, attended and test-first: the two bugs Brigade has today, independent of
   lanes (source devlog 452):
   - doc-check counts only committed `.gitignore` rules (`machineOnly`);
   - `treeKeys` keeps the index's own time on its copy.

   0.7.0's tickets assume them.

**Names and config**

2. **Names.**
   - The source's lane variables become `PHASE_RUN_LANE`, `PHASE_RUN_QA_PORT`,
     `PHASE_RUN_QA_DATABASE`, `PHASE_RUN_TEST_DB_PREFIX` and `PHASE_RUN_FAKE_NOW` (0.6.0 D4's
     prefix).
   - A lane's own values (its test prefix, its QA database) are project data in its row, with no
     default in code.
   - The source's lint rule name and its lane-2 values aren't ported.
3. **The two tables are `phaseRun` sections**, not files: `phaseRun.lanes` (`rows`, `claims`,
   `worktreeSetup`, `landing`) and `phaseRun.hotspots` (`token`, `rows`).
   - They go in `.claude/workflow.json`, in both loaders (`config.mjs` and
     `hooks/workflow-config.mjs`), which already refuse unknown keys. The runner snapshot already
     freezes that file.
   - No `lanes` section means a one-lane run, byte for byte today's.
4. **A lane row has the fields the runner acts on, plus `env`.**
   - `id` and `takes` (D6).
   - `worktree`: setup proposes `../<repo>-lanes/lane-<id>`, beside the repo.
   - `qa`: that lane's database name, put into `phaseRun.qa`'s url. It is refused when it equals
     lane 1's.
   - `ports`: in `phaseRun.ports`' shape, each checked free at the start. A port row gains an
     optional `name`; the lane's port named `qa` becomes `PHASE_RUN_QA_PORT`, and the others are
     only checked free. A lane with a `qa` database but no `qa` port is refused.
   - `testDbPrefix`, which becomes `PHASE_RUN_TEST_DB_PREFIX`, refused when empty or unsafe.
   - `env` `{VAR: value}`, for any other per-lane resource (a cache's database index, a bucket
     prefix).
5. **Two lanes at most.** The loader refuses a third row. The code stays row-generic, so lifting the
   cap means one change plus a trial.
6. **What lane 2 may take is data.**
   - `takes` is `any`, or a label the project picks (a project with walk tickets names its walk
     label).
   - At most one row takes `any`. A second is refused, and the message names the out-of-scope
     upgrade below.
   - A ticket's `## Lane` section is accepted by `/ticket-check` only on a ticket that carries that
     label. It reads the label, never the Areas.
   - It warns when a ticket names an own-file folder but none of its files, as at the source.
7. **Hotspots: setup writes the first rows** from doc-config's known paths:
   - the devlog and the implementation logs, as `log`;
   - the generated indexes, as `generated`;
   - the phase gotchas file, as `own-file`;
   - everything else is left to git.

   The owner adds rows of their own, and refresh offers a row when doc-config gains a path. The
   number token is `NNN`, which doc-config mirrors under a constant pinned equal to the runner's.
   doc-check accepts `NNN` only while `PHASE_RUN_LANE` is set.
8. **Worktree setup is data written from the checklist.** `worktreeSetup` has three parts:
   - `copy`: untracked files to bring in (`.env`, `.claude/settings.local.json`);
   - `commands`: the install and any code generation;
   - `leaves`: files the commands must produce.

   A fresh worktree has only tracked files, so at the source a missing generated file and an ignored
   helper broke a typecheck. So the start check also refuses a tracked script that imports an ignored
   file.

**The night's judge**

9. **The probe comes first.** It is ticket 1, attended, and runs against the *installed* plugin
   enabled at project scope; `--plugin-dir` would prove nothing.
   - **The source's questions, as its §20.1 lists them:**
     - do the session, its hooks and its writes live in the worktree?
     - does `--bg --resume` keep it there?
     - is there no trust prompt under `dontAsk`?
     - is its transcript in the worktree's own projects folder?
     - does `local` read the worktree's settings?
   - **Brigade's own:**
     - does a project-scope Brigade load in a sibling worktree, and run its hooks there?
     - is `CLAUDE_PROJECT_DIR` the worktree?
     - which `claude plugin list --json` row gives the lane's version?

   Any "no" stops the port, and the owner redesigns from the answers.
10. **The snapshot carries doc-check.** The runner copy takes `tools/doc-check.mjs`, the doc tools
    it imports, and its baseline.
    - Inside a run, the gates and a lane's `NNN` acceptance use the copy.
    - `--update-baseline` is refused there.
    - The guard matches a lane's runner copy.

    This extends ADR 0005 to the docs.
11. **A test-imported file on an unread list voids the skip.** 0.6.0 D19's scan finds quoted path
    strings in test files, relative import specifiers included. When a changed file is one a test
    names and sits on a check's `unread` list:
    - that check's receipt is void;
    - so is any gate's `unreadOf` skip that points at it.

    The scan widens from the tests row to every row with a list, and D19's warning becomes a rule at
    the gates. This takes the place of the source's fix, which runs its runner tests, a gate Brigade
    never ported (0.6.0 D9).

**Landing**

12. **The screenshot fingerprint is ported.** On a pass, the runner records a hash of each changed
    source file and each counted screenshot. Landing compares it, so a rebase that leaves a
    ticket's screens alone carries the browser check's pass. Which paths count as source is data
    (the browser check's own paths), not the source's `src/`.
13. **Landing is the source's.** It works in this order:
    - replay the lane's commit onto the newest tip;
    - settle the conflicts Landing owns;
    - number the unnumbered entries;
    - rebuild *every* generated file on the numbered tree;
    - re-gate with the real gates, the migration last;
    - fast-forward by compare-and-swap, and push.

    A conflict or a failed re-gate parks the ticket, and nothing is forced. It all happens under one
    landing lock, which comes with these:
    - undo-detach on every way out, a crash and Ctrl-C included;
    - the hand-back of the primary checkout by the last lane out;
    - a restart that lands its own unlanded tickets first;
    - a lane started without `--branch` on a detached checkout joins the branch a live lane's lock
      names;
    - a lane's `.lane/` scratch files are always in scope;
    - two roots: a lane's run state (results, claims, locks) lives in the primary checkout's
      `.phase-run/<branch>/`, and its session's files follow `PHASE_RUN_ROOT` into its worktree
      (ADR 0007).
14. **The findings record is ported.** Each night finding gets an outcome (fixed, ticketed, taken,
    dropped) in one record per phase branch. The record, the morning report and `status.mjs` read
    every lane's results.

**Setup's checklist** (ADR 0001: no per-tool code)

15. **The test prefix and the browser scripts' QA address are checklist items.** With `lanes` on,
    setup's stack walk asks two things:
    - how the project's tests read `PHASE_RUN_TEST_DB_PREFIX`;
    - how its browser scripts read `PHASE_RUN_QA_PORT` and `PHASE_RUN_QA_DATABASE`.

    Claude writes both in the project's own tools. The phase-run guide shows the source's lane
    helper and its lint rule as worked examples, never defaults, and Claude may copy them in as the
    project's own code. Why not a template helper: what ties a lane to a project is the set of
    environment variables, which any language reads. A stamped JS file would be dead weight outside
    JS, and Brigade would own a file the project's scripts import.
16. **The fake clock.** Brigade reserves `PHASE_RUN_FAKE_NOW`. Setup asks whether the project's
    browser scripts depend on the date, and the source's clock is a worked example in the guide.

**Timing, proof, version**

17. **Build gate:** after Brigade's own first real 0.6.x night in a project, run on 0.6.2, so that
    night proves the base 0.7.0 builds on.
18. **Release gate:** a throwaway-repo two-lane night, as 0.4.0 had.
    - The repo is set up by `setup.mjs`, with one spec that has a lane-1 ticket and a lane-2 ticket.
    - It passes when both are landed in order and the primary checkout is handed back on the phase
      branch.
    - Then the release, then the clean-up.
    - Commit, push and merge rights inside the trial repo are asked for again at that time.
19. **One spec, 0.7.0**, with three ADRs:
    - 0006, numbering at Landing;
    - 0007, two roots;
    - 0008, Landing re-gates on the tip and never forces, which extends 0003.

**Tickets** (proposed, in the source's §20.2 order). Each carries source #321's fixes in its own
block, not after it:
1. **Probe** (attended): D9.
2. **The lane table** (D2–D5): both loaders, and a run without lanes unchanged.
3. **Hotspots and unnumbered entries** (D7): the rows, the token, doc-check's acceptance while
   `PHASE_RUN_LANE` is set, `numberTheLogs`.
4. **The lane declaration** (D6): `ticket-size`'s rule, `/ticket-check`'s lines, the ticket
   template's `## Lane`.
5. **The worktree** (D8): `run.mjs --lane <id>`; the worktree made, or reused and reset to the tip
   before setup; the import check; the branch join; a passing ticket kept unlanded.
6. **The claim and the frontier**: a claim file changed only under an exclusive-create lock; a dead
   process's claims lapse; "built" read off the phase branch; a lane with nothing ready waits while
   a live lane may still land a blocker.
7. **The fingerprint** (D12).
8. **Landing** (D13) on throwaway repos: the pure plan and the executor.
9. **The landing lock** (D13): the re-gate, the hand-back, undo-detach, the unlanded-ticket
   restart, `.lane/` always in scope.
10. **Findings and the reports' lane reading** (D14).
11. **The listed-code rule** (D11).
12. **Setup's checklist items** (D4's proposals, D7, D8, D15, D16) and the guide's worked
    examples.
13. **Finish** (attended): the whole-phase review, the docs and the 0.7.0 version.

**For the spec:**
- **Loader keys.** `lanes` and `hotspots` join `phaseRun`'s key list, and `name` joins a port row's,
  in both `config.mjs` and `hooks/workflow-config.mjs`.
- **Seeing hook changes live** (tickets 1, 3 and 9): as in 0.6.0, only in a scratch repo, and the
  probe uses the *installed* plugin.
- **Ported code** must pass `tests/no-project-specifics`: none of the source's names, env prefix,
  vendors, hosts, ports, database names or devlog numbers.
- **`testDbPrefix` is optional.** Lane 1's row may leave it out, and the project's own test-database
  names apply; a row that sets it may not set it empty.
- **D11 needs `phaseRun.tampering.testFiles`.** The scan reads only those files, so a project with
  no tampering section gets no listed-code rule. Verify and refresh say so.
- **The source's runner tests went from 195 after 2a to 350 after 2b's trial.** Each ticket here
  brings its own block's tests, written first.

## Out of scope

- A lane 2 that takes any ticket whose Areas don't overlap the other lane's. At the source it waits
  for a few watched two-lane nights; here it waits for D6's single-`any` rule to be lifted on
  purpose.
- One command that starts both lanes.
- A third lane (D5).
- The source's own walks, cast, seeds, lint rule, port numbers and database names.
- Per-tool code or a template lane helper (ADR 0001, D15).

## Open questions

- **The probe's answers** (D9). The owner settles ticket 5's design from them.
- **The source's first live two-lane night.** Its ledger, against its two single-lane nights, is
  still owed there (§20.3), and would be worth reading before Brigade's release trial.
- **Memory headroom.** The source's dry run reached 15.61 of 15.73 GB with two lanes and no QA
  server. The trial night (D18) should record the peak on the owner's machine.
