---
job: Which skill, when: how a phase moves from grill to merge. Changes only when the process does.
kind: living
max-lines: 140
---
# Workflow — which skill, when, and how a phase gets built

**Its one job:** answer "what do I reach for right now?". It changes only when the process does;
where things stand is in [the roadmap](../status/roadmap.md) and [the handoff](../status/handoff.md).
The skills named below, except `/roadmap`, are **user-invoked only**: Claude recommends, the owner types.

## Before the first phase: discovery, modules, Phase 0

The ladder, each rung with one job: **discovery** (the whole product) → **modules** (one area each,
with its own words and data; optional for a small project) → **phases** (a slice tested in one
morning, one pull request) → **tickets** (one session, one commit).

1. **Discovery.** Rounds with Claude (in chat or here), saved as `docs/discovery/NN-<topic>.md`
   from [`discovery.md`](../_templates/discovery.md); listed in
   [the discovery index](../discovery/README.md). Never rewritten: a later fact is a dated addendum
   under the title. Its "Requirements and stack" table is what setup reads.
2. **A module's planning grill**: `/grill-with-docs Module N, <name>: plan its phases. Sources: <the
   discovery docs and sections>`. It adds the module's and its phases' rows to the roadmap's tables,
   and `docs/guides/module-N.md`, whose **Sources:** every later grill in it reads first. Numbered:
   Module 1; phases 1A, 1B; branches `phase-1a`. A small project skips modules (`phase-checkout`).
3. **Phase 0**, the skeleton: the app, its test runner, lint and typecheck, a first test. Grilled
   like any phase, then built **attended** on branch `phase-0` (the runner has no gates to run yet)
   and merged through its pull request. Then `/setup-workflow`'s refresh turns its checks into the
   gates, the stop checks and `checks.yml` (test scripts name their own tests). A project
   with screens also builds its shell here (the design rung below).

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
| 7 | **The finish ticket** | Owner + Claude, attended | The whole-phase finish review, the phase-end docs (`doc-sync` §1: the devlog rotated, the handbook, guide and handoff; `/roadmap` for the roadmap and its page) |
| 8 | **Merge** | Owner | Merges the one pull request with a **merge commit** (never squash or rebase: a devlog entry closes when a commit message cites it, and a squash drops those messages). The tickets' issues close; the owner closes the spec by hand |

Skip the grill only for something small and obvious (a typo, a one-line config change).

**Keep grilling → spec in one conversation** (no `/clear` between). Once `/to-spec` publishes, the
spec is a durable issue and a fresh session can run `/to-tickets` from it.

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

`/implement` on `main`, attended, for a one-off: test-first, `/code-review`, `doc-sync`, then it
**stops and asks** for the commit go-ahead (`Closes #N` in the message). `/clear` between tickets.

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

A checklist after any verified change and before its commit, per ticket and at phase end (the
`doc-sync` skill). Its mechanical half, `node tools/doc-check.mjs`, also runs before every commit.

## Other skills

- **On-ramps:** `/triage` for a pile of outside bug reports; `/diagnosing-bugs` for a bug that
  resists a first look (a red test first); `/wayfinder` for a huge, foggy effort.
- **Mid-flow:** `/prototype` (a design question needs a runnable answer), `/research` (primary
  sources, written up in the repo), `/wizard` (steps only a person can do), `/domain-modeling` (when
  a word is the problem).
