---
name: setup-workflow
description: Set a repo up on the Brigade workflow, new or existing. Use when the owner types /setup-workflow in a project that has no .claude/workflow-version.json. Detects the stack, asks overwrite or merge for an existing repo, shows every file it will write or move, writes them after a yes, and stops before the commit.
disable-model-invocation: true
argument-hint: "[--settings <path>]  (a copy of ~/.claude/settings.json, for a trial)"
---

Setup does the same file work every time, so a script does it:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs"` (its header lists the commands). Your part is the
talking: what the owner wants, what the stack really is, and a yes before anything is written. The
owner is a new graduate: say what each choice changes for them, in plain words.

Work files (answers, plan, previews) go in `.git/brigade/` inside the project: never committed,
never in `git status`. `<dir>` below is the project's root (`CLAUDE_PROJECT_DIR`).

## 1. Look

1. Not a git repo: offer `git init -b main` (it is needed for the rest); stop if declined.
2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" detect <dir>`. Read all of it.
3. `stamp` set: this project is already set up. Say so and point at `/update-workflow`. Stop.
4. `brigadeEnabled` false: Brigade is not installed at project scope here. Say how
   (`claude plugin install brigade@<marketplace> --scope project`) and stop: the hooks would not run.

## 2. Pick the mode

- `empty` true → **new**. Nothing to ask.
- Otherwise ask (AskUserQuestion), with what each does to *this* repo (name its files):
  - **Merge** (recommended for a repo with history worth keeping): never overwrites a file. Adds the
    workflow's files beside the project's; appends the workflow's sections to `CLAUDE.md` and
    `.phase-run/` to `.gitignore`, each shown as a diff first; accepts today's docs as they are
    (`doc-check --adopt` lists those without a header, and the list only shrinks).
  - **Overwrite** (a clean slate): on a new branch `adopt-workflow`, moves `docs/`, `CLAUDE.md`,
    `AGENTS.md`, `GLOSSARY.md` (or its older name, `CONTEXT.md`) and a `.claude/settings.json` with more than the plugin keys into
    `docs/history/pre-workflow/` (moved, never deleted), then writes the workflow's files fresh.
- A dirty tree (`git.dirty` not empty) blocks either: list the files and stop until the owner
  commits or stashes them. The plugin install's own `.claude/settings.json` change does not count.

## 3. Confirm the stack, then the config

`node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" propose <dir>` gives the `.claude/workflow.json` the
stack suggests: the stop gate's checks and the phase run's gates from the `package.json` scripts that
exist, the package manager's allow rules. Never guess silently: show the owner what was detected
(package manager, TypeScript, the scripts found, a database such as Prisma's provider, a frontend)
and the proposed gates, and ask in one batch:

- the project's **name** and a **one-paragraph summary** (for `CLAUDE.md`);
- are these **gates** right (add, drop, reorder; a repo with no scripts names its own, e.g.
  `node --test`);
- **a migration target**: off unless the owner names one. A phase run applies migrations to it, so
  it must be a shared development database, never production; if named, fill `phaseRun.migrations`
  from `template/docs/guides/phase-run.md`'s "What your config sets";
- **a browser check** for a frontend: off unless the owner wants it (`phaseRun.browserCheck`);
- **does it have screens?** (default: yes when `frontend` is not empty; ask on an empty repo). A
  project with screens gets the design rung (`docs/agents/workflow.md`): the prompt file with its
  design review (`docs/agents/phase-run-prompt.md`, named by `phaseRun.prompt`) and
- **its prototype folder**, inside the app, so prototypes run in the real shell: show
  `prototypeDir` from detect (a route group where the framework has them: `src/app/(prototype)` for
  Next's app router, `src/routes/(prototype)` for SvelteKit, `pages/prototype` for Nuxt,
  `src/prototype` for a plain React app). When it is null, ask; "not yet" is a fine answer, set
  later in `tools/doc-config.mjs`'s `PROTOTYPE_DIR`;
- merge only: the project's **docs to treat as living** (default: the `.md` files directly under
  `docs/`) and its **code folders** for the path check (default: `topFolders`).

Write the answers to `.git/brigade/answers.json`:
`{ "mode", "name", "summary", "workflow", "frontend"?, "prototypeDir"?, "pathRoots"?, "liveDocs"? }`.

## 4. Show the plan, then write

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" plan <dir> --answers .git/brigade/answers.json --out .git/brigade/plan.json --preview .git/brigade/preview`
   prints what it would move, write, change and leave alone. A "Cannot go ahead" list: fix that first.
2. Show the owner the whole summary. For each "Changed" file, show the real diff:
   `git diff --no-index -- <file> .git/brigade/preview/<file>`. For each "Left alone" conflict, say
   that the project keeps its own file and what the workflow's version would have added. In merge,
   read the "same job" list out: the project's roadmap or handoff stays where it is, and the
   workflow's starts empty beside it; the owner moves content over when they like. Say two more
   things where they apply: `.github/workflows/checks.yml` runs the stop gate's checks on GitHub
   (the project's own from then on: edit it when the checks change), and a `CLAUDE.md` one folder
   down (`docs/CLAUDE.md`) gets a "read it first" line in the new top-level `CLAUDE.md`, as Claude
   reads a nested one only when it works in that folder.
3. Ask for a yes on that exact list. Then
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" apply <dir> --plan .git/brigade/plan.json`.
   It refuses if the repo changed since the plan: plan again and show it again.
4. If `apply` stops partway (an error after it began writing), the tree was clean before it, so the
   way back is `git reset --hard` and `git clean -fd`; overwrite mode then `git switch` back and
   delete `adopt-workflow`. Ask before running either: `git clean -fd` also removes an untracked
   `.claude/settings.json`, so commit the plugin install first.

## 5. Overwrite only: carry the old rules over

Read each file `apply` lists under `oldRules`: the project's `CLAUDE.md` and `AGENTS.md`, top-level or
one folder down, at their archived paths (a `docs/CLAUDE.md` is at
`docs/history/pre-workflow/docs/CLAUDE.md`). List each real rule it holds (a "never",
an "always", a command that must be used, a fact a session must know). Ask about them a few at a
time (AskUserQuestion, up to 4 per call: keep as is, reword, drop), and write the kept ones under
`CLAUDE.md`'s "This project's rules", one line each. Never drop one without asking.

An old glossary (`oldGlossary`: a `GLOSSARY.md`, or a `CONTEXT.md` from before 0.3.0) is handled the
same way: list its terms, ask which to keep, and write the kept ones into a new `GLOSSARY.md` in
the `domain-modeling` skill's format.

## 6. The rest of the setup

Ask before each; the owner may skip any.

- **Labels.** `gh label list --json name --jq '.[].name'`, against
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" labels`. Create only the missing ones
  (`gh label create <name> --color <color> --description "<description>"`), never edit an existing
  one. The triage labels and `docs/agents/issue-tracker.md` come from `/setup-matt-pocock-skills`:
  mention it.
- **Impeccable**, if `frontend` is not empty: offer it (a design skill for frontend work). On a yes:
  `claude plugin install impeccable@impeccable --scope project` (if that marketplace is unknown,
  `claude plugin marketplace add pbakaus/impeccable` first). Never copy its files into the repo.
- **autoMode lines.** Auto mode reads trusted infrastructure only from the user's own settings, so
  each project adds its lines there. Draft them, one per topic that applies, each
  `**Project <absolute path> — <topic>**: <one line>`: what it is (and whether its repo is private),
  cloud and secrets (where they are kept, by name only, never a value), key internal services,
  branches (protected or not), sensitive data, protected environments, routine work (the commands
  run under that path). Write them to `.git/brigade/automode.json` (a JSON list) and run
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" automode --settings <settings> --lines .git/brigade/automode.json`.
  `<settings>` is the path in this skill's arguments if one was given (a trial), else
  `~/.claude/settings.json`. Show the lines added and removed; on a yes run it again with `--apply`
  (it refuses a file it would reformat; then give the lines to paste), and show
  `claude auto-mode config`. Other projects' lines are never changed.

## 7. Check, and stop

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" verify <dir>`: doc-check, the template's two test
   suites, and the config through both loaders. A failure: fix it (in the config, or a doc's line),
   never by loosening a check.
2. Show `git status --short` and the drafted commit message:
   `chore: adopt the workflow (<mode> mode) — devlog #1`. Overwrite mode is on `adopt-workflow`: the
   owner merges it as any branch.
3. **Stop.** Setup never commits; the owner says when. Tell the owner the next steps: commit, then
   grill the first phase (`docs/agents/workflow.md`).

Known limits, to say if they apply: guard-shell's command parsing knows the `pnpm` and `npx`
wrappers, not `yarn` or `bun`; same-job docs are reported, never merged.
