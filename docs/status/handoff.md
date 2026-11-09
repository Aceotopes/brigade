---
job: Where things stand and the next step, for whoever picks the work up. Overwritten, not appended.
kind: living
max-lines: 120
---
# Handoff

## Where things stand

Brigade 0.6.1 is released: 0.6.0 ("measure and trim", spec #11, merged in #26) plus a fix to the
phase-run guide's override example. Its `/update-workflow` here re-copied `tools/phase-run/` and the
guide. Its config drops the tests row's
`unread` list (the doc tests read `docs/`) and adds a `phaseRun.tampering` section for
`node:test`. The runner's own version read returns 0.6.1 from `claude plugin list --json`. The
stop check's row is named `tests`, and spec #11 is closed.

Brigade 0.7.0, two lanes, is decided and specced, not built: `docs/discovery/05-brigade-0.7.0.md`
(D1–D19), ADRs 0006–0008, and spec #27 (13 proposed tickets, no ticket issues yet). It ports a
source project's verified two-lane runner.

Brigade 0.6.2 (05 D1) makes the template's doc-check count only committed `.gitignore` rules, and
keeps git's racy-file re-read in the receipt's index copy. This repo runs it: the plugin is 0.6.2,
and `/update-workflow` re-copied the four changed `tools/` files. The `plugin tests` gate has
`"unreadOf": "tests"`, which does nothing while the tests row has no `unread` list.

## Next step

1. Set up Block23GymV2 and run its first night on 0.6.2: the first real 0.6.x night, and the first
   with a Docker test database. It is 0.7.0's build gate (05 D17).
2. Then the owner runs `/to-tickets` for 0.7.0, from spec #27's proposed tickets.

## Waiting on the owner

- Block23GymV2's setup, the first real project with a Docker test database.
- 0.7.0's tickets (`/to-tickets` from spec #27), after that night.
