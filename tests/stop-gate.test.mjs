// Tests for hooks/stop-gate.mjs: inert outside a phase run, and reading the project it is run for.
// Run: node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
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
  assert.deepEqual(Object.keys(row).sort(), ["endedAt", "passed", "receipt", "skipped", "startedAt", "testsSkipped", "ticket"]);
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

/**
 * The receipt code a project may hold beside a 0.6.0 hook: its own release's, and 0.5.2's (frozen in
 * tests/fixtures), which knows one receipt and one shared list. The hook must behave with the old
 * one exactly as 0.5.2's hook did, so every case below runs under both.
 */
const RECEIPT_CODES = {
  "0.6.0": {
    "tools/phase-run/receipt.mjs": RECEIPT_SOURCE,
    "tools/phase-run/unread.mjs": join(PLUGIN, "template/tools/phase-run/unread.mjs"),
    "tools/phase-run/unread-scan.mjs": join(PLUGIN, "template/tools/phase-run/unread-scan.mjs"),
  },
  "0.5.2": { "tools/phase-run/receipt.mjs": join(PLUGIN, "tests/fixtures/receipt-0.5.2.mjs") },
};

/**
 * A project whose tests always fail, so a test can tell whether the hook ran them; work is in its
 * tree. `vouch` writes the receipt a 0.5.x stop-tests.mjs wrote (one file, the command as written),
 * which 0.6.0's reading must still honour.
 */
async function receiptProject({ withReceiptCode = true, unread, code = "0.6.0" } = {}) {
  const { dir, git } = repo("brigade-project-", {
    ".gitignore": ".phase-run/\n",
    ".claude/workflow.json": JSON.stringify({ version: 1, stopGate: { checks: [{ label: "Typecheck", run: TYPECHECK }, { label: "Tests", run: FAILING_TESTS, receipt: true, ...(unread ? { unread } : {}) }] } }),
    ...(withReceiptCode ? Object.fromEntries(Object.entries(RECEIPT_CODES[code]).map(([rel, source]) => [rel, readFileSync(source, "utf8")])) : {}),
  });
  const base = git("rev-parse", "HEAD");
  write(dir, { "changed.txt": "the ticket's work\n", ".phase-run/.keep": "" });
  const receipts = await import(pathToFileURL(RECEIPT_CODES[code]["tools/phase-run/receipt.mjs"]).href);
  const vouch = (over = {}) =>
    receipts.writeReceipt(receipts.receiptPath(dir, "7"), { base, tree: receipts.treeKey(dir, unread ?? []), commands: [FAILING_TESTS], ...(unread ? { unread } : {}), passed: true, passedAt: "now", ...over });
  const check = (env = {}) => stop(dir, { PHASE_RUN: "1", PHASE_RUN_TICKET: "7", PHASE_RUN_BASE: base, ...env });
  const lastLog = () => JSON.parse(readFileSync(join(dir, ".phase-run", "stop-check-log.jsonl"), "utf8").trim().split("\n").at(-1));
  return { dir, base, vouch, check, lastLog };
}

// 0.4.1: the tests row's unread paths are left out of the receipt's key, so a session's devlog and
// logs, written after its last test pass, no longer make the stop check run the tests again.
const UNREAD = ["docs/**", "*.md"];

for (const code of Object.keys(RECEIPT_CODES)) {
  const project = (options = {}) => receiptProject({ ...options, code });

  test(`${code} receipt code: a receipt that holds skips the tests, and the other checks still run`, async () => {
    const { dir, vouch, check, lastLog } = await project();
    vouch();
    assert.equal(check().status, 0);
    assert.ok(existsSync(join(dir, ".phase-run", "typecheck-ran")), "the typecheck ran");
    assert.deepEqual([lastLog().testsSkipped, lastLog().skipped], [true, ["Tests"]]);
  });

  test(`${code} receipt code: an edit since the passing run, or no receipt, runs the tests`, async () => {
    const edited = await project();
    edited.vouch();
    write(edited.dir, { "changed.txt": "edited after the tests passed\n" });
    const result = edited.check();
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Tests failed/);
    assert.deepEqual([edited.lastLog().testsSkipped, edited.lastLog().skipped], [false, []]);

    const none = await project();
    assert.equal(none.check().status, 2);
  });

  test(`${code} receipt code: a receipt for another base, another command, or a failed run does not hold`, async () => {
    for (const over of [{ base: "another-base" }, { commands: ["npm test"] }, { passed: false }]) {
      const { vouch, check } = await project();
      vouch(over);
      assert.equal(check().status, 2, JSON.stringify(over));
    }
  });

  test(`${code} receipt code: with unread paths, a docs-only edit after the pass skips the tests and logs the receipt held`, async () => {
    const { dir, vouch, check, lastLog } = await project({ unread: UNREAD });
    vouch();
    write(dir, { "docs/devlog.md": "the ticket's entry\n", "README.md": "# Test, edited\n" });
    assert.equal(check().status, 0);
    assert.deepEqual([lastLog().testsSkipped, lastLog().receipt], [true, "held"]);
  });

  test(`${code} receipt code: with unread paths, a code edit, a new code file or a receipt under another list runs the tests`, async () => {
    const cases = [
      ["a code edit", (p) => write(p.dir, { "changed.txt": "edited after the tests passed\n" })],
      ["a new code file", (p) => write(p.dir, { "src/new.js": "untracked code\n" })],
      ["another list", (p) => p.vouch({ unread: ["docs/**"] })],
    ];
    for (const [name, change] of cases) {
      const one = await project({ unread: UNREAD });
      one.vouch();
      change(one);
      assert.equal(one.check().status, 2, name);
      assert.deepEqual([one.lastLog().testsSkipped, one.lastLog().receipt], [false, "stale"], name);
    }
  });

  test(`${code} receipt code: with no receipt written, the log says none`, async () => {
    const { check, lastLog } = await project({ unread: UNREAD });
    assert.equal(check().status, 2);
    assert.equal(lastLog().receipt, "none");
  });
}

test("a project without the receipt code has every check run", async () => {
  const { vouch, check } = await receiptProject({ withReceiptCode: false });
  vouch();
  assert.equal(check().status, 2);
});

// 0.6.0 (#17, ADR 0004): each receipt check keeps its own receipt, keyed on the tree minus its own
// list, so a file one check never reads voids only the others' receipts.
const STOP_TESTS_FILES = ["stop-tests.mjs", "receipt.mjs", "unread.mjs", "unread-scan.mjs", "config.mjs", "metrics.mjs", "ticket-size.mjs", "prices.json"];
const ran = (name) => `node -e "require('fs').writeFileSync('.phase-run/${name}-ran', '')"`;

/** Typecheck and lint (named, `**\/*.md` unread) and the tests (nameless, docs unread), all passing. */
async function threeChecks() {
  const rows = [
    { name: "typecheck", label: "Typecheck", run: ran("typecheck"), receipt: true, unread: ["**/*.md"] },
    { name: "lint", label: "Lint", run: ran("lint"), receipt: true, unread: ["**/*.md"] },
    { label: "Tests", run: `${ran("tests")} {base}`, receipt: true, unread: UNREAD },
  ];
  const { dir, git } = repo("brigade-project-", {
    ".gitignore": ".phase-run/\n",
    ".claude/workflow.json": JSON.stringify({ version: 1, stopGate: { checks: rows } }),
    "docs/data.json": "{}\n",
    "src/a.js": "1\n",
    // The session's own check command, so the receipts the hook reads are the ones it really writes.
    ...Object.fromEntries(STOP_TESTS_FILES.map((name) => [`tools/phase-run/${name}`, readFileSync(join(PLUGIN, "template/tools/phase-run", name), "utf8")])),
  });
  const base = git("rev-parse", "HEAD");
  write(dir, { "src/a.js": "the ticket's work\n", ".phase-run/.keep": "" });
  // A full pass: stop-tests.mjs leaves one receipt per name, and the nameless rows' in test-receipt.
  const fullPass = () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PHASE_RUN/.test(key)));
    const result = spawnSync(process.execPath, [join(dir, "tools/phase-run/stop-tests.mjs"), base], { cwd: dir, encoding: "utf8", env: { ...env, PHASE_RUN_TICKET: "7" } });
    assert.equal(result.status, 0, result.stdout);
  };
  const check = () => {
    for (const name of ["typecheck", "lint", "tests"]) rmSync(join(dir, ".phase-run", `${name}-ran`), { force: true });
    const result = stop(dir, { PHASE_RUN: "1", PHASE_RUN_TICKET: "7", PHASE_RUN_BASE: base });
    const log = JSON.parse(readFileSync(join(dir, ".phase-run", "stop-check-log.jsonl"), "utf8").trim().split("\n").at(-1));
    return { status: result.status, ran: ["typecheck", "lint", "tests"].filter((name) => existsSync(join(dir, ".phase-run", `${name}-ran`))), log };
  };
  return { dir, fullPass, check };
}

test("0.6.0: a docs-only edit after a full pass skips all three checks", async () => {
  const { dir, fullPass, check } = await threeChecks();
  fullPass();
  assert.ok(existsSync(join(dir, ".phase-run", "typecheck-receipt-7.json")) && existsSync(join(dir, ".phase-run", "test-receipt-7.json")));
  write(dir, { "docs/devlog.md": "the ticket's entry\n", "README.md": "# edited\n" });
  const result = check();
  assert.deepEqual([result.status, result.ran], [0, []]);
  assert.deepEqual([result.log.skipped, result.log.receipt], [["typecheck", "lint", "Tests"], "held"]);
});

test("0.6.0: a source edit reruns only the checks whose lists don't cover it", async () => {
  const { dir, fullPass, check } = await threeChecks();
  fullPass();
  write(dir, { "docs/data.json": '{ "edited": true }\n' }); // the tests never read docs/; typecheck and lint might
  const docsData = check();
  assert.deepEqual([docsData.status, docsData.ran, docsData.log.skipped, docsData.log.receipt], [0, ["typecheck", "lint"], ["Tests"], "stale"]);

  fullPass();
  write(dir, { "src/a.js": "edited again\n" });
  const source = check();
  assert.deepEqual([source.status, source.ran, source.log.skipped], [0, ["typecheck", "lint", "tests"], []]);
});

test("0.6.0: the hook writes no receipt, and stops at the first failing uncovered check", async () => {
  const { dir, check } = await threeChecks();
  write(dir, { ".claude/workflow.json": JSON.stringify({ version: 1, stopGate: { checks: [{ name: "lint", label: "Lint", run: 'node -e "process.exit(1)"', receipt: true }, { label: "Tests", run: ran("tests"), receipt: true }] } }) });
  const result = check();
  assert.deepEqual([result.status, result.ran], [2, []], "the tests after the failing lint never ran");
  assert.deepEqual(["typecheck", "lint", "test"].map((name) => existsSync(join(dir, ".phase-run", `${name}-receipt-7.json`))), [false, false, false]);
});

// 0.7.0 (#39, D11): the listed-code rule. A file a test names (a quoted path, a relative import
// included), on a check's unread list, is put back into that check's key: a change there voids its
// receipt. The test files are the ones phaseRun.tampering.testFiles matches, and only those.
/**
 * Lint (docs and scripts unread) and the tests (docs and root .md unread), both named and passing.
 * The one test file names docs/fixture.json and imports ../scripts/tool.mjs; docs/guide.md no test names.
 */
async function listedProject({ testFiles = ["tests/**/*.test.mjs"] } = {}) {
  const rows = [
    { name: "lint", label: "Lint", run: ran("lint"), receipt: true, unread: ["docs/**", "scripts/**"] },
    { name: "tests", label: "Tests", run: ran("tests"), receipt: true, unread: ["docs/**", "*.md"] },
  ];
  const { dir, git } = repo("brigade-project-", {
    ".gitignore": ".phase-run/\n",
    ".claude/workflow.json": JSON.stringify({ version: 1, stopGate: { checks: rows }, ...(testFiles ? { phaseRun: { tampering: { testFiles } } } : {}) }),
    "tests/a.test.mjs": 'import { tool } from "../scripts/tool.mjs";\nconst fixture = readFileSync("docs/fixture.json", "utf8");\n',
    "docs/fixture.json": "{}\n",
    "docs/guide.md": "# Guide\n",
    "scripts/tool.mjs": "export const tool = 1;\n",
    "src/a.js": "1\n",
    ...Object.fromEntries(STOP_TESTS_FILES.map((name) => [`tools/phase-run/${name}`, readFileSync(join(PLUGIN, "template/tools/phase-run", name), "utf8")])),
  });
  const base = git("rev-parse", "HEAD");
  write(dir, { "src/a.js": "the ticket's work\n", ".phase-run/.keep": "" });
  const fullPass = () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PHASE_RUN/.test(key)));
    const result = spawnSync(process.execPath, [join(dir, "tools/phase-run/stop-tests.mjs"), base], { cwd: dir, encoding: "utf8", env: { ...env, PHASE_RUN_TICKET: "7" } });
    assert.equal(result.status, 0, result.stdout);
    return result.stdout;
  };
  const check = () => {
    for (const name of ["lint", "tests"]) rmSync(join(dir, ".phase-run", `${name}-ran`), { force: true });
    const result = stop(dir, { PHASE_RUN: "1", PHASE_RUN_TICKET: "7", PHASE_RUN_BASE: base });
    return { status: result.status, ran: ["lint", "tests"].filter((name) => existsSync(join(dir, ".phase-run", `${name}-ran`))) };
  };
  return { dir, fullPass, check };
}

test("the listed-code rule: a change to a file a test names, on the tests row's list, voids its receipt", async () => {
  const { dir, fullPass, check } = await listedProject();
  fullPass();
  write(dir, { "docs/fixture.json": '{ "edited": true }\n' });
  assert.deepEqual(check(), { status: 0, ran: ["lint", "tests"] }, "on both rows' lists, and both run again");
  // The session's own second run agrees with the hook: nothing is skipped on the changed code.
  assert.doesNotMatch(fullPass(), /already passed/);
});

test("the listed-code rule: a change to an unread file no test names keeps every receipt, as before", async () => {
  const { dir, fullPass, check } = await listedProject();
  fullPass();
  write(dir, { "docs/guide.md": "# Guide, edited\n" });
  assert.deepEqual(check(), { status: 0, ran: [] });
  const receipt = JSON.parse(readFileSync(join(dir, ".phase-run", "tests-receipt-7.json"), "utf8"));
  assert.deepEqual(receipt.unread, ["docs/**", "*.md", "!docs/fixture.json"], "the list it was keyed on: the owner's, and the named file put back");
});

test("the listed-code rule holds on every row with a list: an imported file on lint's list reruns lint", async () => {
  const { dir, fullPass, check } = await listedProject();
  fullPass();
  write(dir, { "scripts/tool.mjs": "export const tool = 2;\n" });
  // The tests never left scripts/ out; lint did, and a test imports the file.
  assert.deepEqual(check(), { status: 0, ran: ["lint", "tests"] });
});

test("the listed-code rule: with no phaseRun.tampering.testFiles there is no rule, and the receipts hold as before", async () => {
  const { dir, fullPass, check } = await listedProject({ testFiles: null });
  fullPass();
  write(dir, { "docs/fixture.json": '{ "edited": true }\n' });
  assert.deepEqual(check(), { status: 0, ran: [] });
  const receipt = JSON.parse(readFileSync(join(dir, ".phase-run", "tests-receipt-7.json"), "utf8"));
  assert.deepEqual(receipt.unread, ["docs/**", "*.md"]);
});

test("the listed-code rule fails closed: a scan that cannot read the test files keys each check on its whole tree", async () => {
  const receipts = await import(pathToFileURL(RECEIPT_SOURCE).href);
  const checks = [{ name: "tests", label: "Tests", run: "t", receipt: true, unread: ["docs/**"] }];
  const broken = () => {
    throw Object.assign(new Error("EACCES"), { code: "EACCES" });
  };
  const groups = receipts.listedGroups(".", checks, ["tests/**/*.test.mjs"], { files: ["tests/a.test.mjs", "docs/a.json"], read: broken });
  assert.deepEqual(groups.map((g) => g.unread), [[]], "nothing left out: the receipt never holds on a list it could not check");
  // A test file that is gone (deleted, still in the index) reads nothing, and is no failure.
  const gone = () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  assert.deepEqual(receipts.listedGroups(".", checks, ["tests/**/*.test.mjs"], { files: ["tests/a.test.mjs"], read: gone }).map((g) => g.unread), [["docs/**"]]);
  // No test files, no scan: nothing is read.
  assert.deepEqual(receipts.listedGroups(".", checks, [], { files: ["tests/a.test.mjs"], read: broken }).map((g) => g.unread), [["docs/**"]]);
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

// #33 (ADR 0007): a lane's stop check judges its own worktree with the primary's shared copy: the
// receipt it reads, the tree it keys and its log are the worktree's.
test("in a lane's worktree the stop gate reads the worktree's receipt, with the primary's runner copy", async () => {
  const workflow = JSON.stringify({ version: 1, stopGate: { checks: [{ label: "Tests", run: FAILING_TESTS, receipt: true }] } });
  const { dir, git } = repo("brigade-project-", { ".gitignore": ".phase-run/\n", ".claude/workflow.json": workflow });
  write(dir, { [`${COPY}/.claude/workflow.json`]: workflow, ...Object.fromEntries(Object.entries(RECEIPT_CODES["0.6.0"]).map(([rel, source]) => [`${COPY}/${rel}`, readFileSync(source, "utf8")])) });
  const worktree = `${dir}-lanes-2`;
  git("worktree", "add", "-q", "-b", "phase-x-lane-2", worktree);
  const base = git("rev-parse", "HEAD");
  write(worktree, { "changed.txt": "the lane's work\n", ".phase-run/.keep": "" });
  const receipts = await import(pathToFileURL(RECEIPT_SOURCE).href);
  const vouch = (root) => receipts.writeReceipt(receipts.receiptPath(root, "7"), { base, tree: receipts.treeKey(worktree, []), commands: [FAILING_TESTS], passed: true, passedAt: "now" });
  const check = () => stop(worktree, { PHASE_RUN: "1", PHASE_RUN_TICKET: "7", PHASE_RUN_BASE: base, PHASE_RUN_RUNNER: join(dir, COPY), PHASE_RUN_ROOT: worktree });
  vouch(dir);
  assert.equal(check().status, 2, "a receipt in the primary checkout vouches for nothing in the worktree");
  vouch(worktree);
  assert.equal(check().status, 0, "the worktree's own receipt held");
  const log = JSON.parse(readFileSync(join(worktree, ".phase-run", "stop-check-log.jsonl"), "utf8").trim().split("\n").at(-1));
  assert.deepEqual([log.testsSkipped, log.receipt], [true, "held"]);
  assert.equal(existsSync(join(dir, ".phase-run", "stop-check-log.jsonl")), false, "nothing of the session's is written in the primary");
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
