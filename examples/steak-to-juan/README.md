# Example: Steak To Juan's project config

Steak To Juan is the project this workflow was lifted from (`Aceotopes/SteakToJuan`, `main` =
`905e2d8`). When Brigade went generic (README steps 1–6), every rule only Steak To Juan has moved
out of the plugin and the template, into this folder, so nothing was lost. It is also a worked
example of a real project's config. Nothing here is copied into a new project.

| File | Becomes, at README step 9 | What it holds |
|---|---|---|
| `workflow.json` | `.claude/workflow.json` | The guard's block rules (prettier `--write`, `prisma format`, the dev-Neon migration rule) and the stop gate's three pnpm checks, exactly as its hooks hardcoded them |
| `doc-sync-rows.md` | `docs/agents/doc-sync-rows.md` | The doc-sync rows only it has: the Module 6 verbs table, the discovery rounds, `design/`, the Build Roadmap Artifact's structure map |

## Also needed at step 9

- **`tools/doc-config.mjs` gains two exports** before it takes Brigade's `doc-check.mjs` (step 4
  moved the folder list out of the code). Steak To Juan's values, as its doc-check hardcoded them:

  ```js
  export const PATH_ROOTS = ["design", "docs", "src", "prisma", "scripts", "test", "sync", "tools", ".github", ".claude"];
  export const PATH_EXTENSIONS = ["md", "html", "tsx", "ts", "mjs", "sql", "yml", "json", "sh", "css"];
  ```
- **`.claude/hooks/spec-issues.json` moves to `.claude/spec-issues.json`**, where Brigade's hook
  reads it.
- **The phase runner's env names change** (`STJ_PHASE_*` → `PHASE_RUN_*`, step 1), so the hooks and
  `run.mjs` must switch together, in one commit.
