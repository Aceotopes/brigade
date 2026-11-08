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
  assert.deepEqual(Object.keys(row).sort(), ["endedAt", "passed", "receipt", "startedAt", "testsSkipped", "ticket"]);
  assert.equal(row.ticket, 7);
  assert.equal(row.passed, true);
  assert.equal(row.receipt, "none", "a project with no receipt row");
  assert.equal(hookTime(log, 7, before), row.endedAt - row.startedAt);
  assert.equal(hookTime(log, 8, before), 0);
});

// ------------------------------------------------------------- the receipt

const RECEIPT_SOURCE = join(PLUGIN, "template/tools/phase-run/receipt.mjs");
const FAILING_TESTS = 'node -e "process.exit(1)"';
const TYPECHECK = "node -e \"require('fs').writeFileSync('.phase-run/typecheck-ran', '')\"";

/** A project whose tests always fail, so a test can tell whether the hook ran them; work is in its tree. */
async function receiptProject({ withReceiptCode = true, unread } = {}) {
  const { dir, git } = repo("brigade-project-", {
    ".gitignore": ".phase-run/\n",
    ".claude/workflow.json": JSON.stringify({ version: 1, stopGate: { checks: [{ label: "Typecheck", run: TYPECHECK }, { label: "Tests", run: FAILING_TESTS, receipt: true, ...(unread ? { unread } : {}) }] } }),
    ...(withReceiptCode ? { "tools/phase-run/receipt.mjs": readFileSync(RECEIPT_SOURCE, "utf8") } : {}),
  });
  const base = git("rev-parse", "HEAD");
  write(dir, { "changed.txt": "the ticket's work\n", ".phase-run/.keep": "" });
  const receipts = await import(pathToFileURL(RECEIPT_SOURCE).href);
  const vouch = (over = {}) =>
    receipts.writeReceipt(receipts.receiptPath(dir, "7"), { base, tree: receipts.treeKey(dir, unread ?? []), commands: [FAILING_TESTS], ...(unread ? { unread } : {}), passed: true, passedAt: "now", ...over });
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

// 0.4.1: the tests row's unread paths are left out of the receipt's key, so a session's devlog and
// logs, written after its last test pass, no longer make the stop check run the tests again.
const UNREAD = ["docs/**", "*.md"];

test("with unread paths, a docs-only edit after the pass skips the tests and logs the receipt held", async () => {
  const { dir, vouch, check, lastLog } = await receiptProject({ unread: UNREAD });
  vouch();
  write(dir, { "docs/devlog.md": "the ticket's entry\n", "README.md": "# Test, edited\n" });
  assert.equal(check().status, 0);
  assert.deepEqual([lastLog().testsSkipped, lastLog().receipt], [true, "held"]);
});

test("with unread paths, a code edit, a new code file or a receipt under another list runs the tests", async () => {
  const cases = [
    ["a code edit", (p) => write(p.dir, { "changed.txt": "edited after the tests passed\n" })],
    ["a new code file", (p) => write(p.dir, { "src/new.js": "untracked code\n" })],
    ["another list", (p) => p.vouch({ unread: ["docs/**"] })],
  ];
  for (const [name, change] of cases) {
    const project = await receiptProject({ unread: UNREAD });
    project.vouch();
    change(project);
    assert.equal(project.check().status, 2, name);
    assert.deepEqual([project.lastLog().testsSkipped, project.lastLog().receipt], [false, "stale"], name);
  }
});

test("with no receipt written, the log says none", async () => {
  const { check, lastLog } = await receiptProject({ unread: UNREAD });
  assert.equal(check().status, 2);
  assert.equal(lastLog().receipt, "none");
});

// ------------------------------------------------------ the frozen runner copy (#16)

const PASSING = { version: 1, stopGate: { checks: [{ label: "Fine", run: "node -e 0" }] } };
const FAILING = { version: 1, stopGate: { checks: [{ label: "Broken", run: 'node -e "process.exit(1)"' }] } };
const COPY = ".phase-run/phase-x/runner";

/** A project whose live workflow.json is `live`, with a runner copy holding `copy` (both written as given). */
function copyProject(live, copy) {
  const { dir, git } = repo("brigade-project-", { ".gitignore": ".phase-run/\n", ".claude/workflow.json": JSON.stringify(live) });
  if (copy) write(dir, { [`${COPY}/.claude/workflow.json`]: JSON.stringify(copy) });
  write(dir, { "changed.txt": "the ticket's work\n" });
  const check = (env = {}) => stop(dir, { PHASE_RUN: "1", PHASE_RUN_TICKET: "7", PHASE_RUN_BASE: git("rev-parse", "HEAD"), ...env });
  return { dir, check, runner: join(dir, COPY) };
}

test("with PHASE_RUN_RUNNER set the stop gate runs the copy's checks; without it, the live tree's", () => {
  const frozenFails = copyProject(PASSING, FAILING);
  const failed = frozenFails.check({ PHASE_RUN_RUNNER: frozenFails.runner });
  assert.equal(failed.status, 2);
  assert.match(failed.stderr, /Broken failed/);
  assert.equal(frozenFails.check().status, 0, "attended reading: the live tree's passing check");

  const frozenPasses = copyProject(FAILING, PASSING);
  assert.equal(frozenPasses.check({ PHASE_RUN_RUNNER: frozenPasses.runner }).status, 0, "the live tree's failing check is not run");
});

test("with PHASE_RUN_RUNNER set the stop gate imports the copy's receipt code, not the project's", async () => {
  const { dir, check, lastLog } = await receiptProject();
  const runner = join(dir, COPY);
  // The copy's receipt code vouches for everything; the project's (real) code sees no receipt at all.
  write(dir, {
    [`${COPY}/.claude/workflow.json`]: readFileSync(join(dir, ".claude/workflow.json"), "utf8"),
    [`${COPY}/tools/phase-run/receipt.mjs`]: [
      "export const receiptPath = () => 'none';",
      "export const readReceipt = () => ({ passed: true });",
      "export const treeKey = () => 'tree';",
      "export const receiptHolds = () => true;",
      "export const receiptUnread = () => [];",
    ].join("\n"),
  });
  assert.equal(check().status, 2, "live receipt code: no receipt, the failing tests run");
  assert.equal(check({ PHASE_RUN_RUNNER: runner }).status, 0, "the copy's code held the receipt");
  assert.equal(lastLog().testsSkipped, true);
});

test("a PHASE_RUN_RUNNER that names no folder, or a copy that lost its config, fails the stop gate", () => {
  const { dir, check } = copyProject(PASSING, null);
  const result = check({ PHASE_RUN_RUNNER: join(dir, COPY) });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /runner copy[\s\S]*is missing/);
  // The folder is there, its workflow.json gone (a shell write): still an error, never "no checks".
  write(dir, { [`${COPY}/manifest.json`]: "{}\n" });
  const lost = check({ PHASE_RUN_RUNNER: join(dir, COPY) });
  assert.equal(lost.status, 2);
  assert.match(lost.stderr, /has lost its \.claude\/workflow\.json/);
});
