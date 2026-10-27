# Steak To Juan's doc-sync rows

What Brigade's `doc-sync` skill took out when it went generic (README step 6): the rows only Steak To
Juan has, copied unchanged from its `.claude/skills/doc-sync/` at `905e2d8`. At README step 9 this
file becomes Steak To Juan's `docs/agents/doc-sync-rows.md`, the slot the skill reads first. Give it
a header (`job` / `kind` / budget) then, since every doc under `docs/` needs one.

## Every ticket (adds to the skill's §5, "Done means")

- **If the change added, wired or re-scoped a Module 6 Verb:** `docs/guides/module-6.md`'s verbs table
  matches `VERBS` / `ROLE_VERBS` / `MODULE_6_VERBS` (`src/lib/permissions.ts`) and
  `test/module-6-verbs.test.ts` passes. This one row of the owner's guide is not deferred to phase
  end: the test pins it.

## When to touch what (adds to `reference/routing-table.md`)

The first three rows are generic rows in STJ's wording (the generic skill dropped the Verbs table,
the `sync/` clause and the config file's exact format); where they disagree, these win.

| Where | Touch it when… |
|---|---|
| `docs/guides/module-N.md` | Phase end: the phases table's "What it gives you", traps, how-tos, owner-held items, present tense. A new module gets one (from `docs/_templates/module-guide.md`) when its planning starts. Its Verbs table moves with the code (`test/module-6-verbs.test.ts` pins it). |
| `docs/reference/tech-stack.md` | A technology is added, replaced or dropped; keep `CLAUDE.md`'s summary in step. `sync/` tooling is out of scope (`adr/0001`). |
| `.impeccable/config.json` | A file it names moves or is deleted, or a new exception is sanctioned with a reason. Load and re-dump it (2-space indent, CRLF); never a formatter. |
| `docs/claude-discovery-rounds/*.md` | A new discovery doc is finished: it gets a row in `CLAUDE.md`'s discovery index (and its count word). Never rewrite one. When built work creates a coordination point for a module not yet grilled, add a dated addendum before that doc's §1 (the new fact, the open question, a labelled recommendation) and a pointer from the roadmap. |
| `design/**` and `design/README.md` | Design lead-time work lands, a file is revised or archived, or a mirror is re-pointed (`design/README.md`'s tables). Redeploy any published mirror in the same pass. Delete a module's prototype once `DESIGN.md` documents it. |
| `README.md` | 🚩 Still the `create-next-app` boilerplate; replacing it is the owner's call. |
| `AGENTS.md` | Never: `next dev` regenerates it. |
| `scripts/README.md` (gitignored, local) | A kept script is added, retired or changes usage, in the same pass as its runbook entry. |
| The Build Roadmap Artifact (`https://claude.ai/artifact/3P5zZTpoYRVwN26dWXJ7Yg`) | Phase end, or when the roadmap, handoff or workflow changes. Hand-built HTML: read `artifact-mirrors.md` first. |

## The Build Roadmap Artifact (adds to `reference/artifact-mirrors.md`)

**Roadmap Artifact mirror — structure map (`https://claude.ai/artifact/3P5zZTpoYRVwN26dWXJ7Yg`; rebuilt
   slim 2026-10-26, devlog `#343`).** One line per item, like the roadmap itself: no per-ticket rows, no
   hashes, no dated history, and **never a history log in the page's head** (the old page carried 880
   lines of one). Its old content is in `docs/history/roadmap-before-2026-10-26.md`. It pulls from three
   files; check this table on every pass that touches any of them:

   | Artifact section | Pulls from | Update the section when… |
   |---|---|---|
   | Masthead + rule box | `docs/status/roadmap.md`'s header (the one-line rule, the rollout order) | The rule or the order changes |
   | **Up next** (three steps) | `docs/status/handoff.md`'s "Next session's plan" and "Waiting on the owner", shortened | Either list changes; it reads as an instruction, so it must never lag |
   | Not done: one card per module or group, one line per phase | `docs/status/roadmap.md`'s Not done sections | A phase starts, merges or is blocked |
   | Noted for later: one line per idea | `docs/status/roadmap.md`'s Noted for later lines (the full entries live in `noted-for-later.md`, linked) | An idea is added, filed or dropped |
   | Delivered: one line per module | `docs/status/roadmap.md`'s Delivered lines; links to the devlog archive | A module is delivered |
   | "How a phase moves" (collapsible) | `docs/agents/workflow.md`'s path of a phase, one line per step | The process changes |

   Doc links point at `https://github.com/Aceotopes/SteakToJuan/blob/main/<path>`; a moved doc means
   repointing its link. Edit the page from a copy of its live HTML (`Artifact` read), never from the `.md`.
   Design constraints established 2026-08-16 — honor these, don't reinvent them on the next
   redeploy:
   - **Dark-first by default, unconditionally.** The bare `:root` selector holds the dark
     palette; `:root[data-theme="light"]` is the only override, and there is **no**
     `prefers-color-scheme` media query — the mirror renders dark regardless of the viewer's OS
     theme unless a light theme is explicitly stamped. This was a deliberate earlier fix (the
     CSS carries its own comment explaining it), not an oversight — don't "fix" it back to a
     three-state light/dark/system pattern without checking with the owner first.
   - Palette pairs (dark / light): background `#14181b` / `#f5f6f7`, accent (amber, active/next)
     `#e08a45` / `#b8622e`, done (green) `#74b46a` / `#3f7a35`, blocked (red) `#e2664f` /
     `#b3402c`, link (blue) `#7cb2e6` / `#3d74a8`, **noted** (violet, added 2026-08-16 for the
     `💡 Noted For Later` zone — deliberately a fifth color, not a reuse of amber/blocked, so a
     captured-but-unfiled idea never visually reads as either "active work" or "blocked")
     `#b490e0` / `#7d4fb5`.
   - Interactivity is plain vanilla JS — every expandable element is `[data-toggle="<id>"]`
     toggling a sibling panel's `hidden` attribute and its own `aria-expanded`. No `capabilities`
     are declared on this Artifact and none are needed; plain expand/collapse isn't live data,
     shared state, or a file handoff, so `artifact-capabilities` doesn't apply here.
   - **To read any mirror's current live content before editing it, use the `Artifact` tool with
     `action: "read"` and the mirror's URL** — it returns the raw HTML and saves the full page to a
     local file (the result names it); build the republish from that file. *(Corrected 2026-09-21:
     this line used to say `WebFetch`, which now refuses `claude.ai/artifact/…` links outright. A
     `javascript_tool` DOM read via browser automation is also blocked by that tool's output
     filter — don't try either.)*
