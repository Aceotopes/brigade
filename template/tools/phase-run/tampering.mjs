// The tampering gate (D15, #20): a ticket that weakens its tests, or what judges them, fails, unless
// the ticket said why before the run. Weakening is a skip or focus marker added to a test file,
// assertions removed on balance over all the diff's test files, or any change to a guarded file or to
// a guarded script's text. The rules are `phaseRun.tampering` as the ticket's **base commit** has it,
// read through config.mjs's own checks, so a ticket cannot loosen what judges it; a section missing
// or broken at the base fails the gate, never waves the ticket through.
//
// A **test override** is a line under the override heading in the ticket body, as fetched at run
// start, that names the path as a whole word: it lets that path through (an overridden test file is
// left out of the assertion count). A reason only in the commit message is refused, and said so in
// the morning report. Nothing here runs a command: the runner hands in the diffs and a reader of
// files at a commit (`git show <rev>:<path>`), so every case is a fixture in run.test.mjs.
import { CONFIG_PATH, tamperingRules } from "./config.mjs";
import { unreadMatcher as globList } from "./unread.mjs";

/**
 * The patch the gate reads: `git` with these, then `<base>..HEAD`. No context lines, renames found
 * (a moved test is no removal), and the prefixes, colour and drivers pinned whatever the owner's
 * git config says, so the headers parse alike on every machine.
 */
export const PATCH_ARGS = ["diff", "-U0", "-M", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];

/**
 * The gate's verdict, or null when the run has no tampering section (no gate). `rules` is the run's
 * own section, which only says the gate is on; the rules that judge are read at `base`.
 * Returns `{ ok, findings, overridden, refused, refusedNote, problem, output }`.
 */
export function tamperingVerdict({ base, rules, paths, patch = "", readAt, body = "", message = "" }) {
  if (!rules) return null;
  let judged;
  try {
    judged = baseRules(base, readAt);
  } catch (error) {
    const problem = error.message;
    return {
      ok: false,
      findings: [],
      overridden: [],
      refused: [],
      refusedNote: null,
      problem,
      output: `The tampering rules could not be read from the base commit ${short(base)}: ${problem}\nThe tampering gate never passes a ticket it cannot judge. The rules are the base commit's, so no change in this ticket can mend them: park the ticket and say so.`,
    };
  }
  const heading = judged.override?.heading ?? null;
  const overrides = sectionLines(body, heading);
  const overridden = new Set();
  /** Whether the override names `path`; each path it lets through is recorded in `overridden`. */
  const overrideAllows = (path) => {
    const allowed = overrides.some((line) => namesPath(line, path));
    if (allowed) overridden.add(path);
    return allowed;
  };
  const isTest = globList(judged.testFiles);
  const isGuarded = globList(judged.guarded);
  const files = patchFiles(patch);
  const findings = [];

  for (const file of files) {
    if (!file.to || !isTest(file.to)) continue;
    for (const marker of judged.markers) {
      const lines = file.added.filter((line) => marker.pattern.test(line));
      if (lines.length > 0 && !overrideAllows(file.to)) findings.push({ kind: "marker", path: file.to, marker: marker.name, lines });
    }
  }

  if (judged.assertions) {
    const every = new RegExp(judged.assertions.pattern.source, `${judged.assertions.pattern.flags}g`);
    const count = (lines) => lines.reduce((sum, line) => sum + [...line.matchAll(every)].length, 0);
    let removed = 0;
    let added = 0;
    const losing = new Set();
    for (const file of files) {
      // A test file renamed out of the test globs takes every assertion with it, not just its edited
      // lines: the suite no longer runs it. Its whole text at the base counts as removed.
      const leftTests = file.from && file.to && file.from !== file.to && isTest(file.from) && !isTest(file.to);
      const baseText = leftTests ? readAt(base, file.from) : null;
      if (leftTests && baseText == null) {
        // Its assertions can't be counted, so it never passes uncounted.
        if (!overrideAllows(file.from)) findings.push({ kind: "unreadable", path: file.from });
        continue;
      }
      const lost = !file.from || !isTest(file.from) ? 0 : leftTests ? count(baseText.split("\n")) : count(file.removed);
      // An overridden file's losses are let through; what any test file gains still counts, so a test
      // moved into an overridden file still balances.
      const from = lost > 0 && !overrideAllows(file.from) ? lost : 0;
      const to = file.to && isTest(file.to) ? count(file.added) : 0;
      if (from > 0) losing.add(file.from);
      removed += from;
      added += to;
    }
    if (removed - added > judged.assertions.maxNetRemoved) {
      findings.push({ kind: "assertions", path: null, paths: [...losing], removed, added, max: judged.assertions.maxNetRemoved });
    }
  }

  for (const path of paths) {
    if (isGuarded(path) && !overrideAllows(path)) findings.push({ kind: "guarded", path });
  }

  for (const { file, script } of judged.guardedScripts) {
    if (!paths.includes(file)) continue;
    if (scriptText(readAt(base, file), script) !== scriptText(readAt("HEAD", file), script) && !overrideAllows(file)) {
      findings.push({ kind: "script", path: file, script });
    }
  }

  const refused = heading ? [...new Set(findings.flatMap((f) => (f.path ? [f.path] : f.paths)).filter((path) => messageNames(message, heading, path)))] : [];
  const refusedNote = refused.length
    ? `The commit message gave a reason for weakening ${refused.map((p) => `\`${p}\``).join(", ")}; it was refused. Only a line under "${heading}" in the ticket body, written before the run, lets a path through.`
    : null;
  const ok = findings.length === 0;
  return { ok, findings, overridden: [...overridden], refused, refusedNote, problem: null, output: ok ? "" : report(findings, { base, heading, refused }) };
}

/** The base commit's rules, through the loaders' own checks. Throws, saying why, when there are none to read. */
function baseRules(base, readAt) {
  if (typeof readAt !== "function") throw new Error("the runner gave the gate no way to read the base commit.");
  const text = readAt(base, CONFIG_PATH);
  if (text == null) throw new Error(`the base commit has no ${CONFIG_PATH}.`);
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`its ${CONFIG_PATH} could not be read as JSON (${error.message}).`);
  }
  const section = data?.phaseRun?.tampering;
  if (section === undefined) throw new Error(`its ${CONFIG_PATH} has no phaseRun.tampering section, while this run has one.`);
  return tamperingRules(section, "phaseRun.tampering");
}

/** One script's text in a package.json-style file, or a stand-in that never equals a real one when it can't be read. */
function scriptText(text, script) {
  if (text == null) return "\0(no file)";
  try {
    const value = JSON.parse(text)?.scripts?.[script];
    return value === undefined ? "\0(no script)" : JSON.stringify(value);
  } catch {
    return `\0(unreadable)${text}`;
  }
}

/** Each kind of finding's line in the gate's output. */
const FINDING_LINES = {
  marker: (f) => `${f.path} adds the "${f.marker}" marker: \`${f.lines[0].trim().slice(0, 160)}\`${f.lines.length > 1 ? ` (and ${f.lines.length - 1} more line(s))` : ""}`,
  assertions: (f) => `${f.removed} assertion match(es) removed and ${f.added} added across the test files, ${f.removed - f.added} net; at most ${f.max} may be (removed from ${f.paths.join(", ")})`,
  guarded: (f) => `${f.path} is guarded, and this ticket changes it`,
  script: (f) => `${f.path}'s "${f.script}" script changed`,
  unreadable: (f) => `${f.path} left the test files, and its text at the base could not be read to count its assertions`,
};

function report(findings, { base, heading, refused }) {
  const lines = [`This ticket weakens its tests or what judges them (phaseRun.tampering, read from the base commit ${short(base)}):`];
  for (const f of findings) lines.push(`- ${FINDING_LINES[f.kind](f)}`);
  if (refused.length) lines.push("", `A reason in the commit message does not count (found for ${refused.join(", ")}).`);
  lines.push(
    "",
    heading
      ? `Undo the change and amend the commit. Only a line under "${heading}" in the ticket body, written by the owner before the run, lets a path through: if the ticket truly needs this, park it and ask for that line.`
      : "Undo the change and amend the commit. This project's rules have no override heading: if the ticket truly needs this, park it and ask the owner.",
  );
  return lines.join("\n");
}

const short = (base) => String(base).slice(0, 9);

/**
 * The files of a `git diff` patch (PATCH_ARGS): each one's old and new path (null for /dev/null)
 * and its added and removed lines. A pure rename has its two paths and no lines.
 */
export function patchFiles(patch) {
  const files = [];
  let file = null;
  let header = false;
  for (const line of String(patch ?? "").replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = { from: null, to: null, added: [], removed: [] };
      files.push(file);
      header = true;
    } else if (!file) continue;
    else if (header) {
      // A pure rename has no ---/+++ lines: its paths are only in these, unprefixed.
      if (line.startsWith("rename from ")) file.from = headerPath(line.slice(12), "");
      else if (line.startsWith("rename to ")) file.to = headerPath(line.slice(10), "");
      else if (line.startsWith("--- ")) file.from = headerPath(line.slice(4), "a/");
      else if (line.startsWith("+++ ")) file.to = headerPath(line.slice(4), "b/");
      else if (line.startsWith("@@")) header = false;
    } else if (line.startsWith("+")) file.added.push(line.slice(1));
    else if (line.startsWith("-")) file.removed.push(line.slice(1));
  }
  return files;
}

/** A `---`/`+++` header's path: git adds a tab after a name with a space, and quotes an unusual one C-style. */
function headerPath(raw, prefix) {
  const name = raw.endsWith("\t") ? raw.slice(0, -1) : raw;
  if (name === "/dev/null") return null;
  const path = name.startsWith('"') && name.endsWith('"') ? unquote(name) : name;
  return prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

const ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** Git's C-style quoting undone: `\303\274` is the bytes of one UTF-8 letter. */
function unquote(quoted) {
  const bytes = [];
  const inner = quoted.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== "\\") {
      const point = String.fromCodePoint(inner.codePointAt(i));
      bytes.push(...Buffer.from(point, "utf8"));
      i += point.length - 1;
    } else if (/[0-7]{3}/.test(inner.slice(i + 1, i + 4))) {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      i += 1;
      bytes.push(ESCAPES[inner[i]] ?? inner.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * The lines under a markdown heading (`## Tests removed or weakened`, any level, a colon allowed),
 * up to the next heading outside a code fence; blank lines left out. No heading configured, no lines.
 */
export function sectionLines(text, heading) {
  if (!heading) return [];
  const want = heading.toLowerCase();
  const out = [];
  let inside = false;
  let fenced = false;
  for (const line of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    if (/^ {0,3}(```|~~~)/.test(line)) fenced = !fenced;
    // A `# …` line in a code fence is code (a shell comment), never a heading.
    const title = fenced ? null : line.match(/^ {0,3}#{1,6}\s+(.+?)\s*$/);
    if (title) inside = title[1].replace(/:$/, "").trim().toLowerCase() === want;
    else if (inside && line.trim()) out.push(line);
  }
  return out;
}

/**
 * Whether `line` names `path` as a whole word: not inside a longer path (`a.test.mjs.bak`,
 * `src/tests/a.test.mjs`), though a sentence's full stop after it is fine.
 */
export function namesPath(line, path) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w./-])${escaped}(?![\\w/-]|\\.\\w)`).test(line);
}

/** A reason in the commit message: the override heading's words, then the path named after them. */
function messageNames(message, heading, path) {
  const at = String(message ?? "").toLowerCase().indexOf(heading.toLowerCase());
  if (at < 0) return false;
  return String(message).slice(at + heading.length).split("\n").some((line) => namesPath(line, path));
}
