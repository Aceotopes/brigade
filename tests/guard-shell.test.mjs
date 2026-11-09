// Tests for hooks/guard-shell.mjs: which project it guards, and which commands are aimed at it.
// Run: node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { FAILING_DOC_CHECK, repo, runHook } from "./helpers.mjs";

/** The hook as Claude Code runs it in `project`: the session's cwd is the project unless given. */
function guard(project, command, { cwd = project, env = {} } = {}) {
  return runHook("guard-shell.mjs", { tool_input: { command }, cwd }, { CLAUDE_PROJECT_DIR: project, ...env });
}

// The frozen runner copy (#16): inside a run the rules are the copy's workflow.json.
const COPY = ".phase-run/phase-x/runner";
const rule = (word) => JSON.stringify({ version: 1, guard: { block: [{ when: "always", command: `^${word}\\b`, message: `no ${word} here` }] } });

test("with PHASE_RUN_RUNNER set the guard applies the copy's rules; without it, the live tree's", () => {
  const { dir } = repo("brigade-project-", { ".claude/workflow.json": rule("live-tool"), [`${COPY}/.claude/workflow.json`]: rule("frozen-tool") });
  const env = { PHASE_RUN: "1", PHASE_RUN_RUNNER: join(dir, COPY) };
  assert.equal(guard(dir, "frozen-tool x", { env }).status, 2);
  assert.match(guard(dir, "frozen-tool x", { env }).stderr, /no frozen-tool here/);
  assert.equal(guard(dir, "live-tool x", { env }).status, 0, "the live rule, written mid-run, does not judge the run");
  assert.equal(guard(dir, "live-tool x").status, 2, "attended: the live tree's rule");
  assert.equal(guard(dir, "frozen-tool x").status, 0);
});

test("a PHASE_RUN_RUNNER that names no folder blocks, rather than guarding with no rules", () => {
  const { dir } = repo("brigade-project-", { ".claude/workflow.json": rule("live-tool") });
  const result = guard(dir, "git status", { env: { PHASE_RUN: "1", PHASE_RUN_RUNNER: join(dir, COPY) } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /runner copy[\s\S]*is missing/);
});

test("the project is CLAUDE_PROJECT_DIR: its own doc-check runs before a commit there", () => {
  const { dir } = repo("brigade-project-", FAILING_DOC_CHECK);
  const result = guard(dir, 'git commit -m "feat: x"');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Blocked by Brigade's guard-shell hook: doc-check failed[\s\S]*doc-check stub ran/);
});

// D10 (#31): inside a run the commit's doc-check is the copy's, as the runner's gate is.
test("inside a run the pre-commit doc-check is the run's copy's, pointed at the project; attended, the live one", () => {
  const passing = 'import { relative } from "node:path";\nif (relative(process.cwd(), process.env.PHASE_RUN_ROOT) !== "") { console.error("not run in the project"); process.exit(1); }\n';
  const { dir, git } = repo("brigade-project-", { ...FAILING_DOC_CHECK, [`${COPY}/.claude/workflow.json`]: '{ "version": 1 }\n', [`${COPY}/tools/doc-check.mjs`]: passing });
  git("checkout", "-q", "-b", "phase-x");
  // No PHASE_RUN_ROOT given: the hook itself points the copy at the project.
  const env = { PHASE_RUN: "1", PHASE_RUN_RUNNER: join(dir, COPY) };
  const inRun = guard(dir, 'git commit -m "feat: x"', { env });
  assert.equal(inRun.status, 0, inRun.stderr);
  assert.match(guard(dir, 'git commit -m "feat: x"').stderr, /doc-check stub ran/, "attended: the live tree's doc-check");
});

test("a run's copy taken without doc-check (an older runner) leaves the commit to the live one", () => {
  const { dir, git } = repo("brigade-project-", { ...FAILING_DOC_CHECK, [`${COPY}/.claude/workflow.json`]: '{ "version": 1 }\n' });
  git("checkout", "-q", "-b", "phase-x");
  const env = { PHASE_RUN: "1", PHASE_RUN_RUNNER: join(dir, COPY), PHASE_RUN_ROOT: dir };
  assert.match(guard(dir, 'git commit -m "feat: x"', { env }).stderr, /doc-check stub ran/);
});

test("a run's copy that took a doc-check and lost it blocks the commit; the live one never judges instead", () => {
  const passing = { "tools/doc-check.mjs": "process.exit(0);\n" };
  const { dir, git } = repo("brigade-project-", { ...passing, [`${COPY}/.claude/workflow.json`]: '{ "version": 1 }\n', [`${COPY}/manifest.json`]: '{ "docCheck": true, "finished": false }\n' });
  git("checkout", "-q", "-b", "phase-x");
  const result = guard(dir, 'git commit -m "feat: x"', { env: { PHASE_RUN: "1", PHASE_RUN_RUNNER: join(dir, COPY), PHASE_RUN_ROOT: dir } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /has lost its tools\/doc-check\.mjs/);
});

test("inside a run the guard refuses a baseline update, naming why", () => {
  const { dir } = repo();
  const result = guard(dir, ["node tools/doc-check.mjs", "--update-baseline"].join(" "), { env: { PHASE_RUN: "1" } });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /judged by the baseline the run's copy took at run start/);
});

test("a project without the doc tools is not blocked for the missing check", () => {
  const { dir } = repo();
  assert.equal(guard(dir, 'git commit -m "feat: x"').status, 0);
});

test("a commit aimed at another repo skips the project's doc-check (the `git -C` bug)", () => {
  const { dir } = repo("brigade-project-", FAILING_DOC_CHECK);
  const other = repo("brigade-other dir-").dir; // a space in the name, so quoting matters
  assert.equal(guard(dir, `git -C "${other}" commit -m "chore: x"`).status, 0);
  assert.equal(guard(dir, `git -C '${other}' --no-pager commit -m "chore: x"`).status, 0);
  assert.equal(guard(dir, `cd "${other}" && git add -A && git commit -m "chore: x"`).status, 0);
  assert.equal(guard(dir, `Set-Location -Path "${other}"; git commit -m "chore: x"`).status, 0);
  // Started in the other repo, the session's cwd is the target:
  assert.equal(guard(dir, 'git commit -m "chore: x"', { cwd: other }).status, 0);
});

test("a command that comes back into the project is checked again", () => {
  const { dir } = repo("brigade-project-", FAILING_DOC_CHECK);
  const other = repo("brigade-other-").dir;
  assert.equal(guard(dir, `cd "${other}" && cd "${dir}" && git commit -m "x"`).status, 2);
  assert.equal(guard(dir, `git -C "${join(dir, "docs")}" commit -m "x"`).status, 2, "a folder inside the project is the project");
  // A folder the shell computes can't be resolved here, so the project's rules still apply (fail closed):
  assert.equal(guard(dir, 'git -C "$PWD" commit -m "x"').status, 2);
  assert.equal(guard(dir, 'cd $(git rev-parse --show-toplevel) && git commit -m "x"').status, 2);
  assert.equal(guard(dir, 'Set-Location $env:USERPROFILE; git commit -m "x"').status, 2);
  // Relative `-C`s stack, the way git reads them:
  const parent = join(other, "..");
  const name = other.slice(parent.length + 1);
  assert.equal(guard(dir, `git -C "${parent}" -C "${name}" commit -m "x"`).status, 0);
});

test("Git Bash's /d/... form of a path is read as a Windows path", { skip: process.platform !== "win32" }, () => {
  const { dir } = repo("brigade-project-", FAILING_DOC_CHECK);
  const other = repo("brigade-other-").dir;
  const posix = other.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replaceAll("\\", "/");
  assert.equal(guard(dir, `git -C ${posix} commit -m "x"`).status, 0);
  const inside = dir.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replaceAll("\\", "/");
  assert.equal(guard(dir, `git -C ${inside} commit -m "x"`).status, 2);
});

test("the owner's own rules hold in every repo: no attribution trailer, no --no-verify", () => {
  const { dir } = repo();
  const other = repo("brigade-other-").dir;
  const trailer = guard(dir, `git -C "${other}" commit -m "x" -m "Co-Authored-By: Someone <a@b.c>"`);
  assert.equal(trailer.status, 2);
  assert.match(trailer.stderr, /no attribution trailer/);
  assert.match(guard(dir, `git -C "${other}" commit --no-verify -m "x"`).stderr, /--no-verify/);
});

test("a spec issue's closing keyword is the project's rule: blocked there, passed elsewhere", () => {
  const { dir } = repo("brigade-project-", { ".claude/spec-issues.json": '{ "specs": [41] }\n' });
  const other = repo("brigade-other-").dir;
  assert.match(guard(dir, 'git commit -m "feat: x, closes #41"').stderr, /would close a spec issue/);
  assert.equal(guard(dir, `git -C "${other}" commit -m "feat: x, closes #41"`).status, 0);
  assert.equal(guard(dir, 'git commit -m "feat: x, closes #42"').status, 0);
});

test("inside a phase run every rule holds for every command, whatever repo it is aimed at", () => {
  const { dir } = repo();
  const other = repo("brigade-other-").dir;
  const run = { env: { PHASE_RUN: "1" } };
  assert.equal(guard(dir, `git -C "${other}" push`).status, 0, "attended: another repo's push is not the project's business");
  assert.match(guard(dir, `git -C "${other}" push`, run).stderr, /never pushes/);
  assert.match(guard(dir, `cd "${other}" && git stash`, run).stderr, /never stashes/);
  assert.match(guard(dir, `git -C "${other}" commit -m "x"`, run).stderr, /commits only on a phase-\* branch/);
});

test("git's global options before the subcommand do not hide it from a rule", () => {
  const { dir } = repo();
  const run = { env: { PHASE_RUN: "1" } };
  assert.match(guard(dir, "git -c core.pager=cat --no-pager push origin x", run).stderr, /never pushes/);
  assert.equal(guard(dir, "git --no-pager stash list", run).status, 0);
});
