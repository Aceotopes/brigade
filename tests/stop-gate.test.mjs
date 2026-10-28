// Tests for hooks/stop-gate.mjs: inert outside a phase run, and reading the project it is run for.
// Run: node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { PLUGIN, repo, runHook, write } from "./helpers.mjs";

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

// The hook writes stop-check-log.jsonl and the runner reads it (metrics.mjs hookTime). The two live in
// different places once installed, so this test runs the real hook and reads its row with the runner's code.
test("each stop check leaves a log row the runner's hookTime reads", async () => {
  const { hookTime } = await import(pathToFileURL(join(PLUGIN, "template/tools/phase-run/metrics.mjs")).href);
  const { dir, git } = repo("brigade-project-", { ".claude/workflow.json": JSON.stringify({ version: 1, stopGate: { checks: [{ label: "Fine", run: "node -e 0" }] } }) });
  write(dir, { "changed.txt": "x\n" });
  const before = Date.now();
  assert.equal(stop(dir, { PHASE_RUN: "1", PHASE_RUN_TICKET: "7", PHASE_RUN_BASE: git("rev-parse", "HEAD") }).status, 0);
  const log = join(dir, ".phase-run", "stop-check-log.jsonl");
  const [row] = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(Object.keys(row).sort(), ["endedAt", "passed", "startedAt", "testsSkipped", "ticket"]);
  assert.equal(row.ticket, 7);
  assert.equal(row.passed, true);
  assert.equal(hookTime(log, 7, before), row.endedAt - row.startedAt);
  assert.equal(hookTime(log, 8, before), 0);
});

// ------------------------------------------------------------- the receipt

const RECEIPT_SOURCE = join(PLUGIN, "template/tools/phase-run/receipt.mjs");
const FAILING_TESTS = 'node -e "process.exit(1)"';
const TYPECHECK = "node -e \"require('fs').writeFileSync('.phase-run/typecheck-ran', '')\"";

/** A project whose tests always fail, so a test can tell whether the hook ran them; work is in its tree. */
async function receiptProject({ withReceiptCode = true } = {}) {
  const { dir, git } = repo("brigade-project-", {
    ".gitignore": ".phase-run/\n",
    ".claude/workflow.json": JSON.stringify({ version: 1, stopGate: { checks: [{ label: "Typecheck", run: TYPECHECK }, { label: "Tests", run: FAILING_TESTS, receipt: true }] } }),
    ...(withReceiptCode ? { "tools/phase-run/receipt.mjs": readFileSync(RECEIPT_SOURCE, "utf8") } : {}),
  });
  const base = git("rev-parse", "HEAD");
  write(dir, { "changed.txt": "the ticket's work\n", ".phase-run/.keep": "" });
  const receipts = await import(pathToFileURL(RECEIPT_SOURCE).href);
  const vouch = (over = {}) =>
    receipts.writeReceipt(receipts.receiptPath(dir, "7"), { base, tree: receipts.treeKey(dir), commands: [FAILING_TESTS], passed: true, passedAt: "now", ...over });
  const check = (env = {}) => stop(dir, { PHASE_RUN: "1", PHASE_RUN_TICKET: "7", PHASE_RUN_BASE: base, ...env });
  const lastLog = () => JSON.parse(readFileSync(join(dir, ".phase-run", "stop-check-log.jsonl"), "utf8").trim().split("\n").at(-1));
  return { dir, base, vouch, check, lastLog };
}

test("a receipt that holds skips the tests, and the other checks still run", async () => {
  const { dir, vouch, check, lastLog } = await receiptProject();
  vouch();
  assert.equal(check().status, 0);
  assert.ok(existsSync(join(dir, ".phase-run", "typecheck-ran")), "the typecheck ran");
  assert.equal(lastLog().testsSkipped, true);
});

test("an edit since the passing run, or no receipt, runs the tests", async () => {
  const edited = await receiptProject();
  edited.vouch();
  write(edited.dir, { "changed.txt": "edited after the tests passed\n" });
  const result = edited.check();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Tests failed/);
  assert.equal(edited.lastLog().testsSkipped, false);

  const none = await receiptProject();
  assert.equal(none.check().status, 2);
});

test("a receipt for another base, another command, or a failed run does not hold", async () => {
  for (const over of [{ base: "another-base" }, { commands: ["npm test"] }, { passed: false }]) {
    const { vouch, check } = await receiptProject();
    vouch(over);
    assert.equal(check().status, 2, JSON.stringify(over));
  }
});

test("a project without the receipt code has every check run", async () => {
  const { vouch, check } = await receiptProject({ withReceiptCode: false });
  vouch();
  assert.equal(check().status, 2);
});
