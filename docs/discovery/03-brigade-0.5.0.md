# Discovery: Brigade 0.5.0, the out-of-step notice

> **Addendum 2026-11-04:** 0.5.0 is built, test-first and attended (tickets #6–#8), and proven by
> the hands-on check (D11).
> - **The check:** real `claude -p` sessions (Claude Code 2.1.317) in scratch git repos, with this
>   Brigade loaded by `--plugin-dir` and the hook events in the output stream:
>   - a stamp older (0.0.1), newer (99.0.0) and missing each sent its line, and Claude quoted it
>     with the "do not act" note;
>   - an equal stamp, and `PHASE_RUN=1`, sent nothing, and Claude answered "NONE".
>
>   Setup's own command in a scratch repo wrote the catalog entry with `autoUpdate: true` beside
>   the install's `enabledPlugins`, and staged it. A later `update` offered nothing.
> - **Found in the build, fixed with tests:**
>   - a stamp without a version read as "from undefined", so a version must be dotted numbers;
>   - a rewrite of a CRLF settings file, or `package.json`, would have changed every line, so JSON
>     edits keep the file's line endings.
> - **Changed from the decisions:** no generic file may name the catalog's owner
>   (`tests/no-project-specifics`). So the ID and the repo are read from `.claude-plugin/`, and
>   `plugin.json` gains `repository`. A file a rewrite would reformat gets the setting "by hand".
> - **Not yet seen live:**
>   - Claude Code reading `autoUpdate` from a project's settings (`/plugin` → Marketplaces);
>   - a release fetched by itself, then the notice at the next launch;
>   - the notice's line as the terminal shows it, rather than in the output stream.
>
>   The first and third wait for 0.5.0 to be pushed and set up in a real project; the second
>   needs a release after 0.5.0 to reach it.
>
> **Changes:** Goals 2 and 3 are met; Goal 1 is built and waits on a later release to be seen.

**Rounds:** 2026-11-03. One grill with the owner, after asking how a project that uses Brigade
learns of a new release. The facts about Claude Code's plugin updates were checked in its docs
first. **Status:** decided, not built.

Like any discovery doc, this one is never rewritten: a later fact is added as a dated addendum at
the top.

## Goals

1. A set-up project hears about a new Brigade release without the owner checking GitHub.
2. A project whose stamp and the installed Brigade differ says so at the start of a session, in
   either direction, and names the one command that fixes it.
3. Nothing in the repo is rewritten without the owner's yes.

## Problems (what happens today)

| Problem | Today |
|---|---|
| A release reaches no project by itself | Claude Code's plugin auto-update is off by default for a third-party catalog, and Brigade never turns it on. The owner has to remember to run `claude plugin update` |
| The plugin and the copied files drift apart | A plugin update brings new hooks and skills, but the template files stay at the stamp's version until `/update-workflow`. Nothing says so. Newer hooks over an older runner is the risky mix, and older hooks refuse a newer config's keys |
| The catalog is named after a person | The plugin ID is `brigade@argee`, in a public repo |

## Requirements and stack

Node only, no dependencies, as before. The facts it builds on, from Claude Code's docs:
- Auto-update is set per catalog by `autoUpdate` on its `extraKnownMarketplaces` entry in a
  settings file. It runs after the first message of a session, and says
  `Plugin updated: <name> · Run /reload-plugins to apply`.
- An update happens only when the version changes; `plugin.json`'s `version` comes first.
- A plugin's `SessionStart` hook can show the user a line (`systemMessage`) and give Claude context
  (`additionalContext`). Its matchers include `startup`.

## Decisions

1. **Suggest, never apply.** The notice only tells the owner. `/update-workflow` stays the owner's
   to type, and shows its plan before it writes.
2. **Out of step, both ways.**
   - Plugin newer than the stamp: "Brigade 0.5.1 is installed, but this project's files are from
     0.5.0. Type /update-workflow to see what changed."
   - Stamp newer than the plugin: "This project is on Brigade 0.5.1, but this machine has 0.5.0.
     Run `claude plugin update brigade@aceotopes`, then /reload-plugins."
3. **Silent in a phase run** (`PHASE_RUN=1`): the run goes on as before.
4. **Not set up** (Brigade on, no stamp): "Brigade is on here, but this repo isn't set up yet. Type
   /setup-workflow." The owner's pick. It suits the project-scope install the README recommends;
   with a user-scope install it shows in every repo.
5. **New releases arrive through Claude Code's auto-update.** Brigade makes no network call of its
   own.
6. **Auto-update is on in the project's committed `.claude/settings.json`**: `"autoUpdate": true`
   on the catalog's `extraKnownMarketplaces` entry, so a collaborator gets it too. `/setup-workflow`
   writes it; `/update-workflow` offers it to a set-up project without it.
7. **The notice runs on a fresh launch only** (`startup`, not resume, clear or compaction), every
   launch while the versions differ. No snooze, so no state to keep.
8. **Both audiences.** The owner sees the line. Claude gets the same fact as context, with "do not
   act on it unless the owner asks".
9. **The catalog is renamed `argee` → `aceotopes`**: the plugin ID becomes `brigade@aceotopes`. The
   repo and the plugin keep the name Brigade. Now is the cheapest time: no project has it installed.
10. **No migration for the old ID.** No project carries `brigade@argee`; the CHANGELOG says to
    reinstall as `brigade@aceotopes`.
11. **The version.** 0.5.0: a new hook, a new setting and a new plugin ID. Proven by unit tests and
    one hands-on check with the real hook in a scratch repo, as 0.4.1 was. No trial release.
12. **No ADR.** Moving to a network check of Brigade's own later is easy to reverse.

**Tickets:**
1. The out-of-step notice (D1–D4, D7, D8).
2. The catalog rename and the auto-update setting (D5, D6, D9, D10).
3. Finish: the docs, the hands-on check and the 0.5.0 version. Blocked by 1 and 2.

## Out of scope

- Applying an update by itself, at any level.
- A snooze or once-a-day limit on the notice.
- Brigade's own check of GitHub for a release.
- Stopping a phase run that is out of step.

## Open questions

None for the build. Not yet seen until a later release reaches a real project: auto-update fetching
it, then the notice on the next launch.
