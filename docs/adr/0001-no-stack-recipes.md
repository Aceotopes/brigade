---
status: accepted
---
# No stack recipes: a project declares its stack, and Claude writes its config

Brigade ships no per-tool recipes (no rows for one package manager, database host or migration
tool). Projects differ too much to cover, and a wrong recipe looks authoritative, which is worse
than a blank slot. Instead a project declares its stack, from its discovery doc, as a `stack`
section in `.claude/workflow.json`: fixed keys, free values. Setup has Claude write the rest of
the config from it, following a checklist (database → the QA database and migrations, test
database → preflight and ports, storage → keeping sessions off the real bucket, package manager
→ commands and the guard's wrappers). The config loaders then check what was written, so a
mistake stops a run at preflight.

## Considered options

- **A starter set of recipes** (the common package managers, databases and hosts): consistent
  configs for those tools, but every row is code to maintain and test, and an untried row would
  have shipped unverified.
- **Recipes a project could add to** (`.claude/recipes/`): flexible, but a second format to learn
  on top of the config it produces.

## Consequences

Two projects on the same stack can get differently worded configs. The checklist and the
loaders' checks are what keep them correct, not shared rows.
