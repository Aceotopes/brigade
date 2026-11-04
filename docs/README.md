---
job: Every doc in this repo and its one job, and the rules every doc keeps.
kind: living
max-lines: 300
---
# Docs

## The rules every doc keeps

- **One job.** Each doc states its job in its header. One fact has one home; other docs link to it.
- **A living doc holds no history.** It says how things are now. What happened goes in the devlog
  (`docs/history/devlog.md`) and the implementation log.
- **Every doc has a header**: `job`, `kind`, and a budget (`max-lines`, `max-entry-lines`). doc-check
  (`node tools/doc-check.mjs`) holds each doc to it on every commit; compress before raising one.
- **Four kinds:** `living` (kept true now), `log` (added to, rotated at each phase end), `record`
  (written once, then frozen), `generated` (a tool writes it, between its markers).
- New docs start from [`_templates/`](_templates/README.md).

## Every doc

<!-- generated:start doc-map -->
### (repository root)

- [CLAUDE.md](../CLAUDE.md) · *living* · What every session on this repo must know first, its rules, and where everything else lives.

### docs/_templates

- [docs/_templates/README.md](_templates/README.md) · *living* · How each kind of doc starts: copy the template, fill it in, keep its header.

### docs/adr

- [docs/adr/README.md](adr/README.md) · *generated* · The decisions that are hard to reverse, one numbered record each, and their status.

### docs/agents

- [docs/agents/issue-tracker.md](agents/issue-tracker.md) · *living* · Where this repo's issues live and what each label means.
- [docs/agents/ticket-template.md](agents/ticket-template.md) · *living* · The shape every ticket follows, so each one stands alone for a fresh session.
- [docs/agents/workflow.md](agents/workflow.md) · *living* · Which skill, when: how a phase moves from grill to merge. Changes only when the process does.

### docs/agents/gotchas

- [docs/agents/gotchas/README.md](agents/gotchas/README.md) · *generated* · The traps each phase found, one file per phase, read by the tickets that name them.

### docs/discovery

- [docs/discovery/README.md](discovery/README.md) · *generated* · Every discovery doc, when it was written and when it last gained an addendum.

### docs/guides

- [docs/guides/phase-run.md](guides/phase-run.md) · *living* · The owner's guide to the unattended phase run: evening and morning checklists, merging, undoing a ticket.

### docs/handbook

- [docs/handbook/README.md](handbook/README.md) · *generated* · The handbook's chapters, one file per finished phase, read in order.

### docs/history

- [docs/history/devlog.md](history/devlog.md) · *log* · The timeline of this phase, one entry per commit, newest first.

### docs/history/devlog

- [docs/history/devlog/README.md](history/devlog/README.md) · *generated* · The devlog's archive, one frozen file per finished phase.

### docs/history/implementation-log

- [docs/history/implementation-log/README.md](history/implementation-log/README.md) · *generated* · The implementation log's index, one entry per ticket, the owner's way of learning the code.

### docs/status

- [docs/status/handoff.md](status/handoff.md) · *living* · Where things stand and the next step, for whoever picks the work up. Overwritten, not appended.
- [docs/status/open-items.md](status/open-items.md) · *generated* · Every question still open, gathered from the docs that hold them.
- [docs/status/roadmap.md](status/roadmap.md) · *living* · The modules in build order and their phases, and where each stands, present tense only.
<!-- generated:end doc-map -->
