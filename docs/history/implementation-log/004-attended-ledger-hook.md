# #004 — The attended ledger hook

**Ticket:** `#15` · **Devlog:** `#9` · **ADRs:** none
**Date:** 2026-11-08

---

## The Problem

The ledger (#14) priced only the nights: the runner writes one `night` row as each ticket ends.
The owner's own attended sessions, grilling, specs, reviews, a finish ticket, were never priced, so
the weekly view could not say what a week really cost. Discovery doc 04 (D3) asks for a plugin
Stop hook that adds those sessions to the same ledger: on in every set-up project, silent, never
blocking, and working even when the project's copied runner is a release behind.

## The Solution

- **`hooks/ledger.mjs`** (new), wired in `hooks/hooks.json` as a Stop group of its own (timeout
  15 s, no status line), beside the phase run's stop gate.
  - `PHASE_RUN=1` is its first statement: it exits before any import beyond node's own.
  - It records only where the project (`CLAUDE_PROJECT_DIR`, else the input's `cwd`) has
    `.claude/workflow.json` and `ledger.attended` is not `false` (`attendedOn`). The file is read
    by `hooks/workflow-config.mjs`; one that loader refuses but that parses as JSON (a project a
    release ahead) is read raw for `ledger.attended`; one that isn't JSON writes nothing.
  - It prices with the **plugin's** `template/tools/phase-run/metrics.mjs` and `prices.json`, and
    writes with the plugin's `ledger.mjs`; `brigade` is the plugin's own version
    (`scripts/versions.mjs` `pluginVersion`, from `plugin.json`). The project's
    `tools/phase-run/` is never read.
  - Per session, `.phase-run/ledger-state/<session>.json` holds `sessionCostFrom`'s state (each
    file's byte offset and counted response ids) **and** the running totals, in one file. Each
    reply prices only the bytes added since, adds them to the totals, and appends one cumulative
    `attended` row (`ticket` null, `branch` from `git branch --show-current`, null when detached).
  - **The row first, then the state**, saved as a temporary file plus a rename.
  - Everything after the `PHASE_RUN` check, the imports included, runs in one try that ends in
    `exit 0`. Nothing is printed on any path.
- **`metrics.mjs`**: `addCost(total, step)` adds two costs in nano-dollars (each model's too) and
  keeps `peakContext` as a maximum; `costUsd` is rounded only at the end.
- **`tests/helpers.mjs`**: `runHook` takes an optional plugin folder, so a test can run a copy of
  the plugin with one file altered.
- **`tests/env-contract.test.mjs`**: the hook joins the readers of `PHASE_RUN`.

## Why This Approach

**Row first, then state, with totals and offsets in one file.** The row is a snapshot of the
session's whole cost (gotcha `#14`), so a duplicate row is harmless: the views keep the latest. If
the hook dies after appending but before saving, the next reply reads the same bytes again from the
old offset and adds them to the old totals, which gives the right total again. The other order
(state first) could lose an increment for good. Keeping the offsets and the totals in the same
file, written with a rename, means they can never disagree: a half-written state can't exist, and
an unreadable one makes the hook start again from byte 0 with no totals, which is also correct.

**Plugin-local code, loaded lazily.** The hook runs in projects that may still hold a 0.5.x runner
copy, with no `sessionCostFrom` and a four-rate price list. Importing from the plugin's own
`template/` (as `version-check.mjs` imports `scripts/versions.mjs`) works whatever the project's
copy is. The imports are dynamic and inside the try, so `PHASE_RUN=1` is checked before any price
is loaded, and a module that fails to load is as silent as any other failure.

**Its own Stop group.** Claude Code runs a Stop event's groups independently; the stop gate's group
is inert outside a phase run and this one inside it. A separate group keeps the two from sharing a
timeout (the gate's is 30 minutes) and keeps a ledger failure from touching the gate.

Interview version: "The hook is an incremental reader with a checkpoint. It keeps a per-session
cursor and running totals in one atomically-renamed file, appends a cumulative snapshot before it
moves the cursor, and the ledger's readers keep only the newest snapshot per session. So a crash at
any point either repeats a write or does nothing; it never loses or double-counts cost. And because
it runs on every reply, it fails open: every path exits 0 and prints nothing."

## Alternatives turned down

- **Append increments and sum them.** A lost row would make the total wrong for good (#14's
  reason); cumulative rows survive a lost or repeated write.
- **Price the whole transcript every reply.** Simpler, but a long attended session's transcript is
  tens of megabytes read on every reply, against a 15-second timeout. The ticket asks for the
  bytes added only.
- **Keep the state beside the plugin (its data folder).** The ledger is per project, so its cursor
  is too; `.phase-run/` is already gitignored by setup.
- **An env variable pointing the hook at a test price list.** A test seam in shipped code; a test
  copies the plugin folder and alters the copy instead.
- **Record under a file that isn't JSON, with the defaults.** It may be the one saying
  `attended: false`; writing nothing honours the owner's switch.
- **(Review) Separate the leading newline from a torn ledger line.** If the 15-second timeout
  killed the hook mid-append, the next row would be glued to the torn line and `readLedger` would
  skip both. One short `appendFileSync` is very unlikely to be cut, and the next reply's row
  replaces the lost one (rows are cumulative). Changing `appendRow` is #14's code and the nights'.
- **(Review) Share the stdin parse and project root across the three hooks.** A shared module
  would need its own dynamic import here, for two lines.
- **(Review) Drop the `cwd` fallback for the project.** Kept: the other two hooks resolve the
  project the same way, and Claude Code always sets `CLAUDE_PROJECT_DIR`.
- **(Review) The 0.5.x test can only pass today.** It is a regression guard, as the ticket asks:
  an import of the project's copy would fail it.

## Real bugs found along the way

- None in shipped code. The code review (standards and spec axes) found these in this ticket's
  first draft, all fixed and tested:
  - A state file that parsed but had a file entry with no offset would throw on every later reply,
    so that session recorded nothing for good. `readState` now checks each entry, and a reading of
    the wrong shape starts again from byte 0, which gives the right total.
  - Any config the plugin's loader refused wrote nothing, so a project a release ahead (a key this
    version doesn't know) lost all its attended rows, against "doesn't care whether the project is
    in step". It now reads `ledger.attended` from the raw JSON then.
  - The append-failure test's second half ran in a fresh project; it now re-runs in the same one.
  - `addCost` listed the summed counters by hand; they now come from `emptyCost`, and the dollar
    rounding is one helper (`priceInDollars`) shared with `sessionCostFrom`.
  - `docs/development.md` lacked the new test file and still said two hooks read workflow.json.
- **Found elsewhere, not fixed here:** `appendRow` in `template/tools/phase-run/ledger.mjs` (#14's)
  assumes the file ends in a newline. A writer killed mid-append (this hook at its 15-second
  timeout) leaves a torn line, the next row is glued onto it, and `readLedger` drops both. A fix:
  start the append with a newline when the file's last byte isn't one. (#14's two notes also
  stand: a throw after `finishBuilt`'s `recordResult` records a ticket twice, and this phase's own
  nights leave no ledger rows until `/update-workflow` copies the template in.)

## What This Concretely Unblocks

- The weekly view's `attended` column now fills in set-up projects once this plugin version is
  installed.
- **#24 (finish)** checks it live: a scratch repo with `--plugin-dir`, since this repo runs the
  *installed* plugin's hooks. Owed to it: one reply in a set-up scratch repo leaves an `attended`
  row in `.phase-run/ledger.jsonl`; `ledger.attended: false` silences it; and the installed cache
  holds `template/tools/phase-run/` and `scripts/versions.mjs` beside `hooks/` (the tests prove the
  imports from this repo's layout, not from Claude Code's plugin cache).

## Run by hand

- None.

## Assumptions made

- **A `.claude/workflow.json` that isn't JSON writes nothing** (it may be the file turning the hook
  off); one the loader refuses but that parses records unless it says `ledger.attended: false`, so
  a typo like `"atended": false` still records (the guard hook refuses that file loudly anyway). To
  reverse either: `attendedOn` in `hooks/ledger.mjs`.
- **A reply that added no priced response writes no row**, and a session with nothing priced never
  gets a $0 first row. To reverse: drop the `step.cost.calls === 0` return.
- **The state lives in `.phase-run/ledger-state/<session>.json`**, the session id with anything but
  letters, digits, `_` and `-` replaced by `_`. To move it: change `STATE_DIR`.
- **`stop_hook_active` changes nothing**: a second Stop in the same reply is just another
  incremental reading.
- **`branch` comes from `git branch --show-current`** (5-second limit), null when detached or not a
  repo. To drop it: pass `branch: null`.
- **Timeout 15 seconds.** To change: `hooks/hooks.json`.
- **The docs**: a line in `docs/development.md`'s layout table, a sentence in the template's
  phase-run guide, a changelog entry.

## Common Questions

**Does it slow a reply?** It runs after the reply, in parallel with the other Stop group. A reply
reads only its own new lines, plus one `git` call.

**What happens in this repo?** Nothing yet: this repo runs the installed 0.5.2 plugin's hooks. A
release with this hook, installed, starts recording here (this repo has `.claude/workflow.json`).

**Was a browser check run?** No. Backend only: no screen changes.

## References

- Spec #11, `docs/discovery/04-brigade-0.6.0.md` D3.
- `hooks/ledger.mjs`, `hooks/hooks.json`, `template/tools/phase-run/metrics.mjs` (`addCost`).
- Tests: `tests/ledger-hook.test.mjs`, `template/tools/phase-run/measure.test.mjs`.
- Gotchas: `docs/agents/gotchas/measure-trim.md`, block `#15`.
