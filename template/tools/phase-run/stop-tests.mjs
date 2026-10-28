// Runs the project's tests (its stop checks marked `"receipt": true` in
// .claude/workflow.json), quietly, and records a receipt on a pass.
//
//   node tools/phase-run/stop-tests.mjs [base]
//
// `base` defaults to PHASE_RUN_BASE (set by the phase run), then `main`. It
// prints only what a person needs: the full test log would stay in a
// session's context and be read again on every later step. With the row's
// `quiet` pair, a pass prints the lines matching `totals` and a failure
// everything from the first line matching `failures`; without one, the last
// lines of a pass and the tail of a failure. On a pass it writes the receipt
// (receipt.mjs), so the Stop hook and a second run on the same code skip the
// tests. Exits with the first failing command's status, or 0.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRunConfig } from "./config.mjs";
import { readReceipt, receiptHolds, receiptPath, treeKey, writeReceipt } from "./receipt.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FAILURE_CAP = 15_000;
const PASS_LINES = 5;

/** What a person needs from a test run's output. `quiet` is the row's { totals, failures } pair, or null. */
export function quietOutput(text, passed, quiet = null) {
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  if (passed) {
    const totals = quiet ? lines.filter((line) => quiet.totals.test(line)) : [];
    return (totals.length ? totals : lines.filter((line) => line.trim()).slice(-PASS_LINES)).join("\n");
  }
  const start = quiet ? lines.findIndex((line) => quiet.failures.test(line)) : -1;
  const failures = (start === -1 ? lines : lines.slice(start)).join("\n").trim();
  return failures.length > FAILURE_CAP ? `…(cut to the last ${FAILURE_CAP} characters)\n${failures.slice(-FAILURE_CAP)}` : failures;
}

function main() {
  const loaded = loadRunConfig(ROOT);
  if (loaded.error) {
    console.log(loaded.error);
    return 2;
  }
  const rows = loaded.config.stopChecks.filter((check) => check.receipt);
  if (rows.length === 0) {
    console.log('No stop check in .claude/workflow.json is marked as the tests ("receipt": true). Run the stop checks by hand.');
    return 2;
  }
  const base = process.argv[2] || process.env.PHASE_RUN_BASE || "main";
  const file = receiptPath(ROOT, process.env.PHASE_RUN_TICKET);
  const tree = treeKey(ROOT);
  const receipt = readReceipt(file);
  if (rows.every((row) => receiptHolds(receipt, { tree, base, command: row.run }))) {
    console.log(`The tests already passed on exactly this code (${receipt.passedAt}). Nothing to run.`);
    return 0;
  }

  for (const row of rows) {
    const command = row.run.replaceAll("{base}", base);
    const run = spawnSync(command, { cwd: ROOT, encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024 });
    const passed = run.status === 0;
    console.log(`${row.label}: ${passed ? "passed" : "FAILED"} (\`${command}\`)`);
    console.log(quietOutput(`${run.stdout ?? ""}\n${run.stderr ?? ""}`, passed, row.quiet) || (passed ? "" : "Failed, with no output."));
    if (!passed) return run.status ?? 1;
  }
  // The code must still be what was tested: nothing edits it while this runs, but check rather than assume.
  if (tree && treeKey(ROOT) === tree) {
    writeReceipt(file, { base, tree, commands: rows.map((row) => row.run), passed: true, passedAt: new Date().toISOString() });
  }
  return 0;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) process.exit(main());
