---
job: The timeline of this phase, one entry per commit, newest first.
kind: log
max-entry-lines: 15
---
# Devlog

Each commit's entry goes on top, in the shape of `docs/_templates/devlog-entry.md`, and the commit
message cites it (`devlog #N`). At each phase end, `node tools/doc-rotate.mjs` moves the closed
entries into `docs/history/devlog/`.

## #47 · fix · the guard checks a message piped to git commit -F -

**Built:** (attended, found building #27's fixes) the guard hook handed doc-check no message for `git commit -F -` with a heredoc, so a commit citing no devlog entry passed. Devlog #44's commit went in that way, and was amended before any push.
- `hooks/guard-shell.mjs`: `-F -` is read as an inline message is, from the command's own text; `-F <file>` is still read from the file.
**Verified:** the test written first (red, then green). The full test command passes (475), and doc-check is clean. Addresses #27.
**Next:** the release night, #41. **Record:** implementation log 032.

## #46 · feat · the code review's skill is config

**Built:** (attended, before #41) the source's later fix "a bare `code-review` started Claude Code's built-in review", which predates 0.7.0 here.
- `phaseRun.codeReview`: the review skill by its full id (`"<plugin>:code-review"`); the runner's loader refuses anything but a skill's name.
- The ticket prompt reads `{{CODE_REVIEW}}`; unset, it is today's `code-review`, byte for byte.
- Setup's skill asks for it as a checklist item, and `verify` warns while it is unset; the guide lists it.
**Verified:** the prompt both ways, the refusals and verify's warning written first (red, then green). The full test command passes (474), and doc-check is clean. Addresses #27.
**Next:** the guard reads a message piped to `git commit -F -`. **Record:** implementation log 031.

## #45 · fix · what can be built tonight

**Built:** (attended, before #41) the source's later frontier fix, checked here: a lane waited on one blocker while another could never be built tonight.
- `claim.mjs` `buildableTonight`: ready, or every blocker done, claimed or buildable tonight in turn; never a parked, not run-ready or out-of-spec blocker, nor a loop. Memoized, so a diamond reads once.
- `laneChoice` waits only for tickets that can be built tonight; a lane's count (`reachable`) counts only those. A one-lane count is today's.
- A ticket the runner's own error failed is now released as parked in a lane (`releaseParked`, shared with `park()`), so the other lane never builds it tonight.
**Verified:** the waits, a diamond, a loop, the count and the error path written first (red, then green). The full test command passes (473), and doc-check is clean. Addresses #27.
**Next:** the code review's skill as config. **Record:** implementation log 030.

## #44 · fix · Landing's minutes

**Built:** (attended, before #41) the source's later fix "Landing's minutes were missing from the ticket's gate time", checked here: they were.
- `metrics.mjs` `withLanding`: the wait for the landing lock joins Slept, the landing itself (replay, rebuild, re-gate, push) joins Gates, and both join the total; Claude's share is unchanged.
- `landPass` times the lock and the landing, and applies it before any outcome is saved.
- The guide's "What it costs" says so.
**Verified:** the sum and a source pin written first (red, then green). The full test command passes (470), and doc-check is clean. Addresses #27.
**Next:** what can be built tonight. **Record:** implementation log 029.

## #43 · fix · every lane names its values, and its gates get them

**Built:** (attended, before #41) the source's later fix "lane 1 ran on lane 2's test databases", checked by symptom here.
- The runner's own gates and Landing's re-gate got only each gate's `env`, never the lane's test prefix, QA port and database or row `env`. So lane 2's suite ran on lane 1's databases. Now `laneVariables` is the one list: the session and every gate job take it, the lane's value over the gate's own. A run without lanes is today's.
- `parseLanes`: once any lane names a test prefix, a port named `qa` or an `env` key, every lane must. A lane naming nothing has nothing to replace what it inherits, which is how the source's leak happened (its cause never traced).
- Setup's skill and the guide's sketch give each lane its own values; setup's plan refuses a walk that gives only lane 2's.
- A pin for the source's "older row" fix: the newest of two rows for one commit decides a restart.
**Verified:** the gates' env and the loader's rule written first (red, then green); older fixtures now give lane 1 its own values. The full test command passes (469), and doc-check is clean. Addresses #27.
**Next:** Landing's minutes. **Record:** implementation log 028.

## #42 · fix · a phase's new gotchas file, judged in the lane

**Built:** (attended, before #41) the first of the source's later two-lane fixes, checked by symptom against this branch (discovery 05's 2026-11-13 addendum, with the owner's calls).
- With no gotchas file on the tip, Landing wrote the lane's block alone, so the file had no header and the re-gate parked the ticket. #41's two tickets would both have parked. Now the block folds onto the tip's copy, or else onto the lane's own copy made from the template (`numberLane`). An add/add from two lanes lands as the tip's copy plus the block.
- One fold rule, `foldBlock` in `doc-lib.mjs`, shared by Landing and doc-check.
- In a lane, doc-check judges each `.lane/<file>` folded onto its file, so a stale word, a missing path or a missing header fails in the lane's own rounds, not at Landing. Outside a lane, `.lane/` is unread.
- The lane prompt tells a lane to make a phase's missing gotchas file from the template, with no block of its own.
**Verified:** 5 tests written first (red, then green): numbering, Landing on throwaway repos (both lanes make the file; the tip has none), and doc-check in a lane. The full test command passes (468), and doc-check is clean. Addresses #27.
**Next:** the lanes' values reach their gates. **Record:** implementation log 027.

## #41 · feat · setup's lane checklist and the guide's examples

**Built:** #40. Setup proposes two lanes, writes them only on a yes, and asks what a lane needs of the project's tools (D4, D7, D8, D15, D16).
- `setup.mjs`: the plan always proposes the lane rows (`../<repo>-lanes/lane-<id>`), `worktreeSetup` and the hotspot rows from doc-config's paths. `answers.lanes` writes them, and an owner's own section is kept.
- Refresh offers one hotspot row for each path doc-config gains, on a project with hotspots. A hand-written row is never changed.
- The setup skill asks the three lane questions only with lanes on: the test prefix, the browser scripts' QA address, the date.
- The template guide's "Two lanes" part: a config sketch, a lane helper, a lint rule and a clock as worked examples, never defaults. No lane helper file is added.
**Verified:** 9 tests at the setup seam, 7 written first (red, then green), and a CLI check of the plan's summary; the plugin's and the template's suites pass; doc-check clean; the code review's seven fixes are folded in (a relative dir, the plan's refusals, the gotchas fallback, Plug'n'Play, the owner's folder rows, a timeout).
**Next:** #41. **Record:** implementation log 026.

## #40 · feat · the listed-code rule

**Built:** #39. A file a test names, on a check's `unread` list, is put back on that list (D11).
- `unread-scan.mjs`: the paths the `phaseRun.tampering.testFiles` files name (relative imports included), and the list widened with a `!` for each listed one.
- `receipt.mjs` `listedGroups`, used by `stop-tests.mjs` and the Stop hook: a change to such a file voids that check's receipt. The hooks' loader now returns `testFiles`.
- `run.mjs` `gatePlan`: the same change voids any `unreadOf` skip that points at the check; a scan that fails refuses the skip.
- Setup's verify and refresh scan every row with a list, and say when there is no listed-code rule.
**Verified:** tests at the hook, runner and setup seams, written first (red, then green); the plugin's and
the template's suites pass; doc-check clean; the code review's three fixes (one scan per plan, `-z`
file names, no git without test files) folded in.
**Next:** #40. **Record:** implementation log 025.

## #39 · feat · findings and the reports' lane reading

**Built:** #38. One findings record per phase branch, and the reports read every lane (D14).
- `findings.mjs`: `findings.json` in the branch folder, written under the claim lock, each finding with its outcome (fixed, ticketed, taken, dropped) or open; every lane's results read back, tagged with their lane.
- `run.mjs`: a lane's report shows the whole night (landed, unlanded, parked, failed, and the findings), naming each lane; the pull request's body lists every lane; the last lane out posts.
- `status.mjs` reads lane folders and shows each lane and what it holds; a run without lanes reports exactly as before.
**Verified:** 15 tests at the runner seam, 14 written first (real processes for the record's race), plus
two `status.mjs` tests; a fixture pins the one-lane report word for word; the plugin's and the
template's suites pass; doc-check clean; the code review's two fixes (atomic results, last-out) folded in.
**Next:** #39. **Record:** implementation log 024.

## #38 · feat · the landing lock: a lane lands its own passes, one at a time

**Built:** #37. A lane lands each pass under one landing lock, and the primary checkout stays good (D13).
- `landing-lock.mjs`: the lock (an async wait, lapsing with its pid), the undo-detach on every way out, the hand-back, the restart's keep.
- `run.mjs` `landPass`: Landing with the real gates, run in the lane's worktree; then the result changed in place, the worktree reset to the tip and the claim released.
- A restart lands its recorded unlanded passes before its first claim; a park is listed, so the other lane never builds it.
- `.lane/` is always in scope; a run without lanes takes none of these paths.
**Verified:** 11 tests at the runner seam on throwaway repos (real processes for the races), the first 9
written first, plus the `.lane/` case; the plugin's and the template's suites pass; doc-check clean;
the code review's fixes folded in.
**Next:** #38. **Record:** implementation log 023.

## #37 · feat · Landing: the plan and the executor

**Built:** #36. Landing puts a lane's passing commit on the phase branch (D13, ADR 0008), tested on throwaway repos.
- `landing.mjs`: `landingPlan` is pure data, D13's steps from the tip, its last numbers, the lane's commit and the hotspot rows.
- `land` carries them out in a scratch worktree at the tip: replay, settle, number, rebuild, re-gate, the migration last.
- The fast-forward is a compare-and-swap (`update-ref` with the old tip), then a plain push; nothing is forced.
- A conflict off the hotspot rows, a failed step or a moved tip parks on `-parked-<N>`, the branch unmoved.
- An unchanged fingerprint carries the browser check's pass; a changed one runs the check again.
**Verified:** 14 tests at the Landing seam, the first 10 written first; the plugin's and the template's
suites pass; doc-check clean; the code review's fixes folded in.
**Next:** #37. **Record:** implementation log 022.

## #36 · feat · the fingerprint: a browser-check pass records what it judged

**Built:** #35. A browser-check pass records a fingerprint, for Landing to carry it over a rebase (D12, ADR 0008).
- `fingerprint.mjs`: a sha256 of each changed file under the check's own `sourceFiles`, and of each counted screenshot.
- `compareFingerprint` says "carry" on an unchanged tree, or "re-check", naming the file that changed or the screenshot gone.
- `run.mjs`: the gate is `browserCheckVerdict`, and the built result gains `fingerprint` only on a pass.
- A ticket with no browser check records none, and its result is as before.
**Verified:** 5 tests at the runner seam, the first 4 written first, on temp trees with fixed times;
the plugin's and the template's suites pass; doc-check clean; the code review's fixes folded in.
**Next:** #36. **Record:** implementation log 021.

## #35 · feat · the claim and the frontier: two lanes never build the same ticket

**Built:** #34. A lane claims its ticket before it builds it, from its frontier (Goal 3, D6, ADR 0007).
- `claim.mjs`: one claim file per branch in the primary checkout, changed only under an exclusive-create lock; a dead process's claims lapse.
- The frontier: ready tickets its row `takes` that no live claim holds, chosen inside the lock.
- With none ready, a lane waits while another live lane may still land a blocker, and stops when none can; two lanes never wait on each other.
- "Built" is read off the phase branch in a lane; a one-lane run still reads `main..HEAD` and picks as before.
**Verified:** 9 tests at the runner seam, written first, with the clock and the process check
injected and the race run in two real processes; the plugin's and the template's suites pass;
doc-check clean; the code review's fixes folded in. **Next:** #35. **Record:** implementation log 020.

## #34 · feat · the worktree: run.mjs --lane builds in a lane's own worktree, each pass unlanded

**Built:** #33. A lane runs its tickets in its own git worktree, with its ports, QA database, prefix and env (D8, D13).
- `lane.mjs`: the worktree made, or reused and reset to the tip; `worktreeSetup`; the ignored-import check; lane locks and the branch join.
- `run.mjs --lane`: run state stays in the primary (`lane-<id>/`); the session's root is the worktree (ADR 0007).
- Both lanes share one runner copy; the last lane out marks it finished.
- A lane's env carries `PHASE_RUN_LANE`, its QA port, database and prefix; `{qaUrl}` takes its database.
- A pass stays on `<branch>-lane-<id>`: no push, no migration (ADR 0008). A run without --lane is unchanged.
**Verified:** 17 tests at the runner and hook seams, written first; the plugin's and the template's
suites pass; doc-check clean; the code review's fixes folded in. **Next:** #34. **Record:** implementation log 019.

## #33 · feat · the lane declaration: a ## Lane holds only on a ticket with its lane's label

**Built:** #32. `/ticket-check` holds a ticket's `## Lane` to the label its lane's row `takes` (D6).
- `ticket-size.mjs` `laneProblems`: refuses a `## Lane` naming no lane, a lane no row has, or a row
  whose label the ticket lacks; the `any` lane needs none. No `## Lane`, no refusal.
- It warns when Areas name an own-file hotspot's folder but none of its files.
- The script fetches labels, prints `refused:` / `warning:` lines, and exits 1 on a refusal.
- `/ticket-check` and both ticket templates gain the `## Lane` section and its rule.
**Verified:** 6 tests at the ticket-size seam, written first; the plugin's and the template's suites
pass; doc-check clean; the code review's fixes folded in. **Next:** #33. **Record:** implementation log 018.

## #32 · feat · the snapshot carries doc-check: a night's docs are judged by its run's copy

**Built:** #31. The runner copy takes doc-check, every doc tool it imports, and its baseline (D10,
ADR 0005 amended). Inside a run, what judges the docs is the copy's; the docs are the repo's.
- `snapshot.mjs` `docTools`: walks doc-check's imports. A restart compares them as runner code;
  the baseline and doc-config, like workflow.json, stay the copy's.
- `doc-lib.mjs` `TOOLS_ROOT` / `checkedRoot`: the copy checks `PHASE_RUN_ROOT`; nothing else is redirected.
- `run.mjs` `docCheck`: the `--head` gate and `--report` run the copy; so does the commit hook.
- From the copy, a baseline write is refused naming why, and a budget raise fails the gate too.
**Verified:** 14 tests at the runner, doc-tools and hook seams; the plugin's and the template's
suites pass; doc-check clean. The code review's fixes are folded in.
**Next:** #32. **Record:** implementation log 017.

## #31 · feat · hotspots and unnumbered entries: a lane writes NNN, a pure step numbers it

**Built:** #30. A lane may write `NNN` where a number goes, and a pure function numbers it from the
tip (ADR 0006). Nothing runs a lane yet.
- doc-check: with `PHASE_RUN_LANE` set, a `## #NNN` entry, a log `NNN-<slug>.md` and `devlog #NNN`
  pass; without it, each fails, naming the token. `NUMBER_TOKEN` mirrors the runner's `HOTSPOT_TOKEN`.
- `numbering.mjs` `numberLane`: `log`, `generated` and `own-file` rows (exact, folder or `*`, with
  `{phase}`); the devlog and the log each take their own next number.
- The lane prompt's `{{LANE_NUMBERS}}` and `PHASE_RUN_LANE` come only with a lane.
**Verified:** 10 runner-seam and 3 doc-tools-seam tests written first; the plugin's and the
template's suites pass; doc-check clean. The code review's fixes are folded in.
**Next:** #31, the runner copy holds doc-check. **Record:** implementation log 016.

## #30 · feat · the lane table: two lanes as config, checked at preflight

**Built:** #29. The runner's loader reads `phaseRun.lanes` and `phaseRun.hotspots` and refuses a bad
table, naming the field. Nothing runs a lane yet, and the hooks' loader is unchanged.
- `parseLanes` / `parseLane`: rows of id, takes, worktree, qa, ports, testDbPrefix and env, at most
  `MAX_LANES` (2), one `any` row, one QA database each, a `qa` port for a row `qa`, safe prefixes.
- `parsePorts`: one port-row parser for `phaseRun.ports` and a lane's, with an optional `name`.
- `parseHotspots`: `token` and `{ path, kind }` rows; `claims` and `landing` take no keys yet.
- No `lanes` section loads as before: `lanes` and `hotspots` are null.
**Verified:** 5 new loader-seam tests written first, hooks seam included: config 19/19; the plugin
and template suites, 0 failures; doc-check clean. The code review's fixes are folded in.
**Next:** #30, hotspots and unnumbered entries. **Record:** implementation log 015.

## #29 · docs · the probe: a lane under the installed plugin

**Built:** #28, run attended on Claude Code 2.1.319 with Brigade 0.6.2 installed at project scope in
a scratch repo, plus a sibling worktree whose `--bg` session had the night's flags. Seven answers are
yes, and the eighth names a row. The session, its hooks, its writes, its transcript and its local settings were all the
worktree's, and they stayed there through a resume. An untrusted folder is refused, never prompted,
and a worktree rides on its primary's trust. `CLAUDE_PROJECT_DIR` in its hooks was the worktree. The
version read and the trust check will need the primary's root. Discovery 05 gains the addendum; the
handoff names the phase run next.
**Verified:** each answer read off the session's own files, its transcript and `claude agents
--json`; the scratch repo, worktree and install removed, the real install untouched; doc-check clean.
**Next:** #27's phase run, #29 first. **Record:** discovery 05's probe addendum.

## #28 · docs · 0.7.0 no longer waits for a real project's night

**Built:** the owner dropped D17, the build gate. Discovery 05 gains a dated addendum saying so.
The release night (D18, #41) still gates the release. The handoff names the probe (#28) next and
the phase run after it, and no longer lists Block23GymV2's setup. #28's "Blocked by" note and a
comment on spec #27 say the same. /ticket-check also ran on #27 (issues only): #29–#40 are
`run-ready`, and its answers are commented on #27.
**Verified:** doc-index picked up the addendum; doc-check clean. Nothing built.
**Next:** #28, the probe, attended. **Record:** discovery 05's addendum.

## #27 · docs · 0.7.0's tickets, published

**Built:** #27's 15 tickets, #28–#42, in this repo's ticket shape, each a sub-issue of #27 with
its "Blocked by" set as native GitHub edges and labelled `ready-for-agent` only. The 13 from the
spec, plus D10 (the snapshot carries doc-check, #31), which had no ticket, and D18's release night
(#41). Every code ticket waits for the probe (#28). #28 and #41 are attended, and #42 (the finish)
is blocked by all 14. The handoff names the probe next, after Block23GymV2's night.
**Verified:** read back from GitHub: 15 sub-issues, every edge as approved, no placeholder left,
every ticket number a link; #27 still open; doc-check clean. Nothing built.
**Next:** Block23GymV2's first night, then #28. **Record:** this entry only.

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
