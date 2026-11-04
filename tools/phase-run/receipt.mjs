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
// The key leaves out the tests row's `unread` paths (git globs such as
// `docs/**`), so a devlog written after the pass keeps the receipt; it records
// that list, and a different list is a different key.
// A session could forge the file with its Write tool; that only skips the
// Stop hook's courtesy re-run. The runner's own gates trust no receipt, and
// are what catch a failure: no gate may ever read this file.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Git's hash of a tree with no files, in a SHA-1 repo and a SHA-256 one. */
const EMPTY_TREES = ["4b825dc642cb6eb9a060e54bf8d69288fbee4904", "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321"];

export function receiptPath(root, ticket) {
  return join(root, ".phase-run", ticket ? `test-receipt-${ticket}.json` : "test-receipt.json");
}

/**
 * The working tree's content as one git tree hash: tracked files as they are
 * on disk plus untracked ones git does not ignore, leaving out the paths that
 * match `unread` (git globs: `docs/**` is the folder, `*.md` the root only).
 * Built in a copy of the index, so the real index (what the session has
 * staged) is never touched. Null when git cannot say.
 */
export function treeKey(root, unread = []) {
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
    // Git does the matching: `:(glob)` makes `*` stop at a slash and `**` cross folders.
    if (unread.length && git(["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...unread.map((p) => `:(glob)${p}`)], env).status !== 0) return null;
    const tree = git(["write-tree"], env);
    const key = tree.status === 0 ? tree.stdout.trim() : null;
    // A list that leaves out every file would key every state of the code alike: no key, so no receipt.
    return EMPTY_TREES.includes(key) ? null : key;
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

/**
 * Whether a receipt covers this command, on this exact code, measured from this base, with the
 * same unread paths left out (a receipt with no list was made under none).
 */
export function receiptHolds(receipt, { tree, base, command, unread }) {
  unread ??= [];
  return Boolean(
    receipt &&
      tree &&
      receipt.passed === true &&
      receipt.tree === tree &&
      receipt.base === base &&
      Array.isArray(receipt.commands) &&
      receipt.commands.includes(command) &&
      sameList(receipt.unread ?? [], unread),
  );
}

/** The unread paths the project's tests rows share (the loaders refuse rows that differ). */
export function receiptUnread(checks) {
  return checks.find((check) => check.receipt)?.unread ?? [];
}

function sameList(a, b) {
  return Array.isArray(a) && a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}
