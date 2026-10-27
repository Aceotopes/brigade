# Phase run: build ticket #{{N}}

You are one session in an unattended phase run. **Nobody will answer a question**, even if
someone is watching, and anything you would have to ask permission for is refused at once. You
build exactly one ticket, commit it once, and stop. A script then checks your work
and either pushes it or sends its failure back to you.

The order below matters: build, check in the browser, write the docs, commit once, then review and
amend.

- Ticket: **#{{N}} {{TITLE}}**
- Branch: `{{BRANCH}}` (you are already on it; never switch, merge, rebase or push)
- Spec: {{SPEC}} (never write "closes" or "fixes" beside a spec's number)
- The commit before your work: `{{BASE}}`
- A `frontend` ticket: **{{FRONTEND}}**

Earlier tickets of this phase may already be on this branch. You have no memory of them. What they
left you is in the code, the gotchas file and the ADRs.

## 1. Read

1. `gh issue view {{N}} --json title,body,comments --jq '.title, .body, (.comments[].body)'`, in
   full (a plain `gh issue view` prints nothing in these shells): acceptance criteria, **Not in this
   ticket**, **Decisions already made**, **Handed forward**, **Areas**, the prototype screen, the
   gotcha blocks it names. If an earlier ticket's implementation log or this ticket's "Handed
   forward" says something is owed to this ticket, it is part of this ticket.
2. What the ticket names, and only that: the gotcha blocks (`docs/agents/gotchas/README.md` indexes
   every phase's file; read the blocks named by the ticket and any whose files you will touch), the
   ADRs, and for a `frontend` ticket its prototype screen.
3. The code you will change.

{{PROJECT_READ}}

Do not read `docs/status/handoff.md`, `docs/handbook/`, the devlog's archive (`docs/history/devlog/`)
or the older entries of `docs/history/devlog.md`. They are phase-end documents and cost a lot to read.

**How to run a command here.** A command the allow list does not match is refused at once, and
on past nights the same few shapes were refused over and over:
- **No redirects and no chains through other tools**: no `> file`, `2>&1`, `| Out-File`, and no
  `cd … &&`. The tool already captures stdout and stderr. To keep output, read it and write the
  file with the Write tool. Run a command from the project folder as it is.
- **A long-running server** (a QA server) runs with the shell tool's background option, as written
  in §5, never with `&` or a redirect.
- **Waiting.** For a subagent (a reviewer), wait for the notice that it finished; never poll its
  output file, which can stay empty to the end (one did). Any other wait is a `node` script
  under `.phase-run/tmp/` with its own deadline (shell `if` and `[` tests are refused here), never
  an open-ended `until … sleep` loop in the background: one session's two kept running after its
  work was done, and the finished ticket was parked at the cap.
- **Deleting a file**: under `.phase-run/tmp/`, `rm .phase-run/tmp/<file>` (or `Remove-Item
  .phase-run/tmp/<file>`); a file you created anywhere else, `node -e "require('fs').rmSync('<path>')"`.
- **Never `git stash`.** Work hidden in a stash passes the clean-tree check and is lost to the
  ticket; a restarted session once found one and applied it. Commit or delete instead.

## 2. Say your plan

Before writing code, post your plan as a comment on the issue (`gh issue comment {{N}} --body-file
<file>`): the approach in a few lines, the files you expect to touch, the tests you will write
first, and anything you intend to assume. This stands in for plan mode. Then carry on without
waiting.

## 3. A question with nobody to ask: decide small ones, park big ones

**Decide it yourself** when the choice is small and easy to change later: a label's wording, an
empty state, a sort order, a helper's name, which existing component to reuse. Take the option that
best fits the spec, the prototype and the shipped app. Record each one, with how to reverse it, in
the implementation log under **Assumptions made** and in the verdict file (§9).

**Park the ticket** when the choice is the owner's: a money rule, privacy, who may see or
do something, a schema choice that is hard to reverse, or anything the ticket's own decisions
contradict. To park: stop building, do not commit, and write the verdict file with
`"status": "parked"` and the question. Ask it so it can be answered in one line, and give your
recommended answer. Work you have already written may stay in the tree; the runner keeps it on a
side branch.

Never guess a big one to keep moving, and never park a small one to be safe.

## 4. Build

- **Test-first.** Use the `tdd` skill at the seams the ticket names. Run the checks and single test
  files as you go, and before you stop, what the stop check runs: {{STOP_CHECKS}}. The runner runs
  the project's full checks itself, after you stop, and sends any failure back to you to fix.
- **A test never reads the real clock.** Pass a fixed `at` (or a fixed date) to what you test;
  never `new Date()`, `Date.now()` or "today" inside a test's expectations. A test that read the
  real clock once expired and failed a whole phase's suite.
- **Stay inside the ticket.** Build what the acceptance criteria ask and nothing in "Not in this
  ticket". If something outside the ticket's Areas must change, keep it minimal and say why in the
  implementation log.
- **Rules that hold everywhere** are in `CLAUDE.md`.
- **Migrations:** {{MIGRATIONS}}. Never edit a migration that an earlier commit added.
- {{SHELL_ENV}}
- **Temporary files** (a commit message, a Playwright script, a seed) go in `.phase-run/tmp/`,
  which is ignored by git. Nothing may be left in the tree outside your commit.

{{PROJECT_BUILD}}

## 5. Browser check (any ticket that changes what a screen shows or does)

{{PROJECT_BROWSER_CHECK}}

A backend-only ticket skips this section and says so in the implementation log.

{{BROWSER_GATE}}

## 6. One design review (`frontend` tickets only)

{{PROJECT_REVIEW}}

## 7. Docs, then one commit

Follow the **per-ticket tier** of the `doc-sync` skill. In short: the implementation
log in full; a devlog entry; the ticket's gotchas block in this phase's file,
`{{GOTCHAS_FILE}}` (made from `docs/_templates/gotchas-phase.md` if it does not exist yet); an ADR if something hard to reverse was decided; the runbook only for a new manual
step; and the per-ticket rows the project adds in its doc-sync rows file, if it has one.
**No index line and no roadmap line**: run `node tools/doc-index.mjs`, which writes the indexes, then
`node tools/doc-check.mjs`. The phase-end tier (the devlog rotation, handbook, owner's guide, roadmap,
session handoff, Artifact pages) is **not** yours.

No doc carries this commit's hash: cite `devlog #NNN` or the ticket `#{{N}}` instead. The devlog
entry's heading is `## #NNN · <type> · <title>`, at most 15 lines (doc-sync §3).

Then commit **once**:

- Write the message to `.phase-run/tmp/commit-{{N}}.txt` and run `git commit -F` on it.
- Shape: `type(scope): summary — devlog #NNN, Closes #{{N}}`, a short paragraph of why, bullets of
  what changed, a closing line on how it was verified.
- `Closes #{{N}}` must be there. No attribution trailer of any kind. Never a closing keyword beside
  the spec's number.
- If you need to change anything after committing, **amend** (`git commit --amend`). A ticket is
  exactly one commit.
- Never push, never close the issue, never open a pull request. The runner does those.

## 8. Code review, folded into that commit

The `code-review` skill reads committed work, so it runs after the commit. Use it with
`{{BASE}}` as the fixed point (its diff is `git diff {{BASE}}...HEAD`, which is exactly this
ticket) and issue #{{N}} as the spec. Fix what is real, re-run the tests the fix touches, and
**amend** the commit. A finding you turn down goes in the implementation log's "Alternatives turned
down", with the reason, in the same amend.

**If a fix touched a screen's source and the ticket changes a screen, run the browser check (§5)
again on the amended code** and save fresh screenshots. The runner's browser-check gate counts only
screenshots newer than your last source edit.

## 9. The verdict file

First stop every background task you started (a QA server, any wait) with TaskStop.
Then, last, write `.phase-run/verdict-{{N}}.json`: the runner reads a verdict written in this turn,
with the turn over, as your end.

```json
{
  "status": "built",
  "summary": "One sentence: what a person can now do.",
  "assumptions": ["Each small choice you took, and how to reverse it."],
  "runByHand": ["Each step only a person can do: a secret to set, a script to run, a check on a real phone."],
  "foundElsewhere": ["A real problem you noticed in code this ticket did not own (an earlier ticket's, or shipped code), with where it is. You did not fix it."],
  "handedForward": ["Something this ticket leaves for a named later ticket (#N), and what exactly is owed."]
}
```

`foundElsewhere` and `handedForward` reach the owner's morning report; without them, two real
bugs and an owed note were once lost across two phases. Say each also in the implementation log.

or, when parked:

```json
{
  "status": "parked",
  "question": "The question, your recommended answer, and what each answer changes."
}
```

Use empty lists when there is nothing to report. Then stop. When you stop, the stop check runs
automatically ({{STOP_CHECKS}}); if one fails you are sent back once to fix it.
