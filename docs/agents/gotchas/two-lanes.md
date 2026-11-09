---
job: Phase two-lanes (Brigade 0.7.0, two lanes): the traps a session must know before touching its files.
kind: living
max-lines: 800
---
# Gotchas — Phase two-lanes: Brigade 0.7.0, two lanes

Read only the blocks your ticket names, or whose files you will touch. Every phase's file is
listed in the gotchas index, `docs/agents/gotchas/README.md`.

## The blocks

**`#29` — the lane table, `template/tools/phase-run/config.mjs` `parseLanes` / `parseLane` / `parsePorts` / `parseHotspots` (built 2026-11-09):**
- Only the runner's loader checks `lanes`, `hotspots` and a port's `name`; the hooks' loader passes
  over them on purpose (owner, 2026-11-09). pinned: `tests/phase-run-config.test.mjs`.
- `lanes` and `hotspots` are parsed last, after `ledger`, so a config without them is refused, if
  at all, by the same check as before. Keep a new section's parse after the old ones.
- A row's QA database is its `qa`, else `phaseRun.qa.name`, for every row. Code that puts a lane's
  database into the url must use the same rule, or it disagrees with the refusal. pinned: the same test.
- `assert.throws(fn, /^…/)` never matches: Node tests a RegExp against `String(error)`, which starts
  `Error: `. The lane tests use a `refusal()` helper that returns the message.
