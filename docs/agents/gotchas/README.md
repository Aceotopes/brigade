---
job: The traps each phase found, one file per phase, read by the tickets that name them.
kind: generated
---
# Gotchas

One file per phase, `<phase>.md` (or where `tools/doc-config.mjs`'s `GOTCHAS_FILE` puts it), from
`docs/_templates/gotchas-phase.md`: only the traps the code, the ADRs and the roadmap don't make
plain. The index below is generated.

<!-- generated:start gotchas -->
**[Gotchas — Phase dogfood: Brigade on itself](dogfood.md)**
- `#9` setup's Node test gates, `scripts/setup.mjs` `detect` / `stackChecks`

**[Gotchas — Phase measure-trim: Brigade 0.6.0, measure and trim](measure-trim.md)**
- `#13` pricing a session, `template/tools/phase-run/metrics.mjs` `sessionCost` / `sessionCostFrom`
- `#14` the ledger, `template/tools/phase-run/ledger.mjs` `ledgerRow` / `appendRow`, `run.mjs` `recordNight`
- `#15` the attended ledger hook, `hooks/ledger.mjs` `record` / `readState` / `attendedOn`, `metrics.mjs` `addCost`
- `#16` the runner snapshot, `template/tools/phase-run/snapshot.mjs`, `hooks/workflow-config.mjs` `judgeRoot` / `loadJudgeConfig`
- `#17` per-check receipts, `template/tools/phase-run/unread.mjs` `unreadMatcher`, `receipt.mjs` `treeKeys` / `receiptGroups`, `hooks/stop-gate.mjs`
<!-- generated:end gotchas -->
