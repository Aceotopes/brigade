# Discovery: Brigade 0.3.0, from discovery to a merged first phase

> **Addendum 2026-10-28:** Phase B (the stack and setup) was grilled, and its details are decided,
> not built:
> 1. **Reading the stack table.** `setup.mjs detect` finds the "Requirements and stack" table in
>    the newest discovery doc that has one, and turns it into a proposed `stack`, reading rows by
>    their fixed Part names. Claude shows it beside what detect found in the files, and asks only
>    about undecided rows and any disagreement.
> 2. **Where the truth is.** Discovery is read only at first setup. After that, the `stack`
>    section of `.claude/workflow.json` is the truth. A stack change goes through a refresh, plus a
>    dated addendum to the discovery doc saying why (doc-sync reminds the owner).
> 3. **A refresh adds freely.** Anything it would change or remove is listed apart and applied one
>    item at a time on a yes. A hand-written row is never dropped silently. Each section is shown
>    as a diff first.
> 4. **Refresh scope:**
>    - `stack`;
>    - `.claude/workflow.json`'s checks, gates, wrappers and permissions;
>    - `checks.yml`;
>    - doc-config's `PROTOTYPE_DIR`;
>    - the design rung's prompt file, once there are screens.
>
>    `/setup-workflow` offers it on a project that is already set up, next to `/update-workflow`.
> 5. **`guard.wrappers`** is plain command prefixes (`["pnpm exec", "pnpm dlx", "pnpm", "npx"]`).
>    The guard strips the longest match and the flags right after it. Setup writes the list for the
>    package manager; without one, today's pnpm and npx list.
> 6. **An undecided row** is left out of `stack`, shown as "undecided" in the Stack block, and
>    asked about by a refresh.
> 7. **`stack` has fixed keys** and any text values: `language`, `framework`, `packageManager`,
>    `database`, `migrations`, `testDatabase`, `storage`, and `other` (a list). The hooks' loader
>    refuses an unknown key. Each table row maps to one key, and Other services is split on commas.
> 8. **The Stack block.** `CLAUDE.md`'s starting copy gets a Stack section between generated
>    markers, which doc-index writes from `stack`. A `CLAUDE.md` without the markers has none.
>    doc-sync's `tech-stack.md` row goes.
> 9. **An older `CLAUDE.md`.** A refresh offers to add the Stack section, as a diff.
> 10. **Docker.** No recipe: Claude writes `docker-compose.yml` and the preflight row
>     (`docker compose up -d --wait`). `setup.mjs docker` reports whether Docker is installed and
>     running. If it is not, the skill explains Docker and links the installer. Nothing is
>     installed.
>
> **Changes:** "The stack and setup" below gains these details. The hooks' loader must allow
> `stack`, `roadmap` and `guard.wrappers` in the same release, or it would refuse the file.
> **Open:** none for phase B.

> **Addendum 2026-10-28:** Phase D (the design rung) was grilled, and its details are decided, not
> built:
> 1. **Sample data** is JSON, one file per module, `design/sample-data/module-N.json`, in a
>    configurable folder (`SAMPLE_DATA_DIR`). The prototype imports it, a seed in any language
>    reads it, and tests load it.
> 2. **Stand-in data.** Phase 0's grill drafts a rough sample-data file for each candidate module
>    from discovery. Each module's planning grill later refines its own file.
> 3. **Approval is recorded in the flow diagram.** `design/flows/module-N.md` opens with
>    `**Approved:** YYYY-MM-DD by the owner` and lists the module's screens by name. A frontend
>    ticket names one of them. No flow, or no Approved line, means not approved.
> 4. **Screen brief.** Each screen in the flow has one: its job, its states (empty, loading,
>    error, long content), and what it must not do. With Impeccable, the surface brief is the
>    screen brief. `/ticket-check` requires one for a frontend ticket's screen.
> 5. **The visual system comes first.** `/ticket-check` refuses a module's frontend tickets until
>    `DESIGN.md` exists. Impeccable's documenter writes it at Phase 0's finish; without
>    Impeccable, Claude writes a plain one from a short template.
> 6. **The finish review.** For a frontend project, setup writes the phase-run prompt file with a
>    default `## Review` section:
>    - with Impeccable, it starts `impeccable-finish-reviewer`;
>    - without, a fresh subagent compares the screenshots with the screen, its flow and
>      `DESIGN.md`.
>
>    Either way it is one round and one fix batch, and the project can edit it afterwards.
> 7. **The prototype folder** is proposed by setup from the framework: Next app router
>    `app/(prototype)/`, SvelteKit `src/routes/(prototype)/`, Nuxt `pages/prototype/`, a plain
>    React or Vite app `src/prototype/`. Setup asks when it can't tell. The answer is saved as
>    `PROTOTYPE_DIR`.
> 8. **Kept out of production.** The prototype folder's layout renders only in development, and
>    its guard carries a `brigade:prototype-guard` marker. doc-check refuses a prototype folder
>    without the marker. Phase 0 also writes the project's own test that a production build hides
>    prototype routes, which runs as a gate.
> 9. **Design index.** `design/README.md` is generated from `design/flows/`: each module's
>    approval date, its screens, and whether its prototype folder still exists.
> 10. **The QA seed** loading the sample data is documented, not enforced: it is project code.
> 11. **Term.** "Screen brief" is the canonical name.
>
> **Changes:** "The design rung" below gains these details. Open question 4 is settled by items 1,
> 2 and 10, and open question 5 by item 7. **Open:** none for phase D.

> **Addendum 2026-10-28:** Phase A (the ladder) was grilled, and its details are decided, not
> built:
> 1. **Template.** `docs/_templates/discovery.md` requires Goals, Problems, Requirements and stack,
>    and Candidate modules. Users, Design, Out of scope and Open questions are optional.
> 2. **Requirements and stack** is a table with one row per stack key (Language, Framework,
>    Package manager, Database, Migrations, Test database, Storage, Other services) and two
>    columns, Choice and Why. "Undecided" is allowed, and setup asks only those rows. Requirements
>    that aren't tools go in a list under the table.
> 3. **Folder and names.** `DISCOVERY_DIR` defaults to `docs/discovery` and is header-exempt.
>    Files are named `NN-topic.md`, numbered in the order they were written.
> 4. **Index.** `docs/discovery/README.md` is generated by doc-index: title, date, latest addendum.
>    `CLAUDE.md`'s "Where things live" points at it.
> 5. **Addendum format.** A dated block under the title, newest first: the new fact, then
>    **Changes:** what it overrides, then **Open:** a question or none. A correction is an addendum
>    too; there is no override.
> 6. **Never rewrite, enforced.** doc-check refuses a commit that changes or removes a committed
>    line below a discovery doc's addendum block.
> 7. **The current stack** is the `stack` config, shown in a generated "Stack" block in
>    `CLAUDE.md`. doc-sync's `tech-stack.md` row goes. The block needs the `stack` section, so it
>    is built in phase B.
> 8. **A module-planning grill** produces the module's rows on the roadmap (plain lines until
>    phase C's tables) and `docs/guides/module-N.md`, which opens with **Sources:**, the discovery
>    docs and sections it came from.
> 9. **Candidate modules.** One becomes a module when its grill puts it on the roadmap.
> 10. **Phase 0** is grilled, built attended on branch `phase-0`, and merged through a pull request
>     with a merge commit. A refresh then fills the gates.
> 11. **Order.** The guide's "Starting a fresh project" shows discovery, then setup, as the default,
>     and "setup first, then refresh" as the alternative.
> 12. **The rename.** `GLOSSARY.md` replaces `CONTEXT.md` in all eleven places in the generic half.
>     A "renamed" ban test fails on `CONTEXT.md` there. Setup detects both names, and overwrite
>     mode archives either one, offering a `CONTEXT.md`'s terms for carrying over.
> 13. **This doc** is renamed `docs/discovery/01-brigade-0.3.0.md` in phase A's build, with every
>     link updated. Only the file name changes.
>
> **Changes:** "The ladder" below gains these details, and the glossary gains "Addendum" and
> "Candidate module". **Open:** none for phase A. Open question 1 below is settled by items 1–2.

**Rounds:** 2026-10-28, a `/grill-with-docs` session with the owner. **Status:** decided, not built.
Nothing below exists in Brigade yet; each phase is built, reviewed and released on its own.
Terms are defined in [the glossary](../../GLOSSARY.md). Two decisions have ADRs:
[no stack recipes](../adr/0001-no-stack-recipes.md) and
[the roadmap's source is the repo](../adr/0002-roadmap-repo-is-truth.md).

This doc has the sections a project's discovery doc will have (the template is part of phase A),
so it doubles as the worked example. Like any discovery doc, it is never rewritten: a later fact
is added as a dated addendum at the top.

## Goals

1. A fresh project goes from discovery to its first merged phase with Brigade filling in the
   config. Nobody hand-writes a gate, a database setting or a CI step.
2. Planning above a phase is part of the workflow: discovery, then modules, then phases, then
   tickets, each with its own home and its own grill.
3. Frontends stop needing redoes. The app shell and its visual system come first, each module's
   screens are prototyped and approved before its tickets, and checks hold that order.
4. The owner can see the project's status at a glance, and which module comes next, on a page that
   can't drift from the repo.

## Problems (what happens today)

| Problem | Today |
|---|---|
| Discovery and modules have no place | The workflow starts at a phase. Discovery docs, module plans and module guides are a project's own habit, kept in its own files and rules |
| Setup can't fill the config for a fresh project | An empty repo has nothing to detect, so setup proposes no gates and writes no CI checks. Nothing re-proposes the config once the app exists. Docker, the databases and migrations are left blank, to be filled in by hand from the guide |
| The stack is stated but never read | The owner names the database host, package manager and storage in discovery; Brigade never sees it |
| The guard can be slipped past | Its command parsing sees through `pnpm exec` and `npx` only, so a block rule misses the same command run through `bunx` or `yarn` |
| Frontends get redone | Screens were designed before the shell and visual system existed, and each invented its own look; prototypes and the real app diverged |
| No status page | The roadmap is a Markdown file; a visual page meant hand-editing HTML at every phase end |

## Users

A solo builder working with Claude Code, planning in Claude chat and building with Brigade,
including one who has never used Docker.

## Requirements and stack

- **Brigade itself:** Node only, no dependencies; Claude Code; the GitHub CLI.
- **The project:** no stack is assumed. A project declares its own, and Brigade works from that
  ([ADR 0001](../adr/0001-no-stack-recipes.md)).
- **Design tools:** Impeccable is optional. When installed, the design steps use its commands and
  files; without it, the same steps run with Claude and a plain design note. Figma is not used.
- **Never:** Brigade installs no software. Setup explains and links instead.

## Decisions

### The ladder (planning above a phase)

- **Discovery docs** live in one configurable folder (`DISCOVERY_DIR`, default `docs/discovery`),
  are exempt from doc headers like other records, and start from a template,
  `docs/_templates/discovery.md`. Its fixed sections include **Requirements and stack**. A
  discovery doc is never rewritten; a later fact becomes a dated addendum.
- **Modules** are optional and numbered: Module 1, its phases 1A and 1B, their branches
  `phase-1a` and `phase-1b`, its guide `docs/guides/module-1.md`. A small project skips modules
  and gives phases names.
- **Planning a module needs no new skill.** It is a `/grill-with-docs` that names its discovery
  docs, and the workflow doc says what it must produce: the module's row and phase rows in the
  roadmap, and its guide.
- **Documentation** is in two places with separate jobs: Brigade's guide gains "Starting a fresh
  project" and "The ladder" (for a reader deciding how to use Brigade); the template's
  `docs/agents/workflow.md` gains "Before the first phase" (the day-to-day reference).
- **The glossary file is `GLOSSARY.md`**, the name `/grill-with-docs` writes, replacing
  `CONTEXT.md` across the template, setup and skills.

### The design rung (frontend projects)

- **The app shell comes first, in Phase 0**, built once in the real app on localhost: header,
  navigation, layout, type and colour. Why: screens designed before the shell each invent their
  own look, which caused the redoes.
- **The shell gets a stand-in page per candidate module**, filled with that module's sample data,
  so it is tested against real-shaped content (long names, empty lists, big numbers) before any
  database exists.
- **`DESIGN.md` is written from what was built**, at the shell's finish, not before. Impeccable's
  own rule: a rulebook written before the build gets defended against reality.
- **Sample data has one source per module**, written at the module's grill from discovery's
  minimum, typical and maximum ranges and edge cases. The prototype shows it and the QA database's
  seed loads it later, so the prototype, the tests and the browser check all see the data the
  screens were designed with.
- **Each module is prototyped after its grill and before its tickets**. Not all modules up front
  (later ones learn from built ones, and early designs go stale), and not per phase (a module's
  phases share screens).
- **The prototype comes first, then the flow diagram.** The diagram is drawn from the approved
  prototype and is the reference later sessions read.
- **Where they live:** each flow diagram is `design/flows/module-N.md` (Mermaid), kept and updated
  to match what shipped. Prototypes live in one designated, configurable folder **inside the app**,
  so they run in the real shell with real components. `design/README.md` lists each module's
  flow, prototype and status.
- **A module's prototype is deleted at its finish**: the built screens and `DESIGN.md` are the
  record, and git keeps the history.
- **No Figma.** Localhost is the canvas: the prototype is real code in the real stack, and a Figma
  copy would be a second source of truth that drifts. One screen can be pushed to Figma as an
  exception if a non-technical reviewer needs to comment.
- **Three checks hold it in place:** `/ticket-check` refuses a frontend ticket whose screen has
  no approved prototype and surface brief (or design note); every frontend ticket gets a fresh
  finish review against its brief, then one fix batch; and a module's frontend tickets wait
  until Phase 0 has produced `DESIGN.md`.

### The stack and setup

- **The stack is declared, then recorded.** Discovery states it in prose; setup turns it into a
  `stack` section in `.claude/workflow.json`, with fixed keys (language, framework, package
  manager, database, migrations, test database, storage, other services) and free values.
- **No recipes** ([ADR 0001](../adr/0001-no-stack-recipes.md)): Claude writes the config from the
  stack, following setup's checklist, and the loaders check it.
- **The guard's wrappers are config**: `guard.wrappers`, filled by setup from the package manager;
  without it, today's `pnpm` and `npx`.
- **Both orders work.** Setup's new mode still counts a repo as empty when it holds only
  discovery docs, so discovery can come first and setup reads its stack. A project already set up
  can **refresh**: `/setup-workflow` offers to bring the config in line with the stack, shown as a
  diff per section, written only on a yes.
- **Docker for a beginner:** setup writes the compose file and the preflight row, runs
  `docker info`, and if Docker is missing or stopped, explains what it is in two sentences and
  links the installer.

### The roadmap

- **The repo is the truth** ([ADR 0002](../adr/0002-roadmap-repo-is-truth.md)): `roadmap.md` holds
  fixed tables (modules in order with what each depends on; phases with spec and status) between
  markers. doc-check checks their format only once a roadmap has them, so older projects keep
  working.
- **`/roadmap`** reads `roadmap.md` and GitHub (spec issues, phase pull requests, parked tickets),
  proposes the out-of-date lines as a diff, writes them on a yes, then offers to create the page,
  or refreshes it.
- **The page** is a Brigade template plus generated data: modules in order with their phases and
  what they wait on, "Up next" from the handoff, Delivered and Noted for later, and "How a phase
  moves". Its link is `roadmap.artifact` in `.claude/workflow.json`.

## Candidate modules

One module, Brigade 0.3.0, in four phases, built in this order:

| Phase | What it builds | Why this order |
|---|---|---|
| **A: the ladder** | The glossary rename; the discovery folder, template and addendum rule; "Before the first phase" with module naming; the guide's fresh-project and ladder sections | Everything else names these rungs |
| **D: the design rung** | The design steps in the workflow doc; `DESIGN_DIR` and the in-app prototype folder; the three checks; the finish review on frontend tickets; prototype deletion at a module's finish | Frontends were the costliest part of past projects |
| **B: the stack and setup** | The `stack`, `guard.wrappers` and `roadmap` config sections; setup reading discovery; new mode with discovery docs; refresh; the stack checklist and the Docker check | Setup needs the ladder's discovery folder |
| **C: the roadmap** | The roadmap's fixed tables and their format check; `/roadmap`, its data script and page template; the fresh-project trial; version 0.3.0 | Last: it reads everything the others produce |

**Proof:** a throwaway repo walks the whole fresh flow before 0.3.0 is released: a discovery doc
with a stack, install, setup reading it, Phase 0 with its shell, a refresh, a module in the
roadmap, `/roadmap` publishing the page, and one small phase run so the page shows a merged
phase.

## Out of scope

- Per-tool recipe tables ([ADR 0001](../adr/0001-no-stack-recipes.md)).
- Installing any software for the user.
- Moving the project Brigade grew out of onto Brigade: it stays independent.
- A hand-built roadmap page.
- Figma as a design source.

## Open questions (each for its own phase's grill)

1. The exact fields and wording of the discovery template's "Requirements and stack" section.
2. The roadmap tables' exact columns, and the markers around them.
3. The roadmap page template's design.
4. The sample data's file format and location (they depend on the stack), and how the QA seed
   reads it.
5. How setup names the in-app prototype folder for a framework it doesn't recognise.
