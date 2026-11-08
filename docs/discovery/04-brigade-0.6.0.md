# Discovery: Brigade 0.6.0, measure and trim

**Rounds:** 2026-11-08. One grill with the owner, to port a runner upgrade one real project built
and verified on its own runner ("2a, measure and trim": its spec 295, merged in its pull request 307,
195 runner tests, proven on a real night). What 2a does, and why, was settled there and is not
re-decided here. This grill settled only how each piece fits a plugin that any repo adopts.
**Status:** decided, not built. **Build timing:** only after the source project's first real night
after its pull request 307, so a bug isn't ported into every project.

**Sources.** These are the source project's runner-upgrades discovery doc at commit 0679616:
- §18, 2a as built, one block per ticket, with its porting order in §18.2;
- §17, its decisions RU-D1 to RU-D38;
- §19, its later decisions, including RU-D39;
- its ADRs on gates that trust no receipt and on the frozen runner snapshot;
- its runner glossary;
- its 2a gotchas.

The full pinned link goes in the spec issue, not here, because Brigade's docs name no one project
(`tests/no-project-specifics`). Numbers written "source #N" below are that project's issues, not
Brigade's.

Like any discovery doc, this one is never rewritten: a later fact is added as a dated addendum at
the top.

## Goals

1. **A night costs what it costs, on record.** Every session, night and attended, leaves a priced
   row in a ledger, so a change to the runner can be measured.
2. **The stop check skips what can't have changed.** Each check keeps its own receipt, so docs
   written after the tests no longer void the test receipt. The source project went from about
   7 minutes a ticket to 0.3 s.
3. **The gates run side by side and skip what can't matter.** They still trust no receipt.
4. **One run is judged by one frozen judge.** That means one copy of the runner and its config, and
   one Brigade version.
5. **A night session starts lighter.** In the source project, trimming unused plugins and skills
   took a first prompt from 57,794 to 46,119 tokens.
6. Every rule a project owns is data in `workflow.json` or a per-machine file, never a site's
   numbers in code.

## Problems (what happens today)

| Problem | Today |
|---|---|
| Cost is per run, then lost | `metrics.mjs` prices a ticket into `results.json`; nothing collects across runs, and attended sessions are never priced. The price list has one cache-write rate and a Haiku row |
| One shared unread list | `stopGate.checks[].unread` must be the same on every receipt row (`sharedUnread`), and only the tests row has one. Typecheck and lint rerun on every stop |
| Gates one after another | `projectGates` runs each gate in turn; the full suite runs even on a docs-only diff |
| The judge can change mid-night | Hooks and config are read live. A plugin auto-update between two tickets would judge the rest of the night by other rules |
| Nothing catches a weakened test | A session could skip or delete tests; only review would notice |
| Every session loads everything | Each night session starts with every installed plugin, skill and MCP server |

## Requirements and stack

Node only, no dependencies, as before. The facts it builds on:
- **Auto-update timing, per Claude Code's docs (03).** It runs after the first message of a
  session, and says `Plugin updated: <name> · Run /reload-plugins to apply`. So a session keeps the
  version it started with, and the next session gets the new one.
- **Settings merge.** A `--settings` file wins over the project's settings, merged object by object.
- **Hook paths.** Brigade's hooks run from `${CLAUDE_PLUGIN_ROOT}`, one folder per version, and
  find the project with `CLAUDE_PROJECT_DIR`.
- **Where the port goes.** The root `tools/phase-run/` is the pinned released runner
  (development.md item 13), so the port goes into `template/tools/phase-run/`.

## Decisions

**Measuring**

1. **Pricing.** The price list gets five rates per model: `input`, `cacheWrite5m`, `cacheWrite1h`,
   `cacheRead` and `output`. It also gets an optional `above` tier for large requests, and
   `fallback: claude-opus-5-5`.
   - `loadPrices` refuses a row missing a rate.
   - `sessionCost` prices a transcript and its subagents per request. `sessionCostFrom` does the
     same incrementally.
   - **Only Opus 5.5, Sonnet 5.5 and Fable 5.1 are listed. Never Haiku** (the source's RU-D39, the
     owner's rule), so today's Haiku row is deleted.
2. **The ledger lives per project.** It is `.phase-run/ledger.jsonl`, gitignored, with one row per
   session reading.
   - The runner writes night rows. Each row carries a `brigade` version field.
   - A new top-level `ledger` section in `workflow.json` holds `attended` and `weekStarts`.
   - The views are `status --ledger` and `--csv`.
3. **The attended ledger hook.** It is a Stop group in the plugin's `hooks/hooks.json`.
   - **When it records:** it is on wherever `.claude/workflow.json` exists, and does nothing
     elsewhere. `ledger.attended: false` turns it off.
   - **Fail-open:** it always exits 0, prints nothing, and is inert when `PHASE_RUN=1`.
   - **Its code:** it uses the plugin's own pricing code and price list, as `version-check.mjs`
     imports plugin-local scripts, so it works while a project is out of step.
4. **Names.** The source's own `*_PHASE_*` variables become `PHASE_RUN_*`.
   - Kept: `PHASE_RUN`, `PHASE_RUN_TICKET` and `PHASE_RUN_BASE`.
   - Added: `PHASE_RUN_SPEC`, `PHASE_RUN_ROOT`, `PHASE_RUN_RUNNER`, `PHASE_RUN_NET_HOSTS` and
     `PHASE_RUN_NOTIFY`.

**The night's judge**

5. **A probe comes first**, attended, on Opus, against the *installed* plugin enabled at project
   scope. `--plugin-dir` would load Brigade regardless and prove nothing. Under the night's real
   flags (`--settings` carrying trim's `enabledPlugins` and `skillOverrides`,
   `--strict-mcp-config`, `--no-chrome`) it answers three questions:
   - (a) do Brigade's hooks fire, and do its skills list?
   - (b) when does Claude Code apply a plugin auto-update, seen live?
   - (c) can `--settings` switch `autoUpdate` off for one session? This is checked on the merged
     result, not just the flag.

   The snapshot ticket is designed on the answers.
6. **No `--setting-sources user,local`.** The source project needed it because its hooks are
   project hooks, and the snapshot's copies would otherwise run beside the live ones. That flag
   also dropped its project skills, hence its skills plugin.
   - Brigade's hooks are plugin hooks, so neither problem exists here.
   - The night keeps loading the project's settings, and the skills plugin isn't ported.
7. **The runner snapshot** copies `tools/phase-run/` and `.claude/workflow.json` at run start.
   - It keeps the source's manifest, its reuse of the copy when a died run restarts, and its
     refusal when the runner code changed.
   - The runner sets `PHASE_RUN_RUNNER=<copy>` in each ticket's settings. While it is set, the
     plugin hooks read the copy's `workflow.json` and import the copy's runner code. Attended, they
     read the live tree.
   - The session's own check command runs from the copy too. Otherwise it would write receipts with
     live code that the hook judges with the copy's.
8. **One run, one Brigade version** (the owner's idea).
   - **The deferral:** night `--settings` switch off `autoUpdate` for Brigade's catalog, so an
     update waits for the owner's next fresh session. The override carries the catalog entry's
     other keys (`source`).
   - **The backstop:** the run-start version goes in the snapshot manifest. If a ticket would
     launch under a different one, for example after an attended session in another window updated
     Brigade, the run stops cleanly with "Brigade updated mid-run (a → b), rerun".
   - **Where it shows:** the version is in the morning report's header and on every ledger row.
   - This doesn't contradict 03's out of scope: that was a project out of step with its stamp, and
     this is the judge changing during one run.
9. **Projects keep the Edit deny** on `tools/phase-run/**` and `.claude/workflow.json`.
   - In a project, the runner is Brigade's stamped copy, not the project's work. The source's
     nights edit their own runner, which is why it lifted that deny.
   - The snapshot is a backstop against shell writes, the owner's edits and an update mid-night.
   - So the source's runner-test gate (source #295's row) isn't ported, nor its "runner tests run
     instead" step. Brigade's own repo already always runs its template runner tests.

**Stop checks**

10. **Per-check receipts.** The key stays `unread`, on each row. The rule that receipt rows share
    one list is dropped.
    - Any row may carry `receipt: true`, and an optional `name`. Its receipt file is
      `.phase-run/<name>-receipt-<ticket>.json`; a nameless row keeps today's
      `test-receipt-<ticket>.json`.
    - One JS matcher replaces git's `:(glob)`, with the same rules: `*` stays inside one folder,
      `**/` crosses folders, and a leading `!` puts a path back. Today's lists keep their meaning.
    - Each check's key is the tree minus its own list, all built from one `git add -A` into a
      temporary index.
    - The gates trust no receipt (ADR 0003, ADR 0004).
11. **Projects already set up get offers, not a migration.** Old files stay valid, so `MIGRATIONS`
    stays empty.
    - `/update-workflow` ends with a refresh dry run and lists what refresh would add: `receipt`
      and `unread: ["**/*.md"]` on typecheck and lint, `name`s, and `unreadOf` on the suite gate.
      It then walks D17's and D18's checklist items for the project's own tools (`after`,
      `{cache}`, the tampering rows), as refresh's step 4 walks the checklist today.
    - Each is a yes per row, and hand-written rows are kept. Refresh's diff learns new keys on an
      existing row, because today it compares rows by `run` only.
    - While a project is out of step (a 0.6.0 hook beside a 0.5.x `receipt.mjs`), the hook falls
      back to 0.5.2's one-receipt behaviour.

**Gates**

12. **Side by side.** Gates run in parallel by default.
    - `after: "<gate label>"` makes a gate wait until that gate has passed: build, then typecheck,
      on Next.js.
    - `alone: true` now means the gate runs by itself after the parallel group, with strays stopped
      first. A suite that owns ports or a database needs this.
    - The first failure stops the rest: the runner kills the process tree and waits for every job.
    - The tampering check runs first. Browser-check and migrations stay last.
13. **Suite skip.** A gate's `unreadOf: "<stop check name>"` skips that gate when the diff is
    non-empty and wholly on that check's `unread` list. There is one list and one matcher, and an
    `unreadOf` naming no check is refused.
14. **Fresh caches.** Gate commands may use `{cache}`, which points at a folder the runner empties
    before each gate run. Claude writes each tool's flag from setup's checklist (D17), for example
    ESLint's `--cache-location {cache}/eslintcache`. The runner holds no tool-specific code for
    this.
15. **Tampering gate.** It lives in `phaseRun.tampering`: `testFiles`, `markers` (name and regex),
    `assertions` (pattern and the largest net removal), `guarded` files, `guardedScripts` (file and
    script) and `override.heading`.
    - It is read from the ticket's base commit, never the working tree, and never fails open.
    - The Test override is read from the ticket body as fetched at night start.
    - Claude writes the rows from setup's checklist (D17), for the project's own test runner.
    - `guarded` includes the test config and `.claude/workflow.json`. No section means no gate.

**Trim and setup**

16. **Trim, a machine list plus a project keep.**
    - `~/.claude/brigade/trim.json` (honouring `CLAUDE_CONFIG_DIR`) holds plugins, skills and
      flags, and a missing file means no trim.
    - Flags are accepted only from the code's own list, and a `brigade@*` row is refused.
    - Trim never switches off a plugin the project's own settings enable, or its `.claude/skills`.
    - `phaseRun.keep` names user skills and plugins that project's nights keep.
    - Trim applies to night sessions only.
17. **Tool-specific rows come from checklist items, not recipes** (ADR 0001). Brigade ships no
    per-tool rows in code. Setup's stack walk gains questions, and Claude writes the rows from the
    project's own tools, in any language, which the loaders then check:
    - **Test runner:** its changed-only command, with `{base}`; a runner without one runs the
      suite. Also its skip and focus markers and its assertion call, for the tampering rows.
    - **Framework and build:** which paths feed the build (the build gate's `when`), and whether
      typecheck reads build output (`after: "build"`).
    - **Typecheck and lint:** each tool's fresh-cache flag (`{cache}`), and each one's `unread`
      list.

    `docs/guides/phase-run.md` shows the source project's rows (Vitest, Next.js, tsc, ESLint) as
    worked examples, never as defaults.
18. **Lint and typecheck hygiene is a checklist item too.** Setup asks, and Claude writes each
    piece in the project's own linter and typecheck config:
    - the linter ignores what `.gitignore` ignores;
    - typecheck leaves out scratch folders (`.phase-run`), named as file shapes;
    - an empty catch needs a reason;
    - tool scripts are checked for undefined names;
    - the linter's cache stays gitignored.

    Refresh asks again for any piece that's missing. Nothing ships as a lint module, so there is no
    rule prefix to name.
19. **Unread-list honesty is a warning.** A template scan finds path strings in test files that
    land on the tests row's `unread` list, and `/setup-workflow` verify and refresh print each hit.
    It is not a gate: the gates already catch what a wrong list lets through.
20. **`detect` finds an existing Docker setup.** It lists any `docker-compose.yml`, `compose.yml`
    or `compose.yaml`, with each service's image and ports (for example `db: postgres:16, 5432`).
    - On an existing project, setup proposes the preflight row (`docker compose up -d --wait`) and
      the port from those services, and never writes a second compose file.
    - It then runs the existing Docker check: installed and running, or the install link and how
      to check it. It never installs Docker.
    - A project with no compose file is asked, as today, where its test database runs.
21. **The version and ADRs.** This is 0.6.0, a new runner, new config keys and a new hook. It gets
    two ADRs, both hard to reverse and both different from the source on purpose:
    - 0004, each stop check keeps its own receipt;
    - 0005, one run, one judge.

**Tickets** (proposed, in the source's §18.2 order, with the probe added first and its step 5
dropped by D9):
1. **Probe** (attended, Opus): D5's three questions.
2. **Pricing** (D1).
3. **Ledger** (D2).
4. **Attended hook** (D3).
5. **Snapshot** (D7, D8): `PHASE_RUN_RUNNER`, hooks reading the copy, the deferred update, the
   version pin.
6. **Per-check receipts** (D10, D11): the matcher, the stop gate, both loaders, `/update-workflow`'s
   offers.
7. **Gates side by side** (D12–D14).
8. **Tampering gate** (D15).
9. **Trim** (D16).
10. **Setup checklist items** (D17–D19): the stack walk's new questions, the worked examples in
    the phase-run guide, the honesty warning.
11. **The compose scan** (D20): `detect` lists compose files and services, setup reuses them.
12. **Finish** (attended): the whole-phase review, the docs and the 0.6.0 version.

**For the spec:**
- **Loader keys.** `cache` joins the gate placeholders. `name`, `after`, `unreadOf`, `keep`,
  `tampering` and `ledger` join the key lists, in both `config.mjs` and
  `hooks/workflow-config.mjs`.
- **Seeing hook changes live** (tickets 4–6). Brigade's own repo runs the *installed* plugin's
  hooks, so a hook change can be seen live only in a scratch repo with `--plugin-dir`, as 0.5.0's
  check did.
- **Ported code** must pass `tests/no-project-specifics`: none of the source's names, env prefix,
  vendors, hosts or devlog numbers.

## Out of scope

- The source's skills plugin and `--setting-sources` (D6).
- The source's runner-test gate (D9).
- The source's own items:
  - the build pointed at its local database;
  - its QA port;
  - its sales modules' catch tests;
  - its step-kind patterns that name its own tools.
- A ledger rollup across projects. Rows stay per project; a later command could merge them.
- Per-tool rows or modules in code (ADR 0001): D17 and D18 are checklist items.
- Haiku, at any level.

## Open questions

- **The probe's three answers** (D5). The owner settles the snapshot ticket's design from them.
- **The reverse out-of-step.** Both loaders throw on unknown keys, and the shell guard loads the
  config on every shell call. So a 0.6.0 `workflow.json` (with `name`, `unreadOf`, `keep`) under a
  0.5.x plugin would break shell commands, not just the stop gate. It is rare for a solo developer,
  and the mirror of D11. The owner decides in the spec whether 0.6.0 hooks should warn instead.
