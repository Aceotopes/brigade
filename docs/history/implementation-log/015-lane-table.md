# #015 — The lane table: two lanes as config, checked at preflight

**Ticket:** `#29` · **Devlog:** `#30` · **ADRs:** none new (0006's hotspot kinds, loaded only)
**Date:** 2026-11-09

---

## The Problem

0.7.0 lets a second runner, a lane, build beside the first. Each lane needs its own resources: a
worktree, ports, a QA database, a test-database prefix, and anything else the project shares. Those
are one project's facts, so they must be data in `.claude/workflow.json`, not values in code (D2,
D3). Before any lane can run, the runner's loader has to accept that data and refuse a bad table at
preflight, the way it already refuses every other `phaseRun` mistake. A project with no lanes must
load exactly as before.

## The Solution

All of it is in the runner's loader, `template/tools/phase-run/config.mjs`. Nothing runs a lane yet.

- **`phaseRun.lanes`**: `rows`, `claims`, `worktreeSetup` and `landing`. `parseLanes` reads each row
  (`id`, `takes`, `worktree`, `qa`, `ports`, `testDbPrefix`, `env`) through `parseLane`, then checks
  the rows against each other.
- **`phaseRun.hotspots`**: `token` and `rows` of `{ path, kind }`, where `kind` is one of
  `HOTSPOT_KINDS` (`log`, `generated`, `own-file`). `parseHotspots` only loads and checks them; what
  each kind does is #30's.
- **A port row's `name`**: the port-row code moved into one `parsePorts`, used by `phaseRun.ports`
  and by a lane row's `ports`. So "in `phaseRun.ports`' shape" is true by construction, not by two
  copies kept alike.
- **The refusals**, each naming the field it is about:
  - a third row, past `MAX_LANES = 2`;
  - a second row whose `takes` is `"any"`, with a message that names the upgrade 0.7.0 leaves out of
    scope;
  - two rows on one QA database, where a row's database is its `qa`, else `phaseRun.qa.name`;
  - a row `qa` with no port named `qa`, or with no `phaseRun.qa` section to put it in;
  - a `testDbPrefix` set empty, or not a lowercase identifier (`^[a-z][a-z0-9_]*$`), or one that
    starts another lane's (`lane` and `lane2_`), so it would match that lane's databases too;
  - an unknown key anywhere in the new sections and rows;
  - two rows with one id, one worktree, or one port number, and two ports named alike in one list.
- **No lanes, as before.** With no section, `lanes` and `hotspots` are `null`, as `qa` and
  `migrations` already are, and each port row's `name` is `null`. The new sections are parsed after
  everything else, so a config without them is refused, if at all, by the same check as before.

The hooks' loader (`hooks/workflow-config.mjs`) is unchanged: it already passes over `phaseRun`'s
keys except the gates' references and the tampering section. A hook-seam test shows that a two-lane
config, and even a lane table the runner refuses, loads there exactly as an empty config does.

## Why This Approach

**Validate at the boundary, once.** The runner reads the config at preflight and nowhere else
trusts it raw. If every refusal lives in the loader, a later ticket's code (#33 starting a lane, #34
claiming a ticket) can assume a well-formed table and stay simple. In an interview: "I parse, don't
validate: the loader turns untrusted JSON into a typed object or a named error, so the rest of the
code never re-checks it."

**Row-generic checks.** Each cross-row check compares a row with the rows before it, not "lane 1
versus lane 2". The cap of two is one constant. Lifting it later changes that line and nothing else
(D5).

**One rule for the QA database.** The ticket says lane 1 without a `qa` uses `phaseRun.qa`'s own
database. Applying that same rule to every row ("its `qa`, else `phaseRun.qa.name`") means two rows
that both leave `qa` out are refused too. Otherwise two lanes would quietly share one database, the
exact thing the refusal exists to stop.

**Only the runner checks lanes.** No hook reads lane config, so the hooks don't check it (the owner's
call on this ticket). The trade-off: a broken lane table is caught at preflight, not by a hook in an
attended session. That is fine, because only the runner acts on it.

## Alternatives turned down

- **A new `lanes.mjs` module.** It would read well, but config.mjs imports nothing the stop-tests
  copy lacks (the comment at `parseKeep`), and a new import would need adding to that copy.
- **Leaving the new keys off the result when the section is absent** (the strictest "byte for
  byte"). The module's convention is `null` for an absent section, and no code serializes the
  config. The existing tests, unchanged, are the ticket's own measure, and they pass.
- **Putting a default token (`NNN`) in `hotspots.token` now.** The token is #30's, so `token` loads
  as given, or `null`.
- **Checking the lane keys in the hooks' loader too**, as D3 first said. The owner decided against it
  on 2026-11-09.

From the code review (standards and spec, both against #29), these were fixed in the same commit:
`noKeysYet` now keeps the keys it checks, so #34 and #36 only add theirs to `KEYS`. Before, it
returned `{}` whatever was written. Two lanes may no longer share or overlap a `testDbPrefix` (spec
#27, story 5). The "lowercase word" refusals name their characters, and the devlog gives counts.
These were turned down:
- **Unrequested refusals** (a shared id, worktree or port; empty `rows`; path and token shapes; no
  placeholders in a lane's `env`). Each closes a way two lanes could collide, or rejects a value no
  later ticket could use. Each is one check, listed under Assumptions, and easy to drop.
- **Exports nothing imports yet** (`MAX_LANES`, `ANY_TICKET`, `HOTSPOT_KINDS`). #30, #32 and #34 read
  them, and the tests spell the values out on purpose, so a changed constant shows in a test.
- **One "seen before" helper** for ports, rows and cross-lane ports, and passing only `qa?.name`
  into `parseLanes`. These are judgement calls, and they would make the code less clear, not more.
- **Two "lowercase word" patterns** (a lane id may start with a digit, a port name may hold `_`).
  The messages now say which characters each takes; one shared pattern would refuse `--lane 2`.

## Real bugs found along the way

None in shipped code. One test trap: `assert.throws` with a RegExp matches `String(error)`, which
starts `Error: `, so a `^`-anchored pattern never matches. The new tests read the message itself.

## What This Concretely Unblocks

- #30 gets the loaded `phaseRun.hotspots`: the rows and the kinds, and the token if one is set.
- #33 gets the loaded lane rows: each one's worktree, its ports with names, `qa`, `testDbPrefix`
  and `env`, plus `worktreeSetup`. Still owed there: nothing checks that `phaseRun.qa.url` holds
  `qa.name`, the spot a lane's database would replace. #33 decides how the url takes a lane's database
  and refuses a url it can't rewrite. Nothing here stops a row's `env` from naming a reserved
  `PHASE_RUN_*` variable either: #33 owns the lane env, so it should refuse one. And `worktree` is
  required on every row, lane 1's too. If lane 1 runs in the primary checkout, #33 relaxes that.
- #34 and #36 get `claims` and `landing` as sections with no keys yet. Each adds its own to
  `KEYS.claims` / `KEYS.landing`.
- #32 reads `takes`: any non-blank text, not checked against the project's labels.
- #40 proposes the first rows. None ship in the blank or the example config.
- #30 decides whether a hotspot `path` is a glob or an exact path. This ticket only checks that it
  is a path from the repo's root.

## Run by hand

None. Backend-only (a config loader), so no browser check.

## Assumptions made

Each is a small choice, easy to change:
- **A row's QA database is its `qa`, else `phaseRun.qa.name`** (the example's url ends in that
  name). To reverse it, apply the fallback to the first row only, in `parseLanes`' `database`.
- **A row `qa` needs a `phaseRun.qa` section.** Drop that check in `parseLane` if a lane may name a
  database with nowhere to put it.
- **Safe `testDbPrefix`: `^[a-z][a-z0-9_]*$`.** Widen the pattern in `testDbPrefix` if a project's
  test databases use another alphabet.
- **Lane `id`**: a whole number of 1 or more, or a lowercase word, kept as text, used once. **`worktree`**:
  required text, used once. Change these in `laneId` and the `parseLane` call.
- **`claims` and `landing` take no keys yet** (only `note`), so a typo is refused now. #34 and #36
  add theirs.
- **`worktreeSetup`**: `copy` and `leaves` are paths from the repo's root, `commands` are command
  lines, each part optional. Lane `env` takes no placeholders.
- **Hotspot rows are `{ path, kind }`**, `path` from the repo's root; a file on no row is left to
  git, so `git` is not a kind. #30 may rename the field.
- **Cross-row refusals the ticket implies**: the same id, worktree or port number in two rows, and
  a `testDbPrefix` that starts another row's. Each is one check in `parseLanes`.

## Common Questions

**Why is lane 1 allowed to leave `testDbPrefix` out, but a row may not set it empty?** Left out
means "use the project's own test-database names", which is what one lane does today. An empty
prefix would be matched by every test database, so a lane cleaning up "its" databases could drop
the other lane's.

**Why refuse a second `any` row?** Two lanes that both take any ticket would need the runner to keep
their Areas from overlapping. That upgrade is out of scope in 0.7.0, so the message says so instead
of failing later in a confusing way.

## References

- `docs/discovery/05-brigade-0.7.0.md`: D2–D6 and "For the spec".
- Spec #27, "Names and config (D2–D5)".
- Code: `template/tools/phase-run/config.mjs` `parseLanes` / `parseLane` / `parsePorts` /
  `parseHotspots`. Tests: `tests/phase-run-config.test.mjs`.
