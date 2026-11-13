// The listed-code rule (0.7.0 D11, #39), and the scan behind it (0.6.0 D19, #22). A test file that
// names a path on a check's `unread` list probably reads it, so that path is put back on the list:
// a change there voids the check's receipt (receipt.mjs `listedGroups`, for the stop check and the
// Stop hook) and any gate's `unreadOf` skip that points at the check (run.mjs `gatePlan`). A change
// to an unread file no test names keeps both, as before.
//
// The test files are the ones `phaseRun.tampering.testFiles` matches, one list used by the tampering
// gate and here: a project with none has no listed-code rule, and setup's verify and refresh say so.
// A path is a quoted string in one: from the repo's root, or from the test's own folder when it
// starts `./` or `../` (a relative import). Globs, URLs, `${…}` and anything with a space are skipped,
// so a path built from pieces (`join(dir, "docs", "a.md")`) goes unseen: the rule only ever voids
// too little, and the runner's gates, which trust no receipt, still run what a skip doesn't cover.
// It runs nothing and reads only what it is handed, so setup's verify and refresh call it with
// detect's file list, and `node tools/phase-run/unread-scan.mjs` runs it on this project. It never
// imports receipt.mjs: the runner imports this file, and no gate may read a receipt.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";

import { unreadMatcher } from "./unread.mjs";

/** What the scan says when there are no test files to read: there is no listed-code rule. */
export const NO_TEST_FILES = "no listed-code rule: set phaseRun.tampering.testFiles, or a file a test reads keeps a check's receipt and suite skip when it changes on that check's unread list";

/**
 * The rows with an `unread` list, as the receipts group them: a named row alone, the nameless rows
 * together (one receipt file, one list; the loaders refuse nameless rows whose lists differ).
 */
export function listRows(config) {
  const rows = new Map();
  for (const check of config?.stopGate?.checks ?? []) {
    if (!Array.isArray(check.unread) || check.unread.length === 0) continue;
    const name = check.name ?? null;
    if (!rows.has(name)) rows.set(name, { name, labels: [], unread: check.unread });
    rows.get(name).labels.push(check.label);
  }
  return [...rows.values()].map(({ name, labels, unread }) => ({ name, label: labels.join(", "), unread }));
}

/** A quoted string on one line: `"…"`, `'…'` or `` `…` ``. */
const QUOTED = /(["'`])((?:\\.|(?!\1)[^\\\r\n])*)\1/g;
/** What a repo path is made of, once a leading `./` or `../` is read. */
const PATH = /^[\w@.~+-]+(?:\/[\w@.~+-]+)*$/;
/** A path's last part has an extension: `a.md`, not `src/x`. */
const HAS_EXTENSION = /\.[A-Za-z0-9]+$/;

/** The repo path a string names, read from the test at `from`, or null when it names none. */
export function pathOf(value, from) {
  if (/[\s*?[\]{}:\\]/.test(value) || value.includes("${")) return null;
  const relative = /^\.\.?\//.test(value);
  const path = posix.normalize(relative ? posix.join(posix.dirname(from), value) : value).replace(/\/$/, "");
  if (path.startsWith("../") || path === ".." || path === "." || !PATH.test(path)) return null;
  // A path has a folder or an extension: `vitest` or `utf8` is a word, `docs/a` or `a.md` is a path.
  return path.includes("/") || HAS_EXTENSION.test(path) ? path : null;
}

/**
 * Each path the test files name, where: `[{ file, line, path }]`, in file and line order. A test file
 * that is gone (listed by git, deleted from the tree) names nothing; any other read error is thrown,
 * so a caller can fail closed.
 */
function namings({ testFiles, files, read }) {
  if (!Array.isArray(testFiles) || testFiles.length === 0) return [];
  const isTest = unreadMatcher(testFiles);
  const found = [];
  for (const file of files.filter(isTest).sort()) {
    let text;
    try {
      text = read(file);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    text.split("\n").forEach((source, i) => {
      const seen = new Set();
      for (const [, , value] of source.matchAll(QUOTED)) {
        const path = pathOf(value, file);
        if (path && !seen.has(path)) {
          seen.add(path);
          found.push({ file, line: i + 1, path });
        }
      }
    });
  }
  return found;
}

/** Every repo path the test files name, sorted: what the listed-code rule may put back on a list. */
export function testNamedPaths({ testFiles, files, read }) {
  return [...new Set(namings({ testFiles, files, read }).map(({ path }) => path))].sort();
}

/**
 * Whether a repo path is one `named` names: the path itself, a file under a named folder, or, for a
 * name without an extension (an import such as `../src/x`), that name with any extension.
 */
function namedTest(named) {
  return (file) =>
    named.some((path) => file === path || file.startsWith(`${path}/`) || (!HAS_EXTENSION.test(path) && file.startsWith(`${path}.`) && !file.slice(path.length).includes("/")));
}

/**
 * The listed code of one `unread` list: each named path on it, or with a repo file (`files`) on it
 * that the name covers (a named folder's files, an import without its extension). Sorted.
 */
export function listedCode(named, unread, files) {
  const onList = unreadMatcher(unread);
  const listedFiles = files.filter(onList); // matched once: the files are many, the names a few
  return named
    .filter((path) => {
      const covers = namedTest([path]);
      return onList(path) || listedFiles.some(covers);
    })
    .sort();
}

/**
 * The list a check is judged by under the listed-code rule: its own, with each listed path put back
 * by a `!` (the matcher's last-match rule), and an extensionless name's files too. With nothing
 * listed it is the owner's list itself, so a receipt keyed on it holds as before the rule.
 */
export function withListedCode(unread, listed) {
  if (listed.length === 0) return unread;
  return [...unread, ...listed.flatMap((path) => (HAS_EXTENSION.test(path) ? [`!${path}`] : [`!${path}`, `!${path}.*`]))];
}

/**
 * The scan setup prints: `files` is the repo's paths (tracked and untracked, not ignored), `read`
 * gives a path's text. Every row with a list (`listRows`) is read. Returns `{ note, hits: [{ file,
 * line, path, row }] }`; `note` is NO_TEST_FILES when the tampering section lists no test files,
 * and then nothing is read.
 */
export function unreadScan({ config, files, read }) {
  const testFiles = config?.phaseRun?.tampering?.testFiles;
  if (!Array.isArray(testFiles) || testFiles.length === 0) return { note: NO_TEST_FILES, hits: [] };
  const rows = listRows(config);
  if (rows.length === 0) return { note: null, hits: [] };
  const found = namings({ testFiles, files, read });
  const named = [...new Set(found.map(({ path }) => path))];
  const listed = rows.map((row) => ({ row, paths: new Set(listedCode(named, row.unread, files)) }));
  const hits = [];
  for (const naming of found) for (const { row, paths } of listed) if (paths.has(naming.path)) hits.push({ ...naming, row });
  return { note: null, hits };
}

/** The scan's lines, one per hit (or its note): what setup prints as warnings. */
export function scanLines({ note, hits }) {
  if (note) return [note];
  return hits.map(({ file, line, path, row }) => `${file}:${line} names "${path}", on the ${row.label} check's unread list: a change there voids that check's receipt and any suite skip pointing at it (the listed-code rule)`);
}

/**
 * The repo's files as git lists them: tracked, and untracked but not ignored. With `-z`, so a name
 * with a non-ASCII letter comes back as it is, never C-quoted (`core.quotePath`), which no glob matches.
 */
export function repoFiles(root) {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return [...new Set(listed.split("\0").filter(Boolean))];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = process.cwd();
  const config = JSON.parse(readFileSync(join(root, ".claude", "workflow.json"), "utf8"));
  const lines = scanLines(unreadScan({ config, files: repoFiles(root), read: (file) => readFileSync(join(root, file), "utf8") }));
  for (const line of lines) console.log(`warning: ${line}`);
  if (!lines.length) console.log("No test file names a path on any check's unread list.");
}
