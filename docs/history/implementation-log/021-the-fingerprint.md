# #021 — The fingerprint: a browser-check pass records what it judged

**Ticket:** `#35` · **Devlog:** `#36` · **ADRs:** 0008 (applied, none new)
**Date:** 2026-11-10

---

## The Problem

A lane's pass waits on its own branch until Landing (ticket #36) replays it onto the newest tip and
runs the real gates again (ADR 0008). For most gates that costs minutes. The browser check is
different: it is the session's own walk of the screens, and the runner only checks the screenshots
it left. Landing can't redo a walk. So without a record of what the pass judged, Landing would have
to park every screen ticket the other lane overtook, even when the rebase touched none of its
screens.

D12 settles the answer, ported from the source project: record a fingerprint on the pass, and let
Landing carry the browser check's pass when the fingerprint still matches. The source's version
hashed a fixed `src/`; here "source" has to be the browser check's own paths.

## The Solution

**A new module, `template/tools/phase-run/fingerprint.mjs`**, with two pure functions:

- **`takeFingerprint({ root, changed, sourceFiles, shots })`** returns `{ sources, screenshots }`.
  Each is a map of a repo-relative path (with `/`) to the sha256 of its bytes under `root`.
  - `sources` holds each changed file that the check's `sourceFiles` pattern matches. A file the
    ticket deleted is recorded as `null`.
  - `screenshots` holds each counted screenshot, the ones the gate counted as fresh.
- **`compareFingerprint(fingerprint, root)`** reads the same files under `root`:
  - `{ verdict: "carry" }` when every one hashes the same;
  - else `{ verdict: "re-check", file, why }` for the first that differs, sources before
    screenshots. `why` is `"gone"` for a file that was there and is not now, else `"changed"`. A
    deleted source file that came back counts as changed.

**In `run.mjs`:**

- `browserCheckProblem(ticket, changed, startedAt)`, which read the `config` and `work` globals,
  became **`browserCheckVerdict({ check, ticket, changed, startedAt, root })`**, exported. It
  returns `{ problem, fingerprint }`.
  - The check doesn't apply (no `browserCheck`, or not `frontend` and no screen file changed):
    `{ problem: null, fingerprint: null }`.
  - A pass: no problem, and the fingerprint of the files `screenshotsSince` counted. The gate's
    count and the fingerprint's screenshots are the same list.
  - A fail: the same problem text as before (now `browserCheckProblem(check, dir, shots)`), and no
    fingerprint.
- `runGates` keeps `projectGates`' `browserCheck` callback as it was (a string or null), and
  catches the fingerprint in a closure. Both of its passing returns are now `{ ok: true,
  fingerprint }`.
- `finishBuilt` takes it, and the built result gains `fingerprint` only when there is one:
  `...(fingerprint ? { fingerprint } : {})`. A ticket without a browser check has a result exactly
  as before.
- #33's source pin on the lane's early return in `runGates` now reads `return { ok: true,
  fingerprint };`.

A screenshot in a subfolder is named by `readdirSync` with the platform's separator (`wide\1280.png`
on Windows). The fingerprint stores it with `/`, prefixed by the screenshot folder, so its paths
look like the diff's.

## Why This Approach

- **Hash the bytes in the working tree, not the git blob.** The screenshots are never committed, so
  they have no blob. For a source file, the clean-tree gate runs before the browser check, so its
  bytes on disk are HEAD's checkout. That is also exactly what the walk ran.
- **The gate and the fingerprint read one count.** The fingerprint is taken from the same
  `screenshotsSince` result that passed the gate. A separate scan could count a different set.
- **The callback's contract is unchanged.** Eight `projectGates` tests pass `browserCheck: () => null`
  or a string. A closure in `runGates` keeps them as they were.
- **The comparison is a pure function of a fingerprint and a folder.** Landing (ticket #36) can call
  it on whichever tree its replay leaves, and the tests run it on a temp folder.

## Alternatives turned down

- **Fingerprint every file the check's `sourceFiles` matches, not just the changed ones.** D12 says
  "each changed source file". Hashing a whole source tree on every pass is slow on a real project.
  Its weak spot is noted below for ticket #36.
- **Hash each source file's git blob** (`git rev-parse HEAD:<path>`). It is immune to line-ending
  settings, but screenshots have no blob, so there would be two kinds of hash in one record. Both
  lanes check out the same repo, with the same settings.
- **Return `{ problem, fingerprint }` from `projectGates`' callback.** It would change a contract
  eight tests pin, for no gain.
- From the code review, turned down:
  - **Pass the source-file list once to both `screenshotsSince` and `takeFingerprint`** (the
    `sourceFiles` filter appears in both). It is one `filter` line each, and changing
    `screenshotsSince`'s signature would touch its older test for no change in behaviour.
  - **Rename away from "fingerprint" and "verdict"**, which `targetFingerprint` and the session's
    verdict file also use. D12 and the ticket name it the fingerprint, and ticket #36 will look for
    that word. `browserCheckProblem` keeps its name too: it still builds the failed check's problem
    text, now from its parts.
  - **Turn `finishBuilt`'s six positional arguments into an object.** That reshapes a function
    this ticket only adds one argument to.

## Real bugs found along the way

None in shipped code. The code review found three in this ticket's first commit, fixed before it
landed:
- The source pin on `runGates`' returns passed if either return carried the fingerprint. It now
  checks both, and that no bare `return { ok: true }` is left.
- A changed path that is a folder (a submodule) made `hashOf` throw `EISDIR`. It is now recorded
  as no file (`null`).
- A `screenshots` config ending in `/` gave paths like `shots/35//x.png`. The trailing slash is
  dropped.

The test #33 pinned the lane's return with sliced `run.mjs` on `"\n}\n"` without normalizing CRLF
first (gotcha #34), so on a CRLF checkout it read to the end of the file. This ticket edited that
test, and it now normalizes.

Found elsewhere, not fixed: `screenshotsSince` counts a changed folder's own mtime as a source
edit, so a ticket that changes a submodule pointer can make its screenshots look stale.

## What This Concretely Unblocks

- **Ticket #36 (Landing)** reads `result.fingerprint` and calls `compareFingerprint` on the replayed
  tree. "carry" skips the browser check's re-gate; "re-check" names the file for the park message.
- **Owed to ticket #36:** the fingerprint holds only the files the ticket changed. A rebase that
  changes a shared source file this ticket never touched (the other lane's edit to a component its
  screen uses) still says "carry". D12 decided that scope; #36 should say so in its park and carry
  log lines, or widen it.
- **Owed to ticket #36:** the comparison must read a tree checked out with the same line-ending
  settings as the pass, since the hash is of the checkout's bytes.
- **Owed to ticket #36:** call `compareFingerprint` with `root` set to the lane's worktree after the
  replay. The screenshots are uncommitted and live only there. Compared from the primary checkout,
  or after anything cleans the screenshot folder, every shot reads "gone". That errs toward a
  needless re-check, never a false carry.

## Run by hand

None. Backend-only (the runner and its tests), so no browser check: no screen changes.

## Assumptions made

Each is a small choice, easy to change:
- **sha256 of the working-tree bytes.** Change `hashOf` in `fingerprint.mjs`.
- **The result's key is `fingerprint: { sources, screenshots }`**, absent when there is none.
- **A deleted source file is recorded as `null`**, and its return counts as "changed". So is a
  changed path that is a folder (a submodule): it is no file, so its hash is `null`.
- **The comparison names the first file that differs**, sources before screenshots, not all of
  them. Collect them all in `compareFingerprint` if ticket #36 wants a list.

## Common Questions

**Does a ticket without a browser check change?** No. `browserCheckVerdict` returns no fingerprint,
and `finishBuilt` adds no key. The problem text a failed check sends is unchanged too.

**Where are the screenshots read from?** The check's `screenshots` folder under the session's root
(`work`): the lane's worktree in a lane, as the gate already read them.

## References

- `docs/discovery/05-brigade-0.7.0.md` D12; spec #27; ADR 0008.
- Code: `template/tools/phase-run/fingerprint.mjs`; `run.mjs` (`browserCheckVerdict`, `runGates`,
  `finishBuilt`).
- Tests: `template/tools/phase-run/run.test.mjs` (the fingerprint section), written first, red on
  the missing module.
