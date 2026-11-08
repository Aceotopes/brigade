---
job: Where things stand and the next step, for whoever picks the work up. Overwritten, not appended.
kind: living
max-lines: 120
---
# Handoff

## Where things stand

Brigade 0.6.0 ("measure and trim") is built on `phase-measure-trim`, draft pull request #26, as
spec #11's tickets: the probe (#12) attended, twelve tickets by a phase run, and the finish (#24)
attended. The finish reviewed the phase against #11, saw the hook changes work in real Claude Code
sessions in a scratch repo, and made the shell guard read only its own part of the config.
`plugin.json` and the CHANGELOG say 0.6.0. This repo's own `tools/phase-run/` and phase-run guide
are still 0.5.2's until `/update-workflow` runs here after the release.

## Next step

1. Merge #26 with a merge commit, never a squash.
2. `claude plugin marketplace update aceotopes`, then `claude plugin update brigade@aceotopes`, in
   this repo; check the plugin cache holds `template/tools/phase-run/` and `scripts/versions.mjs`.
3. `/update-workflow` here: it re-copies the runner and the guide and offers 0.6.0's rows. Narrow
   the tests row's `unread` list then: `tests/docs-links` and `tests/no-project-specifics` read
   `docs/` and the root `.md` files.
4. `node tools/phase-run/run.mjs --spec <n> --dry-run` here, to see the version read from
   `claude plugin list --json`.

## Waiting on the owner

- The merge of #26, and closing spec #11 by hand once its tickets close.
- The first real night under 0.6.0, which proves the runner's own snapshot, gates side by side and
  tampering live.
- Block23GymV2's setup, the first real project with a Docker test database.
