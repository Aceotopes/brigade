// Stop hook (the plugin's hooks.json, a Stop group of its own): the attended ledger. At the end of
// every reply in a set-up project (one with .claude/workflow.json) it appends the session's running
// total to .phase-run/ledger.jsonl as an `attended` row, so the owner's own sessions are priced
// into the same ledger as the nights (template/tools/phase-run/ledger.mjs).
//
// - Off with `ledger.attended: false` in the project's workflow.json, and inert under PHASE_RUN=1:
//   the runner writes a night's rows itself.
// - It prices with the plugin's own runner code and price list (template/tools/phase-run/), never
//   the project's copy, so it works while a project is a release behind. A row's `brigade` is the
//   plugin's version.
// - It reads only what the transcript gained since its last run: the per-session state
//   .phase-run/ledger-state/<session>.json holds sessionCostFrom's offsets and the running totals,
//   in one file. The row is appended first, then the state is saved (a new file, then a rename): a
//   crash between the two only re-reads the same bytes against the old totals next time, and the
//   ledger keeps a session's latest row.
//
// It never stands in a reply's way: on every path, a config that isn't JSON, a missing transcript, an
// unreadable price list, even a module that fails to load, it prints nothing and exits 0. So every
// import beyond node's own is loaded inside the try, after the PHASE_RUN check.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

if (process.env.PHASE_RUN === "1") process.exit(0);

/** Where each session's reading is kept, from the project's root. */
const STATE_DIR = join(".phase-run", "ledger-state");

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isFileEntry = (entry) => isObject(entry) && Number.isSafeInteger(entry.offset) && entry.offset >= 0 && Array.isArray(entry.seen);

/**
 * The saved reading, or a fresh one when there is none or it is not the shape this writes: the
 * whole session is then read again from byte 0 with no totals, which gives the right total. A bad
 * reading kept as it is would throw on every later reply, and the session would record nothing.
 */
function readState(file) {
  try {
    const state = JSON.parse(readFileSync(file, "utf8"));
    if (isObject(state?.files) && Object.values(state.files).every(isFileEntry) && isObject(state.total) && Number.isSafeInteger(state.total.nanoUsd)) return state;
  } catch {
    // no reading yet, or a torn one
  }
  return { files: {}, total: undefined };
}

/**
 * Whether the project has the attended ledger on: its workflow.json loads with `ledger.attended`
 * not false. A file this plugin's loader refuses (a project a release ahead, with a key this
 * version doesn't know) still counts when it parses and doesn't say `attended: false`: the hook
 * doesn't care whether the project is in step. A file that isn't JSON at all writes nothing,
 * since it may be the one turning the hook off.
 */
async function attendedOn(root) {
  const { CONFIG_PATH, loadWorkflowConfig } = await import("./workflow-config.mjs");
  const path = join(root, CONFIG_PATH);
  if (!existsSync(path)) return false; // not a set-up project
  const config = loadWorkflowConfig(root);
  if (!config.error) return config.ledger.attended !== false;
  try {
    return JSON.parse(readFileSync(path, "utf8"))?.ledger?.attended !== false;
  } catch {
    return false;
  }
}

/** The project's branch, or null (a detached head, or no git). */
function branchOf(root) {
  const result = spawnSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8", timeout: 5000 });
  return (result.status === 0 && result.stdout.trim()) || null;
}

async function record() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8")) ?? {};
  } catch {
    input = {};
  }
  // The project, not this file's folder: inside a plugin that is the plugin's cache.
  const root = resolve(process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === "string" && input.cwd) || process.cwd());
  if (!(await attendedOn(root))) return;
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const transcript = typeof input.transcript_path === "string" ? input.transcript_path : "";
  if (!sessionId || !transcript || !existsSync(transcript)) return;

  const { addCost, loadPrices, sessionCostFrom } = await import("../template/tools/phase-run/metrics.mjs");
  const { LEDGER_PATH, appendRow, ledgerRow } = await import("../template/tools/phase-run/ledger.mjs");
  const { pluginVersion } = await import("../scripts/versions.mjs");

  const statePath = join(root, STATE_DIR, `${sessionId.replace(/[^\w-]/g, "_")}.json`);
  const saved = readState(statePath);
  const step = sessionCostFrom(transcript, loadPrices(), saved);
  if (step.cost.calls === 0) return; // nothing new since the last row (and never a $0 first row)
  const total = addCost(saved.total, step.cost);
  appendRow(join(root, LEDGER_PATH), ledgerRow({ at: Date.now(), sessionId, transcript, kind: "attended", branch: branchOf(root), brigade: pluginVersion(), cost: total }));

  mkdirSync(dirname(statePath), { recursive: true });
  const temp = `${statePath}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ files: step.state.files, total })}\n`);
    renameSync(temp, statePath);
  } finally {
    rmSync(temp, { force: true });
  }
}

try {
  await record();
} catch {
  // A lost row is never worth a reply that will not end.
}
process.exit(0);
