---
job: Which skill, when: how a phase moves from grill to merge. Changes only when the process does.
kind: living
max-lines: 140
---
# Workflow — which skill, when, and how a phase gets built

**Its one job:** answer "what do I reach for right now?" for this project, so it doesn't need
re-explaining each time. Evergreen: this file changes only when the process changes. For *current*
status see [`../roadmap.md`](../status/roadmap.md) and [`../session-handoff.md`](../status/handoff.md);
this file never says where things stand, only how to move them forward.

The `mattpocock-skills` named below (`/grill-with-docs`, `/to-spec`, `/to-tickets`, `/implement`)
and this repo's `/ticket-check` are **user-invoked only**: Claude can recommend one, but the owner
types the command.

## Before the first phase: discovery, modules, Phase 0

The ladder, each rung with one job: **discovery** (the whole product) → **modules** (one area each,
with its own words and data; optional for a small project) → **phases** (a slice tested in one
morning, one pull request) → **tickets** (one session, one commit).

1. **Discovery.** Rounds with Claude (in chat or here), saved as `docs/discovery/NN-<topic>.md`
   from [`discovery.md`](../_templates/discovery.md); listed in
   [the discovery index](../discovery/README.md). Never rewritten: a later fact is a dated addendum
   under the title. Its "Requirements and stack" table is what setup reads.
2. **A module's planning grill**: `/grill-with-docs Module N, <name>: plan its phases. Sources: <the
   discovery docs and sections>`. It produces the module's line and its phases' lines in the
   roadmap, and `docs/guides/module-N.md` from its template, which opens with **Sources:**. Modules
   are numbered (Module 1; phases 1A, 1B; branches `phase-1a`, `phase-1b`). A small project skips
   modules and names its phases (`phase-checkout`). A candidate module from discovery becomes a
   module only here.
3. **Phase 0**, the skeleton: the app, its test runner, lint and typecheck, a first test. Grilled
   like any phase, then built **attended** on branch `phase-0` (the runner has no gates to run yet)
   and merged through its pull request. Then its checks become the gates and stop checks in
   `.claude/workflow.json`: the plugin's `scripts/setup.mjs propose .` suggests them. A project
   with screens also builds its shell here (the design rung below).

Every grill after that names its sources the same way: the module guide's **Sources:** say which
discovery docs to read.

## The path of a phase (since 2026-10-07)

```
/grill-with-docs → prototype + flow diagram → /to-spec → /to-tickets → /ticket-check
      → the phase run (unattended, a night at a time) → the finish ticket → merge
```

| # | Step | Who | What happens |
|---|---|---|---|
| 1 | **Grill** — `/grill-with-docs` | Owner + Claude, one sitting | Every question a ticket would otherwise stop on is answered now. Settled terms and decisions go into `GLOSSARY.md` / `docs/adr/` as it goes. After it, only the outcome is written; the owner runs the next commands |
| 2 | **Prototype + flow diagram** | Claude builds, owner reviews | Once per module, before its first frontend phase's tickets: the design rung below. Polish here for as long as it takes: a change costs minutes here and days later. A backend-only phase skips this step |
| 3 | **Spec and tickets** — `/to-spec`, `/to-tickets` | Owner starts, Claude writes | Tickets follow [`ticket-template.md`](ticket-template.md): each stands alone, names its screen (from its module's flow), its decisions and its areas |
| 4 | **Readiness check** — `/ticket-check <spec>` | Owner + Claude, one sitting | Claude reads the spec, every ticket and the code, and asks every open question in one batch. Answers are written into the tickets; ready ones get the `run-ready` label |
| 5 | **The phase run** — `node tools/phase-run/run.mjs --spec <N> --branch phase-<name>` | Claude alone | Builds the `run-ready` tickets in dependency order on the phase branch, a fresh session each. Each is a Claude Code background session, so the owner can watch one (`claude agents`, `claude attach <id>`). See below |
| 6 | **The morning** | Owner | Reads the report on the pull request, answers parked questions on their issues, checks out the branch and hand-tests. Runs step 5 again for the tickets left |
| 7 | **The finish ticket** | Owner + Claude, attended | The whole-phase finish review, the phase-end docs (`doc-sync` §1: the devlog rotated, the handbook, guide, roadmap and handoff), the prototype deleted |
| 8 | **Merge** | Owner | Merges the one pull request with a **merge commit** (never squash or rebase: a devlog entry closes when a commit message cites it, and a squash drops those messages). The tickets' issues close; the owner closes the spec by hand |

Skip the grill only for something small and obvious (a typo, a one-line config change).

**Keep grilling → spec in one conversation.** Don't `/clear` or `/compact` between them, so the
thinking stays connected while it is forming. That stops mattering the moment `/to-spec` publishes:
the spec is then a durable issue, and a fresh session can run `/to-tickets` straight off it
(`gh issue view <n> --comments`).

## What the phase run does per ticket

The owner's guide, with the evening and morning checklists, is
[`docs/guides/phase-run.md`](../guides/phase-run.md). What each session is told is
`tools/phase-run/ticket-prompt.md`, plus the project's own prose (`phaseRun.prompt` in
`.claude/workflow.json`). In order:

1. Reads the ticket and only what it names; posts its plan as a comment on the issue.
2. Builds test-first (the `tdd` skill), a `frontend` ticket toward its prototype screen.
3. Browser check in a headless browser on the QA database (`phaseRun.qa`), for a ticket with a screen.
4. A `frontend` ticket: one design review, if the project names one, and one fix batch.
5. The per-ticket docs (`doc-sync` §1) and **one commit** with `Closes #N`; then `code-review`
   over that commit, its fixes amended into it.
6. The runner checks the gates itself: one commit, clean tree, the implementation log, then the
   project's gates in order (`phaseRun.gates`: typically typecheck, lint, a build, the browser
   check's screenshots, the full suite), then doc-check; then it applies any new migration to the
   migration target (`phaseRun.migrations`). A failure goes back to the same session, up to three
   rounds. Passed: the branch is pushed and the draft pull request updated.

**A question mid-run: decide small ones, park big ones.** A small, easily changed choice is taken
and listed under "Assumptions made" for the owner to confirm or reverse. A money rule,
privacy, who may see or do something, or a hard-to-reverse schema choice parks the ticket: its
question goes on the issue with the `needs-info` label, its dependents wait, and the run moves on.

**Fresh session per ticket, on purpose.** Nothing carries over in memory. What a later ticket
knows of an earlier one is in the code, the gotchas block and the ADR it wrote.

## One ticket by hand (outside a phase run)

`/implement` on `main`, attended, still works for a one-off: it builds test-first, finishes with
`/code-review`, runs `doc-sync`, then **stops and asks** for the commit go-ahead; commit and push
are separate asks (`CLAUDE.md`, Working agreement). Include `Closes #N` in the commit message.
`/clear` between tickets.

## The design rung (a project with screens)

Screens are designed before their tickets, in the real app (Impeccable's commands where named;
without it, the same with Claude).

1. **Phase 0 builds the app shell** (header, navigation, layout, type, colour) with one stand-in
   page per candidate module, on a first draft of each module's sample data
   (`design/sample-data/module-N.json`). Also its prototype guard: the prototype folder
   (doc-config's `PROTOTYPE_DIR`) renders only in development, its layout carries the
   `brigade:prototype-guard` marker, and a test proves production hides it. Then `DESIGN.md`, from
   the built shell (Impeccable's documenter, or `docs/_templates/design-system.md`).
2. **Per module, after its planning grill:** refine its sample data, build its prototype in the
   prototype folder (`/impeccable shape`, then `live`), approve it, then draw its flow diagram,
   `design/flows/module-N.md` from `docs/_templates/flow.md`: the **Approved:** line, and a screen
   brief under each screen. Only then `/to-tickets`.
3. **`/ticket-check` refuses** a `frontend` ticket while `DESIGN.md` is missing, its module's flow
   is unapproved, its screen is not one of the flow's, or the screen has no brief.
4. **Each frontend ticket gets one finish review** against its screen brief and `DESIGN.md` (the
   prompt file's `## Review`), then one fix batch. **At the module's finish** its prototype folder
   is deleted and its flow updated to match what shipped ([the design index](../../design/README.md)).

## `doc-sync`: runs with every change

Not a step of the pipeline: a checklist run after any verified change and before its commit, in
two tiers (per ticket / phase end). Full detail: the `doc-sync` skill (Brigade plugin). Its mechanical
checks are a script, `node tools/doc-check.mjs`, which a hook also runs before every commit.

## On-ramps: they feed the path above

- **A pile of external bug reports or requests** → `/triage`. Not for tickets `/to-tickets` made.
- **Something is broken and resists a first glance** → `/diagnosing-bugs`: a red test reproducing
  the bug first, then the fix with a regression test.
- **A huge, foggy effort** → `/wayfinder`. Slower and denser than grilling.

## Tools reached for mid-flow

- **`/prototype`**: a design question needs a runnable answer rather than more conversation.
- **`/research`**: reading legwork against primary sources, written up as a cited file in the repo.
- **`/wizard`**: the steps only a person can do (a dashboard click-through, provisioning, a secret).
- **`/domain-modeling`**: pulled in by `/grill-with-docs`; directly only when a word is the problem.
