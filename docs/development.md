# Working on Brigade

For changing Brigade itself: what each folder is, how to test it, how it was built, and how to
release a change. Using Brigade in a project is the [guide](guide.md).

## Layout

| Folder | What | Where it runs |
|---|---|---|
| `.claude-plugin/` | `plugin.json` (the plugin) and `marketplace.json` (so `claude plugin marketplace add` can install it from this repo) | — |
| `skills/` | `doc-sync`, `ticket-check`, `setup-workflow`, `update-workflow`, `roadmap` (with `page.html`, the roadmap page's template) | From the plugin, in every project |
| `hooks/` | `guard-shell.mjs` (PreToolUse) and `stop-gate.mjs` (Stop), wired by `hooks.json`. Both read the project's `.claude/workflow.json` through `workflow-config.mjs` | From the plugin, in every project |
| `scripts/` | `setup.mjs`, the file work behind the two setup skills (detect, propose, plan, apply, verify, update, refresh, docker, automode, labels); `roadmap.mjs`, the roadmap's GitHub check and its page; `migrations.mjs`, each version's config format changes | From the plugin, run by those skills |
| `template/` | Files a project keeps **in its own repo**, because CI and `node` run them there: the doc tools, the phase runner, `docs/_templates`, the workflow docs, the doc-check CI job, and blank starting copies of the config | Copied in by `/setup-workflow`, re-copied by `/update-workflow` |
| `scaffold/` | Files setup writes **once**, which the project then owns: the `CLAUDE.md` skeleton, the devlog with entry #1, the roadmap, the handoff, the issue-tracker page, the generated indexes' heads | Rendered by `/setup-workflow` |
| `examples/` | A worked example of one real project's config: its `workflow.json` with a full `phaseRun`, its doc-sync rows and its session prose | Never copied; read for reference |
| `tests/` | The plugin's own tests (below) | From this repo |
| `docs/` | This file and the user guide | — |

## Tests

From the repo root:

```
node --test tests/*.test.mjs
```

From `template/`:

```
node --test tools/doc-tools.test.mjs
node --test tools/phase-run/run.test.mjs tools/phase-run/measure.test.mjs
```

| Test file | What it holds in place |
|---|---|
| `tests/guard-shell.test.mjs`, `tests/stop-gate.test.mjs` | The hooks' rules, which folder a command is aimed at, the stop check's receipt skip, and its log row as the runner reads it |
| `template/tools/phase-run/measure.test.mjs` | The runner's measuring and its night-run table: cost and time split, the receipt, quiet test output, the waits, the size budget, and a prompt that never pauses for a fixed time |
| `tests/workflow-config.test.mjs` | The `.claude/workflow.json` format: every key checked, a broken file fails closed |
| `tests/env-contract.test.mjs` | The phase-run environment variables, the same in the hooks, doc-check and the runner |
| `tests/phase-run-config.test.mjs` | The runner's config loader, and that the example holds what the runner once hardcoded |
| `tests/template.test.mjs` | The template, with the scaffold, passes doc-check on day one |
| `tests/setup.test.mjs` | Setup in each mode, the stack, refresh, update, automode, on fixture repos |
| `tests/roadmap.test.mjs` | `/roadmap`'s script against a stubbed `gh`: the status changes, the rewrite, the page's data and the filled page |
| `tests/no-project-specifics.test.mjs` | No project's name in the generic half (`skills`, `hooks`, `template`, `scaffold`, `scripts`) or in these docs |
| `tests/unbound-calls.test.mjs` | No call to a name nothing defines or imports (the 0.2.1 crash) |
| `tests/docs-links.test.mjs` | Every relative link in `README.md` and `docs/` resolves |

## How it was built

Brigade began as one app's in-repo workflow, copied out on 2026-10-27, and was made generic in
these steps:

1. **One generic env contract.** `PHASE_RUN`, `PHASE_RUN_TICKET`, `PHASE_RUN_BASE`,
   `PHASE_RUN_SPEC` and `PHASE_RUN_NET_HOSTS`, the same in the hooks, doc-check and `run.mjs`.
2. **Hooks find the project, not themselves.** The project is `CLAUDE_PROJECT_DIR`.
   - guard-shell resolves the folder each command is aimed at: `cd`, `Set-Location`, `pushd`,
     git's `-C`, and quoted and Git Bash paths.
   - A project's rules pass a command aimed at another repo. The owner's rules hold everywhere.
   - Inside a phase run, every rule holds for every command.
3. **Hook rules as data**, in `.claude/workflow.json`:
   - block rules (`command` or `text`, an optional `with` and `unless`, and `when`);
   - the stop gate's checks.

   A broken file fails closed.
4. **doc-check's folder list moved into config:** `PATH_ROOTS` and `PATH_EXTENSIONS` in
   `doc-config.mjs`.
5. **Blank starting copies.** The template holds only the workflow's own layout, and passes
   doc-check on day one.
6. **Generic skills.**
   - ticket-check reads the repo from `gh`.
   - doc-sync reads a project's own rows from `docs/agents/doc-sync-rows.md` first.
   - The test that bans one project's names started here.
7. **The phase runner reads its project's config.** `phaseRun` is loaded and checked by
   `template/tools/phase-run/config.mjs`: preflight, ports, the QA database, pinned env, gates,
   the browser check, migrations, extra permissions and a prompt file spliced in by section. Each
   placeholder is allowed only where it makes sense, and a mistake stops the run at preflight.
8. **`/setup-workflow` and `/update-workflow`** (0.2.0 to 0.2.2): new, overwrite and merge modes,
   the stamp, and update.
   - Proven on throwaway repos: an empty one end to end, and copies of an existing app in both
     existing-repo modes.
   - The trials' fixes are 0.2.1 and 0.2.2 in the [CHANGELOG](../CHANGELOG.md).
9. **0.3.0, the rungs above a phase** (2026-10-28), planned as Brigade's own discovery doc and
   built in four phases, each grilled first:
   - A, the ladder: discovery docs, modules, `GLOSSARY.md`;
   - D, the design rung: Phase 0's shell, sample data, prototypes, screen briefs;
   - B, the stack and setup: `stack`, `guard.wrappers`, the refresh, the Docker check;
   - C, `/roadmap` and its page.
   - Proven by a fresh-project trial through every rung, which found the runner's folder-trust
     failure and a doc-budget gap; both are fixed with tests.
   - The decisions are in the [0.3.0 discovery doc](discovery/01-brigade-0.3.0.md), the terms in
     the [glossary](../GLOSSARY.md), and the two lasting choices in
     [ADR 0001](adr/0001-no-stack-recipes.md) and [ADR 0002](adr/0002-roadmap-repo-is-truth.md).
10. **0.4.0, the runner's night** (2026-10-28, unreleased): a port of the runner upgrades one real
    project built after profiling a 14-ticket night. Each ticket is measured (cost at API rates,
    the time split), the run's terminal is a table, the stop check trusts a tests-passed receipt,
    sessions wait on things instead of the clock, and tickets get a size budget. The decisions
    are in the [0.4.0 discovery doc](discovery/02-brigade-0.4.0.md), the receipt's trust in
    [ADR 0003](adr/0003-stop-check-trusts-a-receipt.md).

## Changing the workflow

1. **Is the change for every project, or one?** One project's need goes in that project's config.
   Only a change every project would want goes here.
2. **Make it here**, never in a project's copy of a template file, with its test.
3. **Release it:**
   - bump `version` in `.claude-plugin/plugin.json` (installed plugins are cached per version, so
     an unbumped change may never reach a project);
   - add a `CHANGELOG.md` entry, which `/update-workflow` shows a project;
   - if a config file's format changes, add its migration to `scripts/migrations.mjs`;
   - then commit and push.
4. **In each project:** update the plugin (skills and hooks follow), then run `/update-workflow`
   if `template/` or `scaffold/` changed.

## Not part of Brigade

- **Impeccable** is someone else's plugin, with its own versions. Setup offers to install it for a
  frontend and never carries a copy.
- **The mattpocock skills** are their own plugin. `/setup-matt-pocock-skills` covers the triage
  labels and `docs/agents/issue-tracker.md`.
