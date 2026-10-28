# Brigade

**A Claude Code plugin that turns "build this feature" into a planned, checked, overnight build
that ends in one pull request for you to merge.**

Named after the kitchen brigade: the head chef sets the menu, the line cooks execute, and nothing
leaves the pass unchecked. In Brigade you are the head chef. You and Claude settle every question
up front, Claude sessions build the tickets one by one while nobody watches, and scripts check
every plate before it goes out. Brigade grew out of the workflow of one real app. It was then made
generic, so any repo can adopt it with one command.

## What it solves

Letting an AI agent build software unattended goes wrong in predictable ways. Brigade answers each
one with a script, not a reminder in a prompt:

| The problem | What Brigade does |
|---|---|
| A session forgets the repo's rules (it runs a formatter over every file, skips a hook with `--no-verify`, pushes to `main`) | The **`guard-shell`** hook reads every shell command before it runs and blocks the ones the rules forbid |
| A session says "done" while the tests fail | The **`stop-gate`** hook runs the project's checks before a session may stop. The phase runner then runs every gate again itself, trusting no session's word |
| A ticket built at night stops on a question, and nobody is awake to answer it | **`/ticket-check`** reads the spec, every ticket and the code before the run, and asks you every open question in one sitting |
| Docs drift from the code, or bloat until nobody reads them | **`doc-check`** fails a commit on stale phrases, paths that no longer exist, missing headers, docs over their line budget, and out-of-date indexes. The **`doc-sync`** skill keeps each doc to one job |
| Setting all this up by hand in every repo | **`/setup-workflow`** detects the stack and writes everything: new repos and existing ones |
| A copied workflow goes stale when the plugin improves | **`/update-workflow`** re-copies the plugin's files, using a version stamp to tell your edits from untouched files |

## How it works

```
/grill-with-docs → prototype (if there are screens) → /to-spec → /to-tickets → /ticket-check
      → the phase run (unattended, a night at a time) → the finish ticket → you merge
```

A **phase** is one piece of work: a spec issue on GitHub and its tickets. The **phase runner**
(`tools/phase-run/run.mjs`) builds each `run-ready` ticket in dependency order on a `phase-*`
branch, in a fresh Claude Code session each. After each session it runs the gates itself, sends a
failure back for up to three fix rounds, then pushes the branch or parks the ticket with a reason.
It never touches `main`: merging the one draft pull request is your go-ahead.

Brigade has three parts:

| Part | What it is | Where it lives |
|---|---|---|
| **The plugin** | The two hooks and four skills | Installed into Claude Code; updated with the plugin |
| **The template** | The doc tools, the phase runner, the workflow docs and the doc-check CI job | Copied into your repo by setup, because CI and `node` run them there; re-copied by `/update-workflow` |
| **Your config** | `.claude/workflow.json` (your rules, checks and gates), the doc-check settings, the CI checks | Written once by setup from your stack; yours from then on, and never overwritten |

## Requirements

- [Claude Code](https://claude.com/claude-code)
- Node.js 22 (the generated CI uses 22) and git
- The GitHub CLI, [`gh`](https://cli.github.com/), logged in: tickets are GitHub issues, and the runner opens the pull request
- A GitHub repo for the project
- The **mattpocock-skills** plugin, for the planning and building skills the workflow calls
  (`/grill-with-docs`, `/to-spec`, `/to-tickets`, `tdd`, `code-review`):
  `claude plugin install mattpocock-skills@claude-plugins-official`
- Optional, for a frontend: **Impeccable**, a design plugin. Setup offers to install it.

## Install

In a Claude Code session, opened in your project:

```
/plugin install brigade --marketplace Aceotopes/brigade
```

Claude Code asks you to confirm adding this repo as a marketplace, shows what Brigade installs,
then asks where to turn it on:

| Choice | Brigade runs in | Recorded in |
|---|---|---|
| **For you (user scope)** | Every repo on this machine | `~/.claude/settings.json` |
| **For all collaborators on this repository (project scope)** | This repo, for anyone who installs it | `.claude/settings.json`: commit it |
| **For you, in this repo only (local scope)** | This repo, for you only | `.claude/settings.local.json`, not committed |

With user scope, the guard's own rules (no `--no-verify`, no attribution trailer) apply in every
repo. A repo's own rules, doc-check and the stop gate only act where setup has written Brigade's
files. Committing project scope turns Brigade on for collaborators, but each one still runs the
install once on their own machine.

From a shell, or in a script, the same in one line. With nobody there to answer a prompt, it takes
the scope as a flag (user scope if left out):

```
claude plugin install brigade --marketplace Aceotopes/brigade --scope project
```

Both need Claude Code 2.1.292 or later. On an older version, add the marketplace first, then
install from it by its catalog name, `argee`:

```
claude plugin marketplace add Aceotopes/brigade
claude plugin install brigade@argee --scope project
```

## Quick start

In a Claude Code session opened in your project folder:

1. **`/setup-workflow`**. A new repo is set up directly. For an existing repo it asks whether to
   **merge** (keep everything, add the workflow beside it) or **overwrite** (start clean on a
   branch, with old docs archived, not deleted). It shows every file before writing and runs the
   checks. It never commits: you commit.
2. **`/grill-with-docs <what the phase is>`**. Answer until Claude has no questions left.
3. For a phase with screens, ask for the flow diagram and a clickable prototype, and approve it.
4. **`/to-spec`**, then **`/to-tickets`**. The spec becomes a GitHub issue (say `#12`), and the
   tickets follow it.
5. **`/ticket-check 12`**. Answer its batch of questions; ready tickets get the `run-ready` label.
6. In a terminal, on `main`, with everything committed and pushed:
   ```
   node tools/phase-run/run.mjs --spec 12 --branch phase-checkout --dry-run
   node tools/phase-run/run.mjs --only 13 --branch phase-checkout
   node tools/phase-run/run.mjs --spec 12 --branch phase-checkout --max 4
   ```
   The dry run lists what would be built. Build the first ticket while you are awake, then leave
   the night run going.
7. **The morning:** read the report on the pull request, answer any parked question on its issue,
   and test the branch by hand. Run the same command again the next night for the tickets left.
8. **Finish:** do the finish ticket in an attended session on the branch, then merge the pull
   request with **Create a merge commit** (never squash), and close the spec issue yourself.

The full walkthrough, with every option, is in the [guide](docs/guide.md).

## Commands

**Brigade's slash commands.** You type these; Claude never starts them by itself.

| Command | What it does |
|---|---|
| `/setup-workflow [--settings <path>]` | Set a repo up: new, merge or overwrite. Detects the stack, proposes the config, shows the plan, writes after a yes, and runs the checks. Also offers the GitHub labels, Impeccable for a frontend, and your auto-mode lines |
| `/update-workflow` | After a plugin update: shows what changed since your stamp and re-copies the template files you never edited. Never touches your config |
| `/ticket-check <spec>` | The readiness check before a run: one batch of questions, answers written into the tickets, `run-ready` on each ready one |
| `doc-sync` | Claude uses it by itself after a verified change and before a commit, so each doc keeps telling the truth |

**The phase runner**, `node tools/phase-run/run.mjs`:

| Flag | Meaning | Default |
|---|---|---|
| `--spec <N>` | Build the `run-ready` tickets of spec issue `#N`, in dependency order | — |
| `--only <N>` | Build one ticket only | — |
| `--until <N>` | With `--spec`: stop after ticket `#N` (no nightly cap, unless `--max` is given) | — |
| `--branch phase-<name>` | The phase branch; created on the first night, continued after | required |
| `--max <n>` | At most this many tickets in one run | 4 |
| `--fix-rounds <n>` | Times a failed gate goes back to the session | 3 |
| `--minutes <n>` | Time limit for one ticket's session | 120 |
| `--wait-hours <n>` | How long to wait for a usage limit to lift before giving up | 6 |
| `--permission-mode <mode>` | The permission mode of `--print` sessions (background sessions always refuse what they would have to ask about) | `acceptEdits` |
| `--model <name>` | The sessions' model | Claude Code's |
| `--print` | Hidden `claude -p` sessions instead of background sessions you can watch | off |
| `--dry-run` | List what would be built and check preflight; build nothing | off |

While a run goes, `claude agents` in a second terminal lists its sessions, and `claude attach <id>`
opens one to watch.

**The doc tools**, from the project root:

| Command | What it does |
|---|---|
| `node tools/doc-check.mjs` | Stale phrases, missing paths, headers and line budgets, stale indexes. Runs before every `git commit` |
| `… --head`, `… --message-file F`, `… --message TEXT` | Also check that the devlog's top entry matches HEAD, or the commit about to be made |
| `… --report` | Each budgeted doc's size against its limit, fullest first |
| `… --update-baseline` | Accept today's stale-phrase and missing-path hits (attended sessions only) |
| `node tools/doc-index.mjs [--check]` | Rewrite the generated indexes, or only check that they are current |
| `node tools/doc-rotate.mjs --phase <id> --label "<name>" [--dry-run]` | At a phase's end, move the devlog's closed entries into that phase's archive |

## What the hooks enforce

**Always**, in a repo with Brigade:
- your own block rules from `.claude/workflow.json`;
- no `--no-verify`;
- no attribution trailer on a commit or pull request;
- no closing keyword before a spec issue's number;
- doc-check before every `git commit`.

**Inside a phase run**, also:
- no push, since only the runner pushes;
- no commit off the `phase-*` branch, no branch switching, merge or rebase;
- no closing an issue or opening a pull request by hand;
- no printing `.env`.

The stop gate runs your `stopGate.checks` once each time a session tries to stop. It is a guard
rail on the command text, not a sandbox, so the runner checks the result again.

## Configuration

Your rules live in `.claude/workflow.json`, written by setup from your stack:

```json
{
  "version": 1,
  "guard": { "block": [{ "when": "always", "command": "prettier .*--write", "message": "Format only the lines you changed." }] },
  "stopGate": { "checks": [{ "label": "Typecheck", "run": "pnpm exec tsc --noEmit" }] },
  "phaseRun": { "gates": [{ "label": "Tests", "run": "pnpm test" }] }
}
```

`phaseRun` also holds what must be running before a run, ports, a QA database, migrations, a
browser check and the prose each session is given. Every key is described in the
[guide](docs/guide.md#6-configuring). A typo fails loudly instead of quietly turning a rule off.

## Status

Version **0.2.2** (see [CHANGELOG.md](CHANGELOG.md)). It has been proven on throwaway repos:
- an empty repo, end to end: setup, a real overnight run, its pull request, an update, the finish
  ticket and the merge;
- a copy of an existing app, in both merge and overwrite mode.

Known limits:
- The guard's command parsing knows the `pnpm` and `npx` wrappers, not `yarn` or `bun`. It does not
  follow `gh --repo` or paths passed as arguments.
- In merge mode, when your docs and the workflow's do the same job (two roadmaps), both are kept
  and listed; nothing is merged for you.
- A generated `.github/workflows/checks.yml` is tested here, but has not been seen running on
  GitHub yet.

## More

- [docs/guide.md](docs/guide.md): the full guide (setup modes, a phase start to finish,
  configuration, updating, troubleshooting)
- [docs/development.md](docs/development.md): working on Brigade itself (layout, tests, how it was
  built, releasing)
- [CHANGELOG.md](CHANGELOG.md): what each version changed
