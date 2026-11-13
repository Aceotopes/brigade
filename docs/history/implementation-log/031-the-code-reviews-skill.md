# #031 — The code review's skill is config

**Ticket:** `#27` (attended, before #41) · **Devlog:** `#46` · **ADRs:** 0001 (applied), none new
**Date:** 2026-11-13

---

## The Problem

The ticket prompt tells each session to run "the `code-review` skill" on its commit. Claude Code
has a built-in skill by that name too. A bare name can start the built-in one instead of the
project's own review (a plugin's `<plugin>:code-review`). At the source a night session did, and
the fix there named the skill in full in every prompt. Brigade names no plugin of its own, so which
skill reviews a ticket is the project's choice.

## The Solution

- **`phaseRun.codeReview`**: the review skill's full id, such as `"<plugin>:code-review"`. The
  runner's loader (`config.mjs` `skillName`) accepts `name` or `plugin:name`, and refuses a
  sentence, a path or an empty value. The hooks' loader never looks inside `phaseRun`.
- **The prompt** (`ticket-prompt.md`) reads `{{CODE_REVIEW}}` in both places it named the skill.
  `promptValues` fills it from the key. Unset, it fills in `` `code-review` ``, so the prompt reads
  exactly as before.
- **Setup:**
  - its skill asks for the review skill as a checklist item;
  - its `verify` warns while the key is unset (a warning, never a failure).
- **The guide** lists the key.

## Why This Approach

- **Config, not a name in code** (ADR 0001). Brigade doesn't ship a review skill, and projects use
  different ones.
- **Unset reads as today.** A project that never sets it sees no change, and only a warning.

## Alternatives turned down

- **Setup reads the installed plugins and proposes one.** A plugin's skill list isn't in the
  settings that setup reads. The checklist asks, as for every tool row.
- **Name one plugin's skill in the template prompt.** That ties Brigade to a plugin it doesn't
  ship.

## Real bugs found along the way

None beyond the bare name.

## What This Concretely Unblocks

- A project can make sure its nights run its own review.

## Run by hand

None.

## Assumptions made

- **This repo's own config sets the key only after the release's `/update-workflow`.** Its pinned
  0.6.2 runner refuses unknown keys.

## Common Questions

**What do I write?** The name the session's skill list shows, with its plugin's:
`"<plugin>:code-review"`.

## References

- `docs/discovery/05-brigade-0.7.0.md`, the 2026-11-13 addendum; ADR 0001.
- Code: `template/tools/phase-run/config.mjs` (`skillName`), `template/tools/phase-run/run.mjs`
  (`promptValues`), `template/tools/phase-run/ticket-prompt.md`, `scripts/setup.mjs` (`verify`),
  `skills/setup-workflow/SKILL.md`, `template/docs/guides/phase-run.md`.
- Tests, written first:
  - `tests/phase-run-config.test.mjs`: the prompt named and unset, the refusals, the hooks' loader;
  - `tests/setup.test.mjs`: verify's warning.
