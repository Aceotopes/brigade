---
name: doc-sync
description: Sync this project's documentation to the current state of the repo. Use after implementing and verifying any change — a feature, a schema change, a decision, a config change — and always before a commit. Also use when documentation is suspected stale (a claim that contradicts the code, an OPEN item that reads unresolved but has a decision elsewhere, a handoff note that doesn't match git log).
---

Keep every doc honest about the current state of the project, no more and no less. Each file has
one job; touch only the ones the change affects. Skipping a file that isn't affected is correct.

**This runs after verification**, not after writing code, and before the commit.

Rewritten 2026-10-07 into two tiers (owner's decision; the reasoning is
`docs/history/workflow-upgrade-plan.md`). The long reference material moved out and is read only when
needed:

- `docs/README.md`: every doc and its job, generated from each doc's own header, so a new doc is
  found the moment it has one (a doc under `docs/status`, `guides`, `reference`, `agents` or
  `handbook` without a header fails doc-check).
- `reference/routing-table.md`: when to touch each kind of file that §1 does not cover, and the
  files outside `docs/` (tools, hooks, Artifact pages). Read the row of any file you are about to touch.
- `reference/artifact-mirrors.md`: how to republish an Artifact page. Phase end only.

## 1. Two tiers

**The rules every doc keeps** (since 2026-10-26; `docs/README.md` has them in full): one job; one fact,
one home; a living doc holds no history; every doc's header holds its budget and doc-check enforces it.
**A ticket never adds history to a living doc.** History goes into the devlog and the implementation log;
status into the roadmap, and only when a phase's state changes. New docs start from `docs/_templates/`.

### Every ticket

| File | What to write |
|---|---|
| `docs/history/implementation-log/NNN-*.md` | 🚨 **Required, in full.** The owner's way of understanding the platform. Start from `docs/_templates/implementation-log.md`; the section guide is in that folder's `README.md`. Plain English, college level. **No index row**: the index is generated (`node tools/doc-index.mjs`). Skipped only for a docs/process commit with no code change. |
| `docs/history/devlog.md` | One entry per commit, in §3's shape, at most 15 lines. |
| The phase's gotchas file (`docs/agents/gotchas/module-N/<phase>.md`) | The ticket's block, under a `` **`#NNN` — what it covers (built YYYY-MM-DD):** `` heading: only the traps the code, the ADRs and the roadmap don't make plain. The file is made from `docs/_templates/gotchas-phase.md` at the phase's first block. **No index line**: the index is generated. A trap a test now enforces is one line, "pinned: `test/<file>.test.ts`". A rule that bites every session belongs in `CLAUDE.md` instead. |
| `docs/adr/NNNN-*.md` | Only when something was decided that is hard to reverse, surprising without context, and a real trade-off. Start from `docs/_templates/adr.md`. `ls docs/adr/` before picking the number; never infer it. Never rewrite an old ADR: set its header's `status: superseded` (or `amended`, with a dated note) and write the new one with `supersedes:`. |
| `docs/status/roadmap.md` | **Nothing, as a rule.** Its phase line changes only when the phase starts, merges or is blocked; the draft pull request counts the tickets. |
| `docs/status/noted-for-later.md` | The command-center check: if the ticket exposed a real signal a future monitoring dashboard could show, one line under the sync/ops dashboard's suggestion list. Most tickets add nothing; silence is the correct report. |
| `docs/guides/runbook.md` | Only when the ticket adds a step a person must run (a migration to apply by hand, a secret, a script). This cannot wait for phase end. |
| `DESIGN.md` (+ `.impeccable/design.json`) | A **short** entry, only when the ticket adds a reusable component or changes a rule (a token, a colour role, a cap), in the section format the file already uses. A new colour role needs an ADR first. |
| `CLAUDE.md`, `CONTEXT.md`, `docs/reference/domain-model.md`, `docs/reference/tech-stack.md` | Only when a rule, a term, the schema or the stack changed. Each holds a budget in its header: compress before growing, and check with a search that anything trimmed still exists elsewhere. |

### Once per phase, in its finish ticket

- **Rotate the devlog** after the phase's last ticket and before the finish commit's own entry:
  `node tools/doc-rotate.mjs --phase <phase> --label "Phase <PHASE> — <name>"`. Every closed entry moves
  to `docs/history/devlog/<phase>.md` (frozen); the indexes regenerate.
- The handbook's chapters for the phase, in `docs/handbook/<phase>.md` (from `docs/_templates/handbook-period.md`),
  drawn from its implementation logs (expect two to four), numbered on from the last chapter.
- The module's owner guide (`docs/guides/module-N.md`): the phases table's "What it gives you", traps,
  how-tos, owner-held items. Present tense; no build history.
- `docs/status/roadmap.md`: the phase's line, and the next phase's.
- `docs/status/handoff.md`: where things stand and the next step. Overwrite, don't append (≤120 lines).
- `DESIGN.md`'s full re-documentation and its sidecar (the `impeccable-documenter`), the finish
  review, the design files' dated notes, the prototype deleted.
- Every Artifact page, the Build Roadmap page included: `reference/artifact-mirrors.md`.
- A pass over the phase's gotcha blocks: retire the ones that no longer bite, collapse the ones a test
  now enforces to "pinned: …". Then close the finished phase's files: its gotchas file and its handbook
  file get `growth: closed` and `max-lines` set to their size, so they can only shrink.
- **Doc health:** run `node tools/doc-check.mjs --report` and trim anything at 90% or over before it
  blocks a commit; read `docs/status/open-items.md` and close (where it lives) what the phase settled.

**Why nothing is lost:** each ticket runs in a fresh session, so files are the memory. The "why" is
written into the implementation log and the ADR while it is fresh; the phase-end documents are
written from those. What is given up: the handbook and the owner's guide lag by up to one phase.

**Work outside a phase** (a one-off change on `main`) has no finish ticket. It does the per-ticket
tier, plus any phase-end file the change makes wrong. Its gotchas block goes in the newest phase's file.

## 2. Order, and the checks

1. Schema and vocabulary first (`docs/reference/domain-model.md`, `CONTEXT.md`), then decisions (`docs/adr/`),
   then `CLAUDE.md` / `DESIGN.md` if a rule moved. Closing an `OPEN-nn` item is not optional: mark
   it `✅ CLOSED`, link the ADR.
2. The gotchas block, the runbook if needed.
3. The implementation log.
4. The devlog entry, **last**, so it lists what was built rather than what was intended.
5. **Run `node tools/doc-index.mjs`, then `node tools/doc-check.mjs`.** doc-check does what used to be
   greps run from memory: stale phrases in status docs ("not yet committed", "awaiting the commit
   go-ahead", "not pushed yet", "uncommitted", "not yet decided", `⚠ OPEN-`), paths and relative links
   in live docs that no longer resolve, every doc's header budget (lines, line length, devlog entry
   length), a missing header, and any generated index that is out of date.
   Fix every line it names. A stale phrase or missing path that is correct as written (the line quotes
   the phrase, or says the file is gone) is recorded by an attended session with `--update-baseline`,
   after reading it; never inside a phase run. A budget has no baseline: trim the doc, or raise the
   limit in its header, where the diff shows it. The hook also runs doc-check before every `git commit`.

Two checks the script cannot make:

- **A reversal is stale in its own words.** When the change reverses an earlier decision, search for
  the words that recorded the *original* decision ("deferred to its own module"), across the repo.
  The fixed phrase list will not catch them. This missed five files once (2026-08-27).
- **A moved, renamed or deleted file** also means repathing code comments that cite it (`src/`,
  `test/`, `prisma/`), `design/README.md`'s layout and path map, `.impeccable/config.json`, and any
  surface brief's frontmatter.

## 3. The devlog entry: one per commit, short

`docs/history/devlog.md` holds the **current phase's** entries, one per commit, newest on top. The top
entry is open until a commit message cites it (`devlog #NNN`); then it is closed and never edited,
and the next work starts a new number. Numbers are global and never reused. At phase end the
finish ticket moves the closed entries into the archive (`node tools/doc-rotate.mjs --phase <name>`).

```md
## #NNN · <type> · <what this entry covers>

**Built:** 3–5 bullets: the behaviour first, then the main pieces by name.
**Verified:** what was run and seen (suites and counts, the browser check and as whom), and what was not.
**Next:** the one thing that follows. **Record:** implementation log NNN, adr/NNNN (if any).
```

- `<type>` is the commit's own prefix: one of `tools/doc-config.mjs`'s `DEVLOG_TYPES`
  (feat, fix, docs, chore, refactor, test, style, design, ci, infra, research, perf).
- **At most 15 lines.** The devlog's header holds that budget and doc-check enforces it. The full
  walkthrough is the implementation log; the devlog is the timeline that points at it. Add
  **Decided:** (with its ADR) or **Run by hand:** only when there is one.
- **No commit hash, anywhere, for this commit.** A doc cites `devlog #NNN` or the ticket `#N`;
  `git log --grep "devlog #NNN"` finds the hash. This is why a pull request is merged with a merge
  commit, never squashed: an entry closes when a commit message cites it.

## 4. The commit

**The message:** narrative, not a file list. It agrees with the devlog entry.

```
type(scope): short summary — devlog #NNN, Closes #N (adr/NNNN if one)

One short paragraph of why, for a reader with no memory of the conversation.

- What changed, one line per concrete thing, related files grouped
- Anything a reviewer would otherwise dig for (a drift fix, a reversed decision)

How it was verified, stated plainly. For a docs-only change say what was checked instead.
```

- **`Closes #N`** for the ticket's own issue, the exact keyword. A plain `#N` closes nothing.
- **Never a closing keyword beside a spec issue's number** (`.claude/hooks/spec-issues.json`): the
  owner closes specs by hand. Write "Part of #N".
- **No attribution trailer, ever.**

**Outside a phase run** (any session on `main`): draft the message, stage the files, and **stop**.
Present it and wait for an explicit go-ahead, every time. Commit and push are two separate asks.
After the push, confirm the issue closed (`gh issue view <N> --json state`); a missed keyword is
fixed with `gh issue close <N> --comment "Implemented in <hash> — … Full record: devlog #NNN."`.

**Inside a phase run** (a session started by `tools/phase-run/run.mjs` on a `phase-*` branch): the
session commits the ticket itself, once, when its checks pass, and never pushes. The runner pushes
the branch and keeps one draft pull request; the owner's merge of it is the go-ahead
(`CLAUDE.md`, Working agreement). `Closes #N` fires at that merge, so nothing is closed by hand
during a run. A fix after the commit amends it; a ticket is one commit.

## 5. Done means

- Every per-ticket file the change affects reflects the new state.
- The implementation log entry exists, with its Common Questions.
- `node tools/doc-index.mjs` has run and `node tools/doc-check.mjs` is clean, and for a reversal or a moved file, §2's two extra checks ran.
- The devlog entry is the last edit made.
- **If the change added, wired or re-scoped a Module 6 Verb:** `docs/guides/module-6.md`'s verbs table
  matches `VERBS` / `ROLE_VERBS` / `MODULE_6_VERBS` (`src/lib/permissions.ts`) and
  `test/module-6-verbs.test.ts` passes. This one row of the owner's guide is not deferred to phase
  end: the test pins it.
- In a finish ticket: every phase-end file above, and each Artifact page checked against its source
  (`reference/artifact-mirrors.md`), none assumed current.

## On unfinished work

This project keeps one durable "what's next" file: `docs/status/handoff.md`, in the repo. Do not
also run `mattpocock-skills:handoff`; a second handoff outside version control is the drift this
skill exists to prevent. Inside a phase, the open tickets and the runner's morning report on the
pull request say what is left; the handoff is rewritten at phase end.
