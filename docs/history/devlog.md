---
job: The timeline of this phase, one entry per commit, newest first.
kind: log
max-entry-lines: 15
---
# Devlog

Each commit's entry goes on top, in the shape of `docs/_templates/devlog-entry.md`, and the commit
message cites it (`devlog #N`). At each phase end, `node tools/doc-rotate.mjs` moves the closed
entries into `docs/history/devlog/`.

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
