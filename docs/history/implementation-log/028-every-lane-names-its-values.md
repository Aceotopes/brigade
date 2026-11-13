# #028 — Every lane names its values, and its gates get them

**Ticket:** `#27` (attended, before #41) · **Devlog:** `#43` · **ADRs:** 0007 (applied), none new
**Date:** 2026-11-13

---

## The Problem

Each lane must use its own test databases, QA server and QA database. A lane's values reach the
project's tools as environment variables: `PHASE_RUN_TEST_DB_PREFIX`, `PHASE_RUN_QA_PORT`,
`PHASE_RUN_QA_DATABASE`, and the row's own `env`. Two holes let one lane run on the other's:

- **The runner's own gates never got them.** `gateGroup` started each gate with only that gate's
  `env`. So lane 2's test gate, and Landing's re-gate, which runs the same gates, named lane 1's
  databases (the project's defaults), even though lane 2's session named its own. Two suites at
  once on one set of test databases collide.
- **A row could leave a value out.** The loader allowed lane 1 to have no test prefix while lane 2
  had one. A lane that names nothing gets no variable, so nothing replaces whatever it inherits.
  At the source, lane 1's agent ran on lane 2's test databases this way. The cause was never
  traced there, and the fix was the same rule: every lane names its prefix.

## The Solution

- **`run.mjs` `laneVariables(lane)`.** A lane's variables in one place: its row's `env`,
  `PHASE_RUN_LANE`, and its QA port, QA database and test prefix. It returns nothing without a
  lane. `runVariables` (the session's environment) uses it.
- **The gates get the lane's variables.** `projectGates` takes `laneEnv` and hands it to every gate
  job, over the gate's own `env`, so the lane's value wins. Both of the runner's gate runs pass it:
  a ticket's gates and Landing's re-gate. A run without lanes passes nothing, so its gates' env is
  today's.
- **`config.mjs` `parseLanes`: every lane names every lane value another lane names.** That covers
  a `testDbPrefix`, a port named `qa`, and each `env` key. Otherwise the table is refused, naming
  the row and the value. A value no lane names is fine: a project with no test databases names no
  prefix.
- **Setup:** setup already checks a yes against the runner's loader before anything is written, so
  a walk that gives only lane 2's prefix is refused there. The skill's checklist and the guide's
  sketch now give each lane its own values.

## Why This Approach

- **The rule names the data, not the leak.** The source never found how lane 2's value reached
  lane 1. A rule that each lane names its own values closes every path at once, including ones
  nobody has thought of.
- **The gates matter more than the session.** The session side needs an inherited value to go
  wrong. The gate side was simply missing the values, every time, on every lane-2 gate.
- **The lane's values win over a gate's env.** A gate that set its own test prefix would otherwise
  undo the lane's isolation.

## Alternatives turned down

- **Fill a left-out value with an empty string.** The project's tools would then have to read
  empty as "use the default", which the spec refuses (`testDbPrefix` is never set empty).
- **Fix only the gates.** That leaves the session side the source hit.

## Real bugs found along the way

The gate one above, found by reading `gateGroup`: no lane value ever reached a gate.

## What This Concretely Unblocks

- **#41:** its trial rows get a prefix each, and a trial-only gate writes what each lane's gates
  saw.

## Run by hand

None. The env is pinned with a fake job starter, and the loader's rule with fixtures.

## Assumptions made

- **`env` keys must match across lanes, not only the three named values.** A row's `env` is how a
  project gives each lane any other resource (a cache's database index), so it leaks the same way.
- **A lane's QA database needs no rule.** A lane without `qa` is given `phaseRun.qa`'s name
  explicitly, so it never inherits one.

## Common Questions

**My one-lane project names no prefix. Is it refused?** No. The rule only applies once some lane
names a value, and a run without lanes is untouched.

**Which wins, my gate's `env` or the lane's?** The lane's, for the lane's own variables.

## References

- `docs/discovery/05-brigade-0.7.0.md`, the 2026-11-13 addendum; D2, D4; ADR 0007.
- Code: `template/tools/phase-run/run.mjs` (`laneVariables`, `runVariables`, `gateGroup`,
  `projectGates`, the two gate calls), `template/tools/phase-run/config.mjs` (`parseLanes`),
  `scripts/setup.mjs`, `skills/setup-workflow/SKILL.md`, `template/docs/guides/phase-run.md`.
- Tests, written first:
  - `template/tools/phase-run/run.test.mjs`: the gates' env in a lane and without one; a source pin
    on both gate calls; lane 1's session names its own values;
  - `tests/phase-run-config.test.mjs`: the three refusals, and a table that names no lane value;
  - `tests/setup.test.mjs`: lane 2's values alone are refused at the plan;
  - `tests/phase-run-landing-lock.test.mjs`: the newest of two rows for one commit (a pin for the
    source's "older row" fix).
