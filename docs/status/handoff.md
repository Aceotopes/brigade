---
job: Where things stand and the next step, for whoever picks the work up. Overwritten, not appended.
kind: living
max-lines: 120
---
# Handoff

## Where things stand

Brigade 0.6.1 is released: 0.6.0 ("measure and trim", spec #11, merged in #26) plus a fix to the
phase-run guide's override example. This repo runs it: the plugin is 0.6.1 at project scope, and
`/update-workflow` re-copied `tools/phase-run/` and the guide. Its config drops the tests row's
`unread` list (the doc tests read `docs/`) and adds a `phaseRun.tampering` section for
`node:test`. The runner's own version read returns 0.6.1 from `claude plugin list --json`.

## Next step

1. Start a fresh Claude Code session here, so 0.6.1's hooks are the ones running.
2. Then add `"name": "tests"` to the stop check's row in `.claude/workflow.json`. A 0.5.2 hook
   refuses that key, so it waits for the restart.
3. The next phase's first night is the first real 0.6.0 night: it proves the runner's own snapshot,
   gates side by side and the tampering gate live.

## Waiting on the owner

- Closing spec #11 by hand; its tickets are closed.
- Block23GymV2's setup, the first real project with a Docker test database.
