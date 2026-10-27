---
job: The owner's guide to the unattended phase run: evening and morning checklists, merging, undoing a ticket.
kind: living
max-lines: 560
---
# The phase run — the owner's practical guide

**Scope:** Building a phase's tickets overnight with nobody watching, since 2026-10-07. Covers the
evening and morning routines, what the run does and never does, merging a pull request (your first),
undoing one ticket, and a fix for every likely problem. Background: `docs/history/workflow-upgrade-plan.md`
(why it exists), `docs/agents/workflow.md` (the whole path of a phase), implementation log `140`.
**Date:** 2026-10-07; updated 2026-10-17 after 6B's and 6C's nights (`#194`, devlog `#291`)

---

## The 30-second version

| You want to… | Do this |
|---|---|
| See what a run would build, changing nothing | `node tools/phase-run/run.mjs --spec <N> --branch phase-6b --dry-run` |
| Start the first night of a phase | On `main`, everything committed and pushed: `node tools/phase-run/run.mjs --spec <N> --branch phase-6b --max 4` |
| Continue the next night | The same command. It carries on from where the branch is |
| Build one ticket only | `node tools/phase-run/run.mjs --only <ticket> --branch phase-6b` |
| Build everything up to one ticket, then stop | `node tools/phase-run/run.mjs --spec <N> --branch phase-6b --until <ticket>` |
| Watch a ticket being built | In a second terminal, anywhere: `claude agents` shows the list; `claude attach <id>` opens one (the run prints the id) |
| Read what happened | The report is a comment on the phase's pull request, and a file in `.phase-run/<branch>/` |
| Answer a parked question | Comment on that ticket's issue, remove the `needs-info` label, add `run-ready` |
| Hand-test what was built | `git checkout phase-6b`, then test as usual |
| Go back to `main` | `git checkout main` |
| Finish the phase | Merge the pull request on GitHub with **Create a merge commit** |
| Stop a run early | Ctrl+C in its terminal, then read "If you stopped a run" below |

`<N>` is the spec's issue number. The branch name is yours to pick; it must start with `phase-`.

## A whole phase, start to finish: what to type

The 30-second version starts at the first night. This is everything before and after it, in
order. `N` is the spec's issue number, `phase-6b` the branch name you pick. The reasons for each
step are in `docs/agents/workflow.md`.

**1. Grill the phase** (you and Claude, one sitting). In a fresh Claude Code session in the
project folder, type `/grill-with-docs` followed by what the phase is, for example:

```
/grill-with-docs Module 6 phase 6B Schedule. Scope is §8.3 of the module6-employees discovery doc, open items 6B-O1 to 6B-O6.
```

Answer until it has no questions left. Do not `/clear` afterwards: steps 2 and 3 work best in the
same conversation.

**2. Flow diagram and prototype.** In the same session, in plain words:

```
Build the flow diagram and the clickable prototype for 6B through Impeccable.
```

Click through the prototype and ask for changes until you approve it. A phase with no screens
skips this step.

**3. Spec and tickets.** Still in that session, `/to-spec`. It publishes the spec as a GitHub
issue and says its number. Then `/to-tickets`.

**4. Readiness check.** `/ticket-check N`. It asks every open question in one batch; a ticket with
nothing left open gets the `run-ready` label.

**5. The evening.** Everything committed and pushed on `main`, Docker Desktop open, every other
Claude Code window in this folder closed. In PowerShell, in the project folder:

```
node tools/phase-run/run.mjs --spec N --branch phase-6b --dry-run
```

It lists the tickets and says which are READY. **The first evening of a phase, build one ticket
while you are awake**, and watch it from a second terminal with `claude agents`:

```
node tools/phase-run/run.mjs --only <a READY ticket> --branch phase-6b
```

If that went well, start the night and leave the folder alone:

```
node tools/phase-run/run.mjs --spec N --branch phase-6b --max 4
```

**6. The morning.** Read the report (the newest comment on the phase's pull request). Answer a
parked question on its issue, then remove `needs-info` and add `run-ready`. Hand-test with
`git checkout phase-6b` and `pnpm dev`. Tickets left: the same `--spec` command again tonight.

**7. Finish and merge.** When every ticket but the finish ticket is built and tested, open a
normal session on `phase-6b` and do the finish ticket with it. Then on GitHub, on the pull
request: **Ready for review**, the arrow beside the green button, **Create a merge commit**. On
your laptop, `git checkout main`, then `git pull`. Close the spec issue by hand.

**A worked example of the numbers.** Every issue and pull request on GitHub gets the next number
in one shared count. Say the newest is `#141`. Then `/to-spec` publishes the 6B spec as `#142`,
and that is `N`. `/to-tickets` publishes the tickets after it, say `#143` to `#150`, with `#150`
the finish ticket. So you type:

```
/ticket-check 142
node tools/phase-run/run.mjs --spec 142 --branch phase-6b --dry-run
```

and the dry run answers something like:

```
  #143  READY  ·  6B · Schedule data: shifts and day-off rules
  #144  waiting on #143  ·  6B · Week grid for the manager
  #145  waiting on #143  ·  6B · My schedule on the staff Home
  ...
  #150  not labelled run-ready (run /ticket-check first)  ·  6B · Finish
```

`--spec 142` means "the tickets that belong to spec `#142`"; you never list them yourself. The
first evening you pick the READY one, `--only 143`. For the night it is `--spec 142` again, and
the run takes `#144` and `#145` once `#143` is built. The finish ticket never gets `run-ready`:
it is built with you present.

**While the phase branch is open, do all work on it and none on `main`.** Devlog entries and
implementation logs are numbered in order. A commit on `main` in the middle of a phase takes the
number the branch's next ticket also takes, and the two collide when the pull request merges.

## The mental model

**A branch is a copy of the code that sits beside `main`.** Until now every commit went straight to
`main`. A phase run makes a branch (say `phase-6b`) and commits there. `main` does not change until
you say so. If a night goes badly, `main` is exactly as you left it.

**A pull request is GitHub's page for one branch**: every commit on it, the automatic tests' result,
and a Merge button. The run opens one pull request per phase, marked **draft** (GitHub's word for
"not ready to merge yet"). When the phase is finished and you have tested it, you press Merge, and
the branch's commits join `main`. **That merge is your go-ahead.** It replaces saying "go ahead and
commit" after every ticket.

**A git branch is not a Neon branch.** They share a word and nothing else. The code branch
`phase-6b` lives in git. Your databases stay as they were:

| Database | Used by | Does a run touch it? |
|---|---|---|
| The Docker test databases (`stj_test_1`–`4`, copied fresh each run from `stj_test_template`) | `pnpm test` | Yes: every test run wipes and refills them, as always |
| `stj_cast` (local, in the same Docker container) | The QA cast, for browser checks | Yes: each ticket with a screen resets it |
| The **development** branch on Neon | `pnpm dev` on your laptop | Only to apply a ticket's new migration, after that ticket passes every check |
| Production | Nothing yet (`#14` is not done) | Never |

**A session is pointed at local data.** `.env` also holds the live Loyverse token and the dev Neon
address. Each session starts with `stj_cast` as its database and a placeholder for the Loyverse
token, and loading `.env` cannot change either. So a script a session runs to try something out
reads local data, and nothing it runs can reach the real point of sale. This stops accidents; it
is not a locked door. The R2 keys are left alone, because the QA app stores a captured photo with
them.

**One fresh Claude session per ticket.** The run starts a new session for each ticket, with an empty
memory, the same as you typing `/clear` between tickets. Ticket 12 is as sharp as ticket 1. What a
later ticket knows about an earlier one comes from files: the code on the branch, the ticket's own
text, the gotchas block and the ADR the earlier ticket wrote.

**You can watch it work.** Each ticket's session is a Claude Code *background session*: a real
Claude Code session that runs without a window. The run prints a line like
`#142: session 3fa9c1d2 is working. Watch it: claude attach 3fa9c1d2`. In a **second** terminal
(leave the run's own terminal alone):

- `claude agents` shows every background session, named `ticket-<number>-<title>`, and whether it
  is working. Arrow keys and Enter open one; `←` goes back to the list.
- `claude attach 3fa9c1d2` opens that one directly: the same screen you get when you use Claude
  Code yourself, with each file it reads, each edit and each command as it happens.
- `Ctrl+Z` leaves it. The session keeps working either way.
- **Look, don't type.** Whatever you type into it becomes an instruction to the session, in the
  middle of its ticket. If you do want to steer one, that ticket is no longer unattended: check
  its work yourself in the morning.

A finished ticket's session is stopped, not deleted, so in the morning `claude attach <id>` still
opens it to read back from the top (the report gives each id). `claude rm <id>` removes one you
no longer want listed.

## Before the first night of a phase

1. The phase is grilled, its prototype approved, its spec and tickets published.
2. You ran `/ticket-check <spec>` and answered its questions. The tickets it passed carry the
   `run-ready` label. **The run builds nothing without that label.**
3. `main` is committed and pushed. A run refuses to start a new branch otherwise.

## The evening checklist

1. **Docker Desktop is open** ("Engine running").
2. **Nothing of yours is running in the project folder**: no `pnpm dev`, no QA cast, no other
   Claude Code session working there, no editor saving files there. Watching a ticket with
   `claude attach` is fine; it is the same session, not another one.
3. The laptop is plugged in and **will not sleep**: Settings → System → Power → "When plugged in,
   put my device to sleep after" → Never. A sleeping laptop pauses the run.
4. Look first: add `--dry-run` to the command. It lists every ticket and says READY, done, or why
   it is waiting.
5. Start it, without `--dry-run`. Leave the terminal open.
6. **Do not touch the project folder until the report lands.** Nothing protects it during a run. An
   edit, a `pnpm test`, or a second Claude session in that folder will corrupt the ticket being
   built.

Useful options:

| Option | Default | Meaning |
|---|---|---|
| `--max 4` | 4 | How many tickets to attempt tonight. Keep it at 3 or 4 on a phase's first night |
| `--until <ticket>` | none | Stop after this ticket. Only tickets listed at or before it are built; the ones after it are left for another run. With `--until` the cap of 4 is lifted, because you have named the stopping point yourself; add `--max` beside it to keep a cap |
| `--minutes 120` | 120 | The longest one ticket's session may run before it is stopped and set aside |
| `--fix-rounds 3` | 3 | How many times a failed check is sent back to be fixed |
| `--print` | off | Run the sessions hidden, the way the first trial did (`claude -p`): nothing to watch, and the report shows a dollar figure. The fallback if background sessions misbehave |
| `--wait-hours 6` | 6 | How long to wait for a usage limit to lift, or for a lost internet connection to come back, before giving up |

## What happens to each ticket

1. A fresh session reads the ticket and posts its **plan as a comment on the issue**.
2. It builds test-first. A ticket labelled `frontend` is built through Impeccable, toward its
   prototype screen. It runs the test files it touches, **never the whole suite**: that runs once,
   in the script's own checks (step 6). Until 2026-10-15 the session ran it too, often twice.
3. For a ticket with a screen: a **browser check** as the QA cast, with no window opening
   (Playwright runs "headless"). It walks the acceptance criteria, fails on any browser error, and
   saves screenshots at phone and laptop width to `.impeccable/review-<ticket>/`.
4. A `frontend` ticket gets **one comparison against the prototype** by a fresh reviewer, and one
   round of fixes.
5. The ticket's docs and **one commit**, then a code review of that commit; what the review finds
   is fixed and folded into the same commit. Each time the session stops, a **stop check** runs
   first (typecheck, lint, the tests its changes touch; up to ten minutes when the ticket changed a
   file most of the app imports) and sends the session back once if one fails. The script waits
   for that check to end before it does anything of its own.
6. The script itself then checks: exactly one commit, nothing left uncommitted, typecheck, lint,
   **a full build of the app** (when the ticket changed anything under `src/`; about two minutes),
   **the browser check's screenshots** (when the ticket changed a screen: at least two, saved
   during this ticket), the whole test suite (about three minutes: four test files at a time,
   each on its own copy of the test database), the docs check. If the ticket added a migration, it
   is applied to dev Neon last. The build is there because one known mistake (a screen's code
   importing a file that talks to the database) passes every other check and then breaks every
   page.
7. **A check failed:** its output goes back to the same session to fix, up to three times.
8. **All passed:** the branch is pushed and the pull request is updated. Next ticket.

## When a ticket cannot be finished

Two things can set a ticket aside. Either way the run carries on with the next ticket that does not
depend on it.

- **Parked: it needs your decision.** The session hit a question that is yours: a money or payroll
  rule, privacy, who may see or do something, a database choice that is hard to undo. The question
  and a recommended answer are a comment on the issue, labelled `needs-info`.
- **Failed.** A check still failed after three fix rounds, or the session ran past its time cap.
  The failing output is a comment on the issue, labelled `ready-for-human`.

Small choices are not parked. A label's wording, an empty-state message, a sort order: the session
takes the option that best fits the spec and the prototype and lists it under **Assumptions made**.
The report gathers these for you to confirm or reverse.

Work on a set-aside ticket is not thrown away. It is kept on a side branch named
`phase-6b-parked-<ticket>`, on your laptop only, and the phase branch goes back to its last good
commit. Tickets that depend on a set-aside one wait.

A run never picks a side branch up again. Putting `run-ready` back makes the next run build the
ticket **from the start**, on top of whatever was built since. When the kept work is good and only
the run's own tooling failed it (as with `#147`, 2026-10-10), bring it over in a normal session
instead: cherry-pick the side branch's commit onto the phase branch, settle what later tickets
changed in the same files, give its devlog entry and implementation log the next free numbers, and
run every check from step 6 by hand before committing.

## The morning checklist

1. **Read the report** (the newest comment on the pull request). It lists:
   - **Built**: each ticket, its commit, how big the change was, and a ⚠ line if it touched files
     outside the areas its ticket named. A ticket that is much bigger than you expected, or has a ⚠
     line, is the first to look at.
   - **Assumptions made**: confirm or reverse each. To reverse one, say so in a normal session.
   - **Run by hand**: anything only you can do.
   - **Found in other tickets' code**: a real problem a session noticed in code its ticket did not
     own. It did not fix it: give it to the finish ticket, or a ticket of its own.
   - **Handed forward**: what a ticket left for a later one. Check the later ticket took it.
   - **From an earlier run that stopped before writing its report**: when a night died, the next
     night's report starts with what the dead one built, parked or failed, and its assumptions.
   - **Parked** and **Failed**, with the question or the output.
   - A 🚨 line if a migration drops or rewrites data on dev Neon.
   - **Doc health**: any doc at 90% of its size budget or over, by name, and the whole table folded
     underneath. Nothing to do overnight: the finish ticket trims them, or you raise a limit.
2. **Check the tests on GitHub**: on the pull request, "All checks have passed".
3. **Answer parked questions** on their issues. Then remove `needs-info`, add `run-ready`.
4. **Read the implementation logs** of what was built (`docs/history/implementation-log/`, the newest
   numbers). They are your review of each ticket.
5. **Hand-test**: `git checkout phase-6b`, then `pnpm dev` or the QA cast as usual. Dev Neon already
   has the phase's migrations.
6. Something wrong in a built ticket? Fix it in a normal session **on the phase branch**, and commit
   it there on your go-ahead, as today.
7. Tickets left? Run the same command again tonight.

## Finishing a phase

1. Every ticket but the finish ticket is built and hand-tested.
   - Each ticket that changed a screen committed its browser walk under `scripts/walks/` (since
     `#194`); the finish re-runs every one of them on the final code.
2. **The finish ticket, with you present**, on the phase branch: the devlog moved into its archive
   (`node tools/doc-rotate.mjs --phase 6g`), the whole-phase finish review, the
   handbook, this module's owner guide, the session handoff, `DESIGN.md`, the Artifact pages, the
   prototype deleted.
3. **Merge the pull request.** On GitHub: open it → **Ready for review** → the arrow beside the
   green button → **Create a merge commit** → **Merge pull request** → Confirm.
   - **Never "Squash and merge" or "Rebase and merge".** Both rewrite the commits. A squash also
     drops each commit's message, and the devlog reads an entry as done only once a commit
     message names it (`devlog #NNN`), so every entry of the phase would read as unfinished.
4. On your laptop: `git checkout main`, then `git pull`.
5. The tickets' issues close by themselves at the merge. **Close the spec issue by hand**, as always.
6. Delete the branch when GitHub offers to. Side branches of parked tickets you no longer need:
   `git branch -D phase-6b-parked-<ticket>`.

## Undoing one ticket

Each ticket is one commit. To undo a ticket after the fact, on the phase branch:

```
git revert <the ticket's commit hash>
```

That adds a new commit which reverses it; nothing is erased. If later tickets were built on top of
it, the revert may conflict: ask in a normal session rather than forcing it. A migration the ticket
applied to dev Neon is **not** undone by a revert; it needs a new migration that reverses it.

## What a run can never do

These are enforced by scripts, not by the session remembering them (`.claude/hooks/guard-shell.mjs`
and the runner's own checks):

- push anything itself, or commit anywhere but the phase branch; only the runner pushes, and only
  the phase branch;
- touch `main`;
- run a migration against dev Neon from inside a session (the runner does it, after every check
  passes);
- wait for a person: anything a session would have to ask permission for is refused at once, and
  it has no way to ask a question;
- edit the hooks, the runner or its own settings (`.claude/hooks/`, `tools/phase-run/`, the run's
  folder under `.phase-run/`);
- print `.env` into its transcript (`cat`, `head`, `grep` and the like on that file);
- start when GitHub cannot say which tickets wait on which (the runner refuses, and builds nothing
  in a guessed order);
- run a formatter over the code (`prettier --write`, `prisma format`);
- skip a check with `--no-verify`;
- add an attribution trailer to a commit;
- close a spec issue with a "closes" keyword;
- close an issue or open a pull request by hand.

## Symptom → fix

| What you see | What it means | Do this |
|---|---|---|
| "Not ready to run: The working tree has uncommitted changes" | A run starts only from a clean folder | Commit or put away the changes it lists |
| "main and origin/main differ" | `main` on your laptop has commits GitHub doesn't, or the reverse | `git push` (or `git pull`) on `main`, then start again |
| "The Docker test database did not start" | Docker Desktop is closed | Open it, wait for "Engine running", start again |
| "Something is listening on :8400" or ":3000" | A QA cast or `pnpm dev` is still running | Stop it (Ctrl+C in its terminal), start again |
| "A run is already going (or one crashed)" | The lock file from a run is still there | If no run is going, delete `.phase-run/lock` |
| "…runs here have used \<another endpoint\>" | `.env`'s database address changed since the first run | If you meant to change it, delete `.phase-run/dev-endpoint`; if not, fix `.env` |
| Every ticket says "not labelled run-ready" | `/ticket-check` has not passed them | Run `/ticket-check <spec>` |
| A ticket says "waiting on #N" | A ticket it depends on is not built yet, or was set aside | Answer or fix `#N` first |
| "Could not read from GitHub which tickets #N waits on" | GitHub did not answer three times in a row, so the order of tickets is unknown | Nothing was started. `gh auth status`, check the connection, start again |
| A ticket failed on "build (next build)" | The app would not build with the ticket's change | Read the output on the issue. Most often a screen's file imports one that reaches the database |
| A ticket failed on "browser check" | A ticket that changes a screen has fewer than two screenshots taken **after its last source edit** (since `#194`: a fix after the walk means walking again) | The session did not walk the amended code, even when sent back. Look at the kept branch; try the ticket again, or build it attended |
| A ticket failed on "tests (full suite)" with hundreds of "Unique constraint failed" and a "deadlock detected" | Two test runs shared the one test database. Fixed 2026-10-10 (devlog `#248`): the script now waits for the session's stop check and stops any test run left behind | If it shows again, something else was running tests in this folder during the run. The ticket's own code is likely fine: look at the kept branch before rebuilding it |
| "Stopped a test run left going…" in the terminal | A session was stopped while its tests were still running, and the script ended them so the next suite has the database to itself | Nothing |
| The report says a ticket "ran past the cap" | The session got stuck or the ticket is too big. Or (`#181`, 6D's night) it had finished and was still listed as working: since devlog `#306` a turn that has ended with its verdict written is taken as done after two minutes, and `run.log` says "still listed as working" when that happens | Read the kept branch. If its commit carries `Closes #N` and the verdict says "built", the work is done: land it by hand. Otherwise split the ticket, or raise `--minutes` |
| `claude agents` still lists last night's tickets | Finished sessions are kept, stopped, so you can read them | Nothing. `claude rm <id>` removes one |
| "Could not send #N's next instruction to its session" in the terminal | Claude Code would not wake the ticket's session for a fix round | Nothing at once: the ticket ends up under **Failed**, its work kept on the side branch, and the run goes on. If every ticket does this, add `--print` |
| "Claude Code would not list its background sessions" | Its background service is not running yet, or the installed Claude Code is too old for background sessions | Open `claude agents` once in a second terminal, then start again. Still failing: `claude update`, or add `--print` |
| The report lists "Commands the session was refused" | The session wanted a command its allowlist lacks. Since `#194` the list allows the common read-only tools and deletes under `.phase-run/tmp/`, and the prompt forbids redirects and `cd … &&` chains, the shapes that were refused most | A redirect or a chain: nothing (the prompt already says no). A reasonable new command: add it to `tools/phase-run/settings.json` |
| "The session's turn was cut off … Resuming it" in the terminal | The API dropped the session's turn mid-response ("Connection lost"). Since `#194` the same session is told to carry on; it is not a fix round | Nothing. After three in one call the turn goes to the checks as before |
| A ticket failed on "commit" ("No commit was made") right after "Connection lost" in its session | Before `#194` a dropped turn was taken as finished (6B's `#149`, `#152`) | Should not happen now. If it does, the fix rounds absorb it; check the kept branch |
| `run.log` stopped growing, no "Run finished", the lock file left | The runner died in the night (6C's first night, 05:20) | `claude agents`: stop any `ticket-…` session still working. Read `.phase-run/<branch>/results.json` and the newest `report-*.md` there (rewritten after every ticket since `#194`). Then follow "If you stopped a run" below |
| "a phase-run session never stashes" | A session tried `git stash` | Nothing: it was refused, and the session commits or deletes instead |
| "The push failed" in the report | Usually the network, or GitHub sign-in expired | `gh auth status`; then `git push -u origin phase-6b` by hand |
| "The run stopped early" at the top of the report | The internet (or the usage limit) did not come back within `--wait-hours` | Nothing is broken. Start the same command again when it is back |
| "No internet connection … Waiting" in the terminal | The connection dropped mid-run | Nothing. It resumes by itself when the connection returns |
| The laptop slept and the run stalled | Sleep pauses everything | Wake it; the run continues. Set sleep to Never while plugged in |
| GitHub's checks are red on the pull request | The tests failed on GitHub but passed on your laptop | Open the failing check's log; ask in a normal session on the phase branch |

## If the internet cuts out

A run does not need you for this. Any time of day, not only at night:

- **Before each ticket, before its checks and before the push**, the runner checks that it can
  reach Anthropic and GitHub. If it cannot, it waits and checks again every minute. When the
  connection is back it carries on from where it was.
- **If a session is cut off halfway**, the runner waits the same way, then tells that same session
  to continue. The ticket is not counted as failed.
- **If the connection stays down longer than `--wait-hours`** (6 by default), the run stops. The
  ticket in progress is kept on its side branch, and the report says the run stopped early and why.
  GitHub could not be told, so the ticket keeps its `run-ready` label and the next run builds it
  again from the start.
- **Nothing is lost either way.** Finished tickets are commits on your laptop. A push that failed
  goes out with the next ticket's push, or by hand: `git push -u origin phase-6b`.
- The report is always saved on the laptop too, in `.phase-run/<branch>/`, in case it could not be
  posted on the pull request.

A run will not start without a connection: it says "No internet connection".

## If you stopped a run (Ctrl+C), or the laptop shut down

Ctrl+C stops the ticket's session too (the run does that on its way out). After a power cut or a
closed terminal, check with `claude agents`: if a `ticket-…` session still shows as working, stop
it with `claude stop <id>` before anything else.

The ticket that was being built is half-done in the folder. In a normal Claude session, say: "a
phase run was interrupted on `phase-6b`; look at `git status` and the last lines of
`.phase-run/phase-6b/run.log`, and tell me what state it is in." The usual answer: discard the
half-built ticket's changes (after you agree), delete `.phase-run/lock`, and start the run again; it
picks the same ticket up from the beginning. Tickets already pushed are safe.

**What survives a dead run (since `#194`).** Every finished ticket's result is in
`.phase-run/<branch>/results.json`, and the night's report file in that folder is rewritten after
each ticket, so it is current to the last one finished. The next run's report starts with the dead
run's results under "From an earlier run that stopped before writing its report", and the pull
request's body lists every ticket built on the branch, whichever night built it.

**A stash.** On 6C's restart a new session found a `git stash` left by the dead one and applied it.
Sessions can no longer stash (`guard-shell.mjs`). If `git stash list` shows one anyway, do not apply
it blindly: ask in a normal session what it holds.

## What it costs

Each ticket is a long Claude session, and a night is several. The report shows each ticket's
minutes, its steps, how many tokens the session wrote and how large its conversation grew. A
background session reports no dollar figure; only a `--print` run shows one ("at list price":
what the same work would cost on the pay-as-you-go API, which a subscription does not bill). What
you do spend is your plan's usage allowance, and a long night can reach its limit. When that
happens the run is meant to wait and resume by itself, up to `--wait-hours`; that has never
happened in a real run, so treat it as unproven.

For scale, the trial ticket (`#140`, a backend ticket with one migration, 16 files, run with what
is now `--print`): 38 minutes, 203 steps, $14.87 at list price, one command refused. Of that,
$5.76 was two calls to the advisor (a second, dearer model that re-reads the whole session each
time); nothing was changed after the second one.

## What the trial proved, and what it did not (2026-10-07)

**Proved**, on ticket `#140` (pull request `#141`, merged): a headless session built a ticket from
its issue alone, posted its plan first, committed once, and passed every check the runner makes;
its migration was applied to dev Neon; the hash was filled in, the branch pushed, the draft pull
request opened and the report posted; the merge closed the issue.

**Still not proven**, because nothing went wrong and the ticket had no screen:

- **A `frontend` ticket built through Impeccable** with nobody watching, its browser check and its
  prototype-match review.
- **The fix loop**: a failed check sent back to the session.
- **Setting a ticket aside**: a parked question, a failure, the side branch.
- **Waiting out a usage limit or a lost connection** in the middle of a real session.

So on 6B's first night keep `--max` at 4, include one `frontend` ticket, and look at that one first
in the morning.

**Three gaps closed after reading the trial back (2026-10-08, devlog `#236`):** a session's
database and Loyverse token are pinned to local values (above, "A session is pointed at local
data"); the runner builds the app and looks for the browser check's screenshots itself; and a
failed lookup of a ticket's blockers stops the run before it starts. None of the three has run
inside a real night yet either: the build check and the screenshot check first matter on 6B's
`frontend` ticket.

**Sessions you can watch (2026-10-08, devlog `#237`).** The trial's session was hidden
(`claude -p`). A ticket's session is now a background session you can open (above, "You can
watch it work"). Proved on a harmless task, not on a ticket: a session starts, edits a file, is
refused what it may not do without waiting for anyone, sees the run's local database and
placeholder token, is sent back once by the stop check for a type error, takes a second
instruction as the same session with its memory intact, and is stopped at the time cap.

**Not proven:** a real ticket built this way, and the wait for a usage limit or a lost connection.
For a background session that wait reads the session's own record of the error; the reading was
checked against two of your past sessions that really hit the limit and really lost the
connection, but no run has waited one out. So before 6B's first
full night, build one small ticket with `--only` in the evening and watch it. If background
sessions misbehave, `--print` is the way back to what the trial proved.

**6B's first night (2026-10-10, devlog `#248`).** Five tickets built with nobody watching, three of
them `frontend`; the fix loop and a set-aside ticket both happened for real. One fault was the
run's own: it took a session that had been quiet for three minutes as finished, while that
session's stop check was still running tests, and then ran the whole suite on the same test
database. `#145` failed that way and passed on its fix round; `#147` was set aside with nothing
wrong in it. The stop check now leaves a marker while it runs and the script waits on that, and a
test run that outlives its session is stopped. **Not proven yet:** a night with a ten-minute stop
check under the new wait. On the next evening's `--only`, the line "running the gates" should come
only after the session's last message has been followed by its stop check ending.

**6C's nights (2026-10-14 to 16).** Fifteen tickets built by the run. Four faults, none in a ticket's code, each fixed by `#194` unless said:
- `#162` hit the 120-minute cap chasing a flaky race test and was set aside; it was landed by hand, its migration renamed after `#164`'s and its log numbers changed. The race was fixed at its cause; renumbering a landed ticket is still by hand.
- The first night died silently at 05:20 mid-`#168`: no "Run finished", no report, the lock left. `#166` and `#167`'s report and assumptions were never posted. Results now survive on disk.
- On the restart, a new session found a `git stash` and applied it. Sessions can no longer stash.
- "API Error: Connection lost mid-response" cost fix rounds on 6B (`#146`, `#149`, `#152`). A dropped turn is now resumed.

**The fixes of 2026-10-17 (`#194`, devlog `#291`):**
- results saved per ticket, and a cumulative report and pull request body;
- a dropped turn resumed, not charged;
- the allowlist widened and the prompt's commands rewritten into shapes that pass;
- screenshots counted only after the last source edit, with a walk again after a review fix;
- `foundElsewhere` and `handedForward` in the verdict and the report;
- a "Handed forward" section in tickets;
- the shared registries always in scope;
- each ticket's walk committed under `scripts/walks/`;
- `git stash` refused;
- the runner's own tests (`pnpm test:runner`, and the `runner-tests.yml` workflow in CI);
- git's global options no longer slip past the shell guard.

**Not proven yet:** a real night under them. On 6D's first night watch for "Resuming it" lines, and for a report file that grows after each ticket.

**6D's night (2026-10-16 to 17).** Fourteen tickets built, one set aside. `#181` finished in about
an hour (commit, verdict "built", its turn over) and then sat for 48 minutes until the 120-minute cap
parked it. It had left two background wait loops running, each polling a reviewer's output file that
stayed empty; most likely they kept the session listed as working, so the runner never looked at the
transcript. It was landed by hand after `#191` (devlog `#305`). The fix (devlog `#306`): a turn that has
ended, with a verdict written during that turn, is taken as done once it stays ended for two minutes,
working or not, and `claude stop` ends what it left running; the prompts now say to wait for a
reviewer by its notice, to bound any other wait in a `node` script, to stop every background task
before the verdict, and, in a fix round, to write the verdict again. **Not proven yet:** a night under
it. Watch `run.log` for "still listed as working".
