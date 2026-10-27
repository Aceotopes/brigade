---
job: How each kind of doc starts: copy the template, fill it in, keep its header.
kind: living
---
# Doc templates

Copy one, fill it in, keep the header (`job`, `kind`, a budget where the template has one). doc-check
reads the header at every commit. The kinds and rules are in [`docs/README.md`](../README.md).

| Template | For | Lands in |
|---|---|---|
| [`adr.md`](adr.md) | A decision that is hard to reverse, surprising without context, and a real trade-off | `docs/adr/NNNN-<slug>.md` |
| [`devlog-entry.md`](devlog-entry.md) | One commit's entry (at most 15 lines) | the top of `docs/history/devlog.md` |
| [`implementation-log.md`](implementation-log.md) | One ticket's learning walkthrough | `docs/history/implementation-log/NNN-<slug>.md` |
| [`gotchas-phase.md`](gotchas-phase.md) | A phase's gotchas file, made at the phase's first block | `docs/agents/gotchas/<phase>.md` (where `tools/doc-config.mjs`'s `GOTCHAS_FILE` puts it) |
| [`handbook-period.md`](handbook-period.md) | A phase's handbook chapters, written in its finish ticket | `docs/handbook/<phase>.md` |
| [`module-guide.md`](module-guide.md) | A module's plain-English owner guide | `docs/guides/module-N.md` |
| [`research.md`](research.md) | Point-in-time findings from primary sources | `docs/research/<slug>.md` |

`<phase>` is the phase branch's name without `phase-` (`phase-6g` → `6g`). Numbers: `ls` the folder and
take the next one; never infer it.
