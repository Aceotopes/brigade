// Tests for hooks/stop-gate.mjs: inert outside a phase run, and reading the project it is run for.
// Run: node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { repo, runHook, write } from "./helpers.mjs";

function stop(project, env = {}, input = {}) {
  return runHook("stop-gate.mjs", { cwd: project, ...input }, { CLAUDE_PROJECT_DIR: project, ...env });
}

test("outside a phase run the stop check does nothing", () => {
  const { dir } = repo();
  write(dir, { "changed.txt": "work nobody checked\n" });
  assert.equal(stop(dir).status, 0);
});

test("the second stop goes through: the runner owns the fix loop", () => {
  const { dir } = repo();
  write(dir, { "changed.txt": "x\n" });
  assert.equal(stop(dir, { PHASE_RUN: "1" }, { stop_hook_active: true }).status, 0);
});

test("the project is CLAUDE_PROJECT_DIR: its clean tree and its parked verdict are read", () => {
  const { dir, git } = repo();
  // Nothing written since the base: nothing to check.
  assert.equal(stop(dir, { PHASE_RUN: "1", PHASE_RUN_BASE: git("rev-parse", "HEAD") }).status, 0);
  // A parked ticket has nothing to check, even with work in the tree.
  write(dir, { "changed.txt": "x\n", ".phase-run/verdict-7.json": '{ "status": "parked" }\n' });
  assert.equal(stop(dir, { PHASE_RUN: "1", PHASE_RUN_TICKET: "7", PHASE_RUN_BASE: git("rev-parse", "HEAD") }).status, 0);
});
