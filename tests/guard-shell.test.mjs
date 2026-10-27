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

test("the project is CLAUDE_PROJECT_DIR: its own doc-check runs before a commit there", () => {
  const { dir } = repo("brigade-project-", FAILING_DOC_CHECK);
  const result = guard(dir, 'git commit -m "feat: x"');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Blocked by Brigade's guard-shell hook: doc-check failed[\s\S]*doc-check stub ran/);
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
