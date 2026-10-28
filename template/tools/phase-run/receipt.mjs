// The tests-passed receipt: "the project's tests passed on exactly this code".
// stop-tests.mjs writes it after a pass; the Stop hook (the plugin's
// hooks/stop-gate.mjs, which imports this file from the project) and
// stop-tests.mjs itself skip the tests while the code still matches it.
//
// Why: a ticket's session ran the changed tests, the Stop hook then ran the
// same tests again, and the runner's gates ran the full suite: about 20
// minutes of a ticket repeated a result already known.
//
// The receipt is keyed on the working tree's content (a git tree hash, the
// same before and after the commit), on the base the tests are measured from,
// and on each command it vouches for, so a changed command is a new test set.
// A session could forge the file with its Write tool; that only skips the
// Stop hook's courtesy re-run. The runner's own gates trust no receipt, and
// are what catch a failure: no gate may ever read this file.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function receiptPath(root, ticket) {
  return join(root, ".phase-run", ticket ? `test-receipt-${ticket}.json` : "test-receipt.json");
}

/**
 * The working tree's content as one git tree hash: tracked files as they are
 * on disk plus untracked ones git does not ignore. Built in a copy of the
 * index, so the real index (what the session has staged) is never touched.
 * Null when git cannot say.
 */
export function treeKey(root) {
  const git = (args, env = {}) => spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
  const indexPath = git(["rev-parse", "--git-path", "index"]).stdout.trim();
  if (!indexPath) return null;
  const dir = mkdtempSync(join(tmpdir(), "phase-run-receipt-"));
  const copy = join(dir, "index");
  try {
    const real = resolve(root, indexPath);
    if (existsSync(real)) copyFileSync(real, copy);
    const env = { GIT_INDEX_FILE: copy };
    if (git(["add", "-A"], env).status !== 0) return null;
    const tree = git(["write-tree"], env);
    return tree.status === 0 ? tree.stdout.trim() : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function readReceipt(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeReceipt(file, receipt) {
  mkdirSync(dirname(file), { recursive: true }); // an attended run on a fresh clone has no .phase-run/ yet
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
}

/** Whether a receipt covers this command, on this exact code, measured from this base. */
export function receiptHolds(receipt, { tree, base, command }) {
  return Boolean(
    receipt && tree && receipt.passed === true && receipt.tree === tree && receipt.base === base && Array.isArray(receipt.commands) && receipt.commands.includes(command),
  );
}
