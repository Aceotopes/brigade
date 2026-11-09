---
job: The timeline of this phase, one entry per commit, newest first.
kind: log
max-entry-lines: 15
---
# Devlog

Each commit's entry goes on top, in the shape of `docs/_templates/devlog-entry.md`, and the commit
message cites it (`devlog #N`). At each phase end, `node tools/doc-rotate.mjs` moves the closed
entries into `docs/history/devlog/`.

## #26 · docs · 0.7.0's spec, published

**Built:** spec #27, "0.7.0, two lanes", from discovery 05 (D1–D19), labelled `ready-for-agent`.
It says D1 (0.6.2) is already built, lists 90 user stories and the 13 proposed tickets, and pins the
source's §20 at `43a31019`. Its test seams are the loaders, the runner's exports, doc-tools, setup,
the hooks, and one new one: Landing's pure plan and its executor on throwaway repos. #27 joins
`.claude/spec-issues.json`, so the guard refuses a closing keyword for it. The handoff now says the
spec is out and the tickets wait for Block23GymV2's night.
**Verified:** the issue reads back open and labelled; no closing keyword or stray issue number in its
body; doc-check clean. Nothing built.
**Next:** Block23GymV2's first night, then `/to-tickets` from #27. **Record:** this entry only.

## #25 · chore · update the workflow to 0.6.2

**Built:** `/update-workflow` from 0.6.1 to 0.6.2: `tools/doc-check.mjs`,
`tools/doc-tools.test.mjs`, `tools/phase-run/measure.test.mjs` and `tools/phase-run/receipt.mjs`
re-copied, and the stamp moved. One offer was taken: the `plugin tests` gate gets
`"unreadOf": "tests"`. It does nothing yet, because the `tests` check still has no `unread` list:
refresh suggested `["docs/**","*.md"]`, and that stays declined, since the doc tests read `docs/`.
**Verified:** `setup.mjs verify` all ok; the pinned `tools/` tests 181/181.
**Next:** Block23GymV2's setup and first night on 0.6.2. **Record:** this entry only.

## #24 · fix · 0.6.2: doc-check trusts only committed ignores; receipts keep racy git

**Built:** the template's doc-check excuses a missing path only when a committed `.gitignore`
ignores it (`ignoredPaths`, `check-ignore -v`), and fails a named file that only this machine's
own rule keeps out of git (`machineOnly`). `treeKeys` keeps the index's own time on its copy, so
git still re-reads a same-size edit made in the index's tick. Released as 0.6.2: `plugin.json`,
the CHANGELOG, the README's version, development entry 14. Ported from a source project's fix.
**Verified:** both new tests failed first (the racy-git one only on Linux, in a `node:22`
container; Windows git re-reads anyway), then passed on both. Full command 329/329, pinned
`tools/` 179/179, the two changed suites 94/94 on Linux, doc-check clean.
**Next:** update the plugin here, then `/update-workflow`. **Record:** discovery 05 D1.

## #23 · docs · 0.7.0, two lanes: the grill's outcome

**Built:** discovery 05 records the owner's four-round grill on porting a source project's
two-lane runner: D1–D19 and 13 proposed tickets. 0.6.2 comes first with two bugs found there.
Lanes are `phaseRun.lanes` and `phaseRun.hotspots` rows, at most two, and lane 2 takes a label
the project picks. Setup's checklist, not template code, carries the test prefix and QA address.
ADRs 0006 (numbering at Landing), 0007 (two roots), 0008 (Landing re-gates, never forces). Eight
glossary terms. The handoff names 0.6.2 next.
**Verified:** doc-index rewrote both indexes; doc-check clean; plugin tests 148/148; no source
names in the new docs. Nothing built.
**Next:** 0.6.2, attended. **Record:** discovery 05, adr/0006, adr/0007, adr/0008.

## #22 · chore · the tests row gets its name

**Built:** the stop check's row in `.claude/workflow.json` is named `tests`, so its receipt has a
file of its own. It waited for a session running 0.6.1's hooks, since 0.5.2's refuse the key.
Spec #11 closed by hand; all its tickets were closed.
**Verified:** 0.6.1's `loadWorkflowConfig` reads the row with its name; the full test command
327/327; `setup.mjs verify` all ok; doc-check clean.
**Next:** the first real 0.6.x night, on the next project set up. **Record:** this entry only.

## #21 · chore · update the workflow to 0.6.1

**Built:** `/update-workflow` from 0.5.2 to 0.6.1: ten runner files and the phase-run guide
re-copied, seven runner files added. The config drops the tests row's `unread` list, since
`tests/docs-links` and `tests/no-project-specifics` read `docs/`. It adds `phaseRun.tampering`:
`node:test`'s skip, only and todo markers, `assert.` with 3 net removed, and the config guarded.
**Verified:** `setup.mjs verify` all ok. The runner's `readInstalledBrigade` read 0.6.1 from
`claude plugin list --json`, and `brigadeCatalog` found the catalog. The dry run stops at preflight
(no branch), so it never reaches that read. Not done: the row's `name`, until a 0.6.1 session.
**Next:** a fresh session, then the row's name. **Record:** this entry only.

## #20 · fix · 0.6.1: the guide's override example names no real folder

**Built:** the template phase-run guide's test-override example uses `<folder>/…` placeholder
paths. 0.6.0's named files under `tests/`, which doc-check refused as missing in any project with a
`tests/` folder, so the project's commits were blocked after `/update-workflow`. A new day-one test
runs the template's doc-check in a project with the usual code folders. Released as 0.6.1:
`plugin.json`, the CHANGELOG, the README's version, development entry 14.
**Verified:** the new test failed on the two example lines, then passed; suites 148/26/153, doc-check clean.
Found by `/update-workflow`'s verify on this repo, before any other project updated.
**Next:** update the plugin here and redo `/update-workflow` on 0.6.1. **Record:** this entry only.

## #19 · feat · finish 0.6.0: the guard reads only its own part, the review's fixes, the release

**Built:** the shell guard refuses only a fault in its own part of `workflow.json` (`parseGuard`,
`loadJudgeGuard`), and the startup notice says which kind of fault it is. A night reads its base
settings and prompts from the run's copy (`runnerFile`). An override line must say why. A ledger row
after a torn line starts its own. The guide gained trim, the override and the version stop. The
CHANGELOG, README and `plugin.json` are at 0.6.0. The devlog is rotated, and the gotchas closed.
**Verified:** suites 147/26/153 and doc-check clean. Real `claude -p --plugin-dir` sessions in a
scratch repo showed the attended row, the per-check skip, hooks judging by the copy, trim's saving
(37K-46K to 31K tokens) and the out-of-step shell. Not seen: a real 0.6.0 night.
**Decided:** the guard's own part, the installed version on night rows, and the override's reason
(owner, discovery 04's addendum). **Next:** merge #26, update the plugin, `/update-workflow` here.
**Record:** implementation log 014.
