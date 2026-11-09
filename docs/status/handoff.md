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
stop check's row is named `tests`, and spec #11 is closed.

Brigade 0.7.0, two lanes, is decided, not built: `docs/discovery/05-brigade-0.7.0.md` (D1–D19)
and ADRs 0006–0008. It ports a source project's verified two-lane runner.

Brigade 0.6.2 (05 D1) makes the template's doc-check count only committed `.gitignore` rules, and
keeps git's racy-file re-read in the receipt's index copy. This repo's pinned `tools/` copy is
still 0.6.1's until `/update-workflow`.

## Next step

1. Update this machine's plugin to 0.6.2 (`claude plugin marketplace update aceotopes`, then
   `claude plugin update brigade@aceotopes --scope project`), and run `/update-workflow` here in a
   fresh session.
2. Set up Block23GymV2 and run its first night on 0.6.2: the first real 0.6.x night, and the first
   with a Docker test database. It is 0.7.0's build gate (05 D17).
3. Then the owner runs `/to-spec` and `/to-tickets` for 0.7.0, from 05's proposed tickets.

## Waiting on the owner

- Block23GymV2's setup, the first real project with a Docker test database.
- 0.7.0's spec and tickets (`/to-spec`, `/to-tickets`), after that night.
