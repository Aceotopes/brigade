# #007 — Gates side by side, with the suite skip

**Ticket:** `#19` · **Devlog:** `#12` · **ADRs:** 0004 (the suite skip), 0003 (no gate reads a receipt)
**Date:** 2026-11-08

---

## The Problem

The runner ran a ticket's gates one after another, so a ticket waited for the sum of typecheck,
lint, build and the suite, though most of them never touch each other. A docs-only fix round still
ran the whole suite, though the tests read none of what changed. And a tool's own cache (ESLint's,
TypeScript's) could carry what a session's runs left behind into the gates, which must trust
nothing the session wrote. D12 to D14 in discovery doc 04 settle the answer: gates side by side,
the suite skip on one stop check's list, and a `{cache}` folder the runner empties.

## The Solution

- **Both loaders** (`template/tools/phase-run/config.mjs`, `hooks/workflow-config.mjs`): a gate row
  is `{label, run, when?, env?, freePorts?, alone?, after?, unreadOf?}`, and `{cache}` joins the
  gate placeholders. One function, `gateReferences`, kept word for word in both, refuses an `after`
  that names no gate label and an `unreadOf` that names no stop check `name`. The hooks loader
  still skips the rest of `phaseRun`, and leaves any other shape to the runner.
- **The runner's own `after` rules** (`gateOrder`, `config.mjs` only): `after` links two gates of the
  parallel group. It may not sit on, or name, an `alone` gate, name a label two gates share, or
  wait in a circle. The refusal shows the circle (`a → c → b → a`).
- **The decision function**, `gatePlan({ base, diff, config })` in `run.mjs`: `diff` is `git diff
  --name-status -M -z <base>..HEAD`, read by `diffPaths`, with both sides of a rename or copy
  counted. Each gate comes back with `skip: null | "when" | "unreadOf"`. The suite skip needs a
  non-empty diff with every path on the named check's list, through `unread.mjs`'s
  `unreadMatcher`. The same path list feeds the browser check.
- **The scheduler**, `projectGates(plan, …)` and `gateGroup`:
  - It starts every gate with no pending `after` at once. An `after` gate starts once its gate
    passed; a skipped gate holds nobody up.
  - It looks every 250 ms (`GATE_TICK_MS`). On a failure it reports every failure of that tick
    (`"lint, typecheck"`, each output under a `── label ──` heading), stops the running jobs and
    waits for each. Jobs not yet started never start.
  - Then each `alone` gate runs by itself in list order, strays stopped first, then the browser
    check. Doc-check and migrations stay after it, in `runGates`.
- **`startJob`**: a gate's command through the shell, without blocking. Off Windows the job leads
  its own process group and the kill is `process.kill(-pid)`; on Windows it is `taskkill /T /F`.
- **`{cache}`** is `.phase-run/gate-cache`, emptied once before each `projectGates` call.
- **Docs:** the template's phase-run guide describes `after`, `alone`, `unreadOf`, `{cache}` and
  the order.

## Why This Approach

**One pure decision, one scheduler.** `gatePlan` takes the diff text, so the skip is tested on
docs-only, mixed, empty and renamed diffs with no git and no processes; #20 adds the tampering
verdict to the same function. The scheduler takes a job starter, so most tests use real `node -e`
jobs and a few use a fake one.

**Ticks, not callbacks.** Collecting finished jobs on a tick means two jobs that fail together are
both reported, so a fix round sees both failures instead of one per round. The cost is up to 250 ms
per gate step, against minutes of gates.

**Tests without a stopwatch.** Parallelism is proven by a rendezvous: each of two jobs writes its
flag and waits for the other's. Run one after the other, the first would time out. The kill is
proven by the long job's pid being gone afterwards, not by how fast the call returned.

Interview version: "It's a small DAG scheduler. Each gate is a node, `after` is an edge, and the
loader refuses cycles and edges into the serial tail. Ready nodes start at once; I poll on a tick
so simultaneous failures are all reported, then kill each process tree and await every child, so
nothing outlives the gate run. Skipping is a pure function of the diff: a rename counts both paths,
an empty diff never skips, and the 'unread' list is the same one the receipts use, through the same
matcher, so the two can't disagree."

## Alternatives turned down

- **Event-driven completion (`Promise.race`) instead of a tick.** It reacts faster, but the first
  failure would be the only one reported, and the ticket asks for same-tick failures.
- **Emptying `{cache}` before each gate.** Gates run side by side and share the folder, so emptying
  it per gate would pull a cache out from under a running gate. Each tool names its own file in it.
- **Requiring `after` to name an earlier gate in the list**, which would rule out circles for free.
  It is a rule the owner never asked for; the refusal names the circle instead.
- **Refusing every repeated gate label.** That would break a file that is valid today. Only a label
  an `after` names must be unique.
- **Checking `after` circles in the hooks loader too.** The hooks never run gates. A refusal there
  blocks every shell command in a session, so it fires only on a name that names nothing, as the
  ticket asks.
- **(Review) Drop `plan.base`, which nothing in the runner reads yet.** The ticket says the
  decision function takes the base, and #20's tampering verdict reads the base commit. It stays.
- **(Review) A map from skip reason to message**, in place of `runGates`' one ternary. With two
  reasons the ternary reads plainly; #20 can make it a map if it adds a third.
- **(Review) Refuse an `unreadOf` naming a check with an empty list**, which then never skips. The
  ticket asks only that it name a check; an empty list is harmless (it just never skips), and #18
  is the ticket that offers the rows.
- **(Review) Give the browser check `--name-only` again.** It now gets the same rename-aware list,
  so a screen file renamed away asks for screenshots too. That is a screen change, and one list
  for every gate keeps the skips and the browser check in agreement.
- **(Review) Prove "as long as the slowest" with a stopwatch.** The rendezvous proves overlap
  without reading the clock, which a loaded machine would make flaky.

## Real bugs found along the way

- An existing test pinned the browser check at its place in the list. D12 moves it after
  everything, so that test was rewritten to the new rule deliberately, not dropped: the browser
  check runs after the project's gates and is never asked when one of them failed.
- **(Review) Ctrl-C left the gate jobs running.** Off Windows each job leads its own process group,
  so the terminal's Ctrl-C (the runner's handler exits 130) no longer reached the suite, which then
  held its ports and database. `startJob` now keeps every open job, and the runner's `exit` kills
  them all. pinned: `run.test.mjs` (a runner process that exits leaves no job behind; the test was
  checked red with the kill disabled).
- **(Review) `stop()` could hang a night.** It killed only a job whose shell had not exited, but
  `done` waits for `close`, which a child left holding the output pipe delays forever. The kill is
  now decided on "closed" (off Windows, where a gone pid's tree can't be walked).
- **(Review) Gates left waiting read as a pass.** `gateGroup` ended when nothing was running, even
  with an `after` gate never started. The loaders rule that out, but it now returns a failure.
- **Found elsewhere, not fixed here:** none.

## What This Concretely Unblocks

- **#20** (the tampering gate): `gatePlan` is the decision function it extends. The tampering
  verdict reads the base commit, which the plan already carries as `plan.base`.
- **#18** (offering the new rows): `unreadOf` exists to offer on a suite gate.
- **#22** (setup asking for `after`, `{cache}` flags and the build's `when`): the keys are loaded
  and checked.

## Run by hand

- None.

## Assumptions made

- **A skipped gate satisfies `after`.** A ticket that skips the build still gets its typecheck. To
  reverse it: `ready` in `gateGroup`, then treat a skipped label as failed.
- **`freePorts` on a group gate frees the ports once, before the group starts.** Freeing them
  between parallel jobs could kill a server another gate started. An `alone` gate still frees its
  own. To change it: `projectGates`.
- **Same-tick failures are one failure** for the fix prompt, labelled `"lint, typecheck"`, each
  output tailed to 3,000 characters. To change it: the `failures.length` branch in `gateGroup`.
- **A placed `browser-check` row is still accepted**, though it now runs after everything. Refusing
  it would break existing files. To refuse it: `parseGate`.
- **The tick is 250 ms.** To change it: `GATE_TICK_MS`.

## Common Questions

**Does a 0.5.x file change meaning?** Mostly no. Its gates now run side by side, and its `alone`
gate runs after the rest rather than at its place in the list, which D12 decided. A file with no
`after`, `unreadOf` or `{cache}` loads as before.

**Can the suite skip hide a failure?** Only on a diff wholly on a list the owner wrote; typecheck
and lint still run (ADR 0004). No gate reads a receipt: the skip imports the matcher only, and
`run.test.mjs`'s import walk still never reaches `receipt.mjs`.

**What if the runner is stopped mid-gate?** A Ctrl-C or any ordinary exit kills every open job
(the runner's `exit` handler). A hard kill of the runner itself (`SIGKILL`, a closed terminal
window) runs no handler, so a job may outlive it; the next run's `stopStray` and `freePorts` clear
what's left.

**Two `freePorts` gates in the group?** Their ports are freed once, before the group starts, and
the two then run together. If they need the same port, mark one `alone` (D12).

**Was a browser check run?** No. Backend only: no screen changes.

## References

- Spec #11, `docs/discovery/04-brigade-0.6.0.md` D12 to D14, ADR 0004, ADR 0003.
- `template/tools/phase-run/run.mjs` (`gatePlan`, `diffPaths`, `gateGroup`, `projectGates`,
  `startJob`, `runGates`), `config.mjs` (`gateReferences`, `gateOrder`), `hooks/workflow-config.mjs`.
- Tests: `template/tools/phase-run/run.test.mjs`, `tests/phase-run-config.test.mjs`.
- Gotchas: `docs/agents/gotchas/measure-trim.md`, block `#19`.
