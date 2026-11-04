// What the three doc tools share: reading files as LF text, the frontmatter
// header, the devlog's entries, and which archive bucket a date falls in.
// Pure where it can be, so tools/doc-tools.test.mjs can test it without a repo.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** True when the module is the script node was started with, not an import. */
export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && metaUrl === pathToFileURL(resolve(process.argv[1])).href;
}

/** The working copy mixes CRLF and LF; every comparison is on LF text. */
export function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
}

/** Writes LF text back in the line endings the file already had. */
export function write(rel, text) {
  const abs = join(ROOT, rel);
  const crlf = existsSync(abs) && readFileSync(abs, "utf8").includes("\r\n");
  writeFileSync(abs, crlf ? text.replace(/\n/g, "\r\n") : text);
}

export function git(args, input) {
  // stderr is kept, not printed: a caller that expects a failure (a doc not yet in HEAD) catches it.
  const stdio = ["pipe", "pipe", "pipe"];
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, input, stdio }).replace(/\r\n/g, "\n");
}

export const KINDS = ["living", "log", "record", "generated"];

/**
 * The header a doc opens with:
 *   ---
 *   job: Where every phase stands, present tense only.
 *   kind: living
 *   max-lines: 120
 *   ---
 * A flat `key: value` list, numbers read as numbers. Null when there is none.
 */
export function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---(\n|$)/);
  if (!match) return null;
  const data = {};
  for (const line of match[1].split("\n")) {
    const pair = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!pair) continue;
    let value = pair[2].trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    // A budget is a number; an ADR number like 0038 keeps its zeros.
    data[pair[1]] = /^(0|[1-9]\d*)$/.test(value) ? Number(value) : value;
  }
  return data;
}

/** Sections that start at a `## ` heading: a log's entries, a doc's parts. */
export function sections(text) {
  const lines = text.split("\n");
  const out = [];
  let current = null;
  let inFence = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && /^## /.test(line)) {
      current = { heading: line, start: index + 1, lines: [line] };
      out.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  });
  return out;
}

/**
 * What a doc's header promises and the text breaks. One string per problem,
 * each naming the line and the limit, so the fix is obvious.
 */
export function budgetProblems(file, text) {
  const header = parseFrontmatter(text);
  if (!header) return [];
  const problems = [];
  if (!header.job) problems.push(`${file}: its header has no \`job:\` line.`);
  if (!KINDS.includes(header.kind)) {
    problems.push(`${file}: its header's \`kind:\` is "${header.kind ?? ""}", not one of ${KINDS.join(", ")}.`);
  }
  const lines = text.replace(/\n$/, "").split("\n");
  const raise = "Trim it, or raise the limit in its header (a visible, deliberate choice).";
  if (typeof header["max-lines"] === "number" && lines.length > header["max-lines"]) {
    problems.push(`${file}: ${lines.length} lines, over its max-lines of ${header["max-lines"]}. ${raise}`);
  }
  if (typeof header["max-line-length"] === "number") {
    const headerEnd = lines.indexOf("---", 1); // the header's own lines are not held to it
    lines.forEach((line, index) => {
      if (index <= headerEnd) return;
      if ([...line].length > header["max-line-length"]) {
        problems.push(
          `${file}:${index + 1} is ${[...line].length} characters, over its max-line-length of ${header["max-line-length"]}. ${raise}`,
        );
      }
    });
  }
  if (typeof header["max-entry-lines"] === "number") {
    for (const entry of sections(text)) {
      const length = entry.lines.join("\n").replace(/\n+(---\n*)?$/, "").split("\n").length;
      if (length > header["max-entry-lines"]) {
        problems.push(
          `${file}:${entry.start} "${entry.heading.slice(0, 80)}" is ${length} lines, over its max-entry-lines of ${header["max-entry-lines"]}. ${raise}`,
        );
      }
    }
  }
  return problems;
}

// ------------------------------------------------------------------ the devlog

/** Every `devlog #N` a commit message on this branch has cited: those entries are closed. */
export function citedDevlogNumbers() {
  const cited = new Set();
  let log = "";
  try {
    log = git(["log", "--format=%B", "HEAD"]);
  } catch {
    return cited; // a repository with no commits yet
  }
  for (const match of log.matchAll(/devlog #(\d+)\b/gi)) cited.add(String(Number(match[1])));
  return cited;
}

/**
 * The devlog's entries in file order (newest first), each with its number and
 * whether it is still open. An entry closes when a commit cites it; an entry
 * whose heading carries its hash (the older `## #N — <hash> — title` style) is closed too.
 */
export function devlogEntries(text, cited) {
  return sections(text)
    .filter((section) => /^## #\d+\b/.test(section.heading))
    .map((section) => {
      const number = String(Number(section.heading.match(/^## #(\d+)/)[1]));
      const legacyClosed = !/uncommitted|HASH-PENDING/i.test(section.heading) && /—\s*`?[0-9a-f]{7,}`?\s*—/.test(section.heading);
      return { ...section, number, open: !cited.has(number) && !legacyClosed };
    });
}

/** The devlog's text before its first entry: its header and how-to. */
export function devlogPreamble(text) {
  const at = text.search(/^## #\d+\b/m);
  return at === -1 ? text : text.slice(0, at);
}

// --------------------------------------------------------------- the archives

/**
 * The archive bucket a date (YYYY-MM-DD) belongs to: the first whose `until`
 * is on or after it. Null means after every finished bucket, the current phase.
 */
export function bucketFor(date, phases) {
  return phases.find((phase) => date <= phase.until) ?? null;
}

export function loadPhases(rel) {
  if (!existsSync(join(ROOT, rel))) return [];
  return JSON.parse(read(rel));
}

/** Today in the machine's own time zone, as YYYY-MM-DD. */
export function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
