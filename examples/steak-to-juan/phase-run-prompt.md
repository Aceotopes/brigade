---
job: Steak To Juan's part of each phase-run session's prompt; the runner splices each section into tools/phase-run/ticket-prompt.md.
kind: living
max-lines: 120
---
# Phase run: Steak To Juan's part of the prompt

Read by `tools/phase-run/run.mjs` (`phaseRun.prompt` in `.claude/workflow.json`): each `## ` section
below is spliced into the generic prompt at its place. Moved here from the runner's prompt at
`905e2d8` (Brigade README step 7), less the sentences the generic prompt now says itself (the
`CLAUDE.md` pointer, never migrating the target, never printing `.env`).

## Read

For a `frontend` ticket, also its surface brief in `.impeccable/surfaces/`.

## Build

- **Do not run the full suite (`pnpm test`)**: the runner runs it once in its checks, after you
  stop, and sends any failure back to you to fix. One suite at a time: two runs truncate each
  other's data.
- **A `frontend` ticket is built through Impeccable.** Before the first UI edit, load the
  `impeccable` skill with a full request (never bare: a bare call shows a menu and waits). For
  example: `impeccable craft <the ticket's screen>, extending the shipped system, to match its
  prototype screen and surface brief; target <route>`. Extend "The Pass"; never redesign. Follow the
  skill's bounded passes: one batched look at 390 and 1280, one fix batch, one confirming look.
- **The `CLAUDE.md` rules a night run breaks most easily:** every query tenant-scoped; client components import `*-query.ts` only; a mutating Server Action
  under `/sales/*` returns its failure; colour roles are capped; no formatter runs (`prettier
  --write`, `prisma format`); a hand-built actor sets `payrollRestricted`.
- **A schema change** is a new migration folder under `prisma/migrations/`. The test database and
  `stj_cast` take it on their own.
- **Your database:** `NEON_DATABASE_URL` is already the local `stj_cast` database and
  `LOYVERSE_ACCESS_TOKEN` is a placeholder. A script you run plainly reads `stj_cast`, which exists
  once `scripts/qa-cast.ts` has run.

## Browser check

On the local `stj_cast` database only, never dev Neon:

1. Start `node --env-file=.env --import tsx scripts/qa-cast.ts --serve` with the shell tool's
   **background option**, exactly as written: no `&`, no redirect, no `cd`. It resets and seeds the
   cast, builds, and serves the app on `http://localhost:8400`; cookies land in
   `scripts/qa-cast.json`. Never pass `--open`: no window may open.
2. With **headless** Playwright, signed in as each cast member the ticket matters to, walk every
   acceptance criterion. Fail the check on a console error or a failed request. At 390px wide,
   `document.documentElement.scrollWidth - innerWidth` must be 0. A walk that clicks must **wait for
   hydration** first (a selector the client renders, or the network going idle), never a bare
   timeout; and it must not depend on the weekday or the hour it runs at (`#177`: old walks failed
   on both).
3. **Save the walk as `scripts/walks/{{N}}-<short-slug>.mjs` and commit it with the ticket.** The
   phase's finish ticket re-runs every walk on the final code, and untracked walks under
   `.phase-run/tmp/` were lost to it.
4. Save screenshots at 390 and 1280 to `.impeccable/review-{{N}}/`.
5. **Stop the server** when done. Nothing may be left listening on `:8400`.

The runner also runs `next build` on any change under `src/`.

## Review

Start one `impeccable-finish-reviewer` agent. Give it the built screen (the screenshots and the
route), the approved prototype screen the ticket names, and the surface brief. Ask for an ordered
list of material mismatches. Fix the list in one batch, take a confirming look, and move on. One
round: there is no score to chase.

## Fix

- The browser check again means the ticket's committed walk under `scripts/walks/`.
