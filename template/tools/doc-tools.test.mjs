// Tests for the doc tools (doc-check, doc-index, doc-rotate). Plain node:test:
// no database, no network. Run: pnpm test:docs (node --test tools/doc-tools.test.mjs).
//
// The pure helpers are tested directly. The commit-time behaviour is tested
// end to end in a throwaway git repository holding a copy of tools/ and a
// small doc-config.mjs of its own, so nothing here touches this repo's docs.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { planRotation } from "./doc-rotate.mjs";
import { bucketFor, budgetProblems, devlogEntries, parseFrontmatter } from "./doc-lib.mjs";

const TOOLS = dirname(fileURLToPath(import.meta.url));

test("a header is read as a flat key: value list, numbers as numbers", () => {
  const header = parseFrontmatter("---\njob: Where things stand.\nkind: living\nmax-lines: 120\n---\n# Roadmap\n");
  assert.deepEqual(header, { job: "Where things stand.", kind: "living", "max-lines": 120 });
  assert.equal(parseFrontmatter("# No header\n"), null);
});

test("a doc over its line budget is named, with the way out", () => {
  const text = `---\njob: x\nkind: living\nmax-lines: 6\n---\n# T\none\ntwo\n`;
  const [problem] = budgetProblems("docs/x.md", text);
  assert.match(problem, /8 lines, over its max-lines of 6/);
  assert.match(problem, /raise the limit in its header/);
  assert.deepEqual(budgetProblems("docs/x.md", `---\njob: x\nkind: living\nmax-lines: 8\n---\n# T\none\ntwo\n`), []);
});

test("a line over the length budget is named by its line number", () => {
  const text = `---\njob: x\nkind: living\nmax-line-length: 10\n---\nshort\n${"y".repeat(11)}\n`;
  const problems = budgetProblems("docs/x.md", text);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /docs\/x\.md:7 is 11 characters/);
});

test("an entry over the per-entry budget is named; the separator line does not count", () => {
  const entry = (n, lines) => [`## #${n} · docs · t`, ...Array.from({ length: lines }, () => "- x"), "", "---", ""].join("\n");
  const text = `---\njob: x\nkind: log\nmax-entry-lines: 4\n---\n# Devlog\n\n${entry(2, 3)}${entry(1, 5)}`;
  const problems = budgetProblems("docs/devlog.md", text);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"## #1 · docs · t" is 6 lines/);
});

test("a header with no job or an unknown kind is refused", () => {
  const problems = budgetProblems("docs/x.md", "---\nkind: diary\n---\n");
  assert.equal(problems.length, 2);
});

test("an entry is open until a commit cites it; an old entry with its hash in the heading is closed", () => {
  const text = ["# Devlog", "", "## #340 · feat · new", "x", "", "## #339 · docs · cited", "x", "", "## #338 — 90c5200 — old", "x", ""].join("\n");
  const entries = devlogEntries(text, new Set(["339"]));
  assert.deepEqual(
    entries.map((e) => [e.number, e.open]),
    [
      ["340", true],
      ["339", false],
      ["338", false],
    ],
  );
  assert.equal(devlogEntries("## #337 — uncommitted — x\n", new Set())[0].open, true);
});

test("a date falls in the first bucket whose end is on or after it; past the last, the current phase", () => {
  const phases = [
    { name: "2026-09", label: "September 2026", until: "2026-09-30" },
    { name: "6f", label: "Phase 6F", until: "2026-10-25" },
  ];
  assert.equal(bucketFor("2026-09-30", phases).name, "2026-09");
  assert.equal(bucketFor("2026-10-01", phases).name, "6f");
  assert.equal(bucketFor("2026-10-26", phases), null);
});

test("a rotation moves the closed entries and keeps the preamble and the open one", () => {
  const text = ["# Devlog", "", "How to write one.", "", "---", "", "## #12 · feat · open", "a", "", "---", "", "## #11 · fix · done", "b", "", "---", ""].join("\n");
  const plan = planRotation(text, new Set(["11"]));
  assert.deepEqual(plan.moving, ["11"]);
  assert.deepEqual(plan.staying, ["12"]);
  assert.match(plan.devlog, /^# Devlog\n\nHow to write one\.\n\n---\n\n## #12 · feat · open/);
  assert.doesNotMatch(plan.devlog, /#11/);
  assert.match(plan.archived, /^## #11 · fix · done\nb\n\n---$/);
});

// ------------------------------------------------------------------ end to end

const CONFIG = `
export const DEVLOG = "docs/devlog.md";
export const DEVLOG_ARCHIVE = "docs/devlog";
export const PHASES = "docs/devlog/phases.json";
export const LIVE_DOCS = ["docs/roadmap.md"];
export const STATUS_DOCS = /^docs\\/roadmap\\.md$/;
export const PATH_ROOTS = ["docs", "scripts", "tools"];
export const PATH_EXTENSIONS = ["md", "ts", "mjs"];
export const HEADER_REQUIRED = ["docs"];
export const HEADER_EXEMPT = [/^docs\\/devlog\\//];
export const GENERATED = [{ name: "devlog-archive", target: "docs/devlog/README.md", dir: "docs/devlog" }];
export const DEVLOG_TYPES = ["feat", "fix", "docs", "chore"];
export const DEVLOG_TAGGED_FROM = 1;
`;

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "doc-tools-"));
  mkdirSync(join(dir, "tools"));
  for (const name of ["doc-check.mjs", "doc-index.mjs", "doc-rotate.mjs", "doc-lib.mjs"]) copyFileSync(join(TOOLS, name), join(dir, "tools", name));
  writeFileSync(join(dir, "tools", "doc-config.mjs"), CONFIG);
  mkdirSync(join(dir, "docs", "devlog"), { recursive: true });
  writeFileSync(join(dir, "docs", "roadmap.md"), "---\njob: Where things stand.\nkind: living\nmax-lines: 20\n---\n# Roadmap\n");
  writeFileSync(join(dir, "docs", "devlog", "README.md"), "# Archive\n\n<!-- generated:start devlog-archive -->\n<!-- generated:end devlog-archive -->\n");
  writeFileSync(join(dir, "docs", "devlog.md"), "---\njob: The timeline.\nkind: log\nmax-entry-lines: 15\n---\n# Devlog\n\n## #1 · chore · start\n- the repo\n\n---\n");
  const run = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  run("init", "-q");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "T");
  spawnSync(process.execPath, ["tools/doc-index.mjs"], { cwd: dir });
  run("add", "-A");
  run("commit", "-q", "-m", "chore: start — devlog #1");
  const node = (script, ...args) => spawnSync(process.execPath, [`tools/${script}`, ...args], { cwd: dir, encoding: "utf8" });
  const addEntry = (n, type, lines = 1) => {
    const path = join(dir, "docs", "devlog.md");
    const text = readFileSync(path, "utf8");
    const entry = [`## #${n} · ${type} · work`, ...Array.from({ length: lines }, () => "- x"), "", "---", ""].join("\n");
    writeFileSync(path, text.replace("# Devlog\n\n", `# Devlog\n\n${entry}`));
  };
  return { dir, run, node, addEntry };
}

test("a commit must cite the devlog's open top entry, and a closed one cannot be reused", () => {
  const { run, node, addEntry } = repo();
  assert.equal(node("doc-check.mjs", "--head").status, 0);
  // Reusing #1, which the first commit already cited:
  assert.match(node("doc-check.mjs", "--message", "feat: more — devlog #1").stderr, /already belongs to an earlier commit/);
  addEntry(2, "feat");
  assert.match(node("doc-check.mjs", "--message", "feat: more").stderr, /names no devlog entry/);
  assert.match(node("doc-check.mjs", "--message", "feat: more — devlog #3").stderr, /top entry is #2/);
  assert.equal(node("doc-check.mjs", "--message", "feat: more — devlog #2").status, 0);
  run("commit", "-q", "-am", "feat: more — devlog #2");
  assert.equal(node("doc-check.mjs", "--head").status, 0);
  // An amend keeps citing the entry its commit already closed:
  assert.equal(node("doc-check.mjs", "--message", "feat: more, reworded — devlog #2", "--amend").status, 0);
});

test("a top entry without its type tag, or with an unknown one, is refused", () => {
  const { node, addEntry } = repo();
  addEntry(2, "party");
  assert.match(node("doc-check.mjs", "--message", "x — devlog #2").stderr, /type "party"/);
});

test("an over-budget doc, a missing header and a stale index each fail the check", () => {
  const { dir, node, addEntry } = repo();
  addEntry(2, "feat", 20);
  assert.match(node("doc-check.mjs").stderr, /over its max-entry-lines of 15/);
  writeFileSync(join(dir, "docs", "devlog.md"), readFileSync(join(dir, "docs", "devlog.md"), "utf8").replace(/(- x\n){20}/, "- x\n"));
  writeFileSync(join(dir, "docs", "roadmap.md"), "# Roadmap, no header\n");
  assert.match(node("doc-check.mjs").stderr, /docs\/roadmap\.md: has no header/);
  writeFileSync(join(dir, "docs", "roadmap.md"), "---\njob: Where things stand.\nkind: living\nmax-lines: 20\n---\n# Roadmap\n");
  writeFileSync(join(dir, "docs", "devlog", "README.md"), "# Archive\n\n<!-- generated:start devlog-archive -->\nhand-edited\n<!-- generated:end devlog-archive -->\n");
  assert.match(node("doc-check.mjs").stderr, /index is out of date\. Run: node tools\/doc-index\.mjs/);
  assert.equal(node("doc-index.mjs").status, 0);
  assert.equal(node("doc-check.mjs").status, 0);
});

test("a rotation archives the closed entries, lists the phase, and regenerates the index", () => {
  const { dir, run, node, addEntry } = repo();
  addEntry(2, "feat");
  run("commit", "-q", "-am", "feat: built — devlog #2");
  addEntry(3, "docs"); // open: no commit cites it yet
  const rotated = node("doc-rotate.mjs", "--phase", "6g", "--label", "Phase 6G — Payroll");
  assert.equal(rotated.status, 0, rotated.stderr);
  const devlog = readFileSync(join(dir, "docs", "devlog.md"), "utf8");
  assert.match(devlog, /## #3 · docs/);
  assert.doesNotMatch(devlog, /## #2 |## #1 /);
  const archive = readFileSync(join(dir, "docs", "devlog", "6g.md"), "utf8");
  assert.match(archive, /kind: record/);
  assert.match(archive, /## #2 · feat[\s\S]*## #1 · chore/);
  const phases = JSON.parse(readFileSync(join(dir, "docs", "devlog", "phases.json"), "utf8"));
  assert.equal(phases[0].name, "6g");
  assert.match(readFileSync(join(dir, "docs", "devlog", "README.md"), "utf8"), /\[Phase 6G — Payroll\]\(6g\.md\) · #001–#002, 2 entries/);
  assert.equal(node("doc-check.mjs").status, 0);
  assert.match(node("doc-rotate.mjs", "--phase", "6g").stderr, /already exists/);
});

test("the open-items and ADR indexes read the register, the owner's lists and each ADR's header", () => {
  const dir = mkdtempSync(join(tmpdir(), "doc-index-"));
  mkdirSync(join(dir, "tools"));
  for (const name of ["doc-index.mjs", "doc-lib.mjs"]) copyFileSync(join(TOOLS, name), join(dir, "tools", name));
  writeFileSync(
    join(dir, "tools", "doc-config.mjs"),
    [
      'export const DEVLOG = "docs/devlog.md";',
      'export const PHASES = "docs/phases.json";',
      "export const GENERATED = [",
      '  { name: "open-items", target: "docs/open.md", register: "docs/model.md", lists: [{ files: ["docs/handoff.md"], heading: "Waiting on the owner" }] },',
      '  { name: "adr-index", target: "docs/adr/README.md", dir: "docs/adr" },',
      "];",
    ].join("\n"),
  );
  mkdirSync(join(dir, "docs", "adr"), { recursive: true });
  const marked = (name) => `# T\n\n<!-- generated:start ${name} -->\n<!-- generated:end ${name} -->\n`;
  writeFileSync(join(dir, "docs", "open.md"), marked("open-items"));
  writeFileSync(join(dir, "docs", "adr", "README.md"), marked("adr-index"));
  writeFileSync(
    join(dir, "docs", "model.md"),
    ["**OPEN-01 — Settled thing.** ✅ **CLOSED.**", "", "**OPEN-02 — Still a question.**", "", "**OPEN-03 — Closed on the next", "line.** ✅ **CLOSED**"].join("\n"),
  );
  writeFileSync(join(dir, "docs", "handoff.md"), "# H\n\n## Waiting on the owner\n\n- **Close spec #9**\n  by hand.\n  - a sub-point\n\n## Next\n\n- not this\n");
  writeFileSync(join(dir, "docs", "adr", "0001-a.md"), "---\nstatus: superseded\nsuperseded-by: 0002\nkind: record\n---\n# Old way\n\n**Status:** superseded\n");
  writeFileSync(join(dir, "docs", "adr", "0002-b.md"), "# New way\n\n**Status:** accepted 2026-10-01\n");
  const run = spawnSync(process.execPath, ["tools/doc-index.mjs"], { cwd: dir, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const open = readFileSync(join(dir, "docs", "open.md"), "utf8");
  assert.match(open, /\*\*OPEN-02\*\* Still a question\./);
  assert.doesNotMatch(open, /OPEN-01|OPEN-03/);
  assert.match(open, /- \*\*Close spec #9\*\* by hand\./);
  assert.doesNotMatch(open, /sub-point|not this/);
  const adr = readFileSync(join(dir, "docs", "adr", "README.md"), "utf8");
  assert.match(adr, /\[0001\]\(0001-a\.md\) · \*superseded\* \(superseded by 0002\) · Old way/);
  assert.match(adr, /\[0002\]\(0002-b\.md\) · \*accepted\* · New way/);
});

test("a missing path git ignores is local-only and passes; any other missing path fails", () => {
  const { dir, node } = repo();
  writeFileSync(join(dir, ".gitignore"), "/scripts/*\n");
  const roadmap = (body) => `---\njob: Where things stand.\nkind: living\nmax-lines: 20\n---\n# Roadmap\n${body}\n`;
  writeFileSync(join(dir, "docs", "roadmap.md"), roadmap("Run `scripts/qa-cast.ts`, see [the cast](../scripts/README.md)."));
  assert.equal(node("doc-check.mjs").status, 0, node("doc-check.mjs").stderr);
  writeFileSync(join(dir, "docs", "roadmap.md"), roadmap("Run `tools/gone.mjs`."));
  assert.match(node("doc-check.mjs").stderr, /names a file that does not exist: tools\/gone\.mjs/);
});

test("only a path under the config's folders, of its file types, is checked", () => {
  const { dir, node } = repo();
  const roadmap = (body) => `---\njob: Where things stand.\nkind: living\nmax-lines: 20\n---\n# Roadmap\n${body}\n`;
  // src/ is not one of this project's PATH_ROOTS, and .css not one of its PATH_EXTENSIONS: both are prose.
  writeFileSync(join(dir, "docs", "roadmap.md"), roadmap("Built in `src/gone.ts`, styled by `tools/gone.css`."));
  assert.equal(node("doc-check.mjs").status, 0, node("doc-check.mjs").stderr);
  writeFileSync(join(dir, "docs", "roadmap.md"), roadmap("Built in `scripts/gone.ts`."));
  assert.match(node("doc-check.mjs").stderr, /names a file that does not exist: scripts\/gone\.ts/);
});

test("raising a budget is noted, and refused inside a phase run", () => {
  const { dir, node } = repo();
  writeFileSync(join(dir, "docs", "roadmap.md"), "---\njob: Where things stand.\nkind: living\nmax-lines: 30\n---\n# Roadmap\n");
  const attended = node("doc-check.mjs");
  assert.equal(attended.status, 0, attended.stderr);
  assert.match(attended.stdout, /docs\/roadmap\.md: max-lines raised from 20 to 30\. Raising a budget is the owner's call/);
  const run = spawnSync(process.execPath, ["tools/doc-check.mjs"], { cwd: dir, encoding: "utf8", env: { ...process.env, PHASE_RUN: "1" } });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /A phase run never raises a budget/);
});

test("a new doc anywhere in docs/ needs a header", () => {
  const { dir, node } = repo();
  writeFileSync(join(dir, "docs", "notes.md"), "# Some notes\n");
  assert.match(node("doc-check.mjs").stderr, /docs\/notes\.md: has no header/);
});

test("the health report lists each budgeted doc, fullest first, and closed files apart", () => {
  const { dir, node } = repo();
  writeFileSync(join(dir, "docs", "roadmap.md"), `---\njob: Where things stand.\nkind: living\nmax-lines: 10\n---\n# Roadmap\n${"- a line\n".repeat(4)}`);
  writeFileSync(join(dir, "docs", "old.md"), "---\njob: A finished period.\nkind: living\nmax-lines: 6\ngrowth: closed\n---\n# Old\n");
  const report = node("doc-check.mjs", "--report").stdout;
  assert.match(report, /docs\/roadmap\.md\s+10 \/ 10\s+100%\s+over: trim it|docs\/roadmap\.md\s+10 \/ 10\s+100%/);
  assert.match(report, /Closed \(growth: closed[^\n]*\): 1 files\n.*docs\/old\.md/);
});
