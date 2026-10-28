// The work behind /roadmap: keep a project's roadmap (docs/status/roadmap.md) in step with GitHub,
// then draw the roadmap page from it. The skill does the talking (may I change these lines? publish
// the page); this script does what must be the same every time, and is tested (tests/roadmap.test.mjs).
//
//   node scripts/roadmap.mjs check <dir>                       the roadmap's format problems, and the status
//                                                              changes GitHub suggests (a pull request merged…)
//   node scripts/roadmap.mjs apply <dir> --accept all|<n,n>    write those changes (by their number in check's list)
//   node scripts/roadmap.mjs render <dir> --out <file> [--offline]
//                                                              the roadmap page, filled with the roadmap's data
//
// roadmap.md is the truth; the page is a view of it, never edited by hand (docs/adr/0002 in the plugin).
// The format itself is template/tools/roadmap-format.mjs, which a project's doc-check also reads.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseRoadmap } from "../template/tools/roadmap-format.mjs";

export const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ROADMAP = "docs/status/roadmap.md";
/** The labels the runner parks a ticket with (template/tools/phase-run/run.mjs's PARK_LABEL). */
const PARKED = ["needs-info", "ready-for-human"];

const readText = (path) => readFileSync(path, "utf8");
const lf = (text) => text.replace(/\r\n/g, "\n");

/** `gh` in the project, its JSON parsed; null when the call fails (no remote, no such issue, offline). */
export function ghIn(dir) {
  return (args) => {
    try {
      return JSON.parse(execFileSync("gh", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    } catch {
      return null;
    }
  };
}

/** What GitHub says about each phase: its pull request (found by its branch), its spec, and its parked tickets. */
export function githubFacts(roadmap, gh) {
  const facts = { repo: gh(["repo", "view", "--json", "url"])?.url ?? null, phases: {} };
  for (const phase of roadmap.phases) {
    const pr = phase.branch ? (gh(["pr", "list", "--head", phase.branch, "--state", "all", "--json", "number,state,url", "--limit", "1"]) ?? [])[0] ?? null : null;
    const spec = phase.spec ? gh(["issue", "view", String(phase.spec), "--json", "state,url"]) : null;
    const tickets = phase.spec ? (gh(["api", `repos/{owner}/{repo}/issues/${phase.spec}/sub_issues`]) ?? []) : [];
    const parked = tickets
      .filter((t) => t.state === "open" && (t.labels ?? []).some((l) => PARKED.includes(l.name ?? l)))
      .map((t) => ({ number: t.number, title: t.title, url: t.html_url ?? t.url, label: (t.labels ?? []).map((l) => l.name ?? l).find((n) => PARKED.includes(n)) }));
    facts.phases[phase.phase] = { pr: pr && { number: pr.number, state: pr.state, url: pr.url }, spec, parked };
  }
  return facts;
}

/**
 * The Stands changes GitHub suggests, each a line of roadmap.md to rewrite. A phase is building while its
 * pull request is open and merged once it merges; a module is building once one of its phases is, and
 * delivered when all are merged. A blocked row is the owner's call and never changed. Only forward.
 */
export function proposeChanges(roadmap, facts) {
  const changes = [];
  const now = new Map();
  for (const phase of roadmap.phases) {
    const state = facts.phases[phase.phase]?.pr?.state;
    const derived = state === "MERGED" ? "merged" : state === "OPEN" ? "building" : null;
    const forward = { planned: 0, building: 1, merged: 2 };
    let stands = phase.stands;
    if (phase.stands !== "blocked" && derived && forward[derived] > (forward[phase.stands] ?? 0)) {
      changes.push({ kind: "phase", name: phase.phase, line: phase.line, from: phase.stands, to: derived, why: `its pull request #${facts.phases[phase.phase].pr.number} is ${state.toLowerCase()}` });
      stands = derived;
    }
    now.set(phase.phase, stands);
  }
  for (const module of roadmap.modules) {
    if (module.stands === "blocked" || module.stands === "delivered") continue;
    const own = roadmap.phases.filter((p) => p.module === module.number).map((p) => now.get(p.phase));
    if (!own.length) continue;
    const derived = own.every((s) => s === "merged") ? "delivered" : own.some((s) => s === "merged" || s === "building") ? "building" : null;
    if (derived && derived !== module.stands) {
      changes.push({ kind: "module", name: `${module.number} ${module.name}`, line: module.line, from: module.stands, to: derived, why: derived === "delivered" ? "every phase is merged" : "a phase is under way" });
    }
  }
  return changes.map((change, i) => ({ id: i + 1, ...change }));
}

/** roadmap.md with each change's row given its new Stands (the last cell), everything else as it was. */
export function applyChanges(text, changes) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = lf(text).split("\n");
  for (const change of changes) {
    const row = lines[change.line - 1];
    const cells = row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
    cells[cells.length - 1] = ` ${change.to} `;
    lines[change.line - 1] = `|${cells.join("|")}|`;
  }
  return lines.join(eol);
}

/** The lines under a `## <heading>`: its bullets, or its prose as one item. */
function section(text, heading) {
  const lines = lf(text).split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return [];
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2} /.test(line)) break;
    body.push(line);
  }
  const bullets = body.filter((l) => /^- /.test(l)).map((l) => l.slice(2).trim());
  if (bullets.length) return bullets.filter((b) => !/^nothing( yet)?\.?$/i.test(b));
  const prose = body.join(" ").replace(/\s+/g, " ").trim();
  return prose ? [prose] : [];
}

/** The page's data: the roadmap as written, what GitHub says, the handoff's next step and the phase path. */
export function pageData(dir, roadmap, facts = { repo: null, phases: {} }, today = new Date().toISOString().slice(0, 10)) {
  const read = (rel) => (existsSync(join(dir, rel)) ? readText(join(dir, rel)) : "");
  const project = lf(read("CLAUDE.md")).split("\n").find((l) => /^# /.test(l))?.slice(2).trim() || basename(dir);
  const link = (kind, n) => (facts.repo && n ? `${facts.repo}/${kind}/${n}` : null);
  const phaseOf = (p) => ({
    phase: p.phase,
    spec: p.spec,
    specUrl: facts.phases[p.phase]?.spec?.url ?? link("issues", p.spec),
    branch: p.branch,
    stands: p.stands,
    reason: p.reason,
    pr: facts.phases[p.phase]?.pr ?? null,
  });
  const modules = [...roadmap.modules]
    .sort((a, b) => a.number - b.number)
    .map((m) => ({ number: m.number, name: m.name, dependsOn: m.dependsOn, stands: m.stands, reason: m.reason, phases: roadmap.phases.filter((p) => p.module === m.number).map(phaseOf) }));
  const loose = roadmap.phases.filter((p) => p.module === null).map(phaseOf);
  const delivered = new Set(modules.filter((m) => m.stands === "delivered").map((m) => m.number));
  // The next thing to build: the first unfinished phase without modules, then the first module whose dependencies are delivered.
  const ready = modules.find((m) => m.stands !== "delivered" && m.stands !== "blocked" && m.dependsOn.every((d) => delivered.has(d)));
  const open = (list) => list.find((p) => p.stands !== "merged" && p.stands !== "blocked");
  const nextPhase = open(loose) ?? (ready && open(ready.phases));
  const next = nextPhase ? { module: loose.includes(nextPhase) ? null : ready.number, phase: nextPhase.phase } : ready ? { module: ready.number, phase: null } : null;
  const handoff = read("docs/status/handoff.md");
  const path = lf(read("docs/agents/workflow.md")).match(/## The path of a phase[^\n]*\n+```\n([\s\S]*?)\n```/)?.[1] ?? "";
  return {
    project,
    generated: today,
    repo: facts.repo,
    next,
    modules,
    loose,
    upNext: { steps: section(handoff, "Next step"), waiting: section(handoff, "Waiting on the owner") },
    waitingOnYou: Object.entries(facts.phases).flatMap(([phase, f]) => (f.parked ?? []).map((t) => ({ phase, ...t }))),
    notes: roadmap.notes,
    phasePath: path.replace(/\s+/g, " ").trim(),
  };
}

const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** The roadmap page, filled: its title named after the project, its data block holding the data. */
export function renderPage(data, plugin = PLUGIN) {
  const page = readText(join(plugin, "skills", "roadmap", "page.html"));
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return page
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(data.project)} Roadmap</title>`)
    .replace(/(<script id="roadmap-data" type="application\/json">)[\s\S]*?(<\/script>)/, (all, open, close) => `${open}${json}${close}`);
}

function main() {
  const [command, dir, ...rest] = process.argv.slice(2);
  const value = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : null);
  const print = (data) => console.log(JSON.stringify(data, null, 2));
  try {
    if (!command || !dir) throw new Error("Usage: roadmap.mjs check|apply|render <dir> (see the top of this file).");
    const path = join(dir, ROADMAP);
    if (!existsSync(path)) throw new Error(`No ${ROADMAP} in ${dir}.`);
    const text = readText(path);
    const roadmap = parseRoadmap(text);
    const facts = () => (rest.includes("--offline") ? { repo: null, phases: {} } : githubFacts(roadmap, ghIn(dir)));
    if (command === "check") {
      const found = roadmap.converted && !roadmap.problems.length ? facts() : { repo: null, phases: {} };
      print({ converted: roadmap.converted, problems: roadmap.problems, changes: roadmap.converted ? proposeChanges(roadmap, found) : [], waitingOnYou: pageData(dir, roadmap, found).waitingOnYou });
    } else if (command === "apply") {
      const all = proposeChanges(roadmap, facts());
      const accept = value("--accept");
      const chosen = accept === "all" ? all : all.filter((c) => (accept ?? "").split(",").map(Number).includes(c.id));
      writeFileSync(path, applyChanges(text, chosen));
      print({ written: chosen });
    } else if (command === "render") {
      if (!roadmap.converted) throw new Error(`${ROADMAP} has no roadmap tables yet: convert it first (/roadmap offers to).`);
      if (roadmap.problems.length) throw new Error(`${ROADMAP} is out of format:\n${roadmap.problems.join("\n")}`);
      const out = value("--out");
      if (!out) throw new Error("render needs --out <file>.");
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, renderPage(pageData(dir, roadmap, facts())));
      print({ written: out });
    } else throw new Error("Usage: roadmap.mjs check|apply|render <dir> (see the top of this file).");
  } catch (error) {
    console.error(`roadmap: ${error.message}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
