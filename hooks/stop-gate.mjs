// Stop hook (the plugin's hooks.json). Inert unless PHASE_RUN=1, so an
// attended session is never slowed by it.
//
// Inside a phase run it is the check a person would have made before letting
// the session say "done": the project's stop checks, in order (stopGate.checks
// in .claude/workflow.json; typically typecheck, lint, and the tests the
// ticket's changes touch). A failure exits 2, which sends the session back to
// fix it while it still holds the ticket in mind. No checks, no gate.
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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { loadWorkflowConfig } from "./workflow-config.mjs";

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

const config = loadWorkflowConfig(ROOT);
if (!config.error && config.checks.length === 0) process.exit(0);

const base = process.env.PHASE_RUN_BASE || "main";
const changed = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
const ahead = spawnSync("git", ["rev-list", "--count", `${base}..HEAD`], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
if (changed === "" && ahead === "0") process.exit(0); // nothing was written

// The runner waits while this file names a live process (stopCheckRunning in run.mjs).
if (ticket) {
  const marker = join(ROOT, ".phase-run", `stop-check-${ticket}.json`);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`);
  process.on("exit", () => rmSync(marker, { force: true }));
}

let failure = config.error ? `The project's stop checks could not be read: ${config.error}` : null;
for (const check of config.checks) {
  if (failure) break;
  failure = run(check.label, check.run.replaceAll("{base}", base));
}

if (!failure) process.exit(0);

process.stderr.write(
  `The phase run's stop check failed, so this ticket is not finished.\n\n${failure}\n\n` +
    "Fix the cause, not the check. If you have already committed, amend that commit " +
    "(`git commit --amend`); never add a second commit for this ticket. Then stop again.\n",
);
process.exit(2);
