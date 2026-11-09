# Brigade

Brigade takes a software project from discovery to merged code, with Claude sessions doing the
building and scripts checking every result. These are the words it uses for the pieces of that
work.

## Planning

**Discovery doc**:
A written record of a product's goals, problems, users, requirements and stack, from discovery
rounds. Never rewritten: later facts are added as dated addenda.
_Avoid_: brief, PRD

**Addendum**:
A dated note at the top of a discovery doc that records a later fact and what it changes. The
original text below it is never edited.
_Avoid_: update, revision

**Candidate module**:
A module a discovery doc proposes. It may later be merged, split or dropped, and becomes a module
only when its planning grill puts it on the roadmap.

**Module**:
One area of a product with its own vocabulary and data, built over several phases, with its row on
the roadmap. Optional for a small project.
_Avoid_: epic, feature area

**Phase**:
A slice of work one person can test end to end in a morning and merge on its own: one spec, one
branch, one pull request.
_Avoid_: sprint, milestone

**Phase 0**:
A project's first phase, built attended: the app skeleton, its checks and the app shell.
_Avoid_: setup phase

**Spec**:
The GitHub issue that describes one phase.

**Ticket**:
One session's unit of work in a phase, ending in one commit.
_Avoid_: task, story

**Finish ticket**:
A phase's last ticket, built attended: the whole-phase review and the phase-end docs.

**Roadmap**:
The one record of a project's modules in build order, what each depends on, its phases and their
status.
_Avoid_: plan, tracker

**Delivered**:
A module whose every phase is merged.
_Avoid_: done, shipped

**Roadmap page**:
The roadmap's visual view, published as an Artifact and never edited by hand.
_Avoid_: dashboard

## Building

**Phase run**:
The unattended build of a phase's ready tickets.
_Avoid_: night run, batch

**Gate**:
A check the runner makes on a ticket's result before the branch is pushed.

**Receipt**:
A session's own record that one stop check passed on exactly the code that check reads, from the
same base. Files on that check's unread paths do not count as its code. The stop check skips that
check while the receipt holds; a gate never reads one.
_Avoid_: cache, pass token

**Unread paths**:
The files one stop check never reads, listed on its own row, so an edit to them keeps its receipt.
The tests' list also decides a suite skip.
_Avoid_: ignore list, excluded files, can't-affect list

**Suite skip**:
The gates leaving out the full suite when every file a ticket changed is on the tests' unread
paths.

**Tampering gate**:
The gate that fails a ticket whose diff weakens tests (skips them, deletes assertions, or edits a
guarded test file or script), unless a test override names it.

**Test override**:
A line in a ticket, written before the phase run, naming a test file and why it may be removed or
weakened.

**Runner snapshot**:
The frozen copy of the runner, its config and the Brigade version that judges a whole phase run.
_Avoid_: backup, cache

**Lane**:
One of at most two runners building the same phase run at once, each in its own copy of the repo
with its own ports and databases, so the two share nothing but the phase branch.
_Avoid_: worker, slot, night run

**Claim**:
A lane's hold on the ticket it is building, so the other lane never builds it too. It lapses when
the lane's process dies.
_Avoid_: lock, reservation

**Landing**:
Putting a lane's passing ticket on the phase branch: onto the newest tip, numbered, and checked by
the gates again there. A ticket that conflicts or fails is parked, never forced.
_Avoid_: merge, push

**Unlanded ticket**:
A ticket built and passing in its lane but not yet on the phase branch.
_Avoid_: kept ticket (a kept branch is a failed ticket's)

**Unnumbered entry**:
A devlog entry, implementation log or commit message a lane writes without its number, which
Landing fills in from the phase branch's tip.
_Avoid_: placeholder

**Hotspot**:
A file nearly every ticket's commit writes at the same spot, such as the devlog or a generated
index, with a rule for how Landing settles it.
_Avoid_: shared file, conflict file

**Primary checkout**:
The repo's own folder, as opposed to a lane's worktree beside it. Run state for every lane is kept
there.
_Avoid_: main checkout (`main` is a branch)

**Hand-back**:
The last lane out returning the primary checkout to the phase branch's tip.

**Ledger**:
The append-only record of every session's tokens and cost, one row per session, kept per project.
_Avoid_: log, metrics

**Kind**:
What a ledger row records: `night` (a phase-run session), `attended`, or `other` for a row a probe
labelled itself.

**Trim**:
What a phase-run session starts without: plugins, skills and tools the machine's owner lists as
unused at night.
_Avoid_: slim, minimal mode

**Keep list**:
The plugins and skills one project's phase runs keep despite the trim.

**Stack**:
The tools a project declares it is built with: language, framework, package manager, database,
migrations, test database, storage and other services.
_Avoid_: tech, recipe

**Refresh**:
Bringing a set-up project's config in line with its stack after the stack changes.
_Avoid_: re-setup

**Stamp**:
The record in a set-up project of which Brigade version its copied files came from, and how each
looked when copied.
_Avoid_: lockfile, version file

**Out of step**:
A set-up project whose stamp and the installed Brigade differ in version, either way.
_Avoid_: outdated, stale

## Design

**App shell**:
The frame every screen sits in: header, navigation, layout, type and colour.
_Avoid_: layout, chrome

**Stand-in page**:
A plain page in the app shell that shows one module's sample data until that module's real screens
replace it.
_Avoid_: placeholder

**Sample data**:
Realistic fake content for one module, covering its minimum, typical and maximum cases. It is
shared by the prototype, the QA database and the tests.
_Avoid_: mock data, fixtures

**Prototype**:
A module's screens built in the real app on sample data, approved before its tickets are written,
and deleted once they are built.
_Avoid_: mockup

**Flow diagram**:
A module's map of screens, states and the moves between them, drawn from its approved prototype
and kept as the reference. Its opening line records the prototype's approval.
_Avoid_: user flow, wireframe

**Screen brief**:
A screen's job, its states and what it must not do, approved with its prototype. With Impeccable
it is the surface brief; without, a note under the screen in its flow diagram.
_Avoid_: design note, spec

**Prototype guard**:
The check that keeps prototype screens out of a production build.
_Avoid_: feature flag

**Visual system**:
The project's durable visual decisions, recorded in `DESIGN.md` from the built app shell and
screens.
_Avoid_: design system, style guide
