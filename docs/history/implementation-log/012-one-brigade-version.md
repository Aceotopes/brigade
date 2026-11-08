# #012 — One run, one Brigade version

**Ticket:** `#25` · **Devlog:** `#17` · **ADRs:** 0005 (one run, one judge)
**Date:** 2026-11-08

---

## The Problem

A phase run is many sessions started hours apart, and Brigade's hooks judge each one: the stop gate,
the shell guard, the version check. #16 froze the runner's code and config for the whole run, but
the hooks come from whichever Brigade version is installed when each session starts. If Brigade
updated between two tickets, the rest of the night was judged by other hooks, and the morning
report couldn't show it. One case is real in 0.6.0: its `receipt.mjs` drops `receiptUnread`, so a
0.5.2 hook judging a 0.6.0 tree reruns the tests on every stop.

The probe (#12) found that no session auto-updated a plugin from a locally served catalog. A manual
`claude plugin update` did move the next session's hooks. So ADR 0005 and D8 settle on two
measures. Night sessions switch auto-update off, as insurance for the real GitHub catalog. A version
change between tickets stops the run.

## The Solution

- **`template/tools/phase-run/brigade.mjs`**, a new module that only `run.mjs` imports (node builtins
  only):
  - `brigadeCatalog(root)` reads the project's `.claude/settings.json` (BOM stripped). It takes the
    catalog from the `brigade@<catalog>` key in `enabledPlugins` (an entry that is on wins over one
    that is off) and that catalog's `extraKnownMarketplaces` entry. With no file, no Brigade key, no
    catalog entry, or a file that isn't JSON, it returns `{ catalog: null, why }`.
  - `withAutoUpdateOff(settings, brigade)` merges `extraKnownMarketplaces.<catalog>: { ...entry,
    autoUpdate: false }`, so `source` and any other key stay. With no catalog it returns the
    settings untouched.
  - `parsePluginList(stdout)` reads `claude plugin list --json`: a list, or a list under `plugins`.
    Any other output throws, quoting its first 200 characters.
  - `installedBrigade(rows, root, { platform })` takes the `brigade@…` row whose `projectPath` is the
    repo. Slashes are normalised and a trailing one dropped, and on Windows the compare is
    case-blind. Failing that it takes a `scope: "user"` row, else returns null.
    `readInstalledBrigade(root, exec)` runs the command through the runner's `exec`.
  - `versionStop(started, read)` returns "Brigade updated mid-run (<a> → <b>), rerun.", or a "could
    not be read" reason, or null.
- **`run.mjs`:**
  - `main()` reads the version right after the dry run, before the lock and the branch checkout.
    With none installed for the repo, it stops before the first ticket and says so. If the read fails, it stops naming the error.
  - `run.brigade` is now the installed version, used in the manifest, the header and every night
    ledger row. `run.stamp` keeps the project's stamp, and `run.catalog` keeps `brigadeCatalog`'s
    answer, read once.
  - `sessionSettings` takes `catalog` and returns its object through `withAutoUpdateOff`.
    `writeSessionSettings` passes `run.catalog`.
  - Before each ticket, after the internet wait, `versionStop` runs again. A change sets
    `run.stopped`, logs it, and breaks the loop, so no further ticket starts. The report then marks
    the copy finished, and a rerun takes a fresh one under the new version.
  - The report header reads `… UTC · Brigade 0.6.0 · built …`. When the stamp differs, a line
    says so (and that `/update-workflow` brings the runner up). With no catalog, a ⚠ line says why
    auto-update wasn't switched off. The run's start log names the version too.
- **`snapshot.mjs`:** the manifest gains `brigade`. A restart (an unfinished copy) is refused when
  the copy's `brigade` differs from the installed one. That is the handed-forward note from #16:
  `runnerChanges` compares only `.mjs` files, so it can't see a version change.
- **Docs:** the template's phase-run guide (the frozen-copy bullet, four symptom rows) and the
  changelog.

## Why This Approach

**Defer, then stop as a backstop.** Only stopping would be simpler, but a routine update would cost
the rest of the night. Only deferring can't catch an update the owner runs in another window. Both
together keep the night and still catch the rare change. That is ADR 0005's reasoning, and this
ticket builds it.

**Read the catalog from the project, not a literal.** The runner can't see the plugin's folder. The
project's `enabledPlugins` key is the one place that says which catalog this repo installs Brigade
from, and a fork's catalog has another name.

**Keep the project's entry whole.** A catalog entry given through `--settings` stands in for the
project's. Written with only `autoUpdate`, it would be a catalog with no `source`. So the override
copies the project's entry and changes one key, and with no entry it writes nothing.

**Pure seams, thin wiring.** The version pick, the catalog read, the merge and the stop decision are
pure functions with fixture inputs. Only one line spawns `claude`, through the runner's own `exec`.
The tests never touch this machine's plugins or this repo's settings.

Interview version: "A night run is a dozen sessions, and each one loads the plugin's hooks fresh,
so an update in the middle would judge half the night by different rules. I recorded the installed
plugin version at the start and switched auto-update off in each session's settings. I copied the
project's catalog entry rather than writing a partial one. Then I re-read the version before every
ticket and stopped cleanly on a change. The version goes in the snapshot manifest, the morning
report and the cost ledger, so every number says which version produced it."

## Alternatives turned down

- **Read the catalog per ticket** (as trim reads the project's settings). The run holds one of
  everything from its start: once is enough, and the report can then say once why there is none.
- **Write `{ autoUpdate: false }` when the project has no catalog entry.** It risks a settings entry
  with no `source`. The version stop still covers the run.
- **Keep `run.brigade` as the project's stamp.** The attended hook records the plugin's version, and
  D14 asks for one version across the manifest, the header and the rows. The installed plugin's
  hooks are what judge the night. The stamp is still shown when it differs.
- **Refuse a reused manifest with no `brigade` key.** Nothing can be compared, and the code check
  (`runnerChanges`) already refuses a copy taken by an older runner.
- **Spawn `claude plugin list` in a test.** A night session can't run it, and the output depends on
  the machine. The pure pick is tested with fixture rows instead.

- **(Review) Check the version before each fix round's launch too.** The ticket names a check before
  each ticket. A change mid-ticket is caught before the next ticket, which stops the run. Stopping
  inside a ticket would mean failing or parking it, a call outside this ticket. It is listed for the
  owner below.
- **(Review) Test `main()`'s wiring** (the loop stop, the start-of-run `die`, `writeSessionSettings`
  passing the catalog). These read module globals and spawn `claude`, as #21's review found for its
  wiring. The tests cover the pure seams those lines call.
- **(Review) Pick the installed row by the project's catalog, and skip `projectEnabled: false`.** Two
  Brigade installs for one repo (a fork and the upstream) is not a case the probe saw, and the
  `projectPath` match already narrows the rows to this repo.
- **(Review) Mark the version unknown after a restart on a manifest with no `brigade` key.** Only a
  copy taken by an older runner has none, and `runnerChanges` refuses those first.
- **(Review) Share the settings reader with `trim.mjs`'s `projectKeeps`.** Only `run.mjs` may import
  `trim.mjs`, and the two handle a broken file differently on purpose (trim throws, this explains).
  A third module for one `readFileSync` isn't worth it.
- **(Review) Write a bare `autoUpdate: false` for a catalog added outside the project.** It would be
  an entry with no `source` (see above).

## Real bugs found along the way

- **(Review) A refused start could leave a new phase branch behind.** The version was read after
  `git checkout -b`. It is now read before the lock and the checkout.
- **(Review) `brigade` meant two things:** the version string on `run` and the manifest, and the
  catalog object in `sessionSettings`. The object is now `catalog` throughout. The BOM strip also
  no longer hides an invisible U+FEFF inside a regex.
- **Found elsewhere, not fixed here:** none.

## What This Concretely Unblocks

- **#24** (the finish ticket): its live night shows the version in the report header and the rows,
  and whether the override is accepted by a real session.

## Run by hand

- None for the build. The live check is below, under assumptions.

## Assumptions made

- **`claude plugin list --json` prints a list, or a list under `plugins`.** The probe named the row
  fields but not the wrapper, and this session couldn't run the command. Any other shape stops the
  run, quoting the output, so a wrong guess is loud. To change: `parsePluginList`.
- **The override goes over the merged session settings**, while the base `settings.json` is still
  read from the live `tools/phase-run/` (as before). The run's allowlist was never part of the
  snapshot, and the override doesn't depend on it. To read the copy's: `writeSessionSettings`.
- **`run.brigade` (the ledger rows' `brigade`) is the installed plugin version**, no longer the
  project's stamp. To go back: `main()`'s `run` object.
- **The catalog is read once, at run start.** To read it per ticket: `writeSessionSettings`.
- **No project `extraKnownMarketplaces` entry means no override**, with the report's ⚠ line. To
  write a bare `autoUpdate: false`: `brigadeCatalog`.
- **A version that can't be read before a ticket stops the run**, as a change does. To let it go on:
  `versionStop`.
- **A reused manifest with no `brigade` key restarts.** To refuse it: `takeSnapshot`.
- **The version is checked before each ticket, not before each fix round.** An update that lands
  mid-ticket can judge that ticket's later rounds; the run stops before the next one. To check every
  launch: `runTicket`'s session calls, with a decision on what the ticket's status becomes.
- **The report shows the stamp only when it differs** from the installed version. To drop it:
  `report`.

## Handed forward

- **#24:** on the live night, confirm that `claude plugin list --json` reads as assumed (the run
  starts, and the header names the version), and that a session accepts the
  `extraKnownMarketplaces` override (no settings error in its transcript).

## Common Questions

**What happens to the night when the version changes?** The ticket that was about to start never
starts. The report opens with "The run stopped early. Brigade updated mid-run (a → b), rerun." The
copy is marked finished, so the rerun takes a fresh copy under the new version.

**Why both switch auto-update off and check the version?** The switch keeps routine updates from
landing at night. The check catches what the switch can't: an update the owner runs by hand in
another window.

**Was a browser check run?** No. Backend only: no screen changes.

**Why is `template/docs/guides/phase-run.md` touched, outside the Areas?** Its symptom table is
where an owner looks up a stop message. New stops without rows there can't be found. #16 did the
same for its restart refusal.

## References

- Spec #11, `docs/discovery/04-brigade-0.6.0.md` D8, D14 and the probe's addendum (#12, item d),
  ADR 0005.
- `template/tools/phase-run/brigade.mjs`, `run.mjs` (`sessionSettings`, `writeSessionSettings`,
  `report`, `main`), `snapshot.mjs` (`takeSnapshot`).
- Tests: `template/tools/phase-run/run.test.mjs`.
- Gotchas: `docs/agents/gotchas/measure-trim.md`, block `#25`.
