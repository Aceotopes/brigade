---
job: The owner's guide to the unattended phase run: evening and morning checklists, merging, undoing a ticket.
kind: living
max-lines: 760
---
# The phase run — the owner's practical guide

**Scope:** Building a phase's tickets overnight with nobody watching, since 2026-10-07. Covers the
evening and morning routines, what the run does and never does, merging a pull request (your first),
undoing one ticket, and a fix for every likely problem. Background: `docs/agents/workflow.md` (the
whole path of a phase).
**Date:** 2026-10-07; made generic for Brigade on 2026-10-27. Everything this guide calls "your
project's" is set in `.claude/workflow.json` (its `phaseRun` section; "What your config sets", below).

---

## The 30-second version

| You want to… | Do this |
|---|---|
| See what a run would build, changing nothing | `node tools/phase-run/run.mjs --spec <N> --branch phase-2b --dry-run` |
| Start the first night of a phase | On `main`, everything committed and pushed: `node tools/phase-run/run.mjs --spec <N> --branch phase-2b --max 4` |
| Continue the next night | The same command. It carries on from where the branch is |
| Build one ticket only | `node tools/phase-run/run.mjs --only <ticket> --branch phase-2b` |
| Build everything up to one ticket, then stop | `node tools/phase-run/run.mjs --spec <N> --branch phase-2b --until <ticket>` |
| Watch a ticket being built | In a second terminal, anywhere: `claude agents` shows the list; `claude attach <id>` opens one (the run prints the id) |
| Read what happened | The report is a comment on the phase's pull request, and a file in `.phase-run/<branch>/` |
| Answer a parked question | Comment on that ticket's issue, remove the `needs-info` label, add `run-ready` |
| Hand-test what was built | `git checkout phase-2b`, then test as usual |
| Go back to `main` | `git checkout main` |
| Finish the phase | Merge the pull request on GitHub with **Create a merge commit** |
| Stop a run early | Ctrl+C in its terminal, then read "If you stopped a run" below |

`<N>` is the spec's issue number. The branch name is yours to pick; it must start with `phase-`.

## A whole phase, start to finish: what to type

The 30-second version starts at the first night. This is everything before and after it, in
order. `N` is the spec's issue number, `phase-2b` the branch name you pick. The reasons for each
step are in `docs/agents/workflow.md`.

**1. Grill the phase** (you and Claude, one sitting). In a fresh Claude Code session in the
project folder, type `/grill-with-docs` followed by what the phase is, for example:

```
/grill-with-docs Checkout phase 2B: guest checkout. Scope is §3 of the checkout discovery doc, open items 2B-O1 to 2B-O4.
```

Answer until it has no questions left. Do not `/clear` afterwards: steps 2 and 3 work best in the
same conversation.

**2. Flow diagram and prototype.** In the same session, in plain words:

```
Build the flow diagram and the clickable prototype for 2B.
```

Click through the prototype and ask for changes until you approve it. A phase with no screens
skips this step. (A project that uses Impeccable builds both through it.)

**3. Spec and tickets.** Still in that session, `/to-spec`. It publishes the spec as a GitHub
issue and says its number. Then `/to-tickets`.

**4. Readiness check.** `/ticket-check N`. It asks every open question in one batch; a ticket with
nothing left open gets the `run-ready` label.

**5. The evening.** Everything committed and pushed on `main`, whatever your project's preflight
needs already running (a database container, say), every other Claude Code window in this folder
closed. In PowerShell, in the project folder:

```
node tools/phase-run/run.mjs --spec N --branch phase-2b --dry-run
```

It lists the tickets and says which are READY. **The first evening of a phase, build one ticket
while you are awake**, and watch it from a second terminal with `claude agents`:

```
node tools/phase-run/run.mjs --only <a READY ticket> --branch phase-2b
```

If that went well, start the night and leave the folder alone:

```
node tools/phase-run/run.mjs --spec N --branch phase-2b --max 4
```

**6. The morning.** Read the report (the newest comment on the phase's pull request). Answer a
parked question on its issue, then remove `needs-info` and add `run-ready`. Hand-test with
`git checkout phase-2b` and the app as you usually run it. Tickets left: the same `--spec` command
again tonight.

**7. Finish and merge.** When every ticket but the finish ticket is built and tested, open a
normal session on `phase-2b` and do the finish ticket with it. Then on GitHub, on the pull
request: **Ready for review**, the arrow beside the green button, **Create a merge commit**. On
your laptop, `git checkout main`, then `git pull`. Close the spec issue by hand.

**A worked example of the numbers.** Every issue and pull request on GitHub gets the next number
in one shared count. Say the newest is `#141`. Then `/to-spec` publishes the 2B spec as `#142`,
and that is `N`. `/to-tickets` publishes the tickets after it, say `#143` to `#150`, with `#150`
the finish ticket. So you type:

```
/ticket-check 142
node tools/phase-run/run.mjs --spec 142 --branch phase-2b --dry-run
```

and the dry run answers something like:

```
  #143  READY  ·  2B · Guest checkout data: carts without an account
  #144  waiting on #143  ·  2B · The guest's cart page
  #145  waiting on #143  ·  2B · The order confirmation email
  ...
  #150  not labelled run-ready (run /ticket-check first)  ·  2B · Finish
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
`main`. A phase run makes a branch (say `phase-2b`) and commits there. `main` does not change until
you say so. If a night goes badly, `main` is exactly as you left it.

**A pull request is GitHub's page for one branch**: every commit on it, the automatic tests' result,
and a Merge button. The run opens one pull request per phase, marked **draft** (GitHub's word for
"not ready to merge yet"). When the phase is finished and you have tested it, you press Merge, and
the branch's commits join `main`. **That merge is your go-ahead.** It replaces saying "go ahead and
commit" after every ticket.

**A git branch is not a database branch.** Some database hosts call their copies branches too;
they share a word and nothing else. The code branch `phase-2b` lives in git. Your databases stay as
they were, and a run touches only the ones your config names:

| Database | Named in | Does a run touch it? |
|---|---|---|
| Your test databases | your test command (a gate) | Yes: every test run uses them, as always |
| The QA database | `phaseRun.qa` | Yes: a session's browser check and scripts work on it |
| The migration target (your development database) | `phaseRun.migrations.target` | Only to apply a ticket's new migration, after that ticket passes every check |
| Production | nothing | Never |

**A session is pointed at local data.** `.env` may hold live addresses and tokens. Each session
starts with the values `phaseRun.sessionEnv` pins (the QA database's address, a placeholder for a
live token), and loading `.env` cannot change them. So a script a session runs to try something out
reads local data, and nothing it runs can reach a live service the config pinned away. This stops
accidents; it is not a locked door.

## What your config sets

The runner knows only the workflow. Everything about your project is in `.claude/workflow.json`
(the format is in `tools/phase-run/config.mjs`), and a session is refused any edit to it:

- `stopGate.checks`: what a session must pass each time it stops (typecheck, lint, the tests its
  changes touch). The tests' row carries `"receipt": true`: a session runs it through
  `node tools/phase-run/stop-tests.mjs`, and the stop check skips it while the code is still what
  passed. An optional `"quiet": { "totals", "failures" }` pair of patterns on that row says which
  lines of the test output a session needs (for vitest, `^\s*(Test Files|Tests|Duration)\s` and
  `^\s*FAIL\s`); without it the session sees the last lines of a pass and the tail of a failure.
  An `"unread"` list of globs on that row names what the tests never read (setup writes
  `["docs/**", "*.md"]`; `*.md` is the root only, `**/*.md` every folder's, and a leading `!` puts
  a path back), so a session's devlog written after the pass keeps the receipt. Any other row may
  carry `"receipt": true` and its own `"unread"` too (typecheck and lint with `["**/*.md"]`, say),
  plus a `"name"`: each keeps its own receipt, `.phase-run/<name>-receipt-<ticket>.json` (rows
  without a name share `test-receipt-<ticket>.json`, and so one list). The config refuses a glob
  that names no folder or file, such as `**`. Each stop check logs `"receipt": "held"`, `"stale"`
  or `"none"`, and the checks it skipped, in `.phase-run/stop-check-log.jsonl`.
- `phaseRun.steps`: `{ "kind", "match" }` rows that name what a session's commands were (your
  browser walks as `browser`, say), for the report's time split.
- `phaseRun.ticketSize`: the size budget `/ticket-check` warns on (`checkboxes` or `bullets` under a
  section, or `words`); left out, 8 criteria, 8 Areas entries and 800 words.
- `phaseRun.gates`: the checks the runner itself makes after a session finishes, side by side; a gate
  with `when` runs only if the ticket touched matching files. `after: "<label>"` waits for that gate
  to pass (build, then typecheck); `alone: true` runs a gate by itself after the rest, with strays
  stopped first (a suite that owns ports or a database); `unreadOf: "<stop check name>"` skips a
  gate when every changed file is on that check's `unread` list (the suite skip); `{cache}` in a
  command is a folder emptied before the gates run, for a tool's cache flag.
- `phaseRun.tampering`: the first gate, read from the ticket's base commit. It fails added skip
  `markers` in `testFiles`, a net loss of `assertions`, or a change to a `guarded` file or script; a
  line under the ticket's `override.heading` that names the file and says why, written before the
  run, lets it through ("Weakening a test on purpose", below).
- `phaseRun.preflight` and `phaseRun.ports`: what must be running, and what must be free, before a
  run starts.
- `phaseRun.qa`, `sessionEnv`, `migrations`: the databases above, and the values pinned in a session.
- `phaseRun.browserCheck`: where a ticket that changes a screen saves its screenshots, and how many.
- `phaseRun.permissions`: commands a session may run beyond the rules every project gets
  (`tools/phase-run/settings.json`).
- `phaseRun.keep`: `{plugins, skills}` that your machine's trim list never switches off here.
- `phaseRun.prompt`: your project's own instructions to each session (how to build, how to walk a
  screen, how to review it), a markdown file in `docs/agents/` with `## Read`, `## Build`,
  `## Browser check`, `## Review` and `## Fix` sections.

**Worked examples, never defaults.** Setup writes no tool's rows (`propose` gives only what your
`package.json` scripts name); it asks about your tools, and Claude writes their rows. The project
Brigade was lifted from, a Next.js app on pnpm with Vitest, ESLint and tsc, has these 0.6.0 rows.
Check every flag in your own tools' docs before you copy one:

```json
"stopGate": { "checks": [
  { "label": "Typecheck", "name": "typecheck", "run": "pnpm typecheck", "receipt": true, "unread": ["**/*.md"] },
  { "label": "Lint", "name": "lint", "run": "pnpm lint --cache", "receipt": true, "unread": ["**/*.md"] },
  { "label": "Tests", "name": "tests", "run": "pnpm exec vitest run --changed {base} --passWithNoTests", "receipt": true, "unread": ["docs/**", "*.md"] }
] },
"phaseRun": {
  "gates": [
    { "label": "build", "run": "pnpm exec next build", "when": "^(src/|public/|package\\.json$|pnpm-lock\\.yaml$|next\\.config\\.|tsconfig)" },
    { "label": "typecheck", "run": "pnpm typecheck --incremental --tsBuildInfoFile {cache}/tsbuildinfo", "after": "build", "when": "^(src/|public/|package\\.json$|pnpm-lock\\.yaml$|next\\.config\\.|tsconfig)" },
    { "label": "lint", "run": "pnpm lint --cache --cache-location {cache}/eslintcache", "unreadOf": "lint" },
    { "label": "tests", "run": "pnpm test", "alone": true, "unreadOf": "tests" }
  ],
  "tampering": {
    "testFiles": ["**/*.test.ts", "**/*.test.tsx"],
    "markers": [{ "name": "skip", "pattern": "\\b(describe|it|test)\\.(skip|todo)\\(" }, { "name": "focus", "pattern": "\\b(describe|it|test)\\.only\\(" }],
    "assertions": { "pattern": "\\bexpect\\(", "maxNetRemoved": 0 },
    "guarded": ["vitest.config.ts", ".claude/workflow.json"],
    "override": { "heading": "Test override" }
  }
}
```

- **Vitest's `--changed {base}`** runs only the tests the ticket's changes reach, on the stop check;
  the suite gate still runs them all. A runner with no such flag runs its suite.
- **The build's `when`** names the paths that feed it, so a docs-only ticket skips it. Next.js
  writes types the typecheck reads, so typecheck waits for the build (`after`) and copies its
  `when`, and the two skip together.
- **The cache flags** point ESLint's and tsc's caches into `{cache}`, which the runner empties
  before the gates, so no gate trusts a cache a session wrote. Each goes after the script's own
  command, and the row keeps its name (a gate's is its label), so setup's refresh still knows it.
- **The tampering rows** are Vitest's: its skip and focus calls, and `expect(` as the assertion.
  Their `testFiles` is also the listed-code rule's: a path a test file names is put back on any
  `unread` list, so a change there voids that check's receipt and its suite skip. Without
  `testFiles` there is no such rule, and setup's verify says so.

**Two lanes: worked examples, never defaults.** With `phaseRun.lanes`, a second runner builds a
ticket beside the first, each in its own worktree. Setup proposes the rows, and you say yes; it
asks for each lane's own values. Brigade ships no lane helper: a lane is a few environment variables,
`PHASE_RUN_TEST_DB_PREFIX`, `PHASE_RUN_QA_PORT` and `PHASE_RUN_QA_DATABASE`, which any language
reads. Your project's own code reads them. In the sketch below, each `<…>` is yours to fill:

```json
"lanes": {
  "rows": [
    { "id": 1, "takes": "any", "worktree": "../<repo>-lanes/lane-1",
      "ports": [{ "port": <your QA port>, "what": "lane 1's QA server", "name": "qa" }], "testDbPrefix": "<your test names' prefix>" },
    { "id": 2, "takes": "<lane 2's label>", "worktree": "../<repo>-lanes/lane-2", "qa": "<lane 2's QA database>",
      "ports": [{ "port": <a free port>, "what": "lane 2's QA server", "name": "qa" }], "testDbPrefix": "lane2_" }
  ],
  "worktreeSetup": { "copy": [".env"], "commands": ["<your install>"], "leaves": ["node_modules"] }
},
"hotspots": { "rows": [{ "path": "docs/history/devlog.md", "kind": "log" }, { "path": "docs/agents/gotchas/{phase}.md", "kind": "own-file" }] }
```

The three pieces the project Brigade was lifted from wrote for itself, sketched here for a JavaScript
app with browser scripts (written for this guide, not copied from it):

```js
// The helper, a module of your own. Outside a lane the variables are unset, and the project's own values hold.
export const testDatabase = (name) => `${process.env.PHASE_RUN_TEST_DB_PREFIX ?? ""}${name}`;
export const qaTarget = (own) => ({
  port: Number(process.env.PHASE_RUN_QA_PORT ?? own.port),
  database: process.env.PHASE_RUN_QA_DATABASE ?? own.database,
});

// The lint rule, in eslint.config.mjs: a browser script names no address of its own, so it can't reach the other lane's server.
{ files: ["e2e/**"], rules: { "no-restricted-syntax": ["error",
  { selector: "Literal[value=/localhost:\\d/], TemplateElement[value.raw=/localhost:\\d/]", message: "Use qaTarget() from the lane helper." }] } }

// The clock, for Playwright: one fixed "today", so a screen's dates match its sample data on any night.
export async function fixClock(page) {
  if (process.env.PHASE_RUN_FAKE_NOW) await page.clock.setFixedTime(new Date(process.env.PHASE_RUN_FAKE_NOW));
}
```

- **Every lane names its own values.** Once one row sets a test prefix, a port named `qa` or an
  `env` key, every row must, or the run refuses to start. The runner hands a lane's values to its
  session and to every gate it runs for that lane, Landing's re-gate included.
- **The helper** is the only place that reads the lane's variables. A test or a script asks it for
  a name or an address, so lane 2 never touches lane 1's databases or server.
- **The lint rule** keeps it that way. It refuses a hard-coded address in a browser script.
- **The clock** reads `PHASE_RUN_FAKE_NOW`, which Brigade reserves and never sets. Your project sets
  it where it starts its browser scripts, to an ISO date, if their screens show dates.
- **Hotspots** are the files every ticket writes at one spot. Landing numbers a `log` entry and
  rebuilds a `generated` index, and it adds an `own-file` block to the end of the file. Any other
  file is left to git. Setup's refresh offers a row when `tools/doc-config.mjs` gains a path.
- **The gotchas file.** A lane writes its block to `.lane/<the file>`. A lane in a phase with no
  gotchas file yet makes the file from the template, without its block. Whichever lane lands first
  keeps its copy. In a lane, doc-check judges the file with the block folded in, so a fault fails
  there, not at Landing.

A mistake in that section stops the run before it starts (dry runs too), and says what is wrong.

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

**The run's own terminal is a table.** One row per finished ticket (its minutes, its cost at API
rates, its commit, any fix rounds) with dim lines under it: where its time went, its size, and
anything left for you. Green is built, yellow built after a fix round, red failed or parked. At the
bottom, redrawn in place: "6 of 10 · 4 after this · 7h31m in · done ≈ 04:20", and the ticket being
built with a plain word for what it is doing (reading, writing, testing, browser, reviewing,
waiting, stop hook, gates). The terminal tab's title follows it, and Windows shows a notification
when the run ends or a ticket fails or parks (`PHASE_RUN_NOTIFY=0` before the command turns that
off). Piped to a file, or with `NO_COLOR`, the run prints plain lines instead. `run.log` is always
plain and keeps every five-minute line. From any other terminal, `node tools/phase-run/status.mjs`
prints the same table, and `status.mjs <ticket>` one ticket's full card.

**The ledger outlives every run.** Each ticket, however it ends, adds one priced row to
`.phase-run/ledger.jsonl` (gitignored): its session, its kind (`night`), the Brigade version that
judged it, its cost by model. `status.mjs --ledger` prints it by week (by kind, by model), and
`status.mjs --csv [file]` writes it as CSV, or prints it. Weeks start on `ledger.weekStarts` in
`.claude/workflow.json` (a lowercase day, `monday` by default). A row that could not be written
says "ledger: not written" in the report. Your own sessions are priced into it too: at the end of
every reply, the plugin's Stop hook adds the session's running total as an `attended` row, at the
plugin's version. It is silent, and `"ledger": { "attended": false }` turns it off.

## Weakening a test on purpose

With `phaseRun.tampering` set, the first gate fails a ticket that adds a skip or focus marker to a
test file, removes more assertions than it adds (past `assertions.maxNetRemoved`), or changes a
`guarded` file or script. When a ticket truly must (a flaky case retired, a test replaced, the test
config changed), write a **test override** in the ticket body before the run, under the heading
your config names (`override.heading`):

```md
## Tests removed or weakened

- `<folder>/old-flow.test.mjs`: replaced by `<folder>/new-flow.test.mjs`; #31 removed the old flow.
```

- One line per path, written as it is in the repo, and why. The path is matched as a whole word, so
  `a.test.mjs.bak` or a bare file name names nothing, and a line with only the path lets nothing
  through: the gate says so.
- The body is read as it was when the run started; an edit during the night counts next run.
- A reason a session writes in its commit message never counts. The gate refuses it, and the
  morning report says the session tried.
- The rules are read from the ticket's base commit, so a ticket can't loosen what judges it, and a
  broken section stops the ticket rather than passing it. No `tampering` section, no gate.

## Before the first night of a phase

1. The phase is grilled, its prototype approved, its spec and tickets published.
2. You ran `/ticket-check <spec>` and answered its questions. The tickets it passed carry the
   `run-ready` label. **The run builds nothing without that label.**
3. `main` is committed and pushed. A run refuses to start a new branch otherwise.

## The evening checklist

1. **What your preflight needs is running** (`phaseRun.preflight`: a database container, say). A
   run checks and refuses to start otherwise.
2. **Nothing of yours is running in the project folder**: no dev server, no QA server, no other
   Claude Code session working there, no editor saving files there. Watching a ticket with
   `claude attach` is fine; it is the same session, not another one.
3. The laptop is plugged in and **will not sleep**: Settings → System → Power → "When plugged in,
   put my device to sleep after" → Never. A sleeping laptop pauses the run.
4. Look first: add `--dry-run` to the command. It lists every ticket and says READY, done, or why
   it is waiting.
5. Start it, without `--dry-run`. Leave the terminal open.
6. **Do not touch the project folder until the report lands.** Nothing protects it during a run. An
   edit, a test run, or a second Claude session in that folder will corrupt the ticket being
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
2. It builds test-first, a `frontend` ticket toward its prototype screen (through Impeccable, in a
   project that uses it). It runs the checks and test files it touches, not the full checks: those
   run once, in the script's own checks (step 6).
3. For a ticket with a screen: a **browser check** on the QA database, with no window opening (the
   browser runs "headless"). It walks the acceptance criteria, fails on any browser error, and
   saves screenshots where `phaseRun.browserCheck` says. Your project's prompt file says how.
4. A `frontend` ticket gets **one design review** against its prototype, if your prompt file names
   one, and one round of fixes.
5. The ticket's docs and **one commit**, then a code review of that commit; what the review finds
   is fixed and folded into the same commit. Each time the session stops, a **stop check** runs
   first (`stopGate.checks`; a slow one can take ten minutes when the ticket changed a file most
   of the app imports) and sends the session back once if one fails. Tests that already passed on
   exactly this code (their receipt) are not run again. The script waits for that check to end
   before it does anything of its own, and its own checks trust no receipt.
6. The script itself then checks, in order: exactly one commit, nothing left uncommitted, an
   implementation log; then the tampering gate and your project's gates (`phaseRun.gates`: typically typecheck, lint and a
   build when the ticket touched what it compiles, side by side, then the whole test suite alone,
   then the browser check's screenshots). The first failure stops the rest; then the docs check. If the ticket added a migration, it is applied to the migration
   target last, once everything else is green.
7. **A check failed:** its output goes back to the same session to fix, up to three times.
8. **All passed:** the branch is pushed and the pull request is updated. Next ticket.

## When a ticket cannot be finished

Two things can set a ticket aside. Either way the run carries on with the next ticket that does not
depend on it.

- **Parked: it needs your decision.** The session hit a question that is yours: a money rule,
  privacy, who may see or do something, a database choice that is hard to undo. The question
  and a recommended answer are a comment on the issue, labelled `needs-info`.
- **Failed.** A check still failed after three fix rounds, or the session ran past its time cap.
  The failing output is a comment on the issue, labelled `ready-for-human`.

Small choices are not parked. A label's wording, an empty-state message, a sort order: the session
takes the option that best fits the spec and the prototype and lists it under **Assumptions made**.
The report gathers these for you to confirm or reverse.

Work on a set-aside ticket is not thrown away. It is kept on a side branch named
`phase-2b-parked-<ticket>`, on your laptop only, and the phase branch goes back to its last good
commit. Tickets that depend on a set-aside one wait.

A run never picks a side branch up again. Putting `run-ready` back makes the next run build the
ticket **from the start**, on top of whatever was built since. When the kept work is good and only
the run's own tooling failed it, bring it over in a normal session
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
   - A 🚨 line if a migration drops or rewrites data on the migration target.
   - **Doc health**: any doc at 90% of its size budget or over, by name, and the whole table folded
     underneath. Nothing to do overnight: the finish ticket trims them, or you raise a limit.
2. **Check the tests on GitHub**: on the pull request, "All checks have passed".
3. **Answer parked questions** on their issues. Then remove `needs-info`, add `run-ready`.
4. **Read the implementation logs** of what was built (`docs/history/implementation-log/`, the newest
   numbers). They are your review of each ticket.
5. **Hand-test**: `git checkout phase-2b`, then run the app as usual. The migration target already
   has the phase's migrations.
6. Something wrong in a built ticket? Fix it in a normal session **on the phase branch**, and commit
   it there on your go-ahead, as today.
7. Tickets left? Run the same command again tonight.

## Finishing a phase

1. Every ticket but the finish ticket is built and hand-tested.
   - If your prompt file has each ticket commit its browser walk, the finish re-runs every one of
     them on the final code.
2. **The finish ticket, with you present**, on the phase branch: the devlog moved into its archive
   (`node tools/doc-rotate.mjs --phase 2b`), the whole-phase finish review, the handbook, this
   module's owner guide, the session handoff, the Artifact pages, the prototype deleted (and, with
   Impeccable, `DESIGN.md`).
3. **Merge the pull request.** On GitHub: open it → **Ready for review** → the arrow beside the
   green button → **Create a merge commit** → **Merge pull request** → Confirm.
   - **Never "Squash and merge" or "Rebase and merge".** Both rewrite the commits. A squash also
     drops each commit's message, and the devlog reads an entry as done only once a commit
     message names it (`devlog #NNN`), so every entry of the phase would read as unfinished.
4. On your laptop: `git checkout main`, then `git pull`.
5. The tickets' issues close by themselves at the merge. **Close the spec issue by hand**, as always.
6. Delete the branch when GitHub offers to. Side branches of parked tickets you no longer need:
   `git branch -D phase-2b-parked-<ticket>`.

## Undoing one ticket

Each ticket is one commit. To undo a ticket after the fact, on the phase branch:

```
git revert <the ticket's commit hash>
```

That adds a new commit which reverses it; nothing is erased. If later tickets were built on top of
it, the revert may conflict: ask in a normal session rather than forcing it. A migration the ticket
applied to the migration target is **not** undone by a revert; it needs a new migration that
reverses it.

## What a run can never do

These are enforced by scripts, not by the session remembering them (Brigade's `guard-shell` hook
and the runner's own checks):

- push anything itself, or commit anywhere but the phase branch; only the runner pushes, and only
  the phase branch;
- touch `main`;
- run a migration against the migration target from inside a session (the runner does it, after
  every check passes);
- wait for a person: anything a session would have to ask permission for is refused at once, and
  it has no way to ask a question;
- edit the runner, the project's config or its own settings (`tools/phase-run/`,
  `.claude/workflow.json`, `.claude/spec-issues.json`, the prompt file, the run's folder under
  `.phase-run/`). Behind that, the run is judged by one frozen copy: at its start the runner copies
  `tools/phase-run/` and `.claude/workflow.json` to `.phase-run/<branch>/runner/`, and the run's
  gates, every ticket's stop check, shell guard, test command, base settings and prompts use the copy. A change to the live
  files made mid-night (by you, or by a shell write) judges the next run, not this one. The run also
  holds to one Brigade version: each ticket's settings switch Brigade's auto-update off (for the
  catalog your project's Claude Code settings enable it from), and the report's header names the version.
  Should it change anyway between two tickets, the run stops before the next one;
- print `.env` into its transcript (`cat`, `head`, `grep` and the like on that file);
- start when GitHub cannot say which tickets wait on which (the runner refuses, and builds nothing
  in a guessed order);
- run a command your project's `guard.block` rows refuse (a formatter that rewrites whole files,
  for example);
- skip a check with `--no-verify`;
- add an attribution trailer to a commit;
- close a spec issue with a "closes" keyword;
- close an issue or open a pull request by hand.

## Symptom → fix

| What you see | What it means | Do this |
|---|---|---|
| "Not ready to run: The working tree has uncommitted changes" | A run starts only from a clean folder | Commit or put away the changes it lists |
| "main and origin/main differ" | `main` on your laptop has commits GitHub doesn't, or the reverse | `git push` (or `git pull`) on `main`, then start again |
| "Not ready to run: .claude/workflow.json: …" | A mistake in the `phaseRun` section (a mistyped key, a bad pattern, a placeholder where it is not allowed) | Fix the line it names, start again |
| At a session's start: "Brigade's hooks can't read .claude/workflow.json: …" | A key this plugin doesn't know (the file is from a newer Brigade), or a mistake outside the `guard` section. Shell commands still run; a run won't start | If the file is newer, update the plugin; otherwise fix the line it names |
| "…until then no shell command runs" | A mistake in the `guard` section itself, or a file that isn't JSON: the guard can't tell what to refuse | Fix the line it names with the Edit tool, which still works |
| "\<a preflight label\> failed" | Something a `phaseRun.preflight` row needs is not running (a database container, say); its hint says what | Start it, start again |
| "Something is listening on :\<port\>" | A dev or QA server from `phaseRun.ports` is still running | Stop it (Ctrl+C in its terminal), start again |
| "A run is already going (or one crashed)" | The lock file from a run is still there | If no run is going, delete `.phase-run/lock` |
| "This branch's last run died, and the runner's code changed since its copy was taken" | A crashed run restarts on its frozen copy, and the runner's `.mjs` files it names changed since (an `/update-workflow`, say) | To finish on the old runner, put the code back; to start fresh on the new one, delete the `.phase-run/<branch>/runner` folder it names |
| "Brigade is not installed for this repo" | `claude plugin list --json` lists no `brigade@…` install for this folder, nor one at user scope | Install Brigade (`/plugin`), start again |
| "Brigade updated mid-run (\<a\> → \<b\>), rerun" | Brigade's version changed between two tickets (an update run in another window, say), so the run stopped before the next one | Start the run again: it carries on under the new version |
| "…its copy was taken under Brigade \<a\>, and \<b\> is installed now" | A crashed run would restart under another Brigade version | Put Brigade \<a\> back to finish on it, or delete the `.phase-run/<branch>/runner` folder it names |
| "Brigade's auto-update was not switched off for this run" | Your project's Claude Code settings have no `brigade@…` entry in `enabledPlugins`, or no `extraKnownMarketplaces` entry for its catalog | Nothing, for this run: a version change still stops it. To fix, re-run `/setup-workflow` |
| "…runs here have used \<another host\> as \<the migration target\>" | The migration target's address changed since the first run | If you meant to change it, delete `.phase-run/migration-target`; if not, fix the address |
| Every ticket says "not labelled run-ready" | `/ticket-check` has not passed them | Run `/ticket-check <spec>` |
| A ticket says "waiting on #N" | A ticket it depends on is not built yet, or was set aside | Answer or fix `#N` first |
| "Could not read from GitHub which tickets #N waits on" | GitHub did not answer three times in a row, so the order of tickets is unknown | Nothing was started. `gh auth status`, check the connection, start again |
| A ticket failed on one of your gates (its `label` names it) | That gate's command failed on the ticket's change, three fix rounds running | Read the output on the issue |
| A ticket failed on "browser check" | A ticket that changes a screen has fewer screenshots than `phaseRun.browserCheck.minimum` taken **after its last source edit** (a fix after the walk means walking again) | The session did not walk the amended code, even when sent back. Look at the kept branch; try the ticket again, or build it attended |
| A ticket failed on its test suite with duplicate-row errors or a "deadlock detected" | Two test runs shared one test database | Name your test runner in `phaseRun.strayProcess` and mark the suite's gate `alone`: the script then stops a run left behind first. If it shows anyway, something else ran tests in this folder. The ticket's own code is likely fine: look at the kept branch before rebuilding it |
| "Stopped a \<strayProcess\> process left going…" in the terminal | A session was stopped while its tests were still running, and the script ended them so the next suite has the database to itself | Nothing |
| The report says a ticket "ran past the cap" | The session got stuck or the ticket is too big. Or it had finished and was still listed as working: a turn that has ended with its verdict written is taken as done after two minutes, and `run.log` says "still listed as working" when that happens | Read the kept branch. If its commit carries `Closes #N` and the verdict says "built", the work is done: land it by hand. Otherwise split the ticket, or raise `--minutes` |
| `claude agents` still lists last night's tickets | Finished sessions are kept, stopped, so you can read them | Nothing. `claude rm <id>` removes one |
| "Could not send #N's next instruction to its session" in the terminal | Claude Code would not wake the ticket's session for a fix round | Nothing at once: the ticket ends up under **Failed**, its work kept on the side branch, and the run goes on. If every ticket does this, add `--print` |
| "Claude Code would not list its background sessions" | Its background service is not running yet, or the installed Claude Code is too old for background sessions | Open `claude agents` once in a second terminal, then start again. Still failing: `claude update`, or add `--print` |
| The report lists "Commands the session was refused" | The session wanted a command its allowlist lacks. The list allows the common read-only tools and deletes under `.phase-run/tmp/`, and the prompt forbids redirects and `cd … &&` chains, the shapes that were refused most | A redirect or a chain: nothing (the prompt already says no). A reasonable new command: add it to `phaseRun.permissions.allow` (only this project needs it) or to `tools/phase-run/settings.json` (every project would) |
| "The session's turn was cut off … Resuming it" in the terminal | The API dropped the session's turn mid-response ("Connection lost"). The same session is told to carry on; it is not a fix round | Nothing. After three in one call the turn goes to the checks as before |
| A ticket failed on "commit" ("No commit was made") right after "Connection lost" in its session | A dropped turn was taken as finished | Should not happen now that a dropped turn is resumed. If it does, the fix rounds absorb it; check the kept branch |
| `run.log` stopped growing, no "Run finished", the lock file left | The runner died in the night | `claude agents`: stop any `ticket-…` session still working. Read `.phase-run/<branch>/results.json` and the newest `report-*.md` there (rewritten after every ticket). Then follow "If you stopped a run" below |
| "a phase-run session never stashes" | A session tried `git stash` | Nothing: it was refused, and the session commits or deletes instead |
| "The push failed" in the report | Usually the network, or GitHub sign-in expired | `gh auth status`; then `git push -u origin phase-2b` by hand |
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
  goes out with the next ticket's push, or by hand: `git push -u origin phase-2b`.
- The report is always saved on the laptop too, in `.phase-run/<branch>/`, in case it could not be
  posted on the pull request.

A run will not start without a connection: it says "No internet connection".

## If you stopped a run (Ctrl+C), or the laptop shut down

Ctrl+C stops the ticket's session too (the run does that on its way out). After a power cut or a
closed terminal, check with `claude agents`: if a `ticket-…` session still shows as working, stop
it with `claude stop <id>` before anything else.

The ticket that was being built is half-done in the folder. In a normal Claude session, say: "a
phase run was interrupted on `phase-2b`; look at `git status` and the last lines of
`.phase-run/phase-2b/run.log`, and tell me what state it is in." The usual answer: discard the
half-built ticket's changes (after you agree), delete `.phase-run/lock`, and start the run again; it
picks the same ticket up from the beginning. Tickets already pushed are safe.

**What survives a dead run.** Every finished ticket's result is in
`.phase-run/<branch>/results.json`, and the night's report file in that folder is rewritten after
each ticket, so it is current to the last one finished. The next run's report starts with the dead
run's results under "From an earlier run that stopped before writing its report", and the pull
request's body lists every ticket built on the branch, whichever night built it.

**A stash.** Once, a restarted session found a `git stash` left by the dead one and applied it.
Sessions can no longer stash (Brigade's `guard-shell` hook). If `git stash list` shows one anyway, do not apply
it blindly: ask in a normal session what it holds.

## What it costs

Each ticket is a long Claude session, and a night is several. The report opens with a
**Scoreboard**: each ticket's minutes split into Claude (the model's own work, what is left after
every measured wait), tests, checks, browser, slept, reviews, the stop hook and the gates; its cost
at API rates; its peak context; and its size. The cost is read from the session's transcript and
priced with `tools/phase-run/prices.json`: what the same tokens would cost on the pay-as-you-go
API, a gauge of your plan's allowance, not a bill. Most of a ticket's cost is the model re-reading
its own growing conversation, so a long ticket costs more per step. "Slept" should stay near zero;
size beside cost is what you retune `phaseRun.ticketSize` from. What you do spend is your plan's
usage allowance, and a long night can reach its limit. When that
happens the run is meant to wait and resume by itself, up to `--wait-hours`; that has never
happened in a real run, so treat it as unproven.

**Trim: lighter night sessions.** Every night session loads what this machine has installed:
plugins, skills, MCP servers. A trim list, `~/.claude/brigade/trim.json` (under `CLAUDE_CONFIG_DIR`
when that is set), names what night sessions start without:

```json
{ "plugins": ["<name>@<catalog>"], "skills": ["<skill name>"], "flags": ["--strict-mcp-config", "--no-chrome"] }
```

- Plugin ids are as `claude plugin list` prints them, skills by the name a session lists. Only those
  two flags are accepted: `--strict-mcp-config` drops every MCP server, your project's own
  `.mcp.json` ones too (leave it out if your nights need them), and `--no-chrome` the browser
  extension's tools.
- Night sessions only: your own sessions load everything. A `brigade@…` row is refused, since it
  would switch off the night's own hooks, and a missing file means no trim.
- A project never loses what it enables: a plugin its own Claude Code settings turn on, a skill in
  its `.claude/skills/`, and what its `phaseRun.keep` names (`{ "plugins", "skills" }`), for a user
  skill one project's nights need. Keep the skills the run's prompts call (`tdd`, `code-review`)
  off the list; Brigade's own skills can't be listed.
- A list the runner refuses stops the run at preflight. On one machine, trim took a night session's
  first prompt from 37K to 46K tokens down to 31K (113 skills to 64, three MCP servers to none).
