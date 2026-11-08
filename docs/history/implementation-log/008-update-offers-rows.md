# #008 — `/update-workflow` offers 0.6.0's rows

**Ticket:** `#18` · **Devlog:** `#13` · **ADRs:** 0004 (each stop check keeps its own receipt), 0001 (no stack recipes)
**Date:** 2026-11-08

---

## The Problem

A project set up on 0.5.x has rows with none of 0.6.0's keys: its typecheck and lint carry no
receipt, its tests row has no name, and its suite gate has no `unreadOf`. Nothing reached it but a
template copy, and refresh compared rows by `run` only, so a row the project already had was never
looked inside (beyond 0.4.1's tests-row receipt and list). D11 in discovery doc 04 settles the
answer: offers, not a migration. `/update-workflow` lists what refresh would add, and the owner
says yes row by row.

## The Solution

- **`ROW_OFFERS`** (`scripts/setup.mjs`): a table of the keys 0.6.0 gives a row, by its role
  (`stackChecks`' key) and section:
  - stop checks: `typecheck` and `lint` get `name`, `receipt: true`, `unread: ["**/*.md"]`;
    `test` gets `name: "tests"`;
  - gates: `test` gets `unreadOf: { nameOf: "test" }`, the tests stop check's name.
- **`rowOffers`**, called from `refresh`: for each existing row whose `run` the stack suggests, the
  table's keys it lacks become one `offer` item (`stopGate.checks.offer+<run>`,
  `phaseRun.gates.offer+<run>`). A key the row has is never changed. A row whose offered name
  another row holds gets no offer, since its receipt and list need that name. The gate's offer
  points at the tests row's own name, or at the name its offer would give it. Then the gate's yes
  names that row too, and the summary says so.
- **`offer` items are written only when accepted**, like `change` and `remove`. `refresh(…,
  { onlyAccepted: true })` (`--only-accepted`) writes the accepted ids and nothing else, so an
  update's yeses never carry refresh's own `add`s along.
- **`update`'s report** gains `offers` (`{id, summary}`), refresh's offer items for the config.
  `update --apply` still never writes `workflow.json`, and `MIGRATIONS` stays empty.
- **The shared list** refresh copies onto a tests row added back is the *nameless* receipt rows'
  list. Named rows keep their own (#17), and the stale "every receipt row shares one list" comment
  is gone.
- **Skills:** `update-workflow` gains step 5, the offers after the template copy (AskUserQuestion,
  up to 4 per call), and "nothing to do" now also needs no offers. `setup-workflow` §8 names the
  `offer` op.
- **The prompt (owed by #17)**, `template/tools/phase-run/run.mjs`: `STOP_CHECKS` names
  `stop-tests.mjs` once for every receipt row, at the first one's place, with their labels when
  there are several. `unreadNote` names each list with its checks when they differ.

## Why This Approach

**Offers beside the proposal, not in it.** `proposeWorkflow` stays as it is. #22 pins its output
for a `package.json` project, and D17 makes a new project's typecheck and lint lists a checklist
question about its own tools. A shipped `**/*.md` default would route around that question. So the
0.6.0 keys live in a separate table that only refresh reads, offered to rows that predate them.

**Rules as data.** The table holds the roles and keys. The code knows three rule kinds: a literal
key, a `{ nameOf }` reference, and "a name in use blocks the row". #22's checklist can read the
same table.

**One yes per row, with the row's keys together.** A receipt with its own list needs a name: two
nameless receipt rows with different lists are refused by both loaders. Splitting the keys into
separate yeses would let the owner build a file that doesn't load.

Interview version: "An upgrade shouldn't silently rewrite config the user may have tuned. So
instead of a migration I diff each row against a small table of what the new version adds, keyed
by the row's role. That diff becomes a list of opt-in offers, each tied to an id the user accepts.
Keys that depend on each other travel as one offer, and a cross-row reference (a gate pointing at a
check's name) brings its dependency along. Then no combination of yeses produces a file the loaders
refuse. And I test every partial combination through both loaders."

## Alternatives turned down

- **Putting the 0.6.0 keys in `proposeWorkflow`**, so a fresh project already has them and refresh's
  key diff runs against the proposal. That changes what every new setup writes, against #22's pin
  and D17's checklist. It was weighed with the advisor and turned down.
- **One offer per key** (name, receipt, list separately). Some combinations would be refused by the
  loaders (a nameless receipt row with a list of its own).
- **`update --apply --accept <ids>`** in place of `refresh --only-accepted`. The ticket asks for the
  offers after the template copy, so the yeses come after `--apply` has already run; a second
  command is the honest shape. To reverse: give `update` an `accept` option that calls the same
  refresh items.
- **Folding 0.4.1's tests-row `add`s into the offers.** Those are written without a yes today, and
  their tests pin that. They stay `add`s, and the offers never touch the tests row's list.
- **(Review) Merge `rowOffers`' two loops into one**, as Duplicated Code. The gate loop resolves
  `{ nameOf }` references and names a second row on a yes; the stop loop does neither. One loop
  would need branches for both, and it would read worse than two short loops.
- **(Review) Call a lone receipt row by its label, not "the tests".** Existing pins in
  `run.test.mjs` and `measure.test.mjs` hold "(the tests)" for a single row. A project whose only
  receipt row is not its tests is one nobody has set up. To change it: `stopCheckLine` and
  `unreadNote` in `run.mjs`.
- **(Review) Withhold the gate's offer when the tests row has no receipt**, since its `unreadOf`
  would then never skip. It is harmless (the gate just runs), and 0.4.1's adds give that row its
  receipt on the same refresh.
- **(Review) "nothing for Tests"** in the unread note, when one receipt row has no list, reads
  plainly enough, so it stays.
- **(Review) Say in setup's §8 that accepted offers ride along with refresh's `add`s.** That is
  what `--accept` means there, and the step already says "the ids the owner said yes to".

## Real bugs found along the way

- **A 0.6.0 tests row would have taken a named row's list.** Refresh's "project's own unread list"
  was the first receipt row's. Once Typecheck carried `**/*.md` (named, first), a tests row added
  back or missing its list would have been given `**/*.md`. pinned: `tests/setup.test.mjs` ("a
  tests row added back shares the nameless rows' list").
- **(Review) An offer could make a file the loaders refuse.** A row with `receipt: false` was
  offered an `unread` list, and the loaders refuse a list off a receipt row. A row with its own
  receipt and no list got the offer's `**/*.md` and 0.4.1's `add` for the same key, with a
  summary reading "undefined". A list is now offered only with the receipt it belongs to. pinned:
  `tests/setup.test.mjs` ("a list is offered only with the receipt it belongs to").
- **(Review) A broken `workflow.json` stopped update.** Listing the offers parses the config,
  which update never did before. A config that can't be read now leaves `offers` empty with a
  note, and the template copy goes ahead. pinned: same test.
- **(Review) "which the tests never read"** was said of a list that typecheck and lint share too.
  With several receipt rows it is "which they never read".
- **Changed tests, deliberately:** "right after setup there is nothing to do" and "the project's
  own list is its own" now leave out `offer` items. Until #22's checklist writes these keys at
  setup, a fresh project's rows are 0.5.x-shaped, so the offers are real.
- **Found elsewhere, not fixed here:** none.

## What This Concretely Unblocks

- **#22** (setup asks for tool rows): the update flow to extend. Its checklist items are walked
  after these offers (step 5 of `update-workflow`), and `ROW_OFFERS` is there to read.

## Run by hand

- None.

## Assumptions made

- **The op is `offer`**, separate from `change`, so update can list it as its own group. To merge
  them: the op in `rowOffers` and the `offers` filter in `update`.
- **The names are `typecheck`, `lint` and `tests`** (`test` is reserved for the nameless receipt
  file, #17). To change them: `ROW_OFFERS`.
- **Update lists only `offer` items**, not refresh's other items (`add`, `change`, `remove`):
  those belong to a stack refresh. To widen it: the filter in `update`.
- **The gate's yes names the tests row** when it has no name yet, rather than refusing the
  combination. To refuse instead: drop `naming` in `rowOffers` and skip the gate's offer.
- **A row is recognised by its exact `run`** (what `stackChecks` suggests). A hand-edited command is
  a hand-written row and gets no offer.
- **A declined offer comes back** on the next update or refresh, as `change` and `remove` items do.

## Common Questions

**Does a 0.5.2 project change if the owner says no to everything?** No. `update --apply` copies the
template and never writes `workflow.json`. Refresh writes an offer only for an id the owner gave.

**Can a yes leave a file the hooks refuse?** The tests cover every combination they exercise
(the lint offer alone, the gate alone, names in use) through both loaders. The gate's offer brings
the tests row's name with it.

**Was a browser check run?** No. Backend only: no screen changes.

**Why is `run.mjs` touched, outside the Areas?** #17's log handed the prompt's `STOP_CHECKS` line to
this ticket. Once typecheck and lint take their offers, the prompt would name `stop-tests.mjs`
three times. The change is the one line and the note beside it, pinned in `measure.test.mjs`.

## References

- Spec #11, `docs/discovery/04-brigade-0.6.0.md` D10, D11 and D17, ADR 0004, ADR 0001.
- `scripts/setup.mjs` (`ROW_OFFERS`, `rowOffers`, `refresh`, `update`),
  `template/tools/phase-run/run.mjs` (`stopCheckLine`, `unreadNote`),
  `skills/update-workflow/SKILL.md`, `skills/setup-workflow/SKILL.md`.
- Tests: `tests/setup.test.mjs`, `template/tools/phase-run/measure.test.mjs`.
- Gotchas: `docs/agents/gotchas/measure-trim.md`, block `#18`.
