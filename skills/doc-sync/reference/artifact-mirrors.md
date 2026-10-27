# doc-sync reference: Artifact mirrors (phase-end tier)

**Read it only when you are about to republish an Artifact page**, which in a phase happens once, in
the finish ticket (`SKILL.md` §1). A one-off change outside a phase that makes a mirror wrong still
republishes it in the same pass. A page only this project has (its structure, its design rules) is
described in the project's `docs/agents/doc-sync-rows.md`; read its row first.

7. **Redeploy every drifted Artifact mirror, not just the roadmap's.** Any file this pass touched,
   and any file that changed in a recent commit whose Artifact mirror was never confirmed current,
   is a candidate: the status docs usually have one once one has been published, and design files
   (flow diagrams, wireframes built for the owner's click-through review) often do too. Don't rely
   on remembering which files have mirrors: run `Artifact` with `action: "list"` to see every
   published Artifact and its last-updated date, then for each doc file that has one, compare that
   date against `git log -1 --format=%ai -- <file>` for the file it tracks. Redeploy anything where
   the file is newer than its mirror.

   **A hand-designed mirror is HTML, not a render of its `.md`: never redeploy it by passing the
   `.md` file path.** Publishing a `.md` path renders it through the Artifact tool's generic
   markdown pipeline (default typography, no theme, no cards, no badges), which silently discards
   whatever design an earlier session built by hand. It has happened: a redeploy believed to be a
   pure content sync turned a dashboard into plain black-on-white text, and only the owner
   comparing it against an old version caught it. Load `artifact-design` and rebuild real HTML that
   reads the doc's current content into the existing design every time, even though the file-path
   shortcut looks like the fast, obviously correct path.

   **This step has been skipped before, for real.** A doc's header was corrected in five files,
   but the doc's own published mirror was not one of them, because nothing said it needed to be.
   The stale claim sat live on the mirror for a day until a separate, explicitly requested drift
   check caught it; a fresh session would have had no way to know. Do this on every pass that
   touches a mirrored file, not only when someone asks "did anything drift?"

   Best-effort visual aid, not a second source of truth — but a stale mirror sitting next to a
   correct file is worse than no artifact at all, because it looks authoritative and isn't.
   Skip silently only for a file that has never been published as an Artifact; don't create
   one unprompted.

   **Republishing to an existing URL, the mechanics (learned 2026-09-28):**
   - **To read any mirror's current live content, use the `Artifact` tool with `action: "read"` and
     the mirror's URL.** It returns the raw HTML and saves the full page to a local file (the result
     names it); build the republish from that file. `WebFetch` refuses `claude.ai/artifact/…`
     links, and a browser-automation DOM read is blocked by that tool's output filter.
   - The first publish to a mirror this session hasn't viewed is **refused**; the tool saves the
     live source locally and asks for **every line** to be read. Diff that file against the repo
     file (`git show HEAD:<path>`) first: identical apart from the service's page wrapper means
     nothing to merge, and the republish comes from the repo file. Something else means merge it
     in first.
   - Resending the same content right after a refusal is refused once more; publish again and it
     goes through. If it still refuses "in this same turn", do other work (a different mirror) and
     retry.
   - A "literal `.md` render" mirror republishes from the `.md` path itself. A hand-built page is
     edited in a copy of the saved live HTML and republished from that copy. Check that copy's line
     endings: exact-string edits must match them (`\r\n` in a CRLF file).
   - Mirrors are keyed by URL, not repo path: **moving** a mirrored file changes nothing on the
     mirror itself. Update whatever table lists the mirrors, and redeploy only when the content
     changed.
   - **Path-only drift may be deferred, never silently.** When a pass changes only the file paths
     a mirror's text mentions (a move, not a content change), re-reading ~100KB per mirror for a
     path word is poor value. Name each deferred mirror on an **Owed** line in the devlog entry;
     the next content change to that file redeploys it and clears the line. Content drift is never
     deferred this way.
   - Before republishing a hand-designed page, open the local HTML in headless Playwright at 390px
     and ~1100px and check `document.documentElement.scrollWidth - innerWidth` is 0. Anything wider
     than the viewport (a long pill or `nowrap` chip) has shipped unnoticed before. Keep a
     throwaway script out of the commit (a gitignored folder, or the session's scratchpad).

   When only content changed (a ticket number, a status word, a devlog reference), edit the
   existing HTML file in place and republish to the same URL. When the *shape* of a source file
   changes — a new zone, a section gaining history worth an expand panel, a new workflow on-ramp —
   the corresponding card/row/section markup needs a structural edit to match, not a text
   substitution inside markup that no longer fits what it's describing.
