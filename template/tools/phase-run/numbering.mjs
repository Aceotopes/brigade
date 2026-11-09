// Numbering at Landing (0.7.0, ADR 0006). Two lanes build at once, so neither may take the next
// devlog number: a lane writes the token (`phaseRun.hotspots.token`, default `NNN`) wherever a
// number goes, and this fills the numbers in from the phase branch's tip. Pure: it reads no files
// and runs no git. Landing (#36) hands it the lane's commit and the tip's hotspot files, and
// replays, rebuilds and re-gates on what it returns.
//
// Which file gets which treatment is data, the `phaseRun.hotspots` rows (config.mjs). A row's
// path is a file, a folder, or a pattern with `*` (within one path segment) and `{phase}`:
//   log        a file of `## #` entries (the devlog): the lane's one `## #NNN` entry is numbered
//              and put on top of the tip's file; or a file named `NNN-<slug>.md` (an
//              implementation log): renamed to the next log number, padded to three digits
//   generated  an index: the tip's text is kept, and every generated row is listed to be rebuilt
//   own-file   a file each ticket adds a block to (the phase's gotchas file): the lane writes its
//              block to `.lane/<the file's path>`, and it is appended to the tip's file
//   no row     left as the lane wrote it, for git to settle, even if it carries the token
//
// Two counters: the devlog's and the implementation log's, each one past the tip's last. Where the
// token stands decides which it takes: a log's file name, its `# #NNN` title and a bare `NNN` (as in
// "implementation log NNN") take the log's; every other `#NNN` (`## #NNN ·`, `devlog #NNN`,
// `**Devlog:** \`#NNN\``) takes the devlog's.
import { HOTSPOT_TOKEN } from "./config.mjs";

/** Where a lane writes what it may not write in place: an own-file block. */
export const LANE_DIR = ".lane";

/** The scratch file a lane writes its block for an own-file `path` into. */
export function scratchFor(path) {
  return `${LANE_DIR}/${path}`;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pad = (n) => String(n).padStart(3, "0");
const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");
/** LF text written in `eol`'s line endings. */
const inEol = (text, eol) => text.replace(/\r\n/g, "\n").replace(/\n/g, eol);

/** A row's path, its `{phase}` filled, as a matcher: the path itself, under it as a folder, or its pattern. */
function rowMatcher(row, phase) {
  const path = phase ? row.path.replaceAll("{phase}", phase) : row.path;
  const source = path.split("*").map(escapeRegExp).join("[^/]*");
  return { ...row, path, exact: path.includes("*") ? null : path, pattern: new RegExp(`^${source}(?:/.+)?$`) };
}

/** The row a path falls on: its exact path first, else the longest row that covers it. */
function rowFor(path, rows) {
  const exact = rows.find((row) => row.exact === path);
  if (exact) return exact;
  return rows.filter((row) => row.pattern.test(path)).sort((a, b) => b.path.length - a.path.length)[0] ?? null;
}

/**
 * The kind of row (`log`, `generated`, `own-file`) a path falls on, or null when git settles it.
 * A lane's `.lane/<path>` scratch file is its target's own-file block. Landing's plan (#36) splits
 * what numberLane returns by it.
 */
export function hotspotKind(path, hotspots, phase = null) {
  const rows = (hotspots?.rows ?? []).map((row) => rowMatcher(row, phase));
  const target = path.startsWith(`${LANE_DIR}/`) ? path.slice(LANE_DIR.length + 1) : path;
  const kind = rowFor(target, rows)?.kind ?? null;
  return target === path || kind === "own-file" ? kind : null;
}

/** The token filled in: a log's title line (when `title`), then `#NNN` with the devlog's, then a bare `NNN` with the log's. */
function fill(text, token, numbers, { title = false } = {}) {
  const t = escapeRegExp(token);
  let out = text;
  if (title) out = out.replace(new RegExp(`^# #${t}(?![\\w])`, "m"), `# #${pad(numbers.log)}`);
  out = out.replace(new RegExp(`#${t}(?![\\w])`, "g"), `#${numbers.devlog}`);
  return out.replace(new RegExp(`(?<![\\w#])${t}(?![\\w])`, "g"), pad(numbers.log));
}

/** A log file of entries: the lane's one unnumbered entry, numbered, on top of the tip's entries. */
function withEntry(path, lane, tip, token, numbers) {
  const lines = lane.split("\n");
  const heading = new RegExp(`^## #${escapeRegExp(token)}(?![\\w])`);
  const starts = lines.flatMap((line, index) => (heading.test(line) ? [index] : []));
  if (starts.length === 0) return lane; // nothing unnumbered: git settles it
  if (starts.length > 1) throw new Error(`${path} has ${starts.length} unnumbered entries (## #${token}); a lane commit carries one.`);
  const [start] = starts;
  const next = lines.findIndex((line, index) => index > start && /^## /.test(line));
  const entry = fill(lines.slice(start, next === -1 ? lines.length : next).join("\n"), token, numbers);
  if (tip == null) return fill(lane, token, numbers);
  const at = tip.search(/^## #\d+(?![\w])/m);
  const where = at === -1 ? tip.length : at;
  return tip.slice(0, where) + inEol(`${entry.replace(/\r\n/g, "\n")}\n`, eolOf(tip)) + tip.slice(where);
}

/** An own file: the tip's text with the lane's block appended, or the block alone when the tip has none. */
function fold(tip, block) {
  if (tip == null || !tip.trim()) return block;
  const eol = eolOf(tip);
  return `${tip.trimEnd()}${eol}${eol}${inEol(block.trim(), eol)}${eol}`;
}

/**
 * A lane's commit, numbered for the tip.
 *   files     the lane commit's changed files, `{ path: text }`, a deleted one `null`
 *   message   its commit message
 *   tip       the tip's text of the hotspot files it may need, `{ path: text }` (a file the tip lacks is left out)
 *   last      the tip's last numbers, `{ devlog, log }`
 *   hotspots  the loaded `phaseRun.hotspots` section, `{ token, rows }`
 *   phase     the phase's name, for a row path's `{phase}`
 * Returns `{ files, message, numbers, rebuild }`: `files` says, for every path the lane touched or
 * the numbering adds, what the tip gets (`null`: the path must not exist there); `numbers` the two
 * numbers taken; `rebuild` the generated rows, to rebuild on the numbered tree.
 */
export function numberLane({ files, message = "", tip = {}, last, hotspots, phase = null }) {
  if (!Number.isInteger(last?.devlog) || !Number.isInteger(last?.log) || last.devlog < 0 || last.log < 0) {
    throw new Error(`The tip's last numbers must be whole numbers, { devlog, log } (they are ${JSON.stringify(last)}).`);
  }
  const token = hotspots?.token ?? HOTSPOT_TOKEN;
  const numbers = { devlog: last.devlog + 1, log: last.log + 1 };
  const rows = (hotspots?.rows ?? []).map((row) => rowMatcher(row, phase));
  const out = {};

  // An own-file block, from its scratch file; it replaces any edit the lane made to the file itself.
  for (const [path, text] of Object.entries(files)) {
    if (!path.startsWith(`${LANE_DIR}/`)) continue;
    const target = path.slice(LANE_DIR.length + 1);
    if (rowFor(target, rows)?.kind !== "own-file") continue;
    out[path] = null;
    if (text !== null) out[target] = fold(tip[target], fill(text, token, numbers));
  }

  const named = new RegExp(`^${escapeRegExp(token)}-.+\\.md$`);
  const logs = [];
  for (const [path, text] of Object.entries(files)) {
    if (path in out) continue;
    const row = rowFor(path, rows);
    if (!row || text === null || row.kind === "own-file") out[path] = text;
    else if (row.kind === "generated") out[path] = path in tip ? tip[path] : text;
    else if (named.test(path.split("/").pop())) logs.push(path);
    else out[path] = withEntry(path, text, tip[path], token, numbers);
  }
  if (logs.length > 1) {
    const names = logs.map((path) => path.split("/").pop()).join(", ");
    throw new Error(`The lane wrote ${logs.length} unnumbered logs (${names}); a lane commit carries one.`);
  }
  for (const path of logs) {
    const name = path.split("/").pop();
    out[path] = null;
    out[`${path.slice(0, -name.length)}${pad(numbers.log)}${name.slice(token.length)}`] = fill(files[path], token, numbers, { title: true });
  }

  const rebuild = [...new Set(rows.filter((row) => row.kind === "generated").map((row) => row.path))].sort();
  return { files: out, message: fill(message, token, numbers), numbers, rebuild };
}
