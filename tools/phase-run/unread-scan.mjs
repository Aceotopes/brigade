// The unread list's honesty check (D19, #22): a test file that names a path on the tests row's
// `unread` list probably reads it, so a change there would keep the stop check's receipt (and skip a
// gate whose `unreadOf` points at that row) though the tests read what changed. It is a warning,
// never a gate: the runner's gates still run everything a wrong list lets through.
//
// The test files are the ones `phaseRun.tampering.testFiles` matches, one list used by the tampering
// gate and here. A path is a quoted string in one: from the repo's root, or from the test's own
// folder when it starts `./` or `../`. Globs, URLs, `${…}` and anything with a space are skipped, so
// a path built from pieces (`join(dir, "docs", "a.md")`) goes unseen: the scan only ever under-warns.
// It runs nothing and reads only what it is handed, so setup's verify and refresh call it with
// detect's file list, and `node tools/phase-run/unread-scan.mjs` runs it on this project.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";

import { unreadMatcher } from "./unread.mjs";

/** What the scan says when there are no test files to read. */
export const NO_TEST_FILES = "set phaseRun.tampering.testFiles to check your unread list";

/**
 * The tests row: the stop check named `tests`, else the nameless rows with a receipt and a list
 * (they share one receipt file, so one list). Null when no such row has an `unread` list.
 */
export function testsRow(config) {
  const checks = config?.stopGate?.checks ?? [];
  const row = checks.find((c) => c.name === "tests") ?? checks.find((c) => c.receipt && !c.name && Array.isArray(c.unread));
  return row && Array.isArray(row.unread) && row.unread.length ? row : null;
}

/** A quoted string on one line: `"…"`, `'…'` or `` `…` ``. */
const QUOTED = /(["'`])((?:\\.|(?!\1)[^\\\r\n])*)\1/g;
/** What a repo path is made of, once a leading `./` or `../` is read. */
const PATH = /^[\w@.~+-]+(?:\/[\w@.~+-]+)*$/;

/** The repo path a string names, read from the test at `from`, or null when it names none. */
export function pathOf(value, from) {
  if (/[\s*?[\]{}:\\]/.test(value) || value.includes("${")) return null;
  const relative = /^\.\.?\//.test(value);
  const path = posix.normalize(relative ? posix.join(posix.dirname(from), value) : value).replace(/\/$/, "");
  if (path.startsWith("../") || path === ".." || path === "." || !PATH.test(path)) return null;
  // A path has a folder or an extension: `vitest` or `utf8` is a word, `docs/a` or `a.md` is a path.
  return path.includes("/") || /\.[A-Za-z0-9]+$/.test(path) ? path : null;
}

/**
 * The scan: `files` is the repo's paths (tracked and untracked, not ignored), `read` gives a path's
 * text, and `row` the tests row when the caller knows it (setup finds it by the stack's tests
 * command), else `testsRow`. Returns `{ note, row, hits: [{ file, line, path }] }`; `note` is
 * NO_TEST_FILES when the tampering section lists no test files, and then nothing is read.
 */
export function unreadScan({ config, row: given, files, read }) {
  const testFiles = config?.phaseRun?.tampering?.testFiles;
  if (!Array.isArray(testFiles) || testFiles.length === 0) return { note: NO_TEST_FILES, row: null, hits: [] };
  const row = given ?? testsRow(config);
  if (!row) return { note: null, row: null, hits: [] };
  const isTest = unreadMatcher(testFiles);
  const unread = unreadMatcher(row.unread);
  const hits = [];
  for (const file of files.filter(isTest).sort()) {
    let text;
    try {
      text = read(file);
    } catch {
      continue; // gone since the list was made, or unreadable: nothing to say about it
    }
    text.split("\n").forEach((source, i) => {
      const seen = new Set();
      for (const [, , value] of source.matchAll(QUOTED)) {
        const path = pathOf(value, file);
        if (path && !seen.has(path) && unread(path)) {
          seen.add(path);
          hits.push({ file, line: i + 1, path });
        }
      }
    });
  }
  return { note: null, row, hits };
}

/** The scan's lines, one per hit (or its note): what setup prints as warnings. */
export function scanLines({ note, row, hits }) {
  if (note) return [note];
  return hits.map(({ file, line, path }) => `${file}:${line} names "${path}", on the ${row.label} check's unread list: if the tests read it, a change there keeps the receipt; narrow the list`);
}

/** The repo's files as git lists them: tracked, and untracked but not ignored. */
export function repoFiles(root) {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = process.cwd();
  const config = JSON.parse(readFileSync(join(root, ".claude", "workflow.json"), "utf8"));
  const lines = scanLines(unreadScan({ config, files: repoFiles(root), read: (file) => readFileSync(join(root, file), "utf8") }));
  for (const line of lines) console.log(`warning: ${line}`);
  if (!lines.length) console.log("No test file names a path on the tests row's unread list.");
}
