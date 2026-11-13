# #032 — A piped commit message is checked

**Ticket:** `#27` (attended, found while building it) · **Devlog:** `#47` · **ADRs:** none
**Date:** 2026-11-13

---

## The Problem

Before a commit, the guard hook (`hooks/guard-shell.mjs`) runs doc-check on the commit's message,
so a commit that cites no devlog entry is refused. It found the message in two ways: an inline `-m`
(the command's own text), or a `-F <file>`. A message piped in with `git commit -F -` and a heredoc
matched neither. doc-check ran with no message at all, and the commit passed. That is how this
branch's devlog #44 commit first went in without its entry: it was amended in before anything was
pushed.

## The Solution

`-F -` (or `--file -`) is read like `-m`: the command's own text, heredoc and all, goes to
doc-check as `--message`. A `-F <file>` is still read from the file.

## Why This Approach

The heredoc's text is in the command the hook sees, exactly as an inline `-m`'s is. Reading it
there needs no new parsing.

## Alternatives turned down

- **Refuse `-F -`.** It is a common way to pass a multi-line message, and the text is right there.

## Real bugs found along the way

The one above, a plugin hook bug from before 0.7.0.

## What This Concretely Unblocks

An attended session's piped commit is held to the devlog rule, as a night session's always was (it
writes a message file).

## Run by hand

None.

## Assumptions made

- **The command text stands in for the message.** doc-check looks for `devlog #N` in it, so the
  command's other words do no harm, as with `-m`.

## Common Questions

**Does a night session change?** No. Its prompt writes the message to a file and runs `git commit
-F <file>`.

## References

- Code: `hooks/guard-shell.mjs` (`main`).
- Test, written first: `tests/guard-shell.test.mjs` (a piped message, and a message file).
