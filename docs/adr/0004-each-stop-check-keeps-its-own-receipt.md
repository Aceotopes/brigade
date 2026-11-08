---
status: accepted
---
# Each stop check keeps its own receipt, keyed on the code that check reads

ADR 0003 gave the tests row a receipt, and 0.4.1 let it leave out a list of unread paths. Every
receipt row still had to share that one list, and only the tests row had one. One real project's
runner measured what this costs: in 20 of 24 receipt misses, the tree differed only in docs, the
devlog, gotchas or results the session wrote *after* its last test run. A wider shared list would
have skipped only about a third of the time, because a file one check never reads is often one
another check does read. A walk script is invisible to the tests, for example, but lint reads it.

So each stop-check row may now carry its own `receipt: true` and its own `unread` list, and an
optional `name` that names its receipt file. Each check's key is the working tree minus *that
check's* list, all built from one `git add -A` into a temporary index. A gate row's
`unreadOf: "<name>"` reuses one check's list to skip that gate on a diff wholly on the list (the
suite skip). One JS matcher serves both the key and the skip. In it, `*` stays inside one folder,
`**/` crosses folders, and a leading `!` puts a path back, the same rules as git's `:(glob)`, so
existing lists keep their meaning.

## Considered options

- **One shared list, made wider.** Rejected because of the 20-in-24 measure above: one list can't
  say "the tests can't read this, but lint can".
- **Git pathspecs for the key, plus a JS matcher for the suite skip.** Two matchers could disagree
  on the same path, and a receipt would then vouch for a tree the skip judged differently.
- **A migration rewriting set-up projects' rows.** Old files stay valid, so `/update-workflow`
  offers the new rows through refresh instead, with a yes for each row.

## Consequences

- The stop check's minutes go to near zero when a session's last edits are docs. The source
  project measured about 7 minutes a ticket going to 0.3 s.
- **The trust is unchanged:** a wrong list can skip only the hook's courtesy rerun. The gates trust
  no receipt and run every check. A suite skip runs only when the diff is wholly on a list the
  owner wrote, and typecheck and lint still run.
- A list must name file shapes, not whole folders a check might read from (`docs/**/*.json`, not
  `docs/**`, when a test reads a doc). Setup and refresh warn about test files that read a listed
  path.
