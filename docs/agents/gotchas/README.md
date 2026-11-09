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
- `#19` gates side by side, `template/tools/phase-run/run.mjs` `gatePlan` / `gateGroup` / `projectGates` / `startJob`, `config.mjs` `gateReferences` / `gateOrder`
- `#18` update's offers, `scripts/setup.mjs` `ROW_OFFERS` / `rowOffers` / `refresh` `onlyAccepted`, `update` `offers`
- `#20` the tampering gate, `template/tools/phase-run/tampering.mjs` `tamperingVerdict` / `patchFiles` / `namesPath`, `config.mjs` and `hooks/workflow-config.mjs` `tamperingRules`
- `#21` trim, `template/tools/phase-run/trim.mjs` `readTrim` / `trimEntries` / `withTrim`, `run.mjs` `trimmedSettings` / `printArgs` / `backgroundArgs`
- `#22` setup's tool rows, `scripts/setup.mjs` `roleMatcher` / `unreadWarnings`, `template/tools/phase-run/unread-scan.mjs` `unreadScan` / `pathOf`
- `#25` one run, one Brigade version, `template/tools/phase-run/brigade.mjs` `brigadeCatalog` / `withAutoUpdateOff` / `installedBrigade` / `versionStop`, `run.mjs` `sessionSettings` / `main`, `snapshot.mjs` `takeSnapshot`
- `#23` the compose scan, `scripts/setup.mjs` `parseCompose` / `composeLines` / `COMPOSE_FILES`, `detect` `compose`, `refresh`'s `compose`
- `#24` the finish: the guard's own part, `hooks/workflow-config.mjs` `parseGuard` / `loadJudgeGuard`, `version-check.mjs` `configLine`, `run.mjs` `runnerFile`, `tampering.mjs` `givesReason`

**[Gotchas — Phase two-lanes: Brigade 0.7.0, two lanes](two-lanes.md)**
- `#29` the lane table, `template/tools/phase-run/config.mjs` `parseLanes` / `parseLane` / `parsePorts` / `parseHotspots`
- `#30` hotspots and unnumbered entries, `template/tools/phase-run/numbering.mjs` `numberLane` / `scratchFor`, `template/tools/doc-check.mjs` `unnumberedProblems`, `run.mjs` `laneNumbers` / `runVariables`
- `#31` the snapshot carries doc-check, `template/tools/phase-run/snapshot.mjs` `docTools` / `runnerCode`, `template/tools/doc-lib.mjs` `TOOLS_ROOT` / `checkedRoot`, `run.mjs` `docCheck`, `hooks/guard-shell.mjs`
- `#32` the lane declaration, `template/tools/phase-run/ticket-size.mjs` `laneProblems`, `skills/ticket-check/SKILL.md`, the ticket template
- `#33` the worktree, `template/tools/phase-run/lane.mjs`, `run.mjs` `work` / `sessionState` / `runVariables` / `main`, `config.mjs` `laneQaUrl`
- `#34` the claim and the frontier, `template/tools/phase-run/claim.mjs` `withClaimLock` / `takeClaim` / `laneChoice` / `claimNext` / `builtOn`, `run.mjs` `nextTicket` / `builtRef`
<!-- generated:end gotchas -->
