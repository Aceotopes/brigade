---
job: The timeline of this phase, one entry per commit, newest first.
kind: log
max-entry-lines: 15
---
# Devlog

Each commit's entry goes on top, in the shape of `docs/_templates/devlog-entry.md`, and the commit
message cites it (`devlog #N`). At each phase end, `node tools/doc-rotate.mjs` moves the closed
entries into `docs/history/devlog/`.

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
