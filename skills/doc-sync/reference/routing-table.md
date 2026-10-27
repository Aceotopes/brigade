# doc-sync reference: when to touch what

**What each doc is for** is in its own header (`job:`), gathered in `docs/README.md` by
`node tools/doc-index.mjs`, so a new doc is found the moment it has a header. This file holds only
**when to touch** each kind of file that `SKILL.md` §1 does not settle, and the files outside `docs/`.
A project's own files have their rows in its `docs/agents/doc-sync-rows.md`, read with this table.

**The tier decides when; the row decides how.** Inside a phase, a phase-end file is written once, in
the finish ticket, whatever a row below says.

## By folder

| Where | Touch it when… |
|---|---|
| `docs/status/roadmap.md` | A phase starts, merges or is blocked, or a module's state changes. One line per item, ≤200 characters, no history. A ticket does not touch it. |
| `docs/status/handoff.md` | Phase end (overwrite). Outside a phase: a session ends with unfinished work, or a listed blocker closed. |
| `docs/status/noted-for-later.md` | The owner wants an idea remembered but not filed (what / why not filed / full record), or a ticket's command-center check finds a real signal. An entry leaves only when filed as an issue or the owner drops it; its roadmap line goes with it. |
| `docs/status/open-items.md` | Never by hand: generated from the domain model's unclosed `OPEN-nn` items, the handoff's "Waiting on the owner" and each guide's "Things only you can settle". Settle an item where it lives. |
| `docs/guides/runbook.md` | A step only a person can run is added, changed or retired: what, when, prerequisites, the exact command, what it writes, idempotent or not. Not per ticket otherwise. |
| `docs/guides/module-N.md` | Phase end: the phases table's "What it gives you", traps, how-tos, owner-held items, present tense. A new module gets one (from `docs/_templates/module-guide.md`) when its planning starts. |
| `docs/guides/<tool>.md` | The tool it covers changes: a new error mode, a changed command, a retired resource. |
| `docs/reference/domain-model.md` | A table or column changes, or an `OPEN-nn` item is resolved: mark it `✅ CLOSED`, link the ADR, "Recommendation" becomes "Decided". |
| `docs/reference/tech-stack.md` | A technology is added, replaced or dropped; keep `CLAUDE.md`'s summary in step. |
| `CONTEXT.md` | A domain term appears or its definition sharpens (`mattpocock-skills:domain-modeling`'s format: one term, one word, rejects under `_Avoid_`). The why goes in an ADR. |
| `CLAUDE.md` | A rule, the stack, the working agreement, or a gotcha that bites every session changes. Never status. |
| `docs/agents/*.md` | The process, the ticket shape, the issue tracker, the labels or the domain-doc layout changes; keep `CLAUDE.md`'s "Agent skills" block in step. |
| `docs/agents/gotchas/<phase>.md` (doc-config's `GOTCHAS_FILE`) | A ticket adds, changes or retires a trap (`SKILL.md` §1). A rule that bites every session goes in `CLAUDE.md` instead. |
| `docs/handbook/<phase>.md` | Phase end: two to four chapters from the phase's implementation logs, each with its `**Basis:**` line (ticket, devlog, ADR) under its heading. |
| `docs/adr/NNNN-*.md` | A decision passes all three ADR tests. **`ls docs/adr/` before picking the number**: a numbering collision has happened once. Never rewrite one; supersede or amend it in its header. |
| `docs/history/devlog.md` | Every commit (`SKILL.md` §3). Rotated at phase end by `node tools/doc-rotate.mjs`. |
| `docs/history/implementation-log/NNN-*.md` | Every ticket or real code change (`SKILL.md` §1), before the commit go-ahead is asked for. Numbered on from the last file, independent of other numbers. |
| `docs/history/*` archives and snapshots | Never: frozen records. |
| `docs/research/*.md` | New research only; a re-check is a new dated file. |
| `docs/_templates/*.md` | A doc kind's shape changes. Keep `SKILL.md` §1/§3 in step. |

## Outside `docs/`

| File | Touch it when… |
|---|---|
| A published Artifact page that mirrors a doc | Phase end, or when the doc it mirrors changes. Read `artifact-mirrors.md` first. |
| `tools/phase-run/` | The run's behaviour changes: a gate, the park rule, a command a session needs allowed. Keep `ticket-prompt.md` §7 in step with `SKILL.md` §1; update `docs/guides/phase-run.md` in the same pass. |
| `tools/doc-*.mjs`, `tools/doc-check-baseline.json` | A doc path changes (`tools/doc-config.mjs`, which also lists the folders a cited path may start with), a stale phrase is added, or an index's shape changes; `node --test tools/doc-tools.test.mjs` covers them, and CI runs both on every push. `--report` prints every doc's size against its budget (`.github/workflows/doc-check.yml`). The baseline changes only with `--update-baseline`, attended, never in a phase run. |
| `.claude/workflow.json` | A project rule for the hooks changes: a command to block, a phase-run stop check. |
| `.claude/spec-issues.json` | A spec is published: its number joins the list (`/ticket-check` does it). |
| `.claude/settings.json` | A working-agreement rule changes that a setting, not a hook, enforces. |
| Brigade's hooks and skills (`guard-shell`, `stop-gate`, `doc-sync`, `ticket-check`) | Never in a project: they live in the plugin. A change every project wants is made there; one project's need goes in its `.claude/workflow.json` or `docs/agents/doc-sync-rows.md`. Keep `docs/agents/ticket-template.md` in step with `ticket-check`. |

### In a project that uses Impeccable

| File | Touch it when… |
|---|---|
| `DESIGN.md` + `.impeccable/design.json` | Per ticket: a short entry for a new reusable component or a changed rule. Phase end: the `impeccable-documenter`'s full pass. Refresh the sidecar with it. A new colour role or cap needs an ADR first. |
| `PRODUCT.md` | A product-level fact changes. Through `/impeccable init`; keep its `<!-- impeccable:product-schema N -->` marker. |
| `.impeccable/surfaces/*.md` | A screen family is reshaped past its brief (write the next version), or a target file moves (repath its frontmatter). |
| `.impeccable/critique/*.md` | Never: point-in-time snapshots. |
| `.impeccable/config.json` | A file it names moves or is deleted, or a new exception is sanctioned with a reason. Load and re-dump it in the format it already has; never a formatter. |
