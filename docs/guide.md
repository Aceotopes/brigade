# The Brigade guide

How to set a repo up, take a phase from idea to merge, configure the rules, keep the workflow
current, and get out of trouble. The README has the short version and the command tables; this
guide has the reasons and the options.

- [1. The ladder: from an idea to tickets](#1-the-ladder-from-an-idea-to-tickets)
- [2. Starting a fresh project](#2-starting-a-fresh-project)
- [3. Setting a repo up](#3-setting-a-repo-up)
- [4. What your repo gets](#4-what-your-repo-gets)
- [5. A phase, start to finish](#5-a-phase-start-to-finish)
- [6. Configuring](#6-configuring)
- [7. Updating](#7-updating)
- [8. Troubleshooting](#8-troubleshooting)

## 1. The ladder: from an idea to tickets

Brigade breaks work down in four rungs, each one smaller than the one above, and each with one job.
Terms are in the [glossary](../GLOSSARY.md).

| Rung | What it is | Rough size | Planned from | What comes out |
|---|---|---|---|---|
| **Discovery** | The whole product: goals, problems, users, the stack, the areas it splits into | the whole project | Your discovery rounds, in Claude chat or a session | `docs/discovery/NN-<topic>.md`, never rewritten |
| **Module** | One area with its own words and data ("Inventory", "Payroll"). Optional for a small project | weeks | A planning grill naming its discovery docs | Its phases on the roadmap, and `docs/guides/module-N.md` opening with **Sources:** |
| **Phase** | A slice you can test end to end in one morning and merge on its own | 5–10 tickets, one pull request | A phase grill, from the module guide's sources | A spec issue, then tickets |
| **Ticket** | One session's work | one commit, under two hours | The spec | Code, tests, its implementation log |

**Each grill works on one rung and names its sources** in its first line, so nothing is planned from
memory:

```
/grill-with-docs Module 2, Inventory: plan its phases. Sources: docs/discovery/03-inventory.md and 05-suppliers.md.
/grill-with-docs Phase 2A, stock counts. Sources: 03-inventory.md §2–§4, docs/guides/module-2.md.
```

**Drawing the lines:**
- A module boundary is where the words change: payroll talks about cutoffs and payslips, inventory
  about counts and suppliers.
- A phase is the right size when you could hand-test all of it in one morning.
- A ticket is the right size when one fresh session can finish it without asking anything.

Modules are numbered: Module 1, phases 1A and 1B, branches `phase-1a` and `phase-1b`. A project
without modules names its phases (`phase-checkout`).

**A project with screens adds the design rung**, so screens are designed before their tickets and
never invented during a build:
- **Phase 0** builds the app shell (header, navigation, layout, type, colour) with a stand-in page per
  candidate module, on a first draft of each module's sample data (`design/sample-data/module-N.json`).
  `DESIGN.md`, the visual system, is written from what was built.
- **Each module**, after its planning grill and before its tickets: its prototype is built in the
  real app on its sample data and approved, then drawn as a flow diagram,
  `design/flows/module-N.md`, whose **Approved:** line records the approval and which holds a
  screen brief (job, states, must not) for each screen.
- **`/ticket-check` refuses** a frontend ticket until `DESIGN.md` exists, its module's flow is
  approved, and its screen is in the flow with a brief. Every frontend ticket then gets one finish
  review against its brief.
- **Prototypes never ship.** They live in one folder inside the app that renders only in
  development; doc-check refuses that folder without its guard, and the project's own test proves
  a production build hides it. A module's prototype is deleted once its screens are built.

Impeccable, when installed, does the design work with its own commands (`shape`, `live`, its finish
reviewer and documenter). Without it, Claude does the same steps.

**Discovery docs are records.** Once committed, doc-check refuses a commit that changes one. A later
fact, or a correction, is a dated addendum under the title, newest first:

```
> **Addendum 2026-11-02:** 14 staff, not 40. **Changes:** Goals 2. **Open:** none.
```

So you can always see what was first decided, and what changed since.

## 2. Starting a fresh project

The order, from an empty folder to the first phase:

1. **Create the repo:** `git init -b main`, then `gh repo create <name> --private --source .`
   (the runner reads its tickets from GitHub). Don't push yet: there's nothing to push.
2. **Install Brigade** (README, "Install") at project scope, and commit the settings change.
3. **Save your discovery docs** in `docs/discovery/`, one per topic or round, named `01-<topic>.md`
   onward, in the shape of [`discovery.md`](../template/docs/_templates/discovery.md). Its
   **Requirements and stack** table records the stack (write "undecided" where you haven't chosen).
   Setup reads that table, shows it beside what your files say, and asks only about disagreements
   and undecided parts.
4. **`/setup-workflow`.** A repo holding only discovery docs still counts as new. Setup writes the
   workflow around them, never touches them, and lists them in `docs/discovery/README.md`. Commit,
   then `git push -u origin main`.
5. **`/setup-matt-pocock-skills`**, for the labels `/to-spec` and `/to-tickets` use.
6. **Plan the first module** with a planning grill (the ladder above). A small project skips this
   and plans phases directly.
7. **Phase 0, the skeleton**, built with you there: the app, its test runner, lint, typecheck and a
   first test, on branch `phase-0`, merged through its pull request. The runner can't build it,
   because there are no gates to run yet. Point the test script at your own tests
   (`node --test test/*.test.js`): a bare `node --test` also runs Brigade's `tools/*.test.mjs`.
   Afterwards, run `/setup-workflow` and pick the **refresh**: it adds the gates, the stop checks
   and `.github/workflows/checks.yml` from your new scripts. A project with screens also builds its app shell, stand-in pages, sample
   data drafts and prototype guard in Phase 0, and ends it with `DESIGN.md` (the design rung above).
8. **Every phase after that** follows section 5's path.

**Seeing where it stands: `/roadmap`.** `docs/status/roadmap.md` holds two fixed tables: the
modules in build order (each with what it depends on) and their phases (each with its spec and
branch), every row's status one word (planned, building, merged or delivered, `blocked: <why>`).
`/roadmap` checks the tables against GitHub (a phase is building while its pull request is open,
merged once it merges, and a module is delivered when every phase is), shows the changes as a diff
for your yes, and publishes the **roadmap page**: one card per module in build order, its phases as
coloured chips, the next thing to build lit, and what waits on you. The page is drawn from the file
and never edited by hand; Claude may run `/roadmap` itself at a phase's end. Without the Artifact
tool, it saves the page to `.git/brigade/roadmap.html` instead. A roadmap from before 0.3.0 is
offered a conversion to the tables first.

Setup first and discovery afterwards also works: discovery docs added later are indexed the same way.

## 3. Setting a repo up

Install Brigade first (README, "Install") and commit the `.claude/settings.json` change. Then type
`/setup-workflow` in a Claude Code session in the project folder. Setup has the same file work to do
every time, so a tested script does it (`scripts/setup.mjs`). The skill does the talking: it asks
what it needs, and gets your yes before anything is written.

**The steps it takes:**

1. **Look.** It needs a git repo (it offers `git init -b main`). It stops if the repo is already set
   up (use `/update-workflow`), or if Brigade is not enabled in this repo.
2. **Pick a mode.** An empty repo is **new**, with nothing to ask. Any other repo asks:
   - **Merge** keeps everything. It never overwrites a file: the workflow's files are added beside
     yours. `CLAUDE.md` gets the workflow's sections appended and `.gitignore` gets `.phase-run/`,
     each shown as a diff first. Today's docs are accepted as they are: doc-check's baseline lists
     the ones without a header, and that list can only shrink.
   - **Overwrite** gives a clean slate. On a new branch, `adopt-workflow`, it moves `docs/`,
     `CLAUDE.md`, `AGENTS.md`, `CONTEXT.md` and a customised `.claude/settings.json` into
     `docs/history/pre-workflow/` (moved with `git mv`, never deleted), then writes the workflow's
     files fresh. Afterwards it reads your old `CLAUDE.md` and asks, rule by rule, which to carry
     into the new one.

   Either existing mode refuses a working tree with uncommitted changes, so the setup is one clean
   diff you can read and undo.
3. **Confirm the stack and config.** It shows what it detected:
   - the package manager and lockfile;
   - TypeScript;
   - the `package.json` scripts;
   - a database (for example Prisma's provider);
   - a frontend.

   From that it proposes the checks and gates. You confirm the project's name and summary, the
   gates, an optional migration target (off unless you name a shared development database, never
   production) and an optional browser check.
4. **Show the plan, then write.** Every file it would add, change, move or leave alone, with real
   diffs for the changed ones. After your yes it writes them, then stages them.
5. **The extras**, each asked separately:
   - the four GitHub labels the runner reads;
   - Impeccable, for a frontend;
   - your **auto-mode lines**, which describe this project in `~/.claude/settings.json` so
     Claude Code's auto mode knows what is routine here. Only this project's lines are added, as
     a diff you approve.
6. **Check, and stop.** It runs `setup.mjs verify` (doc-check, the template's two test suites, both
   config loaders), shows `git status`, and drafts the commit message. **Setup never commits.**

## 4. What your repo gets

| Kind | Files | Who owns them afterwards |
|---|---|---|
| **Template** | `tools/doc-*.mjs`, `tools/phase-run/`, `docs/_templates/`, `docs/agents/workflow.md`, `docs/agents/ticket-template.md`, `docs/guides/phase-run.md`, `.github/workflows/doc-check.yml` | The plugin. `/update-workflow` re-copies them. Don't edit them: anything about your project belongs in config |
| **Scaffold** | `CLAUDE.md`, the devlog with entry #1, the roadmap, the handoff, the issue-tracker page, the generated indexes' heads (docs, discovery, design), and for a project with screens the phase-run prompt file with its design review | You. Written once; an update only tells you when the plugin's starting copy changed |
| **Config** | `.claude/workflow.json`, `.claude/spec-issues.json`, `tools/doc-config.mjs`, `tools/doc-check-baseline.json`, `.github/workflows/checks.yml` | You. Written once from your stack; never overwritten (a version that changes a format ships a migration) |
| **Stamp** | `.claude/workflow-version.json` | Setup and update. The plugin version, the mode, and a hash of every template file as copied |

The stamp is how an update tells a template file you edited from one you left alone.

Two guides arrive with the template and are the reference for daily use:
- [`docs/agents/workflow.md`](../template/docs/agents/workflow.md): which skill to use when;
- [`docs/guides/phase-run.md`](../template/docs/guides/phase-run.md): the phase run's evening and
  morning checklists, undoing a ticket, and a symptom → fix table.

## 5. A phase, start to finish

| # | Step | Who | Command |
|---|---|---|---|
| 1 | Grill: every question a ticket could stop on is answered now | You and Claude | `/grill-with-docs <the phase>` |
| 2 | Flow diagram and clickable prototype (skipped when there are no screens) | Claude builds, you approve | Ask in plain words |
| 3 | Spec and tickets, as GitHub issues | You start, Claude writes | `/to-spec`, then `/to-tickets` |
| 4 | Readiness check | You and Claude | `/ticket-check <spec>` |
| 5 | The phase run | Claude alone | `node tools/phase-run/run.mjs --spec <N> --branch phase-<name>` |
| 6 | The morning: the report, parked questions, testing by hand | You | Read the pull request |
| 7 | The finish ticket: the phase-end docs and the whole-phase review | You and Claude | An attended session on the branch |
| 8 | Merge, with a merge commit | You | GitHub's **Create a merge commit** |

Keep steps 1 to 3 in one conversation. A merge commit, not a squash, keeps each ticket's commit
message, which closes its devlog entry.

**What the runner does per ticket:**
1. It starts a fresh background session and hands it the ticket's prompt
   (`tools/phase-run/ticket-prompt.md`, plus your project's prose).
2. The session posts its plan on the issue, builds test-first, writes the per-ticket docs, commits
   once and reviews its own commit.
3. The runner then checks the result itself:
   - one commit, a clean tree, the implementation log;
   - your gates, in order;
   - doc-check;
   - then any migration.
4. A failure goes back to the same session, up to `--fix-rounds` times.
5. A pass pushes the branch and updates the draft pull request.

**When a ticket can't go on, it is parked with a label:**

| Label | Meaning | What you do |
|---|---|---|
| `run-ready` | `/ticket-check` found nothing open; a run may build it | Nothing |
| `needs-info` | Parked on a question only you can answer (money, privacy, permissions, a hard-to-undo schema choice) | Answer on the issue, remove `needs-info`, add `run-ready` |
| `ready-for-human` | Parked after its gates kept failing | Read the report, fix it by hand or re-ticket it |
| `frontend` | Changes a screen: the browser check and the design review apply | Nothing |

Small choices are made and listed under "Assumptions made" for you to confirm. Tickets that depend
on a parked one wait, and the run moves on to the rest.

## 6. Configuring

### `.claude/workflow.json`

**`guard.block`**: commands the guard refuses. Each rule has:

| Key | Meaning |
|---|---|
| `command` or `text` | A regex, tested on each simple command (`command`) or on the whole command line (`text`) |
| `with` | Optional: a regex the same simple command must also match |
| `unless` | Optional: a regex on the whole command line that lets it through |
| `when` | `always`, or `phase-run` (only inside a phase run) |
| `message` | What the session is told when the rule blocks it |

**`guard.wrappers`**: the command prefixes the guard strips before testing a rule, so a rule
against `prisma format` also catches `pnpm exec prisma format` or `bunx prisma format`. Setup
writes them for your package manager (`["bunx", "bun x", "bun run", "bun"]` for bun); without
them, `pnpm exec`, `pnpm dlx`, `pnpm` and `npx`.

**`stopGate.checks`**: `{ "label", "run" }` pairs, run in order each time a phase-run session
tries to stop. In `run`, `{base}` is the run's base commit, for example
`vitest run --changed {base}`.

**`stack`**: what the project is built with, from your discovery doc at setup: `language`,
`framework`, `packageManager`, `database`, `migrations`, `testDatabase`, `storage`, and `other` (a
list), in any words. An undecided part is left out. `CLAUDE.md`'s Stack section is generated from
it. Don't edit it by hand: when the stack changes, run `/setup-workflow` and pick the refresh. The
refresh adds what the new stack suggests, and changes or removes anything only on your yes.

**`phaseRun`**: what the runner checks and pins. The phase-run guide's
"[What your config sets](../template/docs/guides/phase-run.md#what-your-config-sets)" section has
every key; in short:
- `gates`: the runner's own checks, in order; one with `when` runs only if the ticket touched
  matching files;
- `preflight` and `ports`: what must be running, and what must be free, before a run;
- `qa`, `sessionEnv`, `migrations`: the QA database, values pinned in each session, and where
  migrations are applied after every check passes;
- `browserCheck`: screenshots for a ticket that changes a screen;
- `permissions`: extra commands a session may run;
- `prompt`: a Markdown file of your own instructions for each session, with `## Read`, `## Build`,
  `## Browser check`, `## Review` and `## Fix` sections.

A `note` key is allowed anywhere, since JSON has no comments. Any other unknown key is an error, so
a typo stops the run at preflight instead of quietly turning a rule off.

### The other config files

| File | What it holds |
|---|---|
| `.claude/spec-issues.json` | The spec issue numbers. The guard refuses a closing keyword before one, because you close specs by hand. `/ticket-check` adds to it |
| `tools/doc-config.mjs` | Where your docs are, for doc-check and the indexes. The settings you are likely to change: `LIVE_DOCS` (the docs the checks read), `PATH_ROOTS` (the folders a cited path may be in; add `src` and the like as your docs cite them), `GOTCHAS_FILE` (flat by default; a project grouping phases into modules names the module folder), `DISCOVERY_DIR`, and the design rung's `DESIGN_DIR`, `SAMPLE_DATA_DIR` and `PROTOTYPE_DIR` (set by setup from your framework, or `null` until you have one) |
| `tools/doc-check-baseline.json` | Hits doc-check accepts: lines that quote a stale phrase on purpose, and, after a merge setup, docs still without a header |
| `.github/workflows/checks.yml` | Your stop-gate checks on every push and pull request, so a green pull request means your own tests ran, not only the docs. Edit it when your checks change |

## 7. Updating

Two things keep a project current, and `/setup-workflow` on a set-up project offers both:
- **Your stack changed** (you added storage, Phase 0 added `package.json`, you moved hosts): the
  **refresh** (section 6, `stack`).
- **Brigade changed:** the update below.

A plugin update brings new hooks and skills by itself, but not the template files already copied
into your repo:

```
claude plugin marketplace update argee
claude plugin update brigade@argee
```

Then `/update-workflow` in the project. It lists what changed since your stamp, with the
changelog, and writes nothing until you say yes:

| It says | Meaning |
|---|---|
| `replace` / `add` | A template file you never edited, rewritten or added |
| `conflict` | A template file you edited. It is left alone, with the diff shown; the fix is to move your change into config and take the plugin's file |
| `gone` | A file the plugin no longer ships. Kept unless you say remove |
| `review` | A scaffold file whose plugin copy changed. You own your copy, so it is only shown |
| `notes`, `migrations` | Anything else worth knowing, and the config format changes it makes |

Then it runs the checks, drafts the devlog entry and commit message, and stops for your commit.

## 8. Troubleshooting

| You see | What to do |
|---|---|
| "The working tree has changes; commit or put them away first" | Commit or `git stash` them, then run setup again. The plugin install's own `.claude/settings.json` change doesn't count |
| "This project is already set up" | `/setup-workflow` offers the two ways to keep it current: `/update-workflow` after a plugin update, or a refresh of the config after your stack changed |
| Brigade is not enabled here | `claude plugin install brigade@argee --scope project`, then commit the settings change |
| "The repo changed since this plan was made" | Setup plans again and shows you the new plan |
| Setup stopped partway through writing | The tree was clean before it began, so `git reset --hard` and `git clean -fd` undo it (overwrite mode: also switch back and delete `adopt-workflow`). Commit the plugin install first, because `git clean` would remove it |
| The runner says the repo has no GitHub remote | Add one (`gh repo create`, or `git remote add origin …`) and push `main`. Tickets are read from GitHub |
| A commit is refused by doc-check | Fix what it names: a stale phrase, a path that no longer exists, a missing header, a doc over budget, or run `node tools/doc-index.mjs`. Never loosen the check to pass |
| A ticket came back `needs-info` or `ready-for-human` | See the labels table above; the morning report says why |
| Anything else during a run | The phase-run guide's "Symptom → fix" table ([phase-run.md](../template/docs/guides/phase-run.md#symptom--fix)) |
