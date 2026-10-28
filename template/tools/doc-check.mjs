// The mechanical half of the doc-sync skill (the Brigade plugin): the
// checks that used to be greps a session ran from memory. No tokens, no
// network, a second or two.
//
//   node tools/doc-check.mjs                    stale phrases, missing paths, headers and budgets, stale indexes,
//                                               a rewritten discovery doc, an unguarded prototype folder,
//                                               a roadmap table out of format
//   node tools/doc-check.mjs --head             + the devlog's top entry matches HEAD's commit
//   node tools/doc-check.mjs --message-file F   + the devlog's top entry matches a commit about to be made
//   node tools/doc-check.mjs --message TEXT     the same, for a message given inline
//   node tools/doc-check.mjs --update-baseline  accept every current stale-phrase / missing-path hit (attended sessions only)
//   node tools/doc-check.mjs --adopt            the same, and accept every doc now without a header (setup, once)
//   node tools/doc-check.mjs --report           each budgeted doc's size against its limit, fullest first
//
// A change that raises a doc's budget is printed; inside a phase run it is refused.
//
// A hit is not always drift: a doc may quote a stale phrase to teach it, or
// name a deleted file to say it is gone. Such lines are recorded in
// tools/doc-check-baseline.json, so only a NEW hit fails. A line that is
// edited leaves the baseline and is read again, which is the point. The
// baseline's own "note" says how far its first set of lines was audited.
// Budgets have no baseline: a doc over its header's limit is trimmed, or its
// header's limit is raised, where the diff shows it.
//
// A repo that adopts the workflow with docs of its own has docs with no
// header. /setup-workflow lists them once (--adopt) in the baseline's
// "headers"; after that the list only shrinks: --update-baseline drops a file
// once it has a header, and never adds one, so a new doc still needs a header.
//
// Historical records (the devlog's archive, the numbered implementation log,
// docs/adr, docs/research, the discovery rounds) are left as written and are
// not scanned for phrases or paths. Every path is named in tools/doc-config.mjs.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";

import {
  DEVLOG,
  DEVLOG_TAGGED_FROM,
  DEVLOG_TYPES,
  HEADER_EXEMPT,
  HEADER_REQUIRED,
  LIVE_DOCS,
  PATH_EXTENSIONS,
  PATH_ROOTS,
  STATUS_DOCS,
} from "./doc-config.mjs";
import * as docConfig from "./doc-config.mjs";
import { staleIndexes } from "./doc-index.mjs";
import { parseRoadmap } from "./roadmap-format.mjs";
import { ROOT, budgetProblems, citedDevlogNumbers, devlogEntries, git, isMain, parseFrontmatter, read } from "./doc-lib.mjs";

const BASELINE_PATH = join(ROOT, "tools", "doc-check-baseline.json");
/** Optional, since 0.3.0: a config written before then has no DISCOVERY_DIR and gets the default. */
const DISCOVERY_DIR = docConfig.DISCOVERY_DIR ?? "docs/discovery";
/** Optional, since 0.3.0: where the prototypes live, or null for a project with none yet. */
const PROTOTYPE_DIR = docConfig.PROTOTYPE_DIR ?? null;
const PROTOTYPE_GUARD = "brigade:prototype-guard";
/** Optional, since 0.3.0: the roadmap, whose tables /roadmap reads (tools/roadmap-format.mjs). */
const ROADMAP = docConfig.ROADMAP ?? "docs/status/roadmap.md";

const STALE_PHRASES = [
  "not yet committed",
  "awaiting the commit go-ahead",
  "not pushed yet",
  "not yet pushed",
  "uncommitted",
  "not yet decided",
  "⚠ OPEN-",
];
// "still open" was on the old grep's list and is deliberately not here: it
// matched a cash drawer, a browser tab and "still opens" far more often than
// a stale decision. An undecided-then-decided item is a reversal, which a
// phrase list cannot catch anyway (doc-sync SKILL.md, §2).

/** A repo path a doc cites: one of the project's top-level folders, then a file of a known type. No folders, no check. */
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATH_PATTERN =
  PATH_ROOTS.length && PATH_EXTENSIONS.length
    ? new RegExp(
        String.raw`(?<![A-Za-z0-9._/-])(?:${PATH_ROOTS.map(escape).join("|")})\/[A-Za-z0-9._/-]+\.(?:${PATH_EXTENSIONS.map(escape).join("|")})\b`,
        "g",
      )
    : null;

/** `[text](target)` or `[text](target#anchor)`: the target, without its anchor. */
const MARKDOWN_LINK = /\]\(([^)\s#]+)(?:#[^)\s]*)?\)/g;

function walk(rel, out) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return;
  if (statSync(abs).isFile()) {
    if (/\.(md|html)$/.test(rel)) out.push(rel);
    return;
  }
  for (const name of readdirSync(abs)) {
    if (name === "node_modules" || name === "archive") continue;
    walk(`${rel}/${name}`, out);
  }
}

function liveFiles() {
  const out = [];
  for (const entry of LIVE_DOCS) walk(entry, out);
  return [...new Set(out)].sort();
}

/** HEADER_REQUIRED entries are files or folders; a folder covers every .md under it. */
function requiredHeaderFiles() {
  const out = [];
  for (const entry of HEADER_REQUIRED) walk(entry, out);
  return out.filter((file) => file.endsWith(".md"));
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return { stale: {}, missing: {}, headers: [] };
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  return { stale: parsed.stale ?? {}, missing: parsed.missing ?? {}, headers: parsed.headers ?? [] };
}

function loadBaselineNote() {
  if (!existsSync(BASELINE_PATH)) return "";
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")).note ?? "";
}

function scan() {
  const stale = {};
  const missing = {};
  for (const file of liveFiles()) {
    const lines = read(file).split("\n");
    lines.forEach((raw, index) => {
      const line = raw.trim();
      if (STATUS_DOCS.test(file) && STALE_PHRASES.some((phrase) => line.includes(phrase))) {
        (stale[file] ??= []).push({ line: index + 1, text: line });
      }
      for (const match of PATH_PATTERN ? line.matchAll(PATH_PATTERN) : []) {
        const path = match[0];
        // A pattern, not a path: `docs/guides/module-N.md`, `NNN-*.md`, `001-...md`.
        if (/(^|[/_-])N([-_.]|$)|NNN|\.\.\./.test(path)) continue;
        if (existsSync(join(ROOT, path))) continue;
        (missing[file] ??= []).push({ line: index + 1, text: path, repoPath: path });
      }
      // A relative markdown link, read from the file's own folder: the first thing a move breaks.
      if (!file.endsWith(".md")) return;
      for (const match of line.matchAll(MARKDOWN_LINK)) {
        const target = match[1];
        if (/^([a-z][a-z0-9+.-]*:|\/|<)/i.test(target)) continue;
        const repoPath = posix.normalize(posix.join(posix.dirname(file), decodeURI(target)));
        if (existsSync(join(ROOT, repoPath))) continue;
        (missing[file] ??= []).push({ line: index + 1, text: `](${target})`, repoPath });
      }
    });
  }
  return { stale, missing: withoutIgnored(missing) };
}

/**
 * A path git ignores is local-only by design (scripts/ is kept out of the repo): it exists on the
 * machine that wrote the doc and nowhere else, so its absence in a fresh clone or in CI is not drift.
 */
function withoutIgnored(missing) {
  const paths = [...new Set(Object.values(missing).flatMap((hits) => hits.map((hit) => hit.repoPath)))];
  if (paths.length === 0) return missing;
  let ignored = new Set();
  try {
    ignored = new Set(git(["check-ignore", "--no-index", "--stdin"], paths.join("\n")).split("\n").filter(Boolean));
  } catch {
    ignored = new Set(); // check-ignore exits 1 when none of them is ignored
  }
  const kept = {};
  for (const [file, hits] of Object.entries(missing)) {
    const real = hits.filter((hit) => !ignored.has(hit.repoPath));
    if (real.length) kept[file] = real;
  }
  return kept;
}

/** Every doc's header against its own text: a missing header where one is required, and every budget broken. */
/** Every doc held to a header: the live docs, the required folders and the devlog, less the exempt. */
function headeredFiles() {
  const required = new Set(requiredHeaderFiles());
  const files = [...new Set([...liveFiles(), ...required, DEVLOG])]
    .filter((f) => f.endsWith(".md") && existsSync(join(ROOT, f)))
    .filter((f) => !HEADER_EXEMPT.some((pattern) => pattern.test(f)))
    .sort();
  return { files, required };
}

/** Docs that must have a header and have none. */
function headerless() {
  const { files, required } = headeredFiles();
  return files.filter((file) => required.has(file) && !parseFrontmatter(read(file)));
}

function headerProblems(accepted = new Set()) {
  const problems = [];
  const { files, required } = headeredFiles();
  for (const file of files) {
    const text = read(file);
    if (!parseFrontmatter(text)) {
      if (required.has(file) && !accepted.has(file)) {
        problems.push(`${file}: has no header. Open it with --- job / kind / budget --- (see docs/_templates/).`);
      }
      continue;
    }
    problems.push(...budgetProblems(file, text));
  }
  return problems;
}

/**
 * Every budget a change raises, against `base` (HEAD for a commit about to be made, HEAD~1 for the
 * last one). Raising a limit is a deliberate choice the owner makes, so inside a phase run it is
 * refused; elsewhere it is printed, so the diff's reviewer sees it.
 */
function budgetRaises(base) {
  const raises = [];
  for (const file of headeredFiles().files) {
    const now = parseFrontmatter(read(file)) ?? {};
    let before = {};
    try {
      before = parseFrontmatter(git(["show", `${base}:${file}`])) ?? {};
    } catch {
      continue; // a new file: its first budget is not a raise
    }
    for (const key of ["max-lines", "max-line-length", "max-entry-lines"]) {
      const was = before[key];
      const is = now[key];
      if (typeof was === "number" && (typeof is !== "number" || is > was)) {
        raises.push(`${file}: ${key} raised from ${was} to ${typeof is === "number" ? is : "no limit"}.`);
      }
    }
  }
  return raises;
}

/**
 * A discovery doc in three parts: its title line, its addendum block (the quoted and blank lines right
 * under the title), and its body, everything after.
 */
function discoveryParts(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const at = lines.findIndex((line) => /^# /.test(line));
  if (at === -1) return { head: "", addenda: "", body: lines.join("\n") };
  let end = at + 1;
  while (end < lines.length && (lines[end].trim() === "" || lines[end].startsWith(">"))) end += 1;
  return { head: lines.slice(0, at + 1).join("\n"), addenda: lines.slice(at + 1, end).join("\n").trim(), body: lines.slice(end).join("\n") };
}

/**
 * Every committed discovery doc (at `base`) that a change rewrote: a line of its title or body changed,
 * an earlier addendum edited, or the doc deleted. A new addendum on top is the only change allowed, so
 * the doc keeps what was first decided. A rename that keeps the text is allowed.
 */
function discoveryRewrites(base) {
  let committed;
  try {
    committed = git(["ls-tree", "-r", "--name-only", base, "--", DISCOVERY_DIR]).split("\n");
  } catch {
    return []; // no commit yet, or no discovery folder in it
  }
  committed = committed.filter((f) => f.endsWith(".md") && posix.basename(f) !== "README.md");
  const present = [];
  walk(DISCOVERY_DIR, present);
  const problems = [];
  for (const file of committed) {
    const before = discoveryParts(git(["show", `${base}:${file}`]));
    if (!existsSync(join(ROOT, file))) {
      const moved = present.some((other) => {
        const after = discoveryParts(read(other));
        return !committed.includes(other) && after.head === before.head && after.body === before.body;
      });
      if (!moved) problems.push(`${file}: a discovery doc was deleted. Discovery docs are records: a fact that no longer holds gets a dated addendum, the doc stays.`);
      continue;
    }
    const after = discoveryParts(read(file));
    if (after.head !== before.head || after.body !== before.body) {
      problems.push(
        `${file}: a line below its addendum block changed. A discovery doc is never rewritten: put the new fact, or the correction, in a dated addendum under its title ("> **Addendum YYYY-MM-DD:** …"), and restore the line.`,
      );
    } else if (!after.addenda.endsWith(before.addenda)) {
      problems.push(`${file}: an earlier addendum changed. Leave it as written and add a new addendum above it.`);
    }
  }
  return problems;
}

/**
 * The prototype folder, when it exists, must hold its guard: a file directly in it carrying the
 * `brigade:prototype-guard` marker, the code that hides every prototype screen from a production
 * build. The project's own test proves the guard works; this proves nobody removed it.
 */
function prototypeGuardProblems() {
  if (!PROTOTYPE_DIR || !existsSync(join(ROOT, PROTOTYPE_DIR))) return [];
  const guarded = readdirSync(join(ROOT, PROTOTYPE_DIR)).some((name) => {
    const path = join(ROOT, PROTOTYPE_DIR, name);
    return statSync(path).isFile() && readFileSync(path, "utf8").includes(PROTOTYPE_GUARD);
  });
  if (guarded) return [];
  return [
    `${PROTOTYPE_DIR}/: the prototype folder has no guard. A file directly in it (its layout) must hide every prototype screen from a production build and carry the marker "${PROTOTYPE_GUARD}" in a comment.`,
  ];
}

/** Each budgeted doc's size against its limit, fullest first: the warning before a commit is refused. */
function healthReport() {
  const rows = [];
  for (const file of headeredFiles().files) {
    const text = read(file);
    const header = parseFrontmatter(text) ?? {};
    const limit = header["max-lines"];
    if (typeof limit !== "number") continue;
    const lines = text.replace(/\n$/, "").split("\n").length;
    rows.push({ file, lines, limit, pct: Math.round((lines / limit) * 100), closed: header.growth === "closed" });
  }
  rows.sort((a, b) => b.pct - a.pct || a.file.localeCompare(b.file));
  const width = Math.max(...rows.map((r) => r.file.length), 4);
  const row = (r, flag = "") =>
    `${r.file.padEnd(width)}  ${String(r.lines).padStart(5)} / ${String(r.limit).padEnd(6)}  ${String(r.pct).padStart(3)}%${flag}`;
  const out = [`${"Doc".padEnd(width)}  Lines / budget   Used`];
  for (const r of rows.filter((x) => !x.closed)) {
    out.push(row(r, r.pct >= 100 ? "  over: trim it" : r.pct >= 90 ? "  near the limit: trim before it blocks" : ""));
  }
  const closed = rows.filter((x) => x.closed);
  if (closed.length) {
    out.push("", `Closed (growth: closed — a finished period; it may only shrink): ${closed.length} files`);
    for (const r of closed) out.push(row(r));
  }
  return out.join("\n");
}

/**
 * Live docs that cite an ADR its own header marks superseded: a pointer to a decision that no longer
 * holds. A note, not a failure: the citing line may be telling that very history.
 */
function supersededCitations() {
  const dir = "docs/adr";
  if (!existsSync(join(ROOT, dir))) return [];
  const superseded = new Map();
  for (const name of readdirSync(join(ROOT, dir))) {
    if (!/^\d{4}-.+\.md$/.test(name)) continue;
    const header = parseFrontmatter(read(`${dir}/${name}`));
    if (header?.status === "superseded") superseded.set(name.slice(0, 4), header["superseded-by"] || "a later ADR");
  }
  const notes = [];
  if (superseded.size === 0) return notes;
  for (const file of liveFiles()) {
    read(file)
      .split("\n")
      .forEach((line, index) => {
        for (const match of line.matchAll(/adr\/(\d{4})\b/g)) {
          const by = superseded.get(match[1]);
          if (by && !line.includes(`adr/${String(by).slice(0, 4)}`)) {
            notes.push(`${file}:${index + 1} cites adr/${match[1]}, which is superseded by ${by}.`);
          }
        }
      });
  }
  return notes;
}

/** The devlog's top entry, read against a commit message. */
function checkDevlogAgainst(message, { requireOpen }) {
  const problems = [];
  if (/^Merge (branch|pull request|remote-tracking)/.test(message.trimStart())) return problems;
  if (!existsSync(join(ROOT, DEVLOG))) return [`${DEVLOG} does not exist.`];
  const [top] = devlogEntries(read(DEVLOG), citedDevlogNumbers());
  if (!top) return [`${DEVLOG} has no \`## #NNN\` entry.`];
  if (Number(top.number) >= DEVLOG_TAGGED_FROM) {
    const tagged = top.heading.match(/^## #\d+ · (\S+) · \S/);
    if (!tagged) {
      problems.push(`${DEVLOG}'s top entry heading must read "## #${top.number} · <type> · <title>": ${top.heading.slice(0, 120)}`);
    } else if (!DEVLOG_TYPES.includes(tagged[1])) {
      problems.push(`${DEVLOG}'s top entry has the type "${tagged[1]}"; use one of ${DEVLOG_TYPES.join(", ")}.`);
    }
  }
  const cited = [...message.matchAll(/devlog #(\d+)\b/gi)].map((m) => String(Number(m[1])));
  if (cited.length === 0) {
    problems.push(`The commit message names no devlog entry (expected "devlog #${top.number}").`);
  } else if (!cited.includes(top.number)) {
    problems.push(`The commit message cites devlog #${cited.join(", #")}, but the devlog's top entry is #${top.number}.`);
  }
  if (requireOpen && !top.open) {
    problems.push(`The devlog's top entry (#${top.number}) already belongs to an earlier commit. This commit needs its own new entry.`);
  }
  return problems;
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const valueOf = (name) => {
    const at = args.indexOf(name);
    return at === -1 ? null : args[at + 1];
  };

  if (flag("--report")) {
    console.log(healthReport());
    return;
  }

  const found = scan();

  const adopt = flag("--adopt");
  if (adopt || flag("--update-baseline")) {
    if (process.env.PHASE_RUN === "1") {
      console.error("doc-check: the baseline is never updated inside a phase run. Fix the line instead.");
      process.exit(1);
    }
    const next = { note: loadBaselineNote(), stale: {}, missing: {} };
    for (const kind of ["stale", "missing"]) {
      for (const [file, hits] of Object.entries(found[kind])) {
        next[kind][file] = [...new Set(hits.map((hit) => hit.text))].sort();
      }
    }
    // Adopting lists every header-less doc; an update only keeps the listed ones still without one.
    const without = headerless();
    const kept = new Set(loadBaseline().headers);
    const headers = adopt ? without : without.filter((file) => kept.has(file));
    if (headers.length) next.headers = headers;
    writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`doc-check: baseline written (${BASELINE_PATH}).`);
    return;
  }

  const baseline = loadBaseline();
  const failures = [];

  for (const [kind, label] of [
    ["stale", "reads as stale"],
    ["missing", "names a file that does not exist"],
  ]) {
    for (const [file, hits] of Object.entries(found[kind])) {
      const known = new Set(baseline[kind][file] ?? []);
      for (const hit of hits) {
        if (known.has(hit.text)) continue;
        failures.push(`${file}:${hit.line} ${label}: ${hit.text.slice(0, 180)}`);
      }
    }
  }

  failures.push(...headerProblems(new Set(baseline.headers)));
  failures.push(...staleIndexes());
  failures.push(...discoveryRewrites(flag("--head") ? "HEAD~1" : "HEAD"));
  failures.push(...prototypeGuardProblems());
  // The roadmap's tables, once it has them: the format /roadmap and its page read.
  if (existsSync(join(ROOT, ROADMAP))) failures.push(...parseRoadmap(read(ROADMAP)).problems.map((problem) => `${ROADMAP}:${problem}`));

  const raises = budgetRaises(flag("--head") ? "HEAD~1" : "HEAD");
  if (process.env.PHASE_RUN === "1") {
    for (const raise of raises) failures.push(`${raise} A phase run never raises a budget: trim the doc instead.`);
  } else {
    for (const raise of raises) console.log(`  note: ${raise} Raising a budget is the owner's call.`);
  }

  if (flag("--head")) {
    const message = git(["log", "-1", "--format=%B"]);
    const files = git(["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean);
    const problems = checkDevlogAgainst(message, { requireOpen: false });
    const isMerge = /^Merge /.test(message.trimStart());
    if (!isMerge && !files.includes(DEVLOG)) {
      problems.push(`HEAD's commit does not touch ${DEVLOG}. Every commit gets a devlog entry.`);
    }
    failures.push(...problems);
  }

  const messageFile = valueOf("--message-file");
  const messageText = valueOf("--message");
  if (messageFile || messageText) {
    const message = messageFile ? readFileSync(messageFile, "utf8") : messageText;
    failures.push(...checkDevlogAgainst(message, { requireOpen: !flag("--amend") }));
  }

  const notes = supersededCitations();
  for (const note of notes) console.log(`  note: ${note}`);
  if (failures.length === 0) {
    console.log("doc-check: clean.");
    return;
  }
  console.error(`doc-check: ${failures.length} problem(s).\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    "\nFix each line. If a stale phrase or a missing path is correct as written (it quotes the phrase, or says the " +
      "file is gone), an attended session records it with: node tools/doc-check.mjs --update-baseline",
  );
  process.exit(1);
}

if (isMain(import.meta.url)) main();
