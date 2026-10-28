---
job: This project's part of each phase-run session's prompt; the runner splices each section into its own prompt.
kind: living
max-lines: 120
---
# Phase run: this project's part of the prompt

Read by `tools/phase-run/run.mjs` (`phaseRun.prompt` in `.claude/workflow.json`): each `## ` section
below is spliced into the runner's prompt at its place. The sections it has room for are Read,
Build, Browser check, Review and Fix. Written by `/setup-workflow` for a project with screens; edit
it as the project's habits settle.

## Read

For a `frontend` ticket, also its screen's entry in its module's flow diagram
(`design/flows/module-N.md`: the screen brief under its heading) and `DESIGN.md`. With Impeccable,
also the screen's surface brief in `.impeccable/surfaces/`.

## Review

Start one fresh reviewer, with no part of this conversation: Impeccable's `impeccable-finish-reviewer`
agent if this project has it, otherwise a general subagent. Give it the screenshots you saved, the
route, the screen's brief from its flow diagram (and its surface brief, with Impeccable) and
`DESIGN.md`. Ask for an ordered list of material mismatches against them: a missing state, a broken
rule of the visual system, something the brief says it must not do. Fix the list in one batch, take
one confirming look, and move on. One round: there is no score to chase.
