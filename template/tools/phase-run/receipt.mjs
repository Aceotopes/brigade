// The stop checks' receipts: "this check passed on exactly this code". stop-tests.mjs writes one per
// check after a pass; the Stop hook (the plugin's hooks/stop-gate.mjs, which imports this file from
// the project) and stop-tests.mjs itself skip a check while the code still matches its receipt.
//
// Why: a ticket's session ran its checks, the Stop hook then ran the same checks again, and the
// runner's gates ran the full suite: about 20 minutes of a ticket repeated a result already known.
//
// Each check with `"receipt": true` keeps its own receipt (ADR 0004): `.phase-run/<name>-receipt-
// <ticket>.json`, or `test-receipt-<ticket>.json`, the one 0.5.x wrote, which the rows without a
// name share. A receipt is keyed on the working tree's content (a git tree hash, the same before and
// after the commit) minus that check's `unread` paths (unread.mjs), on the base the checks are
// measured from, and on each command it vouches for, with `{base}` filled in. So a devlog written
// after the pass keeps the tests' receipt, and a change to a file lint reads voids only lint's. A
// file a test names is never left out, whatever the list says (the listed-code rule, `listedGroups`).
// A session could forge the file with its Write tool; that only skips the Stop hook's courtesy
// re-run. The runner's own gates trust no receipt, and are what catch a failure: no gate may ever
// read this file (run.test.mjs checks the runner's imports never reach it).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { unreadMatcher } from "./unread.mjs";
import { listedCode, repoFiles, testNamedPaths, withListedCode } from "./unread-scan.mjs";

/** Git's hash of a tree with no files, in a SHA-1 repo and a SHA-256 one. */
const EMPTY_TREES = ["4b825dc642cb6eb9a060e54bf8d69288fbee4904", "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321"];

/** A check's receipt file: by its name, or the one rows without a name share (0.5.x's). */
export function receiptPath(root, ticket, name = null) {
  const stem = name ? `${name}-receipt` : "test-receipt";
  return join(root, ".phase-run", ticket ? `${stem}-${ticket}.json` : `${stem}.json`);
}

/**
 * The stop checks with `"receipt": true`, by the receipt each keeps: a named check alone, the
 * checks without a name together (one file, one list, as 0.5.x had it; the loaders refuse nameless
 * rows whose lists differ).
 */
export function receiptGroups(checks) {
  const groups = new Map();
  for (const check of checks.filter((c) => c.receipt)) {
    const name = check.name ?? null;
    if (!groups.has(name)) groups.set(name, { name, checks: [], unread: check.unread ?? [] });
    groups.get(name).checks.push(check);
  }
  return [...groups.values()];
}

/**
 * receiptGroups under the listed-code rule (0.7.0 D11): each group's list with the files a test
 * names put back on it (unread-scan.mjs), so a change to one voids that check's receipt. The test
 * files are `testFiles` (phaseRun.tampering's); with none there is no rule, and nothing is read. A
 * scan that fails keys every group on its whole tree (an empty list): a receipt never holds on a
 * list that could not be checked. `files` and `read` default to the repo at `root`.
 */
export function listedGroups(root, checks, testFiles, { files = null, read = (file) => readFileSync(join(root, file), "utf8") } = {}) {
  const groups = receiptGroups(checks);
  if (!testFiles?.length || !groups.some((group) => group.unread.length)) return groups;
  try {
    const all = files ?? repoFiles(root);
    const named = testNamedPaths({ testFiles, files: all, read });
    return groups.map((group) => ({ ...group, unread: withListedCode(group.unread, listedCode(named, group.unread, all)) }));
  } catch {
    return groups.map((group) => ({ ...group, unread: [] }));
  }
}

/**
 * The working tree's content as one git tree hash per list: tracked files as they are on disk plus
 * untracked ones git does not ignore, each key leaving out the paths its list matches. All come from
 * one `git add -A` into a copy of the index, so the real index (what the session has staged) is never
 * touched; each list then removes its own paths from a copy of that, and writes its tree. A key is
 * null when git cannot say, or when its list leaves out every file (it would key every state of the
 * code alike).
 */
export function treeKeys(root, lists) {
  const git = (args, env, input) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, ...env }, input, maxBuffer: 64 * 1024 * 1024 });
  const none = lists.map(() => null);
  const indexPath = git(["rev-parse", "--git-path", "index"], {}).stdout?.trim();
  if (!indexPath) return none;
  const dir = mkdtempSync(join(tmpdir(), "phase-run-receipt-"));
  const staged = join(dir, "index");
  try {
    const real = resolve(root, indexPath);
    if (existsSync(real)) {
      copyFileSync(real, staged);
      // Keep the index's own modified time on the copy. Git trusts a cached size and time unless the file is as new as
      // the index ("racy git"), and a fresh time on the copy turned that off: on a coarse clock (Linux, CI) a same-size
      // edit in the tick the index was written in read as unchanged, so the key named old content. utimes keeps whole
      // milliseconds, so the copy's time can only fall a little earlier, which makes git re-read more files, never fewer.
      const { atime, mtime } = statSync(real);
      utimesSync(staged, atime, mtime);
    }
    if (git(["add", "-A"], { GIT_INDEX_FILE: staged }).status !== 0) return none;
    const listed = git(["ls-files", "-z"], { GIT_INDEX_FILE: staged });
    if (listed.status !== 0) return none;
    const paths = [...new Set(listed.stdout.split("\0").filter(Boolean))];
    return lists.map((unread, i) => {
      const leftOut = paths.filter(unreadMatcher(unread ?? []));
      let index = staged;
      if (leftOut.length) {
        index = join(dir, `index-${i}`);
        copyFileSync(staged, index);
        // On stdin, not as arguments: a list matching hundreds of docs would pass Windows' command-line limit.
        if (git(["update-index", "--force-remove", "-z", "--stdin"], { GIT_INDEX_FILE: index }, `${leftOut.join("\0")}\0`).status !== 0) return null;
      }
      const tree = git(["write-tree"], { GIT_INDEX_FILE: index });
      const key = tree.status === 0 ? tree.stdout.trim() : null;
      return EMPTY_TREES.includes(key) ? null : key;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One list's key (treeKeys for a single list). */
export function treeKey(root, unread = []) {
  return treeKeys(root, [unread])[0];
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
 * Whether a receipt covers this check's command (its `run`, `{base}` filled in), on this exact code,
 * measured from this base, with the same unread paths left out (a receipt with no list was made
 * under none). A 0.5.x receipt recorded the command unfilled; under the same base that is the same
 * command, so it still holds.
 */
export function receiptHolds(receipt, { tree, base, command, unread }) {
  unread ??= [];
  const commands = Array.isArray(receipt?.commands) ? receipt.commands : [];
  return Boolean(
    receipt &&
      tree &&
      receipt.passed === true &&
      receipt.tree === tree &&
      receipt.base === base &&
      typeof command === "string" &&
      (commands.includes(command.replaceAll("{base}", base)) || commands.includes(command)) &&
      sameList(receipt.unread ?? [], unread),
  );
}

function sameList(a, b) {
  return Array.isArray(a) && a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}
