# #006 — Each stop check keeps its own receipt

**Ticket:** `#17` · **Devlog:** `#11` · **ADRs:** 0004 (and 0003's addendum)
**Date:** 2026-11-08

---

## The Problem

Until now only the tests row could carry a receipt, and every receipt row had to share one
`unread` list. So a session that wrote its devlog after its last checks still had the Stop hook
rerun typecheck and lint on every stop, and a list wide enough for lint wasn't safe for the tests.
The source project's runner measured the cost: in 20 of 24 receipt misses, the tree differed only
in docs or logs written *after* the last run (ADR 0004). D10 and D11 in discovery doc 04 settle the
answer: one receipt per check, keyed on the code *that check* reads, and no format migration.

## The Solution

- **`template/tools/phase-run/unread.mjs`** (new): `unreadMatcher(list)`, the one JS matcher that
  replaces git's `:(glob)`. `*`, `?` and a `[...]` class (named ones such as `[[:upper:]]`
  included) stay inside one folder; `**/` crosses
  folders; a trailing `/**`, or a plain folder name, covers everything under it (git's pathspecs
  did that too); the last glob that matches wins, and a leading `!` puts a path back.
- **`receipt.mjs`**:
  - `treeKeys(root, lists)`: one copy of the index, one `git add -A`, one `git ls-files -z`. Then,
    per list, a copy of that staged index, `git update-index --force-remove -z --stdin` of the
    paths the list matches, and `write-tree`. `treeKey(root, list)` is the one-list form.
  - `receiptPath(root, ticket, name)`: `<name>-receipt-<ticket>.json`, or 0.5.x's
    `test-receipt-<ticket>.json` for a row with no name.
  - `receiptGroups(checks)`: a named check alone, and all nameless checks together, sharing one file.
  - `receiptHolds` compares the command with `{base}` filled in. A 0.5.x receipt, which recorded
    it unfilled, still holds under its own base.
- **`stop-tests.mjs`**: keys every receipt check in one pass and skips each one whose own receipt
  holds. It runs the rest in the config's order, *all* of them even after a failure, and prints the failures last, cut
  to one shared cap (15,000 characters split between them). Each passing check's receipt is
  written only if its key is unchanged after the runs. Exit: the first failing status.
- **`hooks/stop-gate.mjs`**: with 0.6.0 receipt code (it has `treeKeys`), it runs only the checks
  no receipt covers, in order, to the first failure, writes no receipt, and logs `skipped: [...]`
  (each check's name, else its label). Beside a 0.5.x `receipt.mjs` it takes 0.5.2's path
  unchanged: one key, one file, the first receipt row's list.
- **Both loaders** (`hooks/workflow-config.mjs`, `template/tools/phase-run/config.mjs`), word for
  word:
  - A row may carry `name`: lowercase letters, digits, `-` or `_`, not `test` (the nameless file),
    used once.
  - `unread` stays on any `receipt: true` row. A leading `!` is stripped before today's catch-all
    and inside-the-repo refusals.
  - The every-receipt-row-shares-one-list rule is gone. Only rows with no name, which share one
    file, must still agree.
- **`tests/fixtures/receipt-0.5.2.mjs`** (new): 0.5.2's `receipt.mjs`, frozen, so the hook can be
  tested beside it.
- **Docs:** `docs/guide.md` and the template's phase-run guide describe per-check rows.

## Why This Approach

**One matcher, outside the receipt code.** #19's suite skip has to judge a diff with the same rules
as the key, and it runs in the runner. The runner must never import the receipt reader (ADR 0003).
So the matcher is its own module with no imports, and `run.test.mjs` walks the runner's import
graph to prove `receipt.mjs` is never reached.

**One staging, many trees.** `git add -A` is the slow part on a big tree. Staging once and then
removing each list's paths from a copy of that index gives every check its key for the price of
one. Paths go on stdin because a list matching hundreds of docs would pass Windows' command-line
limit.

**Old files mean what they meant.** A nameless row still writes and reads `test-receipt-<ticket>.json`,
and the matcher keys `["docs/**", "*.md"]` exactly as git did: a test compares the two keys on
ten lists. So a set-up project needs no migration (D11).

**Run everything, judge nothing.** The session's command runs every check so one run shows every
failure. The Stop hook stops at the first failure and writes nothing, because it is a courtesy
re-check, not a source of receipts.

Interview version: "It's cache invalidation keyed on each consumer's real inputs. Every check
declares which paths it never reads; its cache key is a git tree hash of the working tree minus
those paths. I stage the tree once and derive one tree per check from copies of that index, so N
keys cost one `git add`. A docs edit then changes no check's key, but a JSON file under docs
changes lint's and not the tests'. The trust boundary stays where it was: the receipts only skip a
courtesy rerun, and a test proves the gates' code can't even import the reader."

## Alternatives turned down

- **Keep the matcher in `receipt.mjs`** (one file, nothing new to copy into a project). The suite
  skip (#19) would then import the receipt reader into the runner, the one thing ADR 0003 forbids.
- **Refuse any two receipt rows without a name.** That would make a valid 0.5.x file with two
  receipt rows invalid, against D11. They share one file instead, so they keep the one-list rule.
- **Recompute each check's key right after it runs.** That is one `git add -A` per check. One
  recompute after all the runs gives the same answer: a check that writes a tracked file voids the
  receipts it changed.
- **Accept only the filled-in command in `receiptHolds`.** Then a 0.5.x receipt for a command with
  `{base}` would never match, though it names the same command under the same base.
- **(Review) One `heldChecks` export in `receipt.mjs`** for the hook and `stop-tests.mjs`, which
  both walk groups, keys and receipts. They need different things back (the hook whether any
  receipt was read; stop-tests each receipt's `passedAt` and a line per skipped group), so one
  helper would be a wider API for six shared lines.
- **(Review) Rename the log's `testsSkipped`**, which now means "any receipt check was skipped".
  `metrics.mjs` and older logs read it; `skipped` beside it now says which.
- **(Review) A helper for `.replaceAll("{base}", base)`.** It is one call, and each site reads
  plainly.
- **(Review) Refuse a `name` on a row without a receipt**, as `quiet` and `unread` are refused. A
  name is harmless there and only names the row; #19 may want it. Uniqueness still applies.
- **(Review) Keep `receiptUnread` for a 0.5.2 hook beside 0.6.0 receipt code.** The plugin
  updates before a project's runner, so that pairing doesn't arise; if it did, it would only cost
  the courtesy rerun.
- **(Review) The hook adds `skipped` to its log on the 0.5.x path too**, though that path is
  otherwise "exactly 0.5.2". The checks it runs and skips are 0.5.2's; one more field on the log
  row changes nothing a reader of the old fields sees.

## Real bugs found along the way

- **(Review) Checks ran out of config order.** `stop-tests.mjs` ran each receipt group in turn, so
  with `[Unit (no name), Lint, E2E (no name)]` it ran Unit, E2E, Lint, and exited with E2E's status
  though Lint failed first. It now walks the config's rows. pinned: `measure.test.mjs`.
- **(Review) Named classes didn't match.** `[[:upper:]]*.md` ended its class at the first `]`, so
  it never matched `README.md` as git did. The class parser now reads `[:name:]`, and the
  git-equivalence test covers class lists.
- **(Review) A hidden state.** The hook's receipt readers set its log state to an undocumented
  `"read"` that a later line overwrote; they now return it.
- **(Review) No test joined the two halves.** The three-check hook test wrote its receipts by hand;
  its full pass is now a real `stop-tests.mjs` run, so the keys the hook reads are the ones the
  session's command writes.
- The first draft of the cap test printed 4,000 characters, under the cap, so it proved nothing;
  it now prints 20,000.
- **Found elsewhere, not fixed here:** `scripts/setup.mjs`'s comment at the tests-row offer (about
  line 840) still says "every receipt row shares one list". It is setup's code and #18's to
  change.

## What This Concretely Unblocks

- **#18** (offering the new rows): `name`, per-row `unread`, and the matcher's rules
  (`**/*.md`) are what refresh offers. It also owns the prompt's `STOP_CHECKS` line, which repeats
  `stop-tests.mjs (the tests)` once per receipt row once a project has several.
- **#19** (`unreadOf` and the suite skip): `unreadMatcher` from `unread.mjs`, never `receipt.mjs`.
  Each check's `name` is what `unreadOf` names.
- **#22** (the honesty warning): the names and the matcher, to find test files that read a listed
  path.

## Run by hand

- None.

## Assumptions made

- **A name is `^[a-z0-9][a-z0-9_-]*$`, and never `test`.** It is a file name segment and, from
  #19, a reference. To widen it: `checkName` in both loaders.
- **Rows without a name share one file and so one list.** To lift that, give each nameless row a
  derived file name instead (`receiptGroups`, `receiptPath`).
- **`skipped` lists each check's name, else its label.** To change it: the `skipped.push` line in
  `hooks/stop-gate.mjs`.
- **The failures share one cap, split evenly** (15,000 characters). To change it: `FAILURE_CAP` and
  the `share` line in `stop-tests.mjs`.
- **A `[...]` class and a `\` escape are matched as git did**, though the ticket named only `*`,
  `**/`, `?` and `!`, so an old list using them keeps its meaning.
- **A `name` is allowed on a row without a receipt** (it only names the row). To refuse it: one
  line in `checkName` in both loaders.

## Common Questions

**Does an old project change?** No. Its rows have no names, so the receipt file, the one list and
the keys are what they were. Beside a 0.5.x `receipt.mjs`, the hook runs 0.5.2's code path.

**Can a wrong list make a gate pass?** No. A wrong list can only skip the Stop hook's courtesy
rerun; the runner's gates read no receipt and run every check.

**Was a browser check run?** No. Backend only: no screen changes.

## References

- Spec #11, `docs/discovery/04-brigade-0.6.0.md` D10 and D11, ADR 0004, ADR 0003.
- `template/tools/phase-run/unread.mjs`, `receipt.mjs`, `stop-tests.mjs`, `config.mjs`;
  `hooks/stop-gate.mjs`, `hooks/workflow-config.mjs`.
- Tests: `template/tools/phase-run/measure.test.mjs`, `run.test.mjs`, `tests/stop-gate.test.mjs`,
  `tests/phase-run-config.test.mjs`, `tests/workflow-config.test.mjs`, `tests/fixtures/receipt-0.5.2.mjs`.
- Gotchas: `docs/agents/gotchas/measure-trim.md`, block `#17`.
