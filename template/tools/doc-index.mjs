// The indexes nobody writes by hand. A hand-kept index grows a little with
// every entry until each row is a paragraph (the implementation log's index
// reached 3,797 characters in one row); a generated one cannot drift or swell.
//
//   node tools/doc-index.mjs           rewrite every index that changed
//   node tools/doc-index.mjs --check   exit 1 if any index is out of date
//
// What it writes, and where, is tools/doc-config.mjs's GENERATED. Each index
// sits between `<!-- generated:start NAME … -->` and `<!-- generated:end NAME -->`
// in its target, so the target's own hand-written text stays as written.
// doc-check runs --check's logic, so a commit with a stale index is refused.
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";

import { DEVLOG, GENERATED, PHASES } from "./doc-config.mjs";
import { ROOT, bucketFor, devlogEntries, isMain, loadPhases, parseFrontmatter, read, write } from "./doc-lib.mjs";

const naturally = (a, b) => a.localeCompare(b, "en", { numeric: true });

/** A link from the index's own folder to a repo path, always with forward slashes. */
function link(target, path) {
  return relative(dirname(join(ROOT, target)), join(ROOT, path)).split("\\").join("/");
}

function title(text) {
  const heading = text.split("\n").find((line) => /^# /.test(line));
  return heading ? heading.replace(/^# /, "").trim() : "(no title)";
}

function markdownFiles(dir, out = []) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs).sort(naturally)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const rel = dir === "." ? name : posix.join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) markdownFiles(rel, out);
    else if (name.endsWith(".md")) out.push(rel);
  }
  return out;
}

// ------------------------------------------------------------- the generators

/** One line per numbered entry, newest first, grouped by the phase (or month) it was written in. */
function implementationLog({ target, dir }) {
  const phases = loadPhases(PHASES);
  const groups = new Map();
  const names = existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir)) : [];
  for (const name of names.filter((n) => /^\d{3}-.+\.md$/.test(n)).sort(naturally).reverse()) {
    const text = read(posix.join(dir, name));
    const number = name.slice(0, 3);
    const heading = title(text).replace(/^#\d+\s*[—-]\s*/, "");
    const ticket = text.match(/\*\*Ticket:\*\*\s*`?(#\d+)/)?.[1] ?? "—";
    const date = text.match(/\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
    const bucket = date ? bucketFor(date, phases) : null;
    const label = bucket ? bucket.label : "Current phase";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(`- [${number}](${link(target, posix.join(dir, name))}) · \`${ticket}\` · ${date || "no date"} · ${heading}`);
  }
  const out = [];
  for (const [label, rows] of groups) out.push(`### ${label}`, "", ...rows, "");
  return out.join("\n").trim();
}

/** The current devlog, then each archived phase or month: its entry range and end date. */
function devlogArchive({ target, dir }) {
  const phases = loadPhases(PHASES);
  const range = (text) => {
    const numbers = devlogEntries(text, new Set()).map((e) => Number(e.number));
    if (numbers.length === 0) return "no entries";
    const pad = (n) => String(n).padStart(3, "0");
    return `#${pad(Math.min(...numbers))}–#${pad(Math.max(...numbers))}, ${numbers.length} entries`;
  };
  // The current devlog is linked, never counted: a count would change with every commit.
  const out = [`- **Current phase**: [${posix.basename(DEVLOG)}](${link(target, DEVLOG)})`];
  for (const phase of [...phases].reverse()) {
    const file = posix.join(dir, `${phase.name}.md`);
    if (!existsSync(join(ROOT, file))) continue;
    out.push(`- [${phase.label}](${link(target, file)}) · ${range(read(file))} · until ${phase.until}`);
  }
  return out.join("\n");
}

/** Each gotcha file, at any depth, and under each file one line per ticket's block. */
function gotchas({ target, dir }) {
  const out = [];
  for (const file of markdownFiles(dir).filter((f) => posix.basename(f) !== "README.md")) {
    const text = read(file);
    out.push(`**[${title(text)}](${link(target, file)})**`);
    for (const line of text.split("\n")) {
      const block = line.match(/^\*\*`#(\d+)` — (.+?)(?: \((?:built|added)[^)]*\))?:\*\*\s*$/);
      if (block) out.push(`- \`#${block[1]}\` ${block[2]}`);
    }
    out.push("");
  }
  return out.join("\n").trim();
}

/** One line per handbook file: the periods in time order (PHASES), then any other file. */
function handbook({ target, dir }) {
  const order = loadPhases(PHASES).map((phase) => `${phase.name}.md`);
  const rank = (file) => {
    const at = order.indexOf(posix.basename(file));
    return at === -1 ? order.length : at;
  };
  return markdownFiles(dir)
    .filter((f) => posix.basename(f) !== "README.md")
    .sort((a, b) => rank(a) - rank(b) || naturally(a, b))
    .map((file) => `- [${title(read(file))}](${link(target, file)})`)
    .join("\n");
}

/** Every doc that carries a header, grouped by folder, with the job its header gives it. */
function docMap({ target }) {
  const files = [
    ...markdownFiles(".").filter((f) => !f.includes("/")),
    ...markdownFiles("docs"),
  ];
  const groups = new Map();
  // A folder with its own generated index lists its files there; the map lists only that index.
  const indexed = files
    .filter((f) => posix.basename(f) === "README.md" && f !== target && parseFrontmatter(read(f))?.kind === "generated")
    .map((f) => posix.dirname(f));
  for (const file of files) {
    if (file === target) continue;
    if (posix.basename(file) !== "README.md" && indexed.some((dir) => file.startsWith(`${dir}/`))) continue;
    if (/^docs\/_templates\/(?!README\.md$)/.test(file)) continue; // a template's header is a placeholder
    const header = parseFrontmatter(read(file));
    // A frozen record is listed by its folder's index, not one by one here.
    if (!header?.job || header.kind === "record") continue;
    const folder = file.includes("/") ? posix.dirname(file) : "(repository root)";
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(`- [${file}](${link(target, file)}) · *${header.kind ?? "?"}* · ${header.job}`);
  }
  const out = [];
  for (const [folder, rows] of [...groups].sort(([a], [b]) => naturally(a, b))) out.push(`### ${folder}`, "", ...rows, "");
  return out.join("\n").trim();
}

/**
 * One line per ADR, in number order: its status and what it supersedes or is superseded by. Read from the
 * ADR's header (`status`, `supersedes`, `superseded-by`) or, for an ADR without one, its `**Status:**` line.
 */
function adrIndex({ target, dir }) {
  const names = existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir)) : [];
  return names
    .filter((n) => /^\d{4}-.+\.md$/.test(n))
    .sort(naturally)
    .map((name) => {
      const text = read(posix.join(dir, name));
      const header = parseFrontmatter(text) ?? {};
      const status = header.status || (text.match(/\*\*Status:\*\*\s*([A-Za-z-]+)/)?.[1] ?? "?").toLowerCase();
      const links = [
        header.supersedes ? `supersedes ${header.supersedes}` : "",
        header["superseded-by"] ? `superseded by ${header["superseded-by"]}` : "",
        header["amended-by"] ? `amended by ${header["amended-by"]}` : "",
      ].filter(Boolean);
      return `- [${name.slice(0, 4)}](${link(target, posix.join(dir, name))}) · *${status}*${links.length ? ` (${links.join("; ")})` : ""} · ${title(text)}`;
    })
    .join("\n");
}

/**
 * One line per discovery doc, in number order: its title, when its rounds were held (its `**Rounds:**`
 * or `**Date:**` line), and its newest addendum's date, so a reader sees which docs changed since.
 */
function discovery({ target, dir }) {
  return markdownFiles(dir)
    .filter((f) => posix.basename(f) !== "README.md")
    .map((file) => {
      const text = read(file);
      const date = text.match(/^\*\*(?:Rounds|Date):\*\*[^\n]*?(\d{4}-\d{2}-\d{2})/m)?.[1] ?? "no date";
      const addendum = text.match(/^> \*\*Addendum (\d{4}-\d{2}-\d{2}):\*\*/m)?.[1];
      const name = posix.basename(file, ".md");
      return `- [${name.match(/^\d+/)?.[0] ?? name}](${link(target, file)}) · ${title(text)} · ${date} · ${addendum ? `latest addendum ${addendum}` : "no addendum"}`;
    })
    .join("\n");
}

/** The top-level bullets under a `## <heading>` (matched by its start), each joined onto one line. */
function bulletsUnder(text, heading) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## ${heading}`));
  if (start === -1) return [];
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2} /.test(line)) break;
    if (/^- /.test(line)) out.push(line.slice(2).trim());
    else if (/^\s+\S/.test(line) && out.length && !/^\s+- /.test(line)) out[out.length - 1] += ` ${line.trim()}`;
  }
  return out;
}

const clip = (text, max = 220) => ([...text].length > max ? `${[...text].slice(0, max - 1).join("").trimEnd()}…` : text);

/**
 * Every question still open, in one place: the register's unclosed `OPEN-nn` items, and the bullets
 * under each configured "waiting on the owner" heading. Each line links to where the item lives; it
 * is settled there, and leaves this list on the next run.
 */
function openItems({ target, register, lists = [] }) {
  const out = [];
  if (register && existsSync(join(ROOT, register))) {
    const lines = read(register).split("\n");
    const closed = new Set();
    const titles = new Map();
    lines.forEach((line, index) => {
      const item = line.match(/^\*\*OPEN-(\d+)\b(.*)$/);
      if (!item) return;
      const head = `${line} ${lines[index + 1] ?? ""}`;
      if (/CLOSED/.test(head)) closed.add(item[1]);
      if (!/\(original\)/.test(line) && !titles.has(item[1])) {
        titles.set(item[1], item[2].replace(/^\s*[—-]\s*/, "").replace(/\*\*/g, "").replace(/⚠.*$/, "").trim());
      }
    });
    const open = [...titles].filter(([n]) => !closed.has(n));
    out.push(`### Unsettled in the model — [\`${posix.basename(register)}\`](${link(target, register)}) §5`, "");
    out.push(...(open.length ? open.map(([n, t]) => `- **OPEN-${n}** ${clip(t)}`) : ["- None."]), "");
  }
  for (const { files, heading } of lists) {
    for (const file of files.flatMap((f) => (f.endsWith("/") ? markdownFiles(f.slice(0, -1)) : [f]))) {
      if (!existsSync(join(ROOT, file))) continue;
      const bullets = bulletsUnder(read(file), heading);
      if (bullets.length === 0) continue;
      out.push(`### ${heading} — [\`${file}\`](${link(target, file)})`, "", ...bullets.map((b) => `- ${clip(b)}`), "");
    }
  }
  return out.join("\n").trim();
}

export const GENERATORS = {
  "adr-index": adrIndex,
  discovery,
  "open-items": openItems,
  "implementation-log": implementationLog,
  "devlog-archive": devlogArchive,
  gotchas,
  handbook,
  "doc-map": docMap,
};

// ------------------------------------------------------------ the marked block

function blockPattern(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(<!-- generated:start ${escaped}\\b[^>]*-->\\n)([\\s\\S]*?)(<!-- generated:end ${escaped} -->)`);
}

/** Every configured index whose target exists and carries its markers. */
function plans() {
  const out = [];
  for (const entry of GENERATED) {
    if (!existsSync(join(ROOT, entry.target))) continue;
    const text = read(entry.target);
    const match = text.match(blockPattern(entry.name));
    if (!match) continue;
    const build = GENERATORS[entry.name];
    if (!build) throw new Error(`tools/doc-config.mjs names an index "${entry.name}" that tools/doc-index.mjs has no generator for.`);
    const content = build(entry);
    const next = text.replace(blockPattern(entry.name), (_, start, __, end) => `${start}${content}\n${end}`);
    out.push({ ...entry, current: text, next });
  }
  return out;
}

/** The indexes that differ from what the generator would write now. */
export function staleIndexes() {
  return plans()
    .filter((plan) => plan.current !== plan.next)
    .map((plan) => `${plan.target}: the "${plan.name}" index is out of date. Run: node tools/doc-index.mjs`);
}

export function writeIndexes() {
  const written = [];
  for (const plan of plans()) {
    if (plan.current === plan.next) continue;
    write(plan.target, plan.next);
    written.push(plan.target);
  }
  return written;
}

function main() {
  if (process.argv.includes("--check")) {
    const stale = staleIndexes();
    if (stale.length === 0) return console.log("doc-index: every index is up to date.");
    for (const line of stale) console.error(`  - ${line}`);
    process.exit(1);
  }
  const written = writeIndexes();
  console.log(written.length ? `doc-index: rewrote ${written.join(", ")}.` : "doc-index: every index is up to date.");
}

if (isMain(import.meta.url)) main();
