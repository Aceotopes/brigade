// The runner snapshot: one frozen copy of the runner and its config that judges a whole phase run
// (ADR 0005). At run start the runner copies `tools/phase-run/` and `.claude/workflow.json` into
// the run's folder, `.phase-run/<branch>/runner/`, laid out as the repo is, so the hooks and the
// session's check command read the copy exactly as they would read the repo. Each ticket's
// settings point at it (PHASE_RUN_RUNNER), so nothing written mid-night (a shell write, the
// owner's edit) changes the rules for later tickets.
//
//   manifest.json  { takenAt, commit, runId, finished }
//
// A run that died restarts on its unfinished copy, so the night is still judged by one runner. The
// restart is refused, naming the files, when the live runner's code (`.mjs`, not its tests) has
// changed since: the owner then chooses, by finishing on the old code or deleting the copy. A run
// that reaches its report marks the copy finished, and the next run takes a fresh one.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** The copy's folder inside the run's (`.phase-run/<branch>/`). */
export const SNAPSHOT_FOLDER = "runner";
/** What is copied, from the repo's root: the runner's folder and its config. */
const RUNNER_FOLDER = join("tools", "phase-run");
const CONFIG = join(".claude", "workflow.json");
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

/** The runner's code under `root`: its `.mjs` files, its tests left out, as repo paths with `/`. */
function runnerCode(root) {
  const out = new Map();
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
 * when an unfinished copy's runner code no longer matches the live tree's.
 */
export function takeSnapshot({ root, runDir, runId, commit, at }) {
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
    return { dir, manifest, reused: true };
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(root, RUNNER_FOLDER), join(dir, RUNNER_FOLDER), { recursive: true, filter: (source) => !/[\\/]node_modules$/.test(source) });
  // The copy always holds a config, so the hooks can refuse a copy without one (loadJudgeConfig).
  mkdirSync(dirname(join(dir, CONFIG)), { recursive: true });
  if (existsSync(join(root, CONFIG))) cpSync(join(root, CONFIG), join(dir, CONFIG));
  else writeFileSync(join(dir, CONFIG), NO_CONFIG);
  const fresh = { takenAt: new Date(at).toISOString(), commit, runId, finished: false };
  writeManifest(dir, fresh);
  return { dir, manifest: fresh, reused: false };
}

/** Marks the copy at `dir` finished: the next run on this branch takes a fresh one. */
export function finishSnapshot(dir) {
  const manifest = readManifest(dir);
  if (manifest) writeManifest(dir, { ...manifest, finished: true });
}
