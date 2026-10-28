---
job: What every session on this repo must know first, its rules, and where everything else lives.
kind: living
max-lines: 150
---
# {{NAME}}

{{SUMMARY}}

## Commands

{{COMMANDS}}

## Stack

What this project is built with, from `.claude/workflow.json`'s `stack`: generated, so change it
with `/setup-workflow`'s refresh (and note why in a discovery doc's addendum), never here.

<!-- generated:start stack -->
<!-- generated:end stack -->

## Working agreement

- **Commit only with the owner's go-ahead**, and push only when asked; the two are separate asks.
  The one exception is a phase run on a `phase-*` branch, which commits each ticket itself.
- **Every commit gets a devlog entry** at the top of `docs/history/devlog.md` and cites it
  (`… — devlog #N`); doc-check refuses a commit without one. A ticket's commit says `Closes #N`; a
  spec issue is never closed by keyword (write "addresses #N"), the owner closes it by hand.
- **No attribution trailer** on a commit or pull request.
- **Docs follow the change:** after a verified change and before its commit, run the `doc-sync`
  skill. Its mechanical half, `node tools/doc-check.mjs`, runs before every commit.
- **A phase merges with a merge commit**, never a squash or rebase: a devlog entry closes when a
  commit message cites it, and a squash drops those messages.

## Where things live

- `docs/README.md`: every doc and its job, generated from the docs' own headers.
- `docs/discovery/README.md`: the discovery docs (what the product is for), never rewritten; read
  the ones a module's guide names before planning in it.
- `GLOSSARY.md`: the project's terms, written by `/grill-with-docs` as they are settled.
- `docs/status/roadmap.md` and `docs/status/handoff.md`: where things stand and the next step.
- `docs/agents/workflow.md`: which skill to reach for, from grill to merge.
- `docs/guides/phase-run.md`: the unattended phase run, evening to morning.
- `.claude/workflow.json`: this repo's own rules for the hooks and the phase runner.

## This project's rules

One line each, added as they are agreed. A rule that only one phase needs goes in that phase's
gotchas file instead.
