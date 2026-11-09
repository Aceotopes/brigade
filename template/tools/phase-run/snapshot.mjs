// The runner snapshot: one frozen copy of the runner and its config that judges a whole phase run
// (ADR 0005). At run start the runner copies `tools/phase-run/` and `.claude/workflow.json` into
// the run's folder, `.phase-run/<branch>/runner/`, laid out as the repo is, so the hooks and the
// session's check command read the copy exactly as they would read the repo. Each ticket's
// settings point at it (PHASE_RUN_RUNNER), so nothing written mid-night (a shell write, the
// owner's edit) changes the rules for later tickets. Since 0.7.0 (D10) the copy also holds
// `tools/doc-check.mjs`, every doc tool it imports and `tools/doc-check-baseline.json`, so the docs
// are judged by the copy too.
//
//   manifest.json  { takenAt, commit, runId, brigade, docCheck, finished }
//
// `brigade` is the Brigade version installed when the copy was taken (brigade.mjs): the plugin's
// hooks judge the night beside the copy.
//
// A run that died restarts on its unfinished copy, so the night is still judged by one runner. The
// restart is refused, naming the files, when the live runner's code (`.mjs`, not its tests, and the
// doc tools; never the configs or the baseline, which the copy keeps on purpose) has
// changed since, or when another Brigade version is installed now: the owner then chooses, by
// finishing on the old code (or version) or deleting the copy. A run
// that reaches its report marks the copy finished, and the next run takes a fresh one.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";

/** The copy's folder inside the run's (`.phase-run/<branch>/`). */
export const SNAPSHOT_FOLDER = "runner";
/** What is copied, from the repo's root: the runner's folder and its config. */
const RUNNER_FOLDER = join("tools", "phase-run");
const CONFIG = join(".claude", "workflow.json");
/** doc-check (D10): the copy also takes it, every doc tool it imports, and its baseline. */
const DOC_CHECK = "tools/doc-check.mjs";
const BASELINE = join("tools", "doc-check-baseline.json");
/** The docs' config: copied with the doc tools, but kept on a restart like workflow.json, since a ticket may edit it. */
const DOC_CONFIG = "tools/doc-config.mjs";
/** A project with no config gets this in its copy: no rules, the same as no file, but present. */
const NO_CONFIG = '{ "version": 1, "note": "The project had no .claude/workflow.json when this run started." }\n';
const MANIFEST = "manifest.json";

function writeManifest(dir, manifest) {
  writeFileSync(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** The manifest of the copy at `dir`, or null when there is none it can read. */
export function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"));
  } catch {
    return null;
  }
}

/**
 * doc-check and every doc tool it imports, however deep (D10), as repo paths with `/`: what judges
 * the docs, so the copy holds it. Empty for a project without doc-check. Read from its relative
 * imports, so a tool a project's doc-check gains is copied too, and one it drops is not.
 */
export function docTools(root) {
  const found = new Set();
  const visit = (rel) => {
    if (found.has(rel) || !existsSync(join(root, rel))) return;
    found.add(rel);
    const source = readFileSync(join(root, rel), "utf8");
    // A named import, a bare one (for its side effects), and a dynamic one.
    for (const [, a, b, c] of source.matchAll(/\bfrom\s*["'](\.{1,2}\/[^"']+)["']|\bimport\s*["'](\.{1,2}\/[^"']+)["']|\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
      const next = posix.join(posix.dirname(rel), a ?? b ?? c);
      if (!next.startsWith("../")) visit(next); // never out of the repo
    }
  };
  visit(DOC_CHECK);
  return [...found].sort();
}

/** The runner's code under `root`: its `.mjs` files, its tests left out, and the doc tools but their config, as repo paths with `/`. */
function runnerCode(root) {
  const out = new Map();
  for (const rel of docTools(root)) if (rel !== DOC_CONFIG) out.set(rel, readFileSync(join(root, rel)));
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(path);
      } else if (entry.name.endsWith(".mjs") && !entry.name.endsWith(".test.mjs")) {
        out.set(relative(root, path).replaceAll("\\", "/"), readFileSync(path));
      }
    }
  };
  walk(join(root, RUNNER_FOLDER));
  return out;
}

/** The runner code that differs between the live tree and the copy: changed, added or removed, sorted. */
export function runnerChanges(root, dir) {
  const live = runnerCode(root);
  const copy = runnerCode(dir);
  const names = new Set([...live.keys(), ...copy.keys()]);
  return [...names].filter((name) => !live.has(name) || !copy.has(name) || !live.get(name).equals(copy.get(name))).sort();
}

/**
 * The run's copy: an unfinished one reused (a restart), else a fresh one taken from `root`. Throws
 * when an unfinished copy's runner code no longer matches the live tree's, or its Brigade version
 * the one installed now (`brigade`). A copy whose manifest has no version (taken before 0.6.0) has
 * nothing to compare, so its restart goes on.
 */
export function takeSnapshot({ root, runDir, runId, commit, at, brigade = null }) {
  const dir = join(runDir, SNAPSHOT_FOLDER);
  const manifest = readManifest(dir);
  if (manifest && manifest.finished === false) {
    const changed = runnerChanges(root, dir);
    if (changed.length) {
      throw new Error(
        `This branch's last run died, and the runner's code changed since its copy was taken (${manifest.takenAt}): ` +
          `${changed.join(", ")}. A run is judged by one runner from its first ticket to its last, so it will not restart on other code. ` +
          `Put the code back to finish that run on its copy, or delete ${dir} to start a fresh run on the new code.`,
      );
    }
    if (typeof manifest.brigade === "string" && manifest.brigade !== brigade) {
      throw new Error(
        `This branch's last run died; its copy was taken under Brigade ${manifest.brigade}, and ${brigade ?? "no version"} is installed now. ` +
          `A run is judged by one Brigade version from its first ticket to its last, so it will not restart on another. ` +
          `Put Brigade ${manifest.brigade} back to finish that run on its copy, or delete ${dir} to start a fresh run on ${brigade ?? "the installed one"}.`,
      );
    }
    return { dir, manifest, reused: true };
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(root, RUNNER_FOLDER), join(dir, RUNNER_FOLDER), { recursive: true, filter: (source) => !/[\\/]node_modules$/.test(source) });
  // The copy always holds a config, so the hooks can refuse a copy without one (loadJudgeConfig).
  mkdirSync(dirname(join(dir, CONFIG)), { recursive: true });
  if (existsSync(join(root, CONFIG))) cpSync(join(root, CONFIG), join(dir, CONFIG));
  else writeFileSync(join(dir, CONFIG), NO_CONFIG);
  // The docs are judged by the copy too: a night can't change the rules its own docs are checked by.
  const tools = docTools(root);
  for (const rel of [...tools, ...(existsSync(join(root, BASELINE)) ? [BASELINE] : [])]) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    cpSync(join(root, rel), join(dir, rel));
  }
  // `docCheck` tells the commit hook a copy that lost its doc-check (an error) from one an older
  // runner took without one (the live doc-check checks, as before).
  const fresh = { takenAt: new Date(at).toISOString(), commit, runId, brigade, docCheck: tools.length > 0, finished: false };
  writeManifest(dir, fresh);
  return { dir, manifest: fresh, reused: false };
}

/** Marks the copy at `dir` finished: the next run on this branch takes a fresh one. */
export function finishSnapshot(dir) {
  const manifest = readManifest(dir);
  if (manifest) writeManifest(dir, { ...manifest, finished: true });
}
