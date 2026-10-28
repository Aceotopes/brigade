# Example: Steak To Juan's project config

Steak To Juan is the project this workflow was lifted from (`Aceotopes/SteakToJuan`, `main` =
`905e2d8`). When Brigade went generic (Brigade's build steps 1–6), every rule only Steak To Juan has moved
out of the plugin and the template, into this folder, so nothing was lost. It is also a worked
example of a real project's config. Nothing here is copied into a new project.

| File | Becomes, at the switch onto Brigade | What it holds |
|---|---|---|
| `workflow.json` | `.claude/workflow.json` | The guard's block rules (prettier `--write`, `prisma format`, the dev-Neon migration rule) and the stop gate's three pnpm checks, exactly as its hooks hardcoded them; and `phaseRun`, everything its phase runner hardcoded (the pnpm gates, `next build`, Docker, ports 8400/3000, `stj_cast`, the Loyverse placeholder, Prisma → dev Neon, its shared registries, its allow rules) |
| `doc-sync-rows.md` | `docs/agents/doc-sync-rows.md` | The doc-sync rows only it has: the Module 6 verbs table, the discovery rounds, `design/`, the Build Roadmap Artifact's structure map |
| `phase-run-prompt.md` | `docs/agents/phase-run-prompt.md` (it already has its header) | Its part of each session's prompt: the Impeccable steps, its `CLAUDE.md` rule list, its schema and database bullets, the qa-cast browser walk, the finish reviewer |
| `phase-run-history.md` | `docs/history/phase-run-history.md` (a frozen record) | The owner's guide's history sections: the trial, 6B's to 6D's nights, the dated fixes |

## Also needed at the switch

- **`tools/doc-config.mjs` gains two exports** before it takes Brigade's `doc-check.mjs` (step 4
  moved the folder list out of the code). Steak To Juan's values, as its doc-check hardcoded them:

  ```js
  export const PATH_ROOTS = ["design", "docs", "src", "prisma", "scripts", "test", "sync", "tools", ".github", ".claude"];
  export const PATH_EXTENSIONS = ["md", "html", "tsx", "ts", "mjs", "sql", "yml", "json", "sh", "css"];
  ```

  And a third, since 0.2.1: Brigade's gotchas files are flat by default, and Steak To Juan keeps
  one folder per module, so the current module's folder is named (changed when a module starts):

  ```js
  export const GOTCHAS_FILE = "docs/agents/gotchas/module-6/{phase}.md";
  ```
- **`.claude/hooks/spec-issues.json` moves to `.claude/spec-issues.json`**, where Brigade's hook
  reads it.
- **The phase runner's env names change** (`STJ_PHASE_*` → `PHASE_RUN_*`, step 1), so the hooks and
  `run.mjs` must switch together, in one commit.
- **Switch between phases, not mid-phase** (step 7). The runner's state files were renamed:
  `.phase-run/dev-endpoint` → `migration-target` (now the host, not the Neon endpoint id: delete
  the old file once, and the first run records the new one), `<branch>/neon-applied.json` →
  `migrations-applied.json`, and a result's `leftOnNeon` → `leftOnTarget`. A branch that is
  half-built across the switch would lose its record of what dev Neon already has.
