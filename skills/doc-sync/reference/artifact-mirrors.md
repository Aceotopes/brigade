# doc-sync reference: Artifact mirrors (phase-end tier)

Moved out of `SKILL.md` on 2026-10-07, unchanged apart from this header. It was the skill's
"§2 step 7"; a reference to "step 7" or "§2 step 7" in an older doc means this file. **Read it only
when you are about to republish an Artifact page**, which in a phase happens once, in the finish
ticket (`SKILL.md` §1). A one-off change outside a phase that makes a mirror wrong still republishes
it in the same pass.

7. **Redeploy every drifted Artifact mirror — not just `docs/status/roadmap.md`'s.** Any file this
   pass touched, and any file that changed in a recent commit whose Artifact mirror was never
   confirmed current, is a candidate: `docs/status/roadmap.md` always has one once one's been
   published; `design/module-N/…` and `design/shared/…` flow diagrams and wireframes frequently do too
   (built for the owner's click-through review). Don't rely on remembering which files have
   mirrors — run `Artifact` with `action: "list"` to see every published Artifact and its
   last-updated date, then for each doc file that has one, compare that date against
   `git log -1 --format=%ai -- <file>` for the file it tracks. Redeploy anything where the
   file is newer than its mirror.

   **The roadmap mirror is hand-designed HTML, not a literal render of `docs/status/roadmap.md` —
   never redeploy it by passing the `.md` file path directly.** Publishing a `.md` path
   renders it through the Artifact tool's generic markdown pipeline (default typography, no
   theme, no cards, no badges), which silently discards whatever custom design (dark theme,
   module/ticket rail, status chips, a `.note-text` flex-wrap fix) an earlier session built by
   hand. This already happened for real: a redeploy during the ticket #11 session used
   `file_path: docs/status/roadmap.md` directly, believing it was a pure content sync, and only the
   owner comparing it against an old version caught that the artifact had gone from a
   dashboard to plain black-on-white text. Load `artifact-design` and rebuild real HTML that
   reads `docs/status/roadmap.md`'s current content into the existing design system every time this
   mirror is redeployed — never take the file-path shortcut for this one, even though it looks
   like the fast, obviously-correct path for every *other* markdown mirror in this table.

   **This step has already been skipped once, for real, not hypothetically.**
   `design/module-4/archive/expenses-flow.md`'s header was corrected in commit `52d788d`
   (devlog `#021`) to stop claiming ticket #7 needed a screen — the correction landed
   correctly in five files, but the diagram's own published Artifact mirror wasn't one of
   them, because nothing in this skill's routing table or step list said it needed to be. The
   stale claim sat live on that public-looking mirror for a full day until a separate,
   explicitly-requested drift check caught it — a fresh session would have had no way to know
   the mirror was wrong without being told to go check. Do this on every pass that touches a
   mirrored file, not only when someone asks "did anything drift?"

   Best-effort visual aid, not a second source of truth — but a stale mirror sitting next to a
   correct file is worse than no artifact at all, because it looks authoritative and isn't.
   Skip silently only for a file that has never been published as an Artifact; don't create
   one unprompted.

   **Republishing to an existing URL, the mechanics (learned 2026-09-28):**
   - The first publish to a mirror this session hasn't viewed is **refused**; the tool saves the
     live source locally and asks for **every line** to be read. Diff that file against the repo
     file (`git show HEAD:<path>`) first: identical apart from the service's page wrapper means
     nothing to merge, and the republish comes from the repo file. Something else means merge it
     in first.
   - Resending the same content right after a refusal is refused once more; publish again and it
     goes through. If it still refuses "in this same turn", do other work (a different mirror) and
     retry.
   - A "literal `.md` render" mirror republishes from the `.md` path itself. A generated/hand-built
     page (the roadmap, App Shell Flow, Admin/Sales Flow) is edited in a copy of the saved live
     HTML and republished from that copy. Its CRLF line endings mean exact-string edits must match
     `\r\n`.
   - Mirrors are keyed by URL, not repo path: **moving** a mirrored file changes nothing on the
     mirror itself. Update `design/README.md`'s mirrors table, and redeploy only when the content
     changed.
   - **Path-only drift may be deferred, never silently.** When a pass changes only the file paths
     a mirror's text mentions (a move, not a content change), re-reading ~100KB per mirror for a
     path word is poor value. Name each deferred mirror on an **Owed** line in the devlog entry;
     the next content change to that file redeploys it and clears the line (§4's "a mirror
     deferred by an earlier entry is still owed"). Content drift is never deferred this way.
   - Before republishing the roadmap page, open the local HTML in Playwright at 390px and ~1100px
     and check `document.documentElement.scrollWidth - innerWidth` is 0. Anything wider than the
     viewport (a long pill or `nowrap` chip) has shipped unnoticed before. A throwaway script
     belongs in the gitignored `scripts/` (run it from the repo root so `playwright` resolves).

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

   When only content changed (a ticket number, a status word, a devlog reference), edit the
   existing HTML file in place and republish to the same URL. When the *shape* of a source file
   changes — a new zone, a module gaining ticket-level history worth an expand panel, a new
   workflow on-ramp — the corresponding card/row/section markup needs a structural edit to
   match, not a text substitution inside markup that no longer fits what it's describing.
