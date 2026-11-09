---
job: The decisions that are hard to reverse, one numbered record each, and their status.
kind: generated
---
# Decisions (ADRs)

One file per decision, `NNNN-<slug>.md`, from `docs/_templates/adr.md`; never rewritten, only
superseded or amended. The index below is generated from each ADR's header.

<!-- generated:start adr-index -->
- [0001](0001-no-stack-recipes.md) · *amended* · No stack recipes: a project declares its stack, and Claude writes its config
- [0002](0002-roadmap-repo-is-truth.md) · *accepted* · The roadmap's source is the repo; its page is a generated view
- [0003](0003-stop-check-trusts-a-receipt.md) · *accepted* · The stop check skips the tests when a receipt says they passed on exactly this code
- [0004](0004-each-stop-check-keeps-its-own-receipt.md) · *accepted* · Each stop check keeps its own receipt, keyed on the code that check reads
- [0005](0005-one-run-one-judge.md) · *accepted* · One phase run is judged by one frozen copy of the runner and one Brigade version
- [0006](0006-numbering-at-landing.md) · *accepted* · A lane writes its devlog entry, log and commit message unnumbered, and Landing numbers them
- [0007](0007-two-roots.md) · *accepted* · A lane's run state lives in the primary checkout; its session's files live in its worktree
- [0008](0008-landing-regates-never-forces.md) · *accepted* · Landing replays each lane's ticket onto the newest tip, re-gates it there, and never forces
<!-- generated:end adr-index -->
