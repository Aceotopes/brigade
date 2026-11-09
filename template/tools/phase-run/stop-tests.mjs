// Runs the project's receipt checks (its stop checks marked `"receipt": true`
// in .claude/workflow.json: the tests, and from 0.6.0 any other), quietly, and
// records each one's receipt on its pass.
//
//   node tools/phase-run/stop-tests.mjs [base]
//
// `base` defaults to PHASE_RUN_BASE (set by the phase run), then `main`. It
// prints only what a person needs: the full test log would stay in a
// session's context and be read again on every later step. With the row's
// `quiet` pair, a pass prints the lines matching `totals` and a failure
// everything from the first line matching `failures`; without one, the last
// lines of a pass and the tail of a failure. Every check whose receipt does
// not hold runs, even after one fails, so one run shows every failure; the
// failures together are cut to one cap. Each passing check's receipt
// (receipt.mjs) is written if its code is unchanged after the runs, so the
// Stop hook and a second run on the same code skip it. Exits with the first
// failing command's status, or 0.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRunConfig } from "./config.mjs";
import { listedGroups, readReceipt, receiptHolds, receiptPath, treeKeys, writeReceipt } from "./receipt.mjs";

// The config is read beside this file: the repo's, or the run's frozen copy's when the session runs
// the copy (ADR 0005), so its receipt is made under the rules the stop hook judges with. The work it
// tests is the repo's: PHASE_RUN_ROOT inside a run, else the folder this file sits in.
const CONFIG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = process.env.PHASE_RUN_ROOT ? resolve(process.env.PHASE_RUN_ROOT) : CONFIG_ROOT;
const FAILURE_CAP = 15_000;
const PASS_LINES = 5;

/**
 * What a person needs from a test run's output. `quiet` is the row's { totals, failures } pair, or
 * null; `cap` is how much of a failure is kept, its end.
 */
export function quietOutput(text, passed, quiet = null, cap = FAILURE_CAP) {
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  if (passed) {
    const totals = quiet ? lines.filter((line) => quiet.totals.test(line)) : [];
    return (totals.length ? totals : lines.filter((line) => line.trim()).slice(-PASS_LINES)).join("\n");
  }
  const start = quiet ? lines.findIndex((line) => quiet.failures.test(line)) : -1;
  const failures = (start === -1 ? lines : lines.slice(start)).join("\n").trim();
  return failures.length > cap ? `…(cut to the last ${cap} characters)\n${failures.slice(-cap)}` : failures;
}

function main() {
  const loaded = loadRunConfig(CONFIG_ROOT);
  if (loaded.error) {
    console.log(loaded.error);
    return 2;
  }
  // Each receipt: a named check alone, the checks without a name together (one file, as 0.5.x wrote),
  // each list with the files a test names put back on it (the listed-code rule, receipt.mjs).
  const groups = listedGroups(ROOT, loaded.config.stopChecks, loaded.config.tampering?.testFiles);
  if (groups.length === 0) {
    console.log('No stop check in .claude/workflow.json carries a receipt ("receipt": true, the tests\' row at least). Run the stop checks by hand.');
    return 2;
  }
  const base = process.argv[2] || process.env.PHASE_RUN_BASE || "main";
  const ticket = process.env.PHASE_RUN_TICKET;
  const labels = (group) => group.checks.map((check) => check.label).join(", ");
  // Each key leaves out its own check's unread paths: an edit there keeps that check's receipt.
  const keys = treeKeys(ROOT, groups.map((group) => group.unread));
  const due = groups.filter((group, i) => {
    const receipt = readReceipt(receiptPath(ROOT, ticket, group.name));
    const held = group.checks.every((check) => receiptHolds(receipt, { tree: keys[i], base, command: check.run, unread: group.unread }));
    if (held) console.log(`${labels(group)}: already passed on exactly this code (${receipt.passedAt}). Not run again.`);
    return !held;
  });
  if (due.length === 0) {
    console.log("Every check already passed on exactly this code. Nothing to run.");
    return 0;
  }

  // In the config's order, so "the first failure" is the first a reader of the config would expect.
  const failures = [];
  const failedGroups = new Set();
  let status = 0;
  for (const check of loaded.config.stopChecks) {
    const group = due.find((g) => g.checks.includes(check));
    if (!group) continue;
    const command = check.run.replaceAll("{base}", base);
    const run = spawnSync(command, { cwd: ROOT, encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024 });
    const passed = run.status === 0;
    const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    console.log(`${check.label}: ${passed ? "passed" : "FAILED"} (\`${command}\`)`);
    if (passed) {
      const totals = quietOutput(output, true, check.quiet);
      if (totals) console.log(totals);
    } else {
      failedGroups.add(group);
      status ||= run.status ?? 1;
      failures.push({ check, output });
    }
  }
  // Every failure is shown, and together they keep to one cap: the session reads all of it again on each later step.
  const share = Math.floor(FAILURE_CAP / Math.max(failures.length, 1));
  for (const { check, output } of failures) {
    console.log(`\n${check.label} FAILED:`);
    console.log(quietOutput(output, false, check.quiet, share) || "Failed, with no output.");
  }

  // The code must still be what was checked: nothing edits it while this runs, but check rather than assume.
  const passedGroups = due.filter((group) => !failedGroups.has(group));
  const after = passedGroups.length ? treeKeys(ROOT, passedGroups.map((group) => group.unread)) : [];
  passedGroups.forEach((group, j) => {
    const tree = keys[groups.indexOf(group)];
    const why = !tree
      ? `git could not key this code${group.unread.length ? ' (check its "unread" list)' : ""}`
      : after[j] !== tree
        ? "the code changed while the checks ran (did one write a tracked file?)"
        : null;
    if (why) console.log(`${labels(group)}: ${why}, so no receipt is recorded: the stop check will run it again.`);
    else {
      const commands = group.checks.map((check) => check.run.replaceAll("{base}", base));
      writeReceipt(receiptPath(ROOT, ticket, group.name), {
        ...(group.name ? { name: group.name } : {}),
        base,
        tree,
        commands,
        unread: group.unread,
        passed: true,
        passedAt: new Date().toISOString(),
      });
    }
  });
  return status;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) process.exit(main());
