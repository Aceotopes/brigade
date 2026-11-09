# #026 — Setup's lane checklist and the guide's examples

**Ticket:** `#40` · **Devlog:** `#41` · **ADRs:** 0001 (applied), none new
**Date:** 2026-11-10

---

## The Problem

Tickets #29 to #39 built the lanes: the lane table, hotspots, worktrees, claims, Landing. A project
could only turn them on by hand-writing `phaseRun.lanes` and `phaseRun.hotspots`, and nothing told
it what its own tools must do in a lane: name test databases with the lane's prefix, reach the
lane's own QA server, and maybe fix the date. D15 and ADR 0001 rule out a helper file Brigade
stamps in, so setup has to ask, and Claude writes the answers into the project's own tools.

## The Solution

**`scripts/setup.mjs`.**

- `proposeLanes(det, paths, { takes })` gives what setup proposes for two lanes:
  - **The rows.** Lane 1 takes `any`, lane 2 takes a label (`LANE_TWO_LABEL`, `lane-2`, until the
    owner names one). Each worktree is at `../<repo folder>-lanes/lane-<id>` (D4). A row's
    database, ports and test prefix are never proposed (D2): the stack walk asks for them.
  - **`worktreeSetup`** (D8):
    - `copy`: the untracked files from `.env`, `.env.local` and `.claude/settings.local.json`
      that exist, because a lane's start refuses an absent one;
    - `commands`: the package manager's install (CI's `INSTALL` row), plus `prisma generate` when
      there is a schema;
    - `leaves`: `node_modules` when there is an install.
  - **The hotspot rows** (D7), from `hotspotRows`.
- `docPaths(file)` reads a doc-config's `DEVLOG`, `GOTCHAS_FILE` and `GENERATED` by importing the
  file in a child `node` process. The read stays synchronous, and a refresh always reads the file
  as it is now. A file that will not load gives `null`.
- `hotspotRows(paths)`:
  - the devlog and the implementation-log folder are `log`;
  - each `GENERATED` target is `generated`, except one driven by the config (the Stack block in
    `CLAUDE.md`);
  - `GOTCHAS_FILE`, with its `{phase}`, is `own-file`.
- `buildPlan` always returns `proposed`, and the summary prints it under "Two lanes, proposed". It
  writes both sections into `.claude/workflow.json` only on the owner's yes, `answers.lanes`
  (`true` or `{ takes }`). A section the owner's `answers.workflow` already holds is kept as
  written, which is how the stack walk's values for lane 2 get in. On a yes, the plan refuses (as
  a problem, before anything is written):
  - a label that is `any` or empty, or an `answers.lanes` of another shape;
  - a doc-config that will not load when the owner gave no hotspots of their own;
  - a config the runner's own `parseRunConfig` refuses. For example, two rows on `phaseRun.qa`'s
    database because the walk's values are missing.
- `refresh`: on a project with `phaseRun.hotspots`, each row the doc-config now suggests becomes
  one `offer`, unless a row of the owner's already covers its path (`hotspotKind`, a folder row
  included). A doc-config that will not load is a warning. Without a hotspots section (or with
  `rows` that aren't a list), nothing is offered.

**`skills/setup-workflow/SKILL.md`.**

- A "Then two lanes" step, off unless the owner says yes. It shows the proposal and asks lane 2's
  label.
- With lanes on, it asks three questions:
  - how the tests read `PHASE_RUN_TEST_DB_PREFIX`;
  - how the browser scripts read `PHASE_RUN_QA_PORT` and `PHASE_RUN_QA_DATABASE`;
  - whether they depend on the date (`PHASE_RUN_FAKE_NOW` is reserved).
- Refresh's hotspot offers and its doc-config warning are explained, and the labels step creates
  lane 2's label.

**`template/docs/guides/phase-run.md`.** A "Two lanes" part in "What your config sets":
- a sketch of the two sections, with `<…>` for every value that is the project's;
- a lane helper, an ESLint rule and a Playwright clock, as worked examples, never defaults;
- what each hotspot kind does.

It names no project, port, database or devlog number. Its budget went from 700 to 760 lines: it is
at 647, 85%.

## Why This Approach

- **Proposed always, written on a yes.** The plan shows the whole proposal on every run, so the
  owner sees it before choosing. With no yes, `propose` and the written config are today's, byte
  for byte, and the pinned `propose` test and the `OFFERS_052` lists stand.
- **The hotspot rows come from doc-config, not from a list in setup.** These are the files that
  doc-config already names, so a project that moved its devlog gets the right row, and refresh can
  tell when a path is new.
- **A child process, not `import()`.** `plan` and `refresh` are synchronous, and the tests call
  them that way. A cached `import()` would also read a doc-config the refresh test has just
  edited as it was.
- **No `generated` row for `CLAUDE.md`.** Landing keeps the tip's whole file for a `generated` row
  and rebuilds the indexes in it. `CLAUDE.md` is hand-written around its Stack block, so a lane's
  edit to it would be dropped. Left to git, a clash parks the ticket instead of losing the edit.

## Alternatives turned down

- **A stamped lane helper** (`template/tools/lane.mjs`). D15 turned this down: a JS file is dead
  weight outside JS, and Brigade would own a file the project's scripts import. A test now pins
  that no template code outside the runner reads a lane's variables.
- **Offering hotspot rows to every project.** A one-lane project has no use for them, and every
  `update` would list a dozen offers.
- **Proposing lane 2's database, port and prefix.** These values belong to the project (D2). A
  made-up port could clash with one the project uses.
- **Parsing doc-config with regexes.** Its `GENERATED` targets are template literals
  (`${DISCOVERY_DIR}/README.md`), and only evaluating the module reads them right.

- **From the code review, turned down:**
  - *A `generated` row drops a lane's hand edit outside an index's markers* (`docs/README.md`,
    say), the same reason `CLAUDE.md` gets no row. D7 asks for the generated indexes as
    `generated`. Their hand-written heads are rarely touched by a ticket, unlike `CLAUDE.md`. What
    Landing does with the rest of such a file is #36's. It is listed under "Found elsewhere".
  - *Refresh offers again a proposed row the owner deleted.* It does the same for any declined
    offer (ROW_OFFERS, #18). Refresh keeps no memory of a no. The owner silences one with a row of
    their own over the path.
  - *Proposing `prisma generate` and `node_modules` stretches ADR 0001.* D8 says `commands` are
    "the install and any code generation", and these reuse the rows CI already has (`INSTALL`,
    `EXEC`). The owner sees and edits the proposal before the yes.
  - *The guide's budget raised a third time instead of trimmed.* The new part is new content for
    0.7.0. Trimming the owner's guide elsewhere is outside this ticket, and #42 (the finish) can
    weigh it.
  - *Smells:* the install line repeats `checksWorkflowText`'s (its CI step also carries an env and
    a name, so a shared helper saves one line). `"implementation-log"` repeats doc-check's own key
    for that index: doc-config has no constant for it. Both are left as they are.

## Real bugs found along the way

None in shipped code. The code review found these in this ticket's first commit, fixed before it
landed:
- **`plan .` named the worktree `../.-lanes/lane-1`.** The folder's name is now read from the
  resolved path.
- **A doc-config that would not load gave a yes an empty hotspot list**, silently. The plan now
  refuses it, as refresh already warned.
- **A doc-config from before `GOTCHAS_FILE` got no `own-file` row.** It now gets the runner's own
  fallback, `docs/agents/gotchas/{phase}.md`.
- **A yes beside `phaseRun.qa` without the walk's values passed the plan**, and only `verify` after
  `apply` caught it. The plan now runs the runner's loader on the config it would write.
- **`leaves: ["node_modules"]` on a Yarn Plug'n'Play project** would refuse every lane start. It
  is left out when a `.pnp.cjs` or `.pnp.js` is there.
- **An owner's folder row could be overridden by an accepted exact offer.** A path any of the
  owner's rows covers is no longer offered.
- **`docPaths` had no timeout**, so a doc-config whose import never finished would hang setup. It
  now gives up after 30 seconds and counts as one that will not load.

## What This Concretely Unblocks

- **#41** (the release night): its throwaway repo can be set up by `setup.mjs` with two lanes, the
  yes being `"lanes": { "takes": "<label>" }` in the answers, and the walk's values in
  `answers.workflow`.
- **#42** (the finish): the template guide's "Two lanes" part is new. This repo's installed copy,
  `docs/guides/phase-run.md`, gets it with the release's update.

## Run by hand

None. This is setup's script, its skill and a template guide, so there is no browser check and no
screen changes. Setup was checked on scratch repos in `tests/setup.test.mjs`.

## Assumptions made

Each is a small choice, easy to change:
- **Lane 2's default label is `lane-2`** (`LANE_TWO_LABEL`). The skill asks for the real one. To
  change it, edit the constant.
- **The copy candidates are `.env`, `.env.local` and `.claude/settings.local.json`**
  (`WORKTREE_COPY`). Add a project's other untracked files there, or in its own config.
- **`leaves` is `node_modules` after an install**, unless a Plug'n'Play file is there
  (`PNP_FILES`). The Prisma client's output path varies by version, so it isn't guessed. To drop
  it, remove the `leaves` line in `proposeLanes`.
- **The implementation-log folder is found by its `GENERATED` row's name, `implementation-log`.**
  doc-config has no constant for it. If one is added, read that instead in `hotspotRows`.
- **A path counts as covered when any of the owner's rows settles it** (`hotspotKind` is not null),
  whatever the kind. To offer an exact row under a folder row of another kind, compare the kinds
  in `refresh` instead.
- **The guide's helper, lint rule and clock are sketches written for this guide.** The source
  project's own code isn't in this repo. They follow the shape D15 and D16 describe, and the
  guide says so.
- **The guide's budget went up to 760 lines** rather than trimming other parts. To undo, take
  the part out and set it back to 700.

**Found elsewhere, not fixed:**
- **Landing keeps a `generated` row's whole file from the tip** (`numbering.mjs`, #36). A lane's
  hand edit outside an index's generated markers (the intro of `docs/README.md`, say) is dropped
  with no conflict. It is rare for an index, but silent.

## Common Questions

**I said no to lanes. Can I turn them on later?** Yes. Write the two sections from the guide's
sketch, or run setup's plan on a scratch copy to see its proposal. Then walk the three questions.

**Why does refresh offer me a hotspot row?** `tools/doc-config.mjs` names a path (a new generated
index, say) that no row settles. Say yes and Landing settles it. Say no and git does, as before.

**Which variables does a lane set?** `PHASE_RUN_LANE`, `PHASE_RUN_QA_PORT`,
`PHASE_RUN_QA_DATABASE` and `PHASE_RUN_TEST_DB_PREFIX`, from the lane's row. Brigade reserves
`PHASE_RUN_FAKE_NOW` and never sets it.

## References

- `docs/discovery/05-brigade-0.7.0.md` D2, D4, D6, D7, D8, D15, D16; spec #27; ADR 0001, ADR 0006.
- Code: `scripts/setup.mjs` (`proposeLanes`, `docPaths`, `hotspotRows`, `buildPlan`, `refresh`,
  `summarize`); `skills/setup-workflow/SKILL.md`; `template/docs/guides/phase-run.md`.
- Tests, written first: `tests/setup.test.mjs`:
  - the proposal, and nothing written without a yes;
  - lane 2's label, and the owner's own section kept;
  - the walk's values with `phaseRun.qa`, through both loaders;
  - each row through `hotspotKind`;
  - refresh's one offer, the hand-written row and no lanes;
  - a doc-config that will not load;
  - the plan's refusals on a yes;
  - the proposal's edges: a relative dir, Plug'n'Play, an older doc-config;
  - no lane helper in the template;
  - the plan summary's lines.
