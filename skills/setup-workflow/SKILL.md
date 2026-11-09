---
name: setup-workflow
description: Set a repo up on the Brigade workflow, new or existing, or refresh a set-up repo's config after its stack changed. Use when the owner types /setup-workflow. Reads the stack from the discovery doc and the files, asks overwrite or merge for an existing repo, shows every file it will write or move, writes them after a yes, and stops before the commit.
disable-model-invocation: true
argument-hint: "[--settings <path>]  (a copy of ~/.claude/settings.json, for a trial)"
---

Setup does the same file work every time, so a script does it:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs"` (its header lists the commands). Your part is the
talking: what the owner wants, what the stack really is, and a yes before anything is written. The
owner is a new graduate: say what each choice changes for them, in plain words.

Work files (answers, plan, previews) go in `.git/brigade/` inside the project: never committed,
never in `git status`. `<dir>` below is the project's root (`CLAUDE_PROJECT_DIR`).

## 1. Look

1. Not a git repo: offer `git init -b main` (it is needed for the rest); stop if declined.
2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" detect <dir>`. Read all of it.
3. `stamp` set: this project is already set up. Offer the two things that keep it current and do
   the one the owner picks: **update the template** (`/update-workflow`, after a plugin update) or
   **refresh the config from the stack** (§8, after the stack changed or the app grew: Phase 0 added
   `package.json`, a database, screens). Then stop.
4. `brigadeEnabled` false: Brigade is not installed at project scope here. Say how
   (`claude plugin install brigade@<marketplace> --scope project`) and stop: the hooks would not run.

## 2. Pick the mode

- `empty` true → **new**. Nothing to ask.
- Otherwise ask (AskUserQuestion), with what each does to *this* repo (name its files):
  - **Merge** (recommended for a repo with history worth keeping): never overwrites a file. Adds the
    workflow's files beside the project's; appends the workflow's sections to `CLAUDE.md` and
    `.phase-run/` to `.gitignore`, each shown as a diff first; accepts today's docs as they are
    (`doc-check --adopt` lists those without a header, and the list only shrinks).
  - **Overwrite** (a clean slate): on a new branch `adopt-workflow`, moves `docs/`, `CLAUDE.md`,
    `AGENTS.md`, `GLOSSARY.md` (or its older name, `CONTEXT.md`) and a `.claude/settings.json` with more than the plugin keys into
    `docs/history/pre-workflow/` (moved, never deleted), then writes the workflow's files fresh.
- A dirty tree (`git.dirty` not empty) blocks either: list the files and stop until the owner
  commits or stashes them. The plugin install's own `.claude/settings.json` change does not count.

## 3. Confirm the stack, then the config

**The stack first.** detect gives `discoveryStack` (the newest discovery doc's "Requirements and
stack" table, already parsed: only its decided rows), `stackFromFiles` (what `package.json`, the
lockfile and a Prisma schema show) and `stackDisagreements` (where they name different things).
Show the owner both, side by side, and ask only: each disagreement (which is right?), and each part
neither names (decided yet? "undecided" is fine: it stays out of `stack`). The answer is the
`stack` in the proposed config: keys `language`, `framework`, `packageManager`, `database`,
`migrations`, `testDatabase`, `storage`, `other` (a list), any words for the values. After setup
this config is the stack's truth; discovery is not read again.

`node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" propose <dir>` gives the `.claude/workflow.json` the
stack suggests: the stop gate's checks and the phase run's gates from the `package.json` scripts that
exist, `stack`, the guard's `wrappers` and the allow rules for the package manager. Never guess
silently: show the owner what was detected and the proposed gates, and ask in one batch:

- the project's **name** and a **one-paragraph summary** (for `CLAUDE.md`);
- are these **gates** right (add, drop, reorder). A repo without `package.json` but with Node test
  files directly in a top-level `test/` or `tests/` folder (detect's `nodeTests`) gets them
  proposed as the tests row, e.g. `node --test tests/*.test.mjs`; any other repo with no scripts
  names its own. Never a bare `node --test`: in a set-up project it also runs the template's
  `tools/*.test.mjs` in every gate;
- **a migration target**: off unless the owner names one. A phase run applies migrations to it, so
  it must be a shared development database, never production; if named, fill `phaseRun.migrations`
  from `template/docs/guides/phase-run.md`'s "What your config sets";
- **a browser check** for a frontend: off unless the owner wants it (`phaseRun.browserCheck`);
- **does it have screens?** (default: yes when `frontend` is not empty; ask on an empty repo). A
  project with screens gets the design rung (`docs/agents/workflow.md`): the prompt file with its
  design review (`docs/agents/phase-run-prompt.md`, named by `phaseRun.prompt`) and
- **its prototype folder**, inside the app, so prototypes run in the real shell: show
  `prototypeDir` from detect (a route group where the framework has them: `src/app/(prototype)` for
  Next's app router, `src/routes/(prototype)` for SvelteKit, `pages/prototype` for Nuxt,
  `src/prototype` for a plain React app). When it is null, ask; "not yet" is a fine answer, set
  later in `tools/doc-config.mjs`'s `PROTOTYPE_DIR`;
- merge only: the project's **docs to treat as living** (default: the `.md` files directly under
  `docs/`) and its **code folders** for the path check (default: `topFolders`).

**Then walk the stack, part by part.** Brigade ships no per-tool recipe (`docs/adr/0001` in the
plugin): you write the config each part needs, from the owner's answers and
`template/docs/guides/phase-run.md`'s "What your config sets", and the loaders check it.
- **packageManager**: the `guard.wrappers` and allow rules `propose` gave (check them against it).
- **database**: a QA database for sessions (`phaseRun.qa`, never the real one) and, only if the owner
  names a shared development database, `phaseRun.migrations` with its target.
- **testDatabase**: detect's `compose` lists the root's compose files (`compose.yaml`,
  `compose.yml`, `docker-compose.yml`, `docker-compose.yaml`, the first being the one
  `docker compose` runs), each service as a line (`db: postgres:16, 5432`), or `error` ("could not
  read: …", with the line: Brigade's small reader's limit, not Docker's).
  - **A compose file found**, read or not: show its lines and its `skipped` (or its error), and ask
    which service is the test database (a file it could not read: ask for the service and its port
    by hand). An override file beside it (`compose.override.yaml`) is merged by `docker compose` but
    not read here: if there is one, ask whether it changes the database's port. None of
    them is: the owner adds one to their own file. Reuse the file: **never write a second one**, and
    never edit it. Propose a `phaseRun.preflight` row,
    `docker compose up -d --wait`, with the hint "Is Docker running? Or another project's container
    holds the port: stop it, or give this one another port in its compose file." The service's
    port goes in the address sessions use (`phaseRun.qa`'s `url`, or the `sessionEnv` variable
    that holds it), **never in `phaseRun.ports`**: that list must be free before a run, and the
    runner checks it right after preflight starts the database, so it would refuse every run.
  - **None**: ask where the test database runs, as before. If in Docker, write
    `docker-compose.yml` for it (the image, a port, a volume) and the same preflight row and
    address.
  Either way, then §6's Docker check.
- **storage**: keep sessions off the real bucket: `phaseRun.sessionEnv` pins its variables to a test
  bucket or a dummy value.
- **framework**: the prototype folder (above), and whether the build is a gate.
- **other**: each service's live keys stay out of sessions the same way (`sessionEnv`).
- **the test script**: it names the project's own tests (`node --test test/*.test.js`, `vitest run
  src`), never a bare `node --test`, which also finds Brigade's `tools/*.test.mjs` and runs them in
  every gate.

**Then the project's own tools** (D17, D18). `propose` writes no tool-specific keys, so ask about
each, and write what the owner's tools really support: the guide's "What your config sets" has one
project's rows as worked examples, never defaults. Check a flag in the tool's own docs or `--help`
before writing it.
- **names**: a stop check that gets its own receipt also gets a `name` (`typecheck`, `lint`,
  `tests`). A name is lowercase (`^[a-z0-9][a-z0-9_-]*$`), unique, and never `test`. Rows without a
  name share one receipt file, so one `unread` list. A flag goes after the suggested command
  (`pnpm lint --cache`, not a rewritten one), so refresh still knows the named row.
- **the test runner's changed-only command**, with `{base}` (Vitest's `--changed {base}`, say), on
  the tests stop check; the suite gate keeps the whole suite unless the owner says otherwise. A
  runner without one runs the suite. A check with `{base}` is left out of `checks.yml` (CI has no
  base commit), so CI then needs its own suite step.
- **tampering** (`phaseRun.tampering`): the test files' globs (`testFiles`), the runner's skip and
  focus markers as patterns (`markers`), its assertion call (`assertions`, with `maxNetRemoved`),
  `guarded` (the test config, `.claude/workflow.json`), and an `override.heading`. No section, no gate.
- **the build**: which paths feed it (the build gate's `when`), and whether typecheck reads its
  output (the typecheck gate's `after: "build"`). A gate given `after` also gets the waited-on
  gate's `when` and `unreadOf`, so the two skip together.
- **fresh caches and unread lists**: each tool's fresh-cache flag pointing into `{cache}` (gates
  only), and each stop check's `unread` list (typecheck and lint rarely read `**/*.md`).
- **lint and typecheck hygiene**, in the project's own configs, each a yes: the linter ignores what
  git ignores; typecheck leaves out scratch folders like `.phase-run`; an empty catch needs a
  reason; tool scripts are checked for undefined names; the lint cache is gitignored.

**Then two lanes** (0.7.0 D4, D7, D8, D15, D16), off unless the owner says yes. A second lane builds a
ticket beside the first, in its own worktree with its own ports and databases, so a night that waits
on a browser isn't one ticket at a time. `plan` always proposes them (its `proposed`, and "Two lanes,
proposed" in its summary). Show the owner what it proposes and ask yes or no; a no writes nothing:
- the lane rows: lane 1 takes any ticket, and lane 2 takes only tickets with its label. Each
  worktree is at `../<repo folder>-lanes/lane-<id>`, beside the repo;
- `worktreeSetup`: the untracked files a fresh worktree lacks (`copy`), the install and any code
  generation (`commands`), and what they must leave (`leaves`);
- the first hotspot rows, from `tools/doc-config.mjs`'s paths: the devlog and the implementation
  logs as `log`, the generated indexes as `generated`, and the gotchas file as `own-file`. Every
  other file is left to git.

On a yes, ask which label lane 2 takes (`docs`, say, or the project's walk label; never `any`), and
make sure §6 creates it. Then walk the stack for lanes. Ask these three only with lanes on:
- **the test prefix**: how do the project's tests name their test databases, and how will they read
  `PHASE_RUN_TEST_DB_PREFIX`? Lane 2's row gets a `testDbPrefix` (`lane2_`, say); lane 1's may leave
  it out.
- **the browser scripts' QA address**: how do they read `PHASE_RUN_QA_PORT` and
  `PHASE_RUN_QA_DATABASE`? With `phaseRun.qa` set, lane 2's row gets its own `qa` database and a port
  named `qa` in its `ports`.
- **the date**: do the browser scripts depend on today's date? Brigade reserves `PHASE_RUN_FAKE_NOW`
  for a project's own fake clock, and the runner never sets it.

Write each answer into the project's own tools: a small helper, a lint rule, a clock. Never use a
file Brigade ships for this; the guide's "Two lanes" part has worked examples, never defaults. The
lane values go in `answers.workflow`'s `phaseRun.lanes`, starting from `proposed` (a section there is
kept as written), and the yes is `"lanes": { "takes": "<label>" }`.

Write the answers to `.git/brigade/answers.json`:
`{ "mode", "name", "summary", "workflow", "frontend"?, "prototypeDir"?, "pathRoots"?, "liveDocs"?, "lanes"? }`.

## 4. Show the plan, then write

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" plan <dir> --answers .git/brigade/answers.json --out .git/brigade/plan.json --preview .git/brigade/preview`
   prints what it would move, write, change and leave alone. A "Cannot go ahead" list: fix that first.
2. Show the owner the whole summary. For each "Changed" file, show the real diff:
   `git diff --no-index -- <file> .git/brigade/preview/<file>`. For each "Left alone" conflict, say
   that the project keeps its own file and what the workflow's version would have added. In merge,
   read the "same job" list out: the project's roadmap or handoff stays where it is, and the
   workflow's starts empty beside it; the owner moves content over when they like. Say two more
   things where they apply: `.github/workflows/checks.yml` runs the stop gate's checks on GitHub
   (the project's own from then on: edit it when the checks change), and a `CLAUDE.md` one folder
   down (`docs/CLAUDE.md`) gets a "read it first" line in the new top-level `CLAUDE.md`, as Claude
   reads a nested one only when it works in that folder. And `.claude/settings.json` turns on
   auto-update for Brigade's catalog, so a new release reaches the project by itself; it is
   committed, so collaborators get it too. A file a rewrite would reformat is left alone and listed
   under "by hand".
3. Ask for a yes on that exact list. Then
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply <dir> --plan .git/brigade/plan.json`.
   It refuses if the repo changed since the plan: plan again and show it again.
4. If `apply` stops partway (an error after it began writing), the tree was clean before it, so the
   way back is `git reset --hard` and `git clean -fd`; overwrite mode then `git switch` back and
   delete `adopt-workflow`. Ask before running either: `git clean -fd` also removes an untracked
   `.claude/settings.json`, so commit the plugin install first.

## 5. Overwrite only: carry the old rules over

Read each file `apply` lists under `oldRules`: the project's `CLAUDE.md` and `AGENTS.md`, top-level or
one folder down, at their archived paths (a `docs/CLAUDE.md` is at
`docs/history/pre-workflow/docs/CLAUDE.md`). List each real rule it holds (a "never",
an "always", a command that must be used, a fact a session must know). Ask about them a few at a
time (AskUserQuestion, up to 4 per call: keep as is, reword, drop), and write the kept ones under
`CLAUDE.md`'s "This project's rules", one line each. Never drop one without asking.

An old glossary (`oldGlossary`: a `GLOSSARY.md`, or a `CONTEXT.md` from before 0.3.0) is handled the
same way: list its terms, ask which to keep, and write the kept ones into a new `GLOSSARY.md` in
the `domain-modeling` skill's format.

## 6. The rest of the setup

Ask before each; the owner may skip any.

- **Labels.** `gh label list --json name --jq '.[].name'`, against
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" labels`, plus the label lane 2 takes when lanes are on. Create only the missing ones
  (`gh label create <name> --color <color> --description "<description>"`), never edit an existing
  one. The triage labels and `docs/agents/issue-tracker.md` come from `/setup-matt-pocock-skills`:
  mention it.
- **Impeccable**, if `frontend` is not empty: offer it (a design skill for frontend work). On a yes:
  `claude plugin install impeccable@impeccable --scope project` (if that marketplace is unknown,
  `claude plugin marketplace add pbakaus/impeccable` first). Never copy its files into the repo.
- **Docker**, if the test database runs in it: `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" docker`.
  Running: say so. Not installed, or installed but not running: explain in two sentences what it is
  ("Docker runs the test database in a small sealed box on your machine, so tests never touch real
  data. Brigade starts it before each phase run and needs Docker Desktop running for that."), give
  its `help` link to install Docker Desktop, and how to check it works (`docker info`). Never install
  it yourself.
- **autoMode lines.** Auto mode reads trusted infrastructure only from the user's own settings, so
  each project adds its lines there. Draft them, one per topic that applies, each
  `**Project <absolute path> — <topic>**: <one line>`: what it is (and whether its repo is private),
  cloud and secrets (where they are kept, by name only, never a value), key internal services,
  branches (protected or not), sensitive data, protected environments, routine work (the commands
  run under that path). Write them to `.git/brigade/automode.json` (a JSON list) and run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" automode --settings <settings> --lines .git/brigade/automode.json`.
  `<settings>` is the path in this skill's arguments if one was given (a trial), else
  `~/.claude/settings.json`. Show the lines added and removed; on a yes run it again with `--apply`
  (it refuses a file it would reformat; then give the lines to paste), and show
  `claude auto-mode config`. Other projects' lines are never changed.

## 7. Check, and stop

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" verify <dir>`: doc-check, the template's two test
   suites, and the config through both loaders. A failure: fix it (in the config, or a doc's line),
   never by loosening a check. A `warn` line is the listed-code rule's scan (0.7.0 D11): each path a
   test file (`phaseRun.tampering.testFiles`) names that a row's `unread` list leaves out. The rule
   puts it back, so a change there voids that check's receipt and its suite skip. With no
   `testFiles` it is one line: there is no listed-code rule. Say each line. It never fails.
2. Show `git status --short` and the drafted commit message:
   `chore: adopt the workflow (<mode> mode) — devlog #1`. Overwrite mode is on `adopt-workflow`: the
   owner merges it as any branch.
3. **Stop.** Setup never commits; the owner says when. Tell the owner the next steps: commit, then
   grill the first phase (`docs/agents/workflow.md`).

Known limit, to say if it applies: same-job docs are reported, never merged.

## 8. Refresh: the config after the stack changes

On a project already set up (§1.3), when the owner picks the refresh:

1. Ask what changed ("you added storage", "Phase 0 added `package.json`", "we moved to another
   host"), and write the stack as it now is to `.git/brigade/stack.json` (the config's `stack` with
   the change; an undecided part left out). Nothing changed in the stack itself (only the app grew):
   skip `--stack`.
2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" refresh <dir> --stack .git/brigade/stack.json`:
   a report, nothing written. Its items:
   - `set`: the stack itself; `add`: what the stack suggests and the config lacks. Both are written.
   - `change`, `remove`: a row the stack would not suggest, a changed file (`checks.yml`), an older
     `CLAUDE.md`'s missing Stack section. **Never written unless the owner says yes**, item by item
     (AskUserQuestion, up to 4 per call). A hand-written row is kept by default.
   - `offer`: keys a newer release gives a row the stack suggests (a check's `name`, its own
     `receipt` and `unread` list, a gate's `unreadOf`), one item per row. Asked and written the same
     way as `change`. On a project with `phaseRun.hotspots`, each path `tools/doc-config.mjs` has
     gained since (a new generated index, say) is one offer too. A row the owner wrote, for that path
     or over it, is never changed.
   - A row is matched by its exact `run`, or, when it has a name (a stop check's `name`, a gate's
     `label`), by the suggested command with flags added after it: a named row that gained a cache
     flag is still its row, never added back plain or offered for removal. A nameless stop check is
     matched by its `run` alone, and a command the stack no longer suggests (another package
     manager) is a stranger whatever its name.
   - `warnings`: the listed-code rule's scan, as in §7, and a doc-config that will not load (no
     hotspot row can be checked). Say each; none is an item.
3. Run it again with `--apply` and `--accept <the ids the owner said yes to>`. It writes, regenerates
   the indexes (the Stack block in `CLAUDE.md` follows), and stages.
4. Walk §3's checklist for the parts that changed (a new database: its QA database; a new test
   database in Docker: compose and the Docker check). The report's `compose` is detect's: a project
   that gained a compose file, with no `docker compose up` row in `phaseRun.preflight` yet, gets
   §3's testDatabase step for it (the file reused, never a second; the port in `phaseRun.qa`, never
   `phaseRun.ports`). Then its project's-own-tools items for any key
   the config still lacks (a name, `{base}`, tampering, `when` and `after`, `{cache}`, an `unread`
   list, each hygiene piece): one yes each, a hand-written row kept as it is. Then `verify`.
5. Remind the owner to record why in a dated addendum at the top of the discovery doc it came from
   ("> **Addendum YYYY-MM-DD:** storage is Cloudflare R2. **Changes:** Requirements and stack."),
   and draft `chore: refresh the config from the stack — devlog #N`. **Stop** before the commit.
