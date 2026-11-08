---
status: accepted
---
# The stop check skips the tests when a receipt says they passed on exactly this code

Profiling one real project's 14-ticket night showed each ticket running nearly the same tests three
times: the session's own changed-tests run (often twice), then the Stop hook's identical re-run
(10 to 11 minutes measured), then the runner's full suite in its gates. About 20 minutes of an
85-minute ticket repeated a result already known.

A session now runs its tests through `tools/phase-run/stop-tests.mjs`, which runs the stop checks
marked `"receipt": true` and, on a pass, writes `.phase-run/test-receipt-<ticket>.json`: the base,
the working tree's content as one git tree hash (built in a copy of the index, so it is the same
before and after the commit and the session's staging is untouched), and the commands it vouches
for. The Stop hook skips a receipt row whose receipt still matches, and runs every other check. The
runner's gates trust no receipt and run the full suite on every ticket, as before.

## Considered options

- **Drop the hook's test run outright.** The hook exists so a failure is fixed while the session
  still holds the ticket in mind; an edit after the passing run would reach the gates untested and
  cost a fix round.
- **Key the receipt on the commit hash.** The session tests before it commits, so the hash changes
  at the commit and the receipt would never match.
- **Let the runner write the receipt.** The runner is not running while the session tests; only a
  script the session calls sees the pass.
- **A copy of the receipt code in the plugin's hooks.** The hook imports the project's own
  `tools/phase-run/receipt.mjs` instead, so there is one copy; a project without it (or a hook
  that cannot load it) runs every check, as before receipts existed.

## Consequences

- The hook's test minutes go to near zero on a ticket whose session tested last. Its log
  (`stop-check-log.jsonl`) records `testsSkipped`, and the report's Scoreboard shows the hook's
  minutes.
- A session could forge a receipt with its Write tool. That skips only the hook's courtesy re-run:
  the gates' full suite still catches the failure. **No gate may ever read the receipt**, or that
  stops being true.
- The receipt names the commands it vouches for, so changing a receipt row's `run` makes every old
  receipt stop matching. There is one command, in one place.

## Addendum 2026-10-30: unread paths (0.4.1, decided, not built)

The 0.4.0 trial night showed the receipt holding only when a session tested last. Each ticket
ends by writing its devlog and logs, and a docs-only edit was still a new tree, so the hook ran
the tests again.

- **"The same code" now means every file except the ones the project lists as unread.** That
  list is `"unread"` on the tests' row, written in git globs. Setup writes `["docs/**", "*.md"]`;
  with no list, every file counts, as before.
- The receipt records the list it was made under. A different list makes the receipt stale, as a
  different command does.
- **The trust stays the same:** a wrong list (one that names a file the tests do read) can skip
  only the hook's re-run, and the gates still run the full suite. To keep that mistake small, the
  loader refuses a catch-all such as `**`.
- The prompt also tells a session to run the tests last, after its docs.

## Addendum 2026-11-02: unread paths built (0.4.1)

Built as decided, with one widening: the review of the build found catch-alls past the four
named ones (`**/**`, `**/*.*`, `./**`, `src/..`). So the loaders refuse any glob that names no
folder or file, or that leaves the repo. As a backstop, a list that still leaves out every file
gives no key, so no receipt is written.

## Addendum 2026-11-08: a receipt per check (0.6.0, decided, not built)

Each stop check may now keep its own receipt and its own unread list, so the rule that receipt
rows share one list goes. See ADR 0004. The trust is unchanged: no gate reads a receipt.
