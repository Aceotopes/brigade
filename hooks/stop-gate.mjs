// Stop hook (the plugin's hooks.json). Inert unless PHASE_RUN=1, so an
// attended session is never slowed by it.
//
// Inside a phase run it is the check a person would have made before letting
// the session say "done": the project's stop checks, in order (stopGate.checks
// in .claude/workflow.json; typically typecheck, lint, and the tests the
// ticket's changes touch). A receipt check is skipped when the session's
// stop-tests.mjs passed it on exactly this code (its receipt). A failure exits 2,
// which sends the session back to fix it while it still holds the ticket in
// mind. No checks, no gate.
//
// It sends the session back ONCE. On the second stop the hook's input carries
// `stop_hook_active`, and the stop goes through: the runner then runs the full
// gates itself and owns the bounded fix loop (tools/phase-run/run.mjs). Without
// that, a check the session cannot fix would hold it in a loop all night.
//
// While the checks run it leaves a marker, .phase-run/stop-check-<ticket>.json.
// Claude Code does not always list a session as working while its Stop hook
// runs, so the runner reads the marker instead: without it a long check (the
// changed tests of a widely imported file take ten minutes) was taken for a
// finished session, and the runner's own suite ran on the same test database
// at the same time (#145 and #147, 2026-10-10).
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { judgeRoot, loadJudgeConfig } from "./workflow-config.mjs";

const TAIL = 5000;

if (process.env.PHASE_RUN !== "1") process.exit(0);

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8")) ?? {};
} catch {
  input = {};
}
if (input.stop_hook_active) process.exit(0);

// The project, not this file's folder: inside a plugin that is the plugin's cache.
const ROOT = resolve(process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === "string" && input.cwd) || process.cwd());

// A parked ticket has nothing to check: the session wrote its question and stopped.
const ticket = process.env.PHASE_RUN_TICKET;
const verdictPath = join(ROOT, ".phase-run", `verdict-${ticket}.json`);
if (ticket && existsSync(verdictPath)) {
  try {
    if (JSON.parse(readFileSync(verdictPath, "utf8")).status === "parked") process.exit(0);
  } catch {
    // An unreadable verdict is the runner's to report; the checks still run.
  }
}

function run(label, command) {
  const result = spawnSync(command, { cwd: ROOT, encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status === 0) return null;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  return `${label} failed (\`${command}\`). The end of its output:\n\n${output.slice(-TAIL)}`;
}

// The checks and the receipt code are the run's frozen copy's when PHASE_RUN_RUNNER names one (ADR
// 0005), so nothing written mid-night changes how later tickets are judged. The work they judge
// (git, the verdict, the receipt file, each check's cwd) stays the project's.
const JUDGE = judgeRoot(ROOT);
const config = loadJudgeConfig(ROOT);
if (!config.error && config.checks.length === 0) process.exit(0);

const base = process.env.PHASE_RUN_BASE || "main";
const changed = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
const ahead = spawnSync("git", ["rev-list", "--count", `${base}..HEAD`], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
if (changed === "" && ahead === "0") process.exit(0); // nothing was written

// The runner waits while this file names a live process (stopCheckRunning in run.mjs).
// Each check's start and end also go to stop-check-log.jsonl: the runner's
// report counts them as the ticket's "hook" minutes (hookTime in metrics.mjs).
const startedAt = Date.now();
let testsSkipped = false; // set below; declared first so the exit handler can always read it
const skipped = []; // the checks a receipt covered, by name (else label)
let receiptState = "none"; // "held" | "stale" | "none": why the receipt checks ran or didn't
if (ticket) {
  const marker = join(ROOT, ".phase-run", `stop-check-${ticket}.json`);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, `${JSON.stringify({ pid: process.pid, startedAt })}\n`);
  process.on("exit", (code) => {
    rmSync(marker, { force: true });
    const entry = { ticket: Number(ticket), startedAt, endedAt: Date.now(), passed: code === 0, testsSkipped, skipped, receipt: receiptState };
    appendFileSync(join(ROOT, ".phase-run", "stop-check-log.jsonl"), `${JSON.stringify(entry)}\n`);
  });
}

// The session's own tools/phase-run/stop-tests.mjs leaves a receipt for each
// receipt check that passes. A `receipt` check whose receipt still holds (this
// exact code minus its own `unread` paths, this base, this command) is not run
// again; every other check is, in order, to the first failure. The hook writes
// no receipt. The receipt code is the project's (the run's copy of it),
// imported from it: a project without it, or one this cannot load, has every
// check run, as before receipts existed. A 0.5.x receipt.mjs (no `treeKeys`)
// knows one receipt with one shared list, and is used exactly as 0.5.2 used it.
const receiptChecks = config.checks.filter((check) => check.receipt);
const receipts = receiptChecks.length ? await loadReceipts() : null;
const { holds, read } = !receipts ? { holds: () => false, read: false } : typeof receipts.treeKeys === "function" ? perCheckReceipts(receipts) : sharedReceipt(receipts);
if (read) receiptState = receiptChecks.every(holds) ? "held" : "stale";

let failure = config.error ? `The project's stop checks could not be read: ${config.error}` : null;
for (const check of config.checks) {
  if (failure) break;
  if (holds(check)) {
    testsSkipped = true;
    skipped.push(check.name ?? check.label);
    continue;
  }
  failure = run(check.label, check.run.replaceAll("{base}", base));
}

/**
 * 0.6.0: each receipt check's own receipt, keyed on the tree minus its own list (ADR 0004). Which
 * checks one holds for, and whether any receipt was there to read.
 */
function perCheckReceipts(receipts) {
  const groups = receipts.receiptGroups(config.checks);
  const keys = receipts.treeKeys(ROOT, groups.map((group) => group.unread));
  const held = new Set();
  let read = false;
  groups.forEach((group, i) => {
    const receipt = receipts.readReceipt(receipts.receiptPath(ROOT, ticket, group.name));
    read ||= Boolean(receipt);
    for (const check of group.checks) {
      if (receipts.receiptHolds(receipt, { tree: keys[i], base, command: check.run, unread: group.unread })) held.add(check);
    }
  });
  return { holds: (check) => held.has(check), read };
}

/** 0.5.2's reading, unchanged: one receipt, keyed on the tree minus the receipt rows' one list. */
function sharedReceipt(receipts) {
  const unread = receipts.receiptUnread?.(config.checks) ?? []; // a 0.4.0 receipt.mjs has no list to apply
  const tree = receipts.treeKey(ROOT, unread);
  const receipt = receipts.readReceipt(receipts.receiptPath(ROOT, ticket));
  return { holds: (check) => Boolean(check.receipt && receipts.receiptHolds(receipt, { tree, base, command: check.run, unread })), read: Boolean(receipt) };
}

async function loadReceipts() {
  try {
    return await import(pathToFileURL(join(JUDGE, "tools", "phase-run", "receipt.mjs")).href);
  } catch {
    return null;
  }
}

if (!failure) process.exit(0);

process.stderr.write(
  `The phase run's stop check failed, so this ticket is not finished.\n\n${failure}\n\n` +
    "Fix the cause, not the check. If you have already committed, amend that commit " +
    "(`git commit --amend`); never add a second commit for this ticket. Then stop again.\n",
);
process.exit(2);
