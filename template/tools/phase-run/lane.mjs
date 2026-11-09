// A lane's start (0.7.0, D8, D13, ADR 0007): what `run.mjs --lane <id>` does before its first
// ticket, each piece taking its roots and returning (or throwing) a refusal the runner prints.
//
//   - the lane's row, its two roots, and its own branch (`<phase branch>-lane-<id>`);
//   - its lock, `.phase-run/lane-<id>.lock`, found before the branch is known, so a lane started
//     without --branch on a detached checkout can join the branch a live lane's lock names;
//   - its worktree, made fresh at the row's path, or reused and reset to the phase branch's tip;
//   - `worktreeSetup`: the untracked files copied in, the commands run there, the files they leave;
//   - the start check that refuses a tracked script importing an ignored file;
//   - its ports, its env, and when the shared runner copy may be marked finished.
//
// Two roots (ADR 0007): the lane's run state (results, logs, the copy, the locks) lives in the
// primary checkout; its session's files (verdicts, receipts, scratch) live in its worktree.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";

import { laneDatabase } from "./config.mjs";

/** The branch a lane builds on: a `phase-*` name, since a session commits only on one (guard-shell). */
export function laneBranch(branch, id) {
  return `${branch}-lane-${id}`;
}

/** The row `--lane <id>` names, or a refusal naming the ids there are. */
export function laneRow(config, id) {
  if (!config.lanes) throw new Error(`--lane ${id}: .claude/workflow.json has no phaseRun.lanes, so there is no lane to run. Leave out --lane for a one-lane run.`);
  const row = config.lanes.rows.find((lane) => String(lane.id) === String(id));
  if (!row) throw new Error(`--lane ${id}: phaseRun.lanes.rows has no lane "${id}" (its lanes: ${config.lanes.rows.map((lane) => lane.id).join(", ")}).`);
  return row;
}

/**
 * A lane's places (ADR 0007). `tree` is its worktree, the session's root; `runDir` holds its
 * results and logs in the primary checkout; `copyDir` is the branch's folder, whose runner copy
 * both lanes share (ADR 0005).
 */
export function laneRoots({ root, branch, lane }) {
  const copyDir = join(root, ".phase-run", branch);
  return { tree: resolve(root, lane.worktree), runDir: join(copyDir, `lane-${lane.id}`), copyDir, branch: laneBranch(branch, lane.id) };
}

// ------------------------------------------------------------------ the locks

/** Where lane `id`'s lock lives: under `.phase-run/` itself, so it is found before the branch is known. */
export function laneLockPath(state, id) {
  return join(state, `lane-${id}.lock`);
}

export function writeLaneLock(state, { id, pid, branch, at }) {
  mkdirSync(state, { recursive: true });
  writeFileSync(laneLockPath(state, id), `${JSON.stringify({ lane: String(id), pid, branch, startedAt: new Date(at).toISOString() })}\n`);
}

/** Whether a process is still running: a lock whose process died names no live lane. */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Every lane lock under `state` whose process still runs, as `{ lane, pid, branch, startedAt }`. */
export function liveLanes(state, alive = pidAlive) {
  if (!existsSync(state)) return [];
  return readdirSync(state)
    .filter((name) => /^lane-.+\.lock$/.test(name))
    .flatMap((name) => {
      try {
        return [JSON.parse(readFileSync(join(state, name), "utf8"))];
      } catch {
        return [];
      }
    })
    .filter((lock) => Number.isInteger(lock.pid) && typeof lock.branch === "string" && alive(lock.pid));
}

/**
 * The branch a lane started without --branch joins, on a detached checkout (D13): the one a live
 * lane's lock names. Null when no lane is live; refused when live lanes name two branches.
 */
export function joinBranch(state, alive = pidAlive) {
  const branches = [...new Set(liveLanes(state, alive).map((lock) => lock.branch))];
  if (branches.length > 1) throw new Error(`Live lanes are on two branches (${branches.join(", ")}): name the one this lane joins with --branch.`);
  return branches[0] ?? null;
}

/** Whether lane `id` may mark the shared runner copy finished: no other lane on `branch` still runs. */
export function mayFinishCopy(state, { id, branch }, alive = pidAlive) {
  return !liveLanes(state, alive).some((lock) => lock.branch === branch && lock.lane !== String(id));
}

// ---------------------------------------------------------------- the worktree

function run(cwd, command, args, input) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, status: result.status, stdout: (result.stdout ?? "").replace(/\r\n/g, "\n").trim(), stderr: (result.stderr ?? "").replace(/\r\n/g, "\n").trim() };
}

function git(cwd, ...args) {
  const result = run(cwd, "git", args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

const pathKey = (path) => {
  const key = resolve(path).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? key.toLowerCase() : key;
};

/** The folders git has as this repo's worktrees. */
function worktrees(root) {
  return git(root, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

/**
 * The lane's worktree, ready for setup: made at `tree` on the lane's branch, cut from the phase
 * branch's tip, or (a second start) reused and reset to that tip, its untracked files cleaned and
 * its ignored ones (an install) kept. A lane branch holding commits the phase branch lacks is an
 * unlanded pass, and a reset would lose it: the start is refused, naming them.
 */
export function prepareWorktree({ root, tree, branch, ownBranch: lane }) {
  const tip = git(root, "rev-parse", "--verify", `${branch}^{commit}`);
  const known = run(root, "git", ["rev-parse", "--verify", "--quiet", `refs/heads/${lane}`]).ok;
  if (known) {
    const unlanded = git(root, "log", "--format=%h %s", `${branch}..${lane}`);
    if (unlanded) {
      throw new Error(
        `${lane} holds commits ${branch} does not have, so resetting the lane to the tip would lose them:\n${unlanded}\n` +
          `Land them on ${branch}, or delete ${lane} if they are not wanted, then start the lane again.`,
      );
    }
  }
  git(root, "worktree", "prune"); // first: a worktree folder deleted by hand is still registered until pruned
  const reused = worktrees(root).some((path) => pathKey(path) === pathKey(tree));
  if (reused) {
    git(tree, "checkout", "--force", "-B", lane, tip);
    git(tree, "clean", "-fd");
    return { tree, tip, reused: true };
  }
  if (existsSync(tree) && readdirSync(tree).length > 0) {
    throw new Error(`${tree} exists and is not one of this repo's worktrees: move it aside, or give the lane's row another worktree.`);
  }
  git(root, "worktree", "add", "-B", lane, tree, tip);
  return { tree, tip, reused: false };
}

/**
 * `worktreeSetup` (D8), run in the worktree: each `copy` file brought in from the primary
 * checkout, each command run in order, then every `leaves` file checked. Throws on the first
 * refusal, naming what is missing or what failed. `shell(command, cwd)` runs a command line.
 */
export function setupWorktree({ root, tree, setup, shell }) {
  const absent = setup.copy.filter((rel) => !existsSync(join(root, rel)));
  if (absent.length) throw new Error(`phaseRun.lanes.worktreeSetup.copy names ${absent.join(", ")}, which the primary checkout (${root}) does not have.`);
  for (const rel of setup.copy) {
    mkdirSync(dirname(join(tree, rel)), { recursive: true });
    cpSync(join(root, rel), join(tree, rel), { recursive: true });
  }
  for (const command of setup.commands) {
    const result = shell(command, tree);
    if (!result.ok) throw new Error(`phaseRun.lanes.worktreeSetup.commands: \`${command}\` failed in ${tree}:\n${result.output.slice(-1500)}`);
  }
  const missing = setup.leaves.filter((rel) => !existsSync(join(tree, rel)));
  if (missing.length) {
    throw new Error(`phaseRun.lanes.worktreeSetup.leaves: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing in ${tree} after the setup commands ran. A fresh worktree has only tracked files: add the command that makes it.`);
  }
}

// ------------------------------------------------------------- ignored imports

/** The scripts the import check reads: what Node (and a TypeScript build) loads. */
const SCRIPT = /\.(mjs|cjs|js|jsx|ts|mts|cts|tsx)$/;
const EXTENSIONS = [".mjs", ".js", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx", ".json"];
/** A relative specifier: `from "…"`, a bare `import "…"`, `import("…")` and `require("…")`. */
const SPECIFIER = /\bfrom\s*["'](\.{1,2}\/[^"']+)["']|\bimport\s*["'](\.{1,2}\/[^"']+)["']|\b(?:import|require)\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;

/** The repo paths a specifier may load: as written, with an extension, as a folder's index, and a `.js` that is TypeScript. */
function candidates(path) {
  const out = [path, ...EXTENSIONS.map((ext) => `${path}${ext}`), ...EXTENSIONS.map((ext) => `${path}/index${ext}`)];
  if (/\.(m|c)?js$/.test(path)) out.push(path.replace(/js$/, "ts"), path.replace(/\.js$/, ".tsx"));
  return out;
}

/**
 * The tracked scripts in `tree` that import an ignored file (D8): a fresh worktree has none of its
 * ignored files, so such a script breaks there. A file `allowed` names, or one under a folder it
 * names (what worktreeSetup copies in or its commands leave), is accounted for. Each as
 * `{ script, imports }`, sorted.
 */
export function ignoredImports(tree, allowed = []) {
  const tracked = new Set(git(tree, "ls-files", "-z").split("\0").filter(Boolean));
  const covered = (path) => allowed.some((rel) => path === rel || path.startsWith(`${rel.replace(/\/+$/, "")}/`));
  const asked = new Map(); // a candidate path → the imports that may load it
  for (const script of [...tracked].filter((path) => SCRIPT.test(path) && !path.split("/").includes("node_modules"))) {
    let source;
    try {
      source = readFileSync(join(tree, script), "utf8");
    } catch {
      continue; // a tracked file deleted in the tree: nothing to read
    }
    for (const [, a, b, c] of source.matchAll(SPECIFIER)) {
      const target = posix.normalize(posix.join(posix.dirname(script), a ?? b ?? c));
      if (target.startsWith("../")) continue; // out of the repo
      const paths = candidates(target);
      if (paths.some((path) => tracked.has(path)) || paths.some(covered)) continue;
      for (const path of paths) asked.set(path, [...(asked.get(path) ?? []), { script, imports: target }]);
    }
  }
  if (asked.size === 0) return [];
  const result = run(tree, "git", ["check-ignore", "--stdin"], [...asked.keys()].join("\n"));
  if (result.status !== 0 && result.status !== 1) throw new Error(`git check-ignore failed in ${tree}: ${result.stderr}`);
  const found = new Map();
  for (const path of result.stdout.split("\n").filter(Boolean)) {
    for (const hit of asked.get(path) ?? []) found.set(`${hit.script}\0${hit.imports}`, hit); // named as written, not as a candidate
  }
  return [...found.values()].sort((x, y) => (x.script + x.imports).localeCompare(y.script + y.imports));
}

/** The start's refusal for ignored imports, naming each script and the file it imports, or null. */
export function ignoredImportsProblem(found) {
  if (found.length === 0) return null;
  return (
    `A tracked script imports an ignored file, which a fresh worktree does not have:\n${found.map(({ script, imports }) => `  ${script} imports ${imports}`).join("\n")}\n` +
    "Track the file, or have phaseRun.lanes.worktreeSetup bring it in (copy) or make it (commands, with the file in leaves)."
  );
}

// -------------------------------------------------------------- ports and env

/** The lane's ports that something already listens on, each named, as refusals. `busy(port)` answers. */
export async function lanePortProblems(lane, busy) {
  const problems = [];
  for (const { port, what } of lane.ports) {
    if (await busy(port)) problems.push(`Something is listening on :${port} (${what}, lane ${lane.id}). Stop it before the lane starts.`);
  }
  return problems;
}

/** What a lane's session runs on (D4): its QA port (the one named "qa"), its QA database, its test prefix. */
export function laneValues(lane, config) {
  const qa = lane.ports.find((port) => port.name === "qa");
  return {
    id: String(lane.id),
    qaPort: qa ? String(qa.port) : null,
    qaDatabase: laneDatabase(lane, config.qa),
    testDbPrefix: lane.testDbPrefix,
    env: lane.env,
  };
}

/** What a lane does with a passing ticket: its commit stays on the lane's branch, unpushed and unmigrated, for Landing (ADR 0008). */
export function afterPass(lane) {
  return lane ? { push: false, migrate: false } : { push: true, migrate: true };
}
