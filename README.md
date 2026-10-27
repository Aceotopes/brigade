# Brigade

A Claude Code plugin that runs a team of AI agents through grill → spec → tickets → an unattended
overnight build, with hooks that enforce the rules and docs that hold a budget. Named after the
kitchen brigade: the head chef sets the menu, the line cooks execute, and nothing leaves the pass
unchecked. Built while making software for a restaurant (Steak To Juan), and lifted out of it so a
new or existing project gets the workflow without hand setup.

**Source:** copied from `Aceotopes/SteakToJuan` at `main` = `905e2d8` (2026-10-27), after the
docs restructure (PR #224, devlog #339–#345). Until Steak To Juan switches onto this plugin, the
two copies can drift: a workflow fix made there after `905e2d8` has to be carried here by hand.

> 🚨 **Do not install this plugin yet.** Steak To Juan already runs its own copies of both hooks, so
> installing it there would run every check twice. Install at project scope only, once step 8's
> throwaway-repo trial passes (the hooks read `CLAUDE_PROJECT_DIR` since step 2, and the phase
> runner reads its project's config since step 7).

## Layout

| Folder | What | Where it runs |
|---|---|---|
| `.claude-plugin/` | `plugin.json` (the plugin), `marketplace.json` (so `/plugin marketplace add` can install it from a git repo) | — |
| `skills/` | `doc-sync`, `ticket-check`, `setup-workflow`, `update-workflow` | from the plugin, in every project |
| `scripts/` | `setup.mjs`, the file work behind the two setup skills (detect, plan, apply, update, the autoMode lines), and `migrations.mjs`, each version's config format changes | from the plugin, run by those skills |
| `hooks/` | `guard-shell.mjs` (PreToolUse), `stop-gate.mjs` (Stop), wired by `hooks.json`; both read the project's `.claude/workflow.json` through `workflow-config.mjs` | from the plugin, in every project |
| `template/` | files a project keeps **in its own repo**, because CI and `node` run them there: the doc tools, the phase runner, `docs/_templates`, the workflow docs, the doc-check CI job, and blank starting copies of the project's config (`.claude/workflow.json`, `.claude/spec-issues.json`, `tools/doc-config.mjs`, `tools/doc-check-baseline.json`) | copied in by `/setup-workflow` |
| `scaffold/` | files setup writes **once**, which the project then owns and update never touches: the `CLAUDE.md` skeleton, the devlog with entry #1, the roadmap, the handoff, the issue-tracker page, the generated indexes' heads | rendered by `/setup-workflow` |
| `CHANGELOG.md` | what each version changed, which `/update-workflow` shows a project before it re-copies the template | — |
| `examples/steak-to-juan/` | Steak To Juan's own rows, moved out of the generic files (its `workflow.json` with its `phaseRun` section, its doc-sync rows, its part of the session prompt, its phase-run history), and what step 9 needs | never copied; read at step 9 |
| `tests/` | the plugin's own tests: the hooks, the env contract, the runner config as shipped, the template on day one, setup in each mode, no project's name in the generic half | `node --test tests/*.test.mjs`, from here |

The template's tests run from `template/`: `node --test tools/doc-tools.test.mjs` and
`node --test tools/phase-run/run.test.mjs`.

## Done (2026-10-27)

1. ✅ **One generic env contract**: `PHASE_RUN`, `PHASE_RUN_TICKET`, `PHASE_RUN_BASE`,
   `PHASE_RUN_SPEC`, `PHASE_RUN_NET_HOSTS`, in the hooks, doc-check and run.mjs together.
   `tests/env-contract.test.mjs` keeps the two halves in step.
2. ✅ **Hooks find the project, not themselves**: the project is `CLAUDE_PROJECT_DIR`. guard-shell
   resolves the folder each command is aimed at (`cd`, `Set-Location`, `pushd`, git's `-C`, quoted
   and Git Bash paths); the project's rules pass a command aimed at another repo, the owner's rules
   (no `--no-verify`, no trailer) hold everywhere, and inside a phase run every rule holds for every
   command. A folder the shell computes (`cd $X`) keeps the project's rules on. No
   `tools/doc-check.mjs` in the project, no doc-check. Not resolved: `gh --repo`, paths passed as
   arguments.
3. ✅ **Hook rules in `.claude/workflow.json`**: block rules (`command` or `text`, optional `with`
   and `unless`, `when: always | phase-run`) and the stop gate's checks (`{base}` filled in). A
   broken file fails closed. The spec list stays its own file, now `.claude/spec-issues.json`.
   Steak To Juan's rows are in `examples/steak-to-juan/workflow.json`. Still a habit in code: the
   wrapper stripping knows `pnpm` and `npx`, not `yarn` or `bun`.
4. ✅ **doc-check's folder list** is `PATH_ROOTS` / `PATH_EXTENSIONS` in `doc-config.mjs`.
5. ✅ **Blank starting copies**: `doc-config.mjs` holds the workflow's own layout only,
   `DEVLOG_TAGGED_FROM = 1`; the baseline holds only the template's own two lines; no specs.
   `tests/template.test.mjs` proves the template passes doc-check on day one, given the files
   setup must write (its `SETUP_WRITES` list is step 8's contract).
6. ✅ **Skills**: ticket-check reads the repo from `gh api repos/{owner}/{repo}/…`; doc-sync reads a
   project's `docs/agents/doc-sync-rows.md` first; Impeccable rows are conditional; Steak To Juan's
   rows are in `examples/steak-to-juan/doc-sync-rows.md`. `tests/no-project-specifics.test.mjs`
   bans its names from the generic half.
7. ✅ **The phase runner reads its project's config**: `phaseRun` in `.claude/workflow.json`, loaded
   and checked by `template/tools/phase-run/config.mjs` (preflight rows, ports, the QA database,
   pinned session env, the stray test process, gates in order with `when`/`env`/`alone`, the
   browser check, migrations with a target, always-in-scope files, extra permissions, and a prompt
   file whose `## ` sections are spliced into the session's prompt). Each placeholder is allowed
   only where it makes sense, so a gate cannot reach the migration target. A mistake there stops
   the run at preflight, dry runs too (the hooks skip that section). `settings.json` holds only
   the rules every project needs; a session may not edit the config, the spec list or the prompt
   file. Steak To Juan's values, prompt prose and guide history are in `examples/steak-to-juan/`,
   and `tests/phase-run-config.test.mjs` proves its example holds what run.mjs hardcoded.
8. ✅ **`/setup-workflow` and `/update-workflow`** (0.2.2): `scripts/setup.mjs` does the file work
   (detect → plan → apply; update; the autoMode lines) and the skills do the talking. New, overwrite
   (on branch `adopt-workflow`, old files archived under `docs/history/pre-workflow/`) and merge (never
   overwrites; a doc-check `headers` baseline that only shrinks). `template/` is re-copied by update,
   `scaffold/` is written once and only reported when it changes, config is never touched; the stamp is
   `.claude/workflow-version.json`. Setup never commits. Trials on 2026-10-27, in
   `D:\HGP\brigade-trials\`: an empty repo end to end (setup, a real phase run, its pull request,
   an update, the attended finish, the merge) and block23-gym clones in overwrite and merge, run
   again on fresh clones under 0.2.2. Their fixes are 0.2.1 and 0.2.2 in CHANGELOG.md. Not yet seen:
   a generated `checks.yml` running on GitHub.
   **Until step 9, install at project scope only**: a user-scope install would also run in Steak To
   Juan, whose own hook copies would then run every check twice.

## To do, in order

9. **Switch Steak To Juan onto the plugin** (after 6G merges, between phases): delete its hook and
   skill copies, install this, copy in `examples/steak-to-juan/`'s files as its README says (the
   config, the prompt prose, the history, the doc-config exports, the renamed run-state files),
   re-run `test:docs`, `test:runner` and a dry-run phase run.
   **Impeccable too, in the same switch.** Steak To Juan never installed Impeccable as a plugin:
   its files were copied by hand into `.claude/skills/impeccable/` and
   `.claude/agents/impeccable-*.md` on 2026-09-05 (devlog #086) and sit at **4.2.0**, while the
   real plugin (installed for HubsteriaBrew) is **4.5.0**. Delete those copies, install Impeccable
   at project scope (`impeccable@impeccable`), then run `/impeccable doctor` to report and repair
   what 4.2 → 4.5 changed. Its project files (`PRODUCT.md`, `DESIGN.md`, `.impeccable/`) belong to
   the app and stay. Steak To Juan's `phaseRun.permissions` (its example `workflow.json`) has six allow-rules naming
   `.claude/skills/impeccable/scripts/…`: point them at wherever the plugin keeps that script, or
   a night run's session gets a permission prompt nobody is awake to answer. After 6G only: its frontend tickets use Impeccable.

## Changing the workflow later

1. Is the change for every project, or only one? One project's need goes in that project's config;
   only a change every project would want comes here.
2. Make it here (never in a project's copy of a template file), with its test.
3. Bump `version` in `.claude-plugin/plugin.json` (installed plugins are cached per version, so an
   unbumped change may never reach a project), commit, push.
4. In each project: update the plugin (skills and hooks follow), then run `/update-workflow` if
   `template/` changed.

Not part of this plugin: Impeccable (someone else's plugin with its own versions; `/setup-workflow`
should detect a frontend project and offer to install it, never carry a copy) and the mattpocock skills
(already a user-level plugin; their setup skill covers labels and `issue-tracker.md`).
