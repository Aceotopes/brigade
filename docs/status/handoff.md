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
(D1–D19), ADRs 0006–0008, spec #27, and its 15 tickets #28–#42 (sub-issues with native blocking
edges, `ready-for-agent` only, none `run-ready`). It ports a source project's verified two-lane
runner. #28 (the probe) and #41 (the release night) are attended, and #42 is the finish.

Brigade 0.6.2 (05 D1) makes the template's doc-check count only committed `.gitignore` rules, and
keeps git's racy-file re-read in the receipt's index copy. This repo runs it: the plugin is 0.6.2,
and `/update-workflow` re-copied the four changed `tools/` files. The `plugin tests` gate has
`"unreadOf": "tests"`, which does nothing while the tests row has no `unread` list.

## Next step

1. #28, the probe, attended. Its answers decide whether the rest of #27 is built as written. The
   build no longer waits for a real project's night (05's addendum, 2026-11-09, drops D17).
2. Then a phase run: #29–#40 are `run-ready` (`/ticket-check`, 2026-11-09), and the first frontier
   is #29, #31, #35 and #39. `node tools/phase-run/run.mjs --spec 27 --branch phase-two-lanes --max 4`.

## Waiting on the owner

- #28, the probe.
