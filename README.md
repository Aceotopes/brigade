# Brigade

A Claude Code plugin that runs a team of AI agents through grill → spec → tickets → an unattended
overnight build, with hooks that enforce the rules and docs that hold a budget. Named after the
kitchen brigade: the head chef sets the menu, the line cooks execute, and nothing leaves the pass
unchecked. Built while making software for a restaurant (Steak To Juan), and lifted out of it so a
new or existing project gets the workflow without hand setup.

**Source:** copied from `Aceotopes/SteakToJuan` at `main` = `905e2d8` (2026-10-27), after the
docs restructure (PR #224, devlog #339–#345). Until Steak To Juan switches onto this plugin, the
two copies can drift: a workflow fix made there after `905e2d8` has to be carried here by hand.

> 🚨 **Do not install this plugin yet.** The hooks still find the repo from their own location
> (`../..`), which inside a plugin points at the plugin, not the project; and Steak To Juan already
> runs its own copies of both hooks, so installing it there would run every check twice. Install
> once the hooks read `CLAUDE_PROJECT_DIR` and Steak To Juan has dropped its own copies.

## Layout

| Folder | What | Where it runs |
|---|---|---|
| `.claude-plugin/` | `plugin.json` (the plugin), `marketplace.json` (so `/plugin marketplace add` can install it from a git repo) | — |
| `skills/` | `doc-sync`, `ticket-check` (and, still to write, `setup-workflow`) | from the plugin, in every project |
| `hooks/` | `guard-shell.mjs` (PreToolUse), `stop-gate.mjs` (Stop), wired by `hooks.json` | from the plugin, in every project |
| `template/` | files a project keeps **in its own repo**, because CI and `node` run them there: the doc tools, the phase runner, `docs/_templates`, the workflow docs, the doc-check CI job | copied in by `/setup-workflow` |

## To do, in order

1. **One generic env contract.** `STJ_PHASE_RUN` / `STJ_PHASE_TICKET` / `STJ_PHASE_BASE` /
   `STJ_PHASE_SPEC` / `STJ_PHASE_NET_HOSTS` → `PHASE_RUN_*`, in `hooks/*.mjs`,
   `template/tools/doc-check.mjs` and `template/tools/phase-run/run.mjs` together.
2. **Hooks find the project, not themselves.** `ROOT` from `process.env.CLAUDE_PROJECT_DIR`.
   And a rule applies only to commands aimed at that project: on 2026-10-27, SteakToJuan's
   guard-shell blocked `git -C D:/HGP/brigade commit …` because SteakToJuan's devlog rule ran
   against another repo's commit. Resolve the repo a git command targets (`-C <dir>`, a leading
   `cd`) and let the project's rules pass a command for any other repo.
3. **Hook rules into a per-project config** (e.g. `.claude/workflow.json`): the formatter
   blocklist (`prettier --write`, `prisma format`), the migration rule, the spec-issues list,
   and `stop-gate`'s three commands (typecheck, lint, changed tests).
4. **`doc-check.mjs:57`'s top-level folder regex** (`design|docs|src|prisma|…`) into `doc-config.mjs`.
5. **`doc-config.mjs` becomes a skeleton**: drop Steak To Juan's paths (DESIGN.md, `.impeccable`,
   discovery rounds, `DEVLOG_TAGGED_FROM = 339` → `1`). Empty `doc-check-baseline.json`'s entries.
6. **Skills:** `ticket-check`'s repo slug from `gh repo view`; `doc-sync`'s Module 6 verbs row
   (SKILL.md ~158) out, with a slot for project-specific routing rows (e.g. a project's
   `docs/agents/doc-sync-rows.md`); its Impeccable/DESIGN.md rows conditional.
7. **The phase runner** (`template/tools/phase-run/run.mjs`, ~73 couplings): the gates
   (`pnpm typecheck/lint/test`, `next build`), the Prisma → dev Neon migration step, the
   `stj_cast` QA database and the Loyverse-token blanking into a config of commands plus an
   optional after-gates step. Same for `ticket-prompt.md`, `settings.json` and the guide.
8. **`skills/setup-workflow`**: scaffolds a new repo — CLAUDE.md skeleton, `docs/` folders with
   their generated-index markers, `template/` copied in, `test:docs`/`test:runner` scripts,
   triage labels (or defer to mattpocock's `/setup-matt-pocock-skills`), and the project's
   `Project <path> —` lines in `~/.claude/settings.json` `autoMode.environment`.
   Two parts the first version must include:
   - **An update mode** (`/setup-workflow --update`, or a separate `/update-workflow`): re-copies
     `template/`'s files into a project that already has them and **never touches its config
     files** (`doc-config.mjs`, the hook and runner config, `spec-issues.json`). A plugin update
     reaches the skills and hooks on its own, but not the template files already copied into each
     repo, so this is the only way they get a fix. It is safe only if a project never edits a
     template file: every project detail lives in config (steps 3–7 exist for that).
   - **A version stamp per project** (e.g. `.claude/workflow-version`, holding the plugin version
     the template was copied from). The update mode reads it, reports "this project is on 0.3.0",
     lists what changed since, and migrates the project's config when a new version changes a
     config format.
   - **Full support for existing projects, not just new ones** (owner's goal, 2026-10-27). Older
     repos often have loose or no rules, so setup asks the owner, per project, which way to adopt:
     - **Overwrite — a clean slate.** The workflow's layout and files replace what is there, for a
       cleaner base for future work. Safeguards: refuse to start on a dirty tree; do it on its own
       branch (e.g. `adopt-workflow`), never on `main`; move the old docs, `CLAUDE.md` and
       `.claude/` settings into an archive folder (e.g. `docs/history/pre-workflow/`) instead of
       deleting them, so nothing is lost and it can be read back; show the full list of moved and
       replaced files and get a yes before writing; carry the old `CLAUDE.md`'s real rules into
       the new one (asked one by one), not drop them.
     - **Merge — keep what is there, with safeguards.** Never overwrite an existing file: add the
       workflow's sections to `CLAUDE.md` and its hooks to `.claude/settings.json` beside the old
       ones, and show each change as a diff before writing. Point `doc-config.mjs` at where the
       docs already live rather than moving them. Write `doc-check-baseline.json` from the repo as
       it stands, so existing docs without a header or budget are accepted on day one instead of
       blocking the first commit; then add headers gradually, removing each baseline entry as its
       doc is fixed.
     Either way: detect the stack (package manager, test, lint and typecheck commands, database)
     and propose the config from it for the owner to confirm, never guess silently; and record
     which mode was used in the version stamp's file, so the update mode knows.
   - **Done only after a trial on a throwaway repo.** Steps 1–8 are tested only against Steak To
     Juan's files. Before using the plugin on a real project: an empty test repo → install the
     plugin at project scope → `/setup-workflow` → one small spec and ticket → one phase run. Then
     the same on a copy of an existing repo, once in each mode. Whatever needed a code change
     (not a config change) to work is a Steak To Juan assumption still in the "generic" part: fix
     it here.
   - **Until step 9, install at project scope only** (as Impeccable is for HubsteriaBrew). A user-
     scope install would also run in Steak To Juan, whose own hook copies would then run every
     check twice.
9. **Switch Steak To Juan onto the plugin** (after 6G merges): delete its hook and skill copies,
   install this, re-run `test:docs`, `test:runner` and a dry-run phase run.
   **Impeccable too, in the same switch.** Steak To Juan never installed Impeccable as a plugin:
   its files were copied by hand into `.claude/skills/impeccable/` and
   `.claude/agents/impeccable-*.md` on 2026-09-05 (devlog #086) and sit at **4.2.0**, while the
   real plugin (installed for HubsteriaBrew) is **4.5.0**. Delete those copies, install Impeccable
   at project scope (`impeccable@impeccable`), then run `/impeccable doctor` to report and repair
   what 4.2 → 4.5 changed. Its project files (`PRODUCT.md`, `DESIGN.md`, `.impeccable/`) belong to
   the app and stay. The phase runner's `settings.json` has six allow-rules naming
   `.claude/skills/impeccable/scripts/…`: point them at wherever the plugin keeps that script, or
   a night run's session gets a permission prompt nobody is awake to answer. After 6G only: its frontend tickets use Impeccable.

## Changing the workflow later

1. Is the change for every project, or only one? One project's need goes in that project's config;
   only a change every project would want comes here.
2. Make it here (never in a project's copy of a template file), with its test.
3. Bump `version` in `.claude-plugin/plugin.json` (installed plugins are cached per version, so an
   unbumped change may never reach a project), commit, push.
4. In each project: update the plugin (skills and hooks follow), then run the update mode if
   `template/` changed.

Not part of this plugin: Impeccable (someone else's plugin with its own versions; `/setup-workflow`
should detect a frontend project and offer to install it, never carry a copy) and the mattpocock skills
(already a user-level plugin; their setup skill covers labels and `issue-tracker.md`).
