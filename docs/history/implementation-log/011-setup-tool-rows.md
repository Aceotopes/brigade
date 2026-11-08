# #011 — Setup asks for tool rows

**Ticket:** `#22` · **Devlog:** `#16` · **ADRs:** 0001 (no stack recipes)
**Date:** 2026-11-08

---

## The Problem

0.6.0 gave the config new keys: a check's `name` and its own `receipt` and `unread` list, a gate's
`after`, `when`, `unreadOf` and `{cache}`, and the `phaseRun.tampering` section. The loaders check
them, but nothing in setup wrote them for a new project, and the right values depend on the
project's own tools (its test runner's skip markers, its linter's cache flag). ADR 0001 says Brigade
ships no per-tool rows, so setup had to ask instead. Two more gaps: refresh matched a row by its
exact command, so a row whose command gained a cache flag looked like a stranger (the plain row
offered back, the edited one offered for removal); and nothing warned when a tests row's `unread`
list left out a file the tests actually read.

## The Solution

- **The checklist** (`skills/setup-workflow/SKILL.md` §3, "Then the project's own tools"): names
  from the roles refresh knows (`typecheck`, `lint`, `tests`), the tests' changed-only command with
  `{base}` on the stop check, the tampering rows, the build gate's `when` and `after` (copying the
  waited-on gate's `when` and `unreadOf`), `{cache}` flags and `unread` lists, and the lint and
  typecheck hygiene pieces in the project's own configs. §8's refresh walks the same items for any
  key still missing, and `/update-workflow` gains a step 6 that walks them after #18's offers.
- **Worked examples** in the template's phase-run guide, "What your config sets": the source
  project's rows (Vitest's `--changed {base}`, the Next.js build's `when`, typecheck `after` it,
  ESLint and tsc pointed into `{cache}`, Vitest's tampering markers), headed "never defaults". A
  throwaway script checked the example through both loaders.
- **The honesty scan**, `template/tools/phase-run/unread-scan.mjs`: `unreadScan({ config, files,
  read })` reads the files `phaseRun.tampering.testFiles` matches, finds quoted path strings
  (`pathOf`: from the root, or from the test's folder for `./` and `../`; globs, URLs, `${…}` and
  spaces skipped) and reports each that lands on the tests row's `unread` list (`testsRow`: the check
  named `tests`, else the nameless receipt rows). No `testFiles`: one line, "set
  phaseRun.tampering.testFiles to check your unread list", and nothing read. It imports only
  `./unread.mjs`'s matcher, and runs on its own as `node tools/phase-run/unread-scan.mjs`.
- **Setup prints it**: `scripts/setup.mjs` `unreadWarnings` runs the plugin's copy on the project's
  file list (`projectFiles`, now shared with `detect`), handing it the stop check in the stack's
  tests role, whatever its name. `refresh` returns `warnings` for the config as it is, never an
  item; `verify` adds a `warn` line that never fails.
- **Row matching** (`roleMatcher`, `roleMatchers`): a row holds a stack role by its exact `run`; or,
  when it has a name (a stop check's `name`, a gate's `label`), by the suggested command with flags
  added after it, if no row holds that role by its exact run. Refresh's lists, the 0.4.1 tests-row
  adds, `rowOffers` and the scan's tests row all use it. A command the stack no longer suggests (the
  project moved to npm) is still a stranger, named or not.
- **`propose` pinned**: a test holds `proposeWorkflow`'s whole guard, stop gate and phase-run rows
  for a `package.json` project, so a tool-specific key can't slip into code.

## Why This Approach

**Questions, not recipes.** A recipe table for Vitest, Jest, pytest and the rest would be code to
maintain, and an untried row looks authoritative. A checklist lets Claude write what the project's
own tools do, and the loaders catch a malformed row. The guide's examples show what good rows look
like without being a default anyone inherits.

**A name plus the command it grew from.** The owner's rule is "match by name, else by exact run",
so that a row whose command gained a cache flag is still recognised. Proposed rows carry no names,
so a name alone points at no role. What a name can safely say is "this row is the suggested one,
with flags added": the row's command must start with the suggested command. That keeps the
cache-flag case, keeps #18's pinned case (a hand-written `pnpm lint:css` row that happens to be
named `lint`) a stranger, and keeps a real stack change visible: a project that moved from pnpm to
npm still gets npm's rows offered and pnpm's offered for removal. Gates have no `name`, but they are
where `{cache}` flags go, so a gate's `label`, which `after` already uses as its name, plays that part.

**A warning, not a gate** (D19). The scan is a guess about what a test reads. It under-warns (a
path joined from pieces goes unseen) and can over-warn (a fixture path a test writes into a temp
repo). The gates already run everything a wrong list lets through, so a hint is the right weight.

Interview version: "The new config keys depend on each project's tools, and the plugin's rule is to
ship no per-tool recipes. So setup asks a checklist of questions and Claude writes the rows, which
the loaders validate. I also taught refresh to recognise a row by its name once its command changes,
and added a cheap scan that warns when the tests seem to read a file the config claims they don't."

## Alternatives turned down

- **A name alone, matched to Brigade's role names** (the first build). The review found that every
  gate has a label, so a project that switched package manager got no add and no removal: the
  stale commands stayed without a word. And a tests row named `unit` was never recognised. Both
  are fixed by the "command it grew from" rule above.
- **Name-first matching, word for word.** It gives a hand-written row named `lint` the Lint row's
  offers, which #18's test forbids, and hides a stack change behind any name.
- **(Review) The worked examples are close to the recipes ADR 0001 turned down.** The ticket asks
  for them in the guide; they are one project's rows, headed "never defaults", and the checklist
  says to check every flag in the project's own tools.
- **(Review) Move the examples out instead of raising the guide's budget.** The criterion names the
  guide's "What your config sets"; the raise is in the header, where the diff shows it.
- **(Review) Drop the scan's CLI and its own `repoFiles`.** The template can't import setup, and a
  template script a project can run on its own is how the other phase-run tools work.
- **(Review) Unexport `testsRow` and `pathOf`.** They are the scan's two rules a reader looks for; a
  test can reach them without the git fixture.
- **Changed-only tests on the suite gate too.** The source project runs `--changed {base}` on the
  stop check and the full suite as its gate; the gates are what runs everything.
- **The file list in `detect`'s output.** The skill reads all of detect's JSON; a big repo's file
  list would flood it. `projectFiles` is shared instead.
- **Importing the project's copy of the scan.** A project a release behind has none, and refresh
  can run before `/update-workflow`. The plugin's copy always exists.
- **Moving the examples out of the guide.** The criterion puts them in "What your config sets"; the
  guide's `max-lines` went from 560 to 620 instead, which #21's log said would be needed.

## Real bugs found along the way

- **(Review) Label matching hid a package-manager switch.** See the first alternative above.
  pinned: `tests/setup.test.mjs` ("a name never hides a stack change").
- **(Review) The scan read only a tests row named `tests`**, and refresh scanned the config with its
  unaccepted adds applied, so a warning could quote a row the project didn't have. It now gets the
  row by its role and scans the config as it is. pinned: `tests/setup.test.mjs` ("any name will do").
- **Found elsewhere, not fixed here:** this repo's own tests row lists `docs/**` and `*.md` as
  unread, but `tests/docs-links.test.mjs` and `tests/no-project-specifics.test.mjs` read `docs/`,
  `README.md` and `CHANGELOG.md`. A docs-only change keeps the stop check's receipt though those
  tests read it. The gates still run them, so nothing ships unchecked. `.claude/workflow.json` is
  the owner's to change.

## What This Concretely Unblocks

- **#23** (the compose scan) builds on the same checklist.
- **#24** (the finish ticket) can describe 0.6.0's setup as it now runs.

## Run by hand

- None.

## Assumptions made

- **A named row matches by the suggested command with flags added after it**, never by its name
  alone, and only when no row holds the role by its exact run. A flag put in the middle of the
  command (`pnpm exec eslint --cache .` for `pnpm lint`) is a stranger, as in 0.5.x. To change:
  `roleMatcher` in `scripts/setup.mjs`.
- **A gate's name is its `label`.** To drop gates from name matching: `roleMatchers`' `gateRole`.
- **The tests row** is the stop check in the stack's tests role (setup), else the check named
  `tests`, else the nameless receipt rows (the scan alone). To change: `unreadWarnings`, `testsRow`.
- **A path string** is a quoted one-line string with a folder or an extension. To widen or narrow:
  `pathOf`.
- **The changed-only command goes on the stop check**, the suite gate keeping the whole suite, as
  the source project does. To change: the checklist line in `skills/setup-workflow/SKILL.md`.
- **The guide's budget** went to 620 lines. To trim instead: its worked examples block.

## Handed forward

- None.

## Common Questions

**Does setup write any of these keys itself?** No. `propose` stays 0.5.x-shaped (a test pins it);
Claude writes the keys from the owner's answers during setup.

**Why does verify say "warn" and still pass?** The scan guesses from strings in the test files. A
hit is worth a look, not a stop.

**Was a browser check run?** No. Backend and docs only: no screen changes.

**Why is the template's phase-run guide touched?** It is in this ticket's Areas
(`template/docs/guides/`), for the worked examples.

## References

- Spec #11, `docs/discovery/04-brigade-0.6.0.md` D17, D18, D19, ADR 0001.
- `scripts/setup.mjs` (`roleMatcher`, `rowOffers`, `refresh`, `verify`, `unreadWarnings`,
  `projectFiles`), `template/tools/phase-run/unread-scan.mjs`.
- `skills/setup-workflow/SKILL.md` §3, §7, §8; `skills/update-workflow/SKILL.md` steps 6 and 7.
- Tests: `tests/setup.test.mjs`.
- Gotchas: `docs/agents/gotchas/measure-trim.md`, block `#22`.
