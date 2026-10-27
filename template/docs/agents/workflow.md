---
job: Which skill, when: how a phase moves from grill to merge. Changes only when the process does.
kind: living
max-lines: 130
---
# Workflow — which skill, when, and how a phase gets built

**Its one job:** answer "what do I reach for right now?" for this project, so it doesn't need
re-explaining each time. Evergreen: this file changes only when the process changes. For *current*
status see [`../roadmap.md`](../status/roadmap.md) and [`../session-handoff.md`](../status/handoff.md);
this file never says where things stand, only how to move them forward.

The `mattpocock-skills` named below (`/grill-with-docs`, `/to-spec`, `/to-tickets`, `/implement`)
and this repo's `/ticket-check` are **user-invoked only**: Claude can recommend one, but the owner
types the command.

## The path of a phase (since 2026-10-07)

```
/grill-with-docs → flow diagram + prototype → /to-spec → /to-tickets → /ticket-check
      → the phase run (unattended, a night at a time) → the finish ticket → merge
```

| # | Step | Who | What happens |
|---|---|---|---|
| 1 | **Grill** — `/grill-with-docs` | Owner + Claude, one sitting | Every question a ticket would otherwise stop on is answered now. Settled terms and decisions go into `CONTEXT.md` / `docs/adr/` as it goes. After it, only the outcome is written; the owner runs the next commands |
| 2 | **Flow diagram + prototype** | Claude builds, owner reviews | A Mermaid flow diagram, then a clickable prototype in the app's real colours with fake data, built through Impeccable. Polish here for as long as it takes: a change costs minutes here and days later. At approval a surface brief is written per new screen family (`.impeccable/surfaces/`). A backend-only phase skips this step |
| 3 | **Spec and tickets** — `/to-spec`, `/to-tickets` | Owner starts, Claude writes | Tickets follow [`ticket-template.md`](ticket-template.md): each stands alone, names its prototype screen, its decisions and its areas |
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
[`../implementation-log/_phase-run-guide.md`](../guides/phase-run.md). What each
session is told is `tools/phase-run/ticket-prompt.md`. In order:

1. Reads the ticket and only what it names; posts its plan as a comment on the issue.
2. Builds test-first (the `tdd` skill). A `frontend` ticket is built through Impeccable, extending
   the shipped system toward its prototype screen and surface brief.
3. Browser check with headless Playwright on the local `stj_cast` database, as the QA cast.
4. A `frontend` ticket: one prototype-match review by a fresh reviewer, one fix batch.
5. The per-ticket docs (`doc-sync` §1) and **one commit** with `Closes #N`; then `code-review`
   over that commit, its fixes amended into it.
6. The runner checks the gates itself (one commit, clean tree, typecheck, lint, `next build` when
   `src/` changed, the browser check's screenshots when a screen changed, the full suite,
   doc-check), then applies any new migration to dev Neon. A failure goes back to the same session,
   up to three rounds. Passed: the branch is pushed and the draft pull request updated.

**A question mid-run: decide small ones, park big ones.** A small, easily changed choice is taken
and listed under "Assumptions made" for the owner to confirm or reverse. A money or payroll rule,
privacy, who may see or do something, or a hard-to-reverse schema choice parks the ticket: its
question goes on the issue with the `needs-info` label, its dependents wait, and the run moves on.

**Fresh session per ticket, on purpose.** Nothing carries over in memory. What a later ticket
knows of an earlier one is in the code, the gotchas block and the ADR it wrote.

## One ticket by hand (outside a phase run)

`/implement` on `main`, attended, still works for a one-off: it builds test-first, finishes with
`/code-review`, runs `doc-sync`, then **stops and asks** for the commit go-ahead; commit and push
are separate asks (`CLAUDE.md`, Working agreement). Include `Closes #N` in the commit message.
`/clear` between tickets.

## Design lead-time: check before a ticket with a screen

A new screen family needs its flow diagram and, for a screen-heavy phase, its approved prototype
before any ticket builds it (`CLAUDE.md`, Design lead-time; files under `design/module-N/`, see
`design/README.md`). Check against the ticket's own acceptance criteria, not a note written before
the ticket existed: a ticket that needs a screen nothing was designed for is a stop-and-flag
moment, and `/ticket-check` looks for exactly that. After a build `DESIGN.md` is the record, and
the prototype is deleted in the finish ticket.

## `doc-sync`: runs with every change

Not a step of the pipeline: a checklist run after any verified change and before its commit, in
two tiers (per ticket / phase end). Full detail: `.claude/skills/doc-sync/SKILL.md`. Its mechanical
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
