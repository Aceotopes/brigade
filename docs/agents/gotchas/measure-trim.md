---
job: Phase measure-trim (Brigade 0.6.0, measure and trim): the traps a session must know before touching its files.
kind: living
max-lines: 800
---
# Gotchas — Phase measure-trim: Brigade 0.6.0, measure and trim

Read only the blocks your ticket names, or whose files you will touch. Every phase's file is
listed in the gotchas index, `docs/agents/gotchas/README.md`.

## The blocks

**`#13` — pricing a session, `template/tools/phase-run/metrics.mjs` `sessionCost` / `sessionCostFrom` (built 2026-11-08):**
- A response that called the advisor has a top-level `usage` that leaves the advisor's pass out. Its
  requests are in `usage.iterations`: `type: "message"` at the response's model and
  `type: "advisor_message"` with its own `model`. Price the iterations, never the top-level usage
  as well, or the session's own tokens count twice. pinned: `template/tools/phase-run/measure.test.mjs`.
- The top-level `cache_creation` split does not match the iterations' (seen live: 1h 2,424 and
  5m 0 at the top, while the iterations held 2,424 at 1h and 1,936 at 5m). Read the split per
  iteration.
- Costs are whole nano-dollars (`nanoUsd`). Add those, and round only for `costUsd`: rounded
  dollars do not sum across `sessionCostFrom` steps.
- `sessionCostFrom`'s state is keyed by the resolved file path and keeps every counted response id,
  even across a rewrite. Store it as it is returned; don't trim `seen`, or a response's later line
  is counted again. pinned: `template/tools/phase-run/measure.test.mjs`.
- Edit `template/tools/phase-run/`, never the root `tools/phase-run/`: that is the pinned released
  runner, moved only by `/update-workflow`.
