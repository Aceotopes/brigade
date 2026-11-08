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
`node:test`. The runner's own version read returns 0.6.1 from `claude plugin list --json`. The
stop check's row is named `tests`, and spec #11 is closed. No next phase is planned here.

## Next step

1. Set up Block23GymV2 and run its first night: the first real 0.6.x night, and the first with a
   Docker test database. It proves the runner's own snapshot, gates side by side, the tampering
   gate and setup's compose-file reuse live.
2. Bring what that night shows back here as the next spec, then fill the roadmap's tables and
   publish its first page.

## Waiting on the owner

- Block23GymV2's setup, the first real project with a Docker test database.
