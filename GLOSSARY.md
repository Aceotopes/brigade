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

**Roadmap page**:
The roadmap's visual view, published as an Artifact and never edited by hand.
_Avoid_: dashboard

## Building

**Phase run**:
The unattended build of a phase's ready tickets.
_Avoid_: night run, batch

**Gate**:
A check the runner makes on a ticket's result before the branch is pushed.

**Stack**:
The tools a project declares it is built with: language, framework, package manager, database,
migrations, test database, storage and other services.
_Avoid_: tech, recipe

**Refresh**:
Bringing a set-up project's config in line with its stack after the stack changes.
_Avoid_: re-setup

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
and kept as the reference.
_Avoid_: user flow, wireframe

**Visual system**:
The project's durable visual decisions, recorded in `DESIGN.md` from the built app shell and
screens.
_Avoid_: design system, style guide
