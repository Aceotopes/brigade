---
job: Steak To Juan's phase-run history, from the first trial to 6D's night: what each night proved and what it broke.
kind: record
---
# The phase run's history in Steak To Juan

Moved unchanged out of the owner's guide (`docs/guides/phase-run.md`) when Brigade made the guide
generic (Brigade's build step 7, 2026-10-27). When Steak To Juan switches onto Brigade, it becomes a frozen record in Steak To Juan's
`docs/history/`. The `#` numbers are Steak To Juan's issues; devlog numbers are its devlog's.

## What it costs, for scale

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
