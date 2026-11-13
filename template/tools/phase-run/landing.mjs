// Landing (0.7.0, D13, ADR 0008): a lane's passing commit put on the phase branch. A lane's gates
// ran on the tip it cut its branch from; by the time it is ready the other lane may have landed, so
// the commit is replayed onto the newest tip and judged again there before the branch moves.
//
// Two parts, the seam the spec names:
//   landingPlan  pure: the tip, its last numbers, the lane's commit (as data) and the hotspot rows
//                in; the steps out, in D13's order. It composes numberLane (numbering.mjs, ADR 0006).
//   land         the executor: reads those inputs with git, and carries out the plan's steps in a
//                scratch worktree detached at the tip, removed on every way out. It never touches a
//                checkout: the lock, undo-detach and the hand-back are landing-lock.mjs's, and
//                run.mjs `landPass` calls this under the lock.
//
// The steps: replay (a cherry-pick) -> settle (the generated and own-file rows) -> number (the log
// rows and the message) -> rebuild (every generated row) -> commit -> re-gate -> browser check (only
// with a fingerprint: carried when unchanged) -> migrate (last of the gates) -> fast-forward (a
// compare-and-swap from the tip) -> push. A conflict on a path Landing does not write, any failed
// step before the fast-forward, or a tip that moved, parks the ticket on `<branch>-parked-<N>` with
// the phase branch unmoved. Nothing is ever forced, and a failed push is reported, not retried.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { compareFingerprint } from "./fingerprint.mjs";
import { LANE_DIR, hotspotKind, numberLane } from "./numbering.mjs";

const MAX_BUFFER = 64 * 1024 * 1024;
/** A numbered log's name: three digits or more (numberLane pads to three, and a thousandth log has four). */
const LOG_NAME = /^(\d{3,})-.+\.md$/;
const tail = (text, length = 3000) => (text.length > length ? `…${text.slice(-length)}` : text);
const short = (hash) => String(hash).slice(0, 9);

/** What a carried pass vouches for (D12's scope, owed by #35): only the files the ticket itself changed. */
export const CARRY_NOTE =
  "The browser check's pass carried over the replay: every source file the ticket changed and every screenshot it counted is unchanged. " +
  "A shared file the ticket never changed is not in the fingerprint, so another lane's edit to one does not re-run the check.";

/**
 * The tip's last numbers, `{ devlog, log }`: the devlog's from its `## #N` entries (`entries`, the
 * texts of the log rows' files) and the `devlog #N` its commits cite (`messages`), so a devlog
 * rotated empty at a phase's end still counts; the log's from the `NNN-<slug>.md` names (`logNames`).
 */
export function lastNumbers({ entries = [], logNames = [], messages = "" }) {
  const numbers = (text, pattern) => [...text.matchAll(pattern)].map((match) => Number(match[1]));
  const devlog = [...entries.flatMap((text) => numbers(text, /^## #(\d+)(?![\w])/gm)), ...numbers(messages, /\bdevlog #(\d+)\b/gi)];
  const log = logNames.flatMap((name) => name.match(LOG_NAME)?.[1] ?? []).map(Number);
  return { devlog: Math.max(0, ...devlog), log: Math.max(0, ...log) };
}

/**
 * The steps of one landing, as plain data.
 *   branch, ticket   the phase branch, the ticket's number (its parked branch is `<branch>-parked-<N>`)
 *   tip, commit      the tip's hash, the lane's commit
 *   files, message   the lane commit's changed files `{ path: text }` (a deleted one null) and message
 *   tipFiles, last   the tip's text of those files and of each own-file target; its last numbers
 *   hotspots, phase  the loaded `phaseRun.hotspots`, the phase's name for `{phase}`
 *   migrations       the migrations the commit adds, by name; fingerprint  its browser-check pass's, or null
 *   push             whether the branch is pushed after the fast-forward
 * `settle` and `number` hold only what Landing writes over the replay: a path git merged is left as
 * git left it. Every replay conflict must fall on one of their paths, or the ticket parks.
 */
export function landingPlan({ branch, ticket, tip, commit, files, message = "", tipFiles = {}, last, hotspots, phase = null, migrations = [], fingerprint = null, push = true }) {
  const numbered = numberLane({ files, message, tip: tipFiles, last, hotspots, phase });
  const settle = {};
  const number = {};
  for (const path of Object.keys(numbered.files).sort()) {
    const text = numbered.files[path];
    if (path in files && files[path] === text) continue; // as the lane wrote it: git's to settle
    const kind = hotspotKind(path, hotspots, phase);
    (kind === "generated" || kind === "own-file" ? settle : number)[path] = text;
  }
  const steps = [
    { do: "replay", commit, onto: tip },
    { do: "settle", write: settle },
    { do: "number", write: number, numbers: numbered.numbers },
    ...(numbered.rebuild.length ? [{ do: "rebuild", rows: numbered.rebuild }] : []),
    { do: "commit", message: numbered.message },
    { do: "re-gate" },
    ...(fingerprint ? [{ do: "browser-check", fingerprint }] : []),
    ...(migrations.length ? [{ do: "migrate", names: [...migrations].sort() }] : []),
    { do: "fast-forward", branch, from: tip },
    ...(push ? [{ do: "push", branch }] : []),
  ];
  return { ticket, numbers: numbered.numbers, steps };
}

// ------------------------------------------------------------------ the executor

/** `git` in `cwd`: `{ ok, out, output }`, `out` untrimmed (a file's text keeps its last newline). */
function gitAt(cwd, args, input = undefined) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", input, maxBuffer: MAX_BUFFER });
  return { ok: result.status === 0, out: result.stdout ?? "", output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`.trim() };
}

function must(cwd, args, input) {
  const result = gitAt(cwd, args, input);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.output}`);
  return result.out;
}

/** The text of `path` at `rev`, or null when `rev` has no such file. */
function textAt(cwd, rev, path) {
  const result = gitAt(cwd, ["show", `${rev}:${path}`]);
  return result.ok ? result.out : null;
}

/**
 * A step made of one shell command, run in the landing's tree: null when it exits 0, else
 * `{ gate: label, output }`. The re-gate, the rebuild and the migration each take this shape.
 */
export function commandStep(label, commandLine, env = {}) {
  return async (dir) => {
    const result = spawnSync(commandLine, { cwd: dir, shell: true, encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: MAX_BUFFER });
    if (result.status === 0) return null;
    return { gate: label, output: `${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`.trim() };
  };
}

/** The lane commit's changes as `[status, path]`, renames split into a delete and an add. */
function changesOf(repo, commit) {
  const fields = must(repo, ["diff", "--name-status", "--no-renames", "-z", `${commit}^`, commit]).split("\0").filter(Boolean);
  const changes = [];
  for (let i = 0; i + 1 < fields.length; i += 2) changes.push([fields[i], fields[i + 1]]);
  return changes;
}

/**
 * The tip's last numbers, read off the files on its `log` rows and its commit messages. The rows are
 * matched by numbering.mjs's own rule (`hotspotKind`), so a row with `*` finds its files: a git
 * pathspec would not expand it the same way.
 */
function readLast(repo, tip, hotspots, phase) {
  const entries = [];
  const logNames = [];
  for (const file of must(repo, ["ls-tree", "-r", "--name-only", "-z", tip]).split("\0").filter(Boolean)) {
    if (hotspotKind(file, hotspots, phase) !== "log") continue;
    const name = file.split("/").pop();
    if (LOG_NAME.test(name)) logNames.push(name);
    else if (name.endsWith(".md")) entries.push(textAt(repo, tip, file) ?? "");
  }
  return lastNumbers({ entries, logNames, messages: must(repo, ["log", "--format=%B", tip]) });
}

/**
 * Keeps `commit` on `<branch>-parked-<N>` without overwriting anything: an earlier park's branch
 * holding other work is left alone, and the next free `-2`, `-3`… name is taken. `{ keptOn, output }`.
 * The runner keeps a restart's unrecorded commit this way too (run.mjs landUnlanded).
 */
export function keepParked(repo, branch, ticket, commit) {
  const base = `${branch}-parked-${ticket}`;
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const existing = gitAt(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}^{commit}`]);
    if (existing.ok && existing.out.trim() === commit) return { keptOn: name };
    if (existing.ok) continue;
    const made = gitAt(repo, ["branch", name, commit]);
    return made.ok ? { keptOn: name } : { keptOn: null, output: made.output };
  }
  return { keptOn: null, output: `${base} and its next 98 names are all taken.` };
}

/** A callback's failure, or the error it threw, as `{ gate, output }`; null when it passed. */
async function attempt(label, fn) {
  try {
    return (await fn()) ?? null;
  } catch (error) {
    return { gate: label, output: error?.stack ?? String(error) };
  }
}

/**
 * Lands `commit` (a lane's one passing commit) on `branch` in `repo`, the primary checkout.
 *   ticket                 its number, for the parked branch's name
 *   hotspots, phase        as landingPlan takes them
 *   rebuild(dir, rows)     rebuilds the generated rows on the numbered tree
 *   regate(dir, { base, head })   the real gates on the landed tree, the migration left out
 *   fingerprint, shotsRoot, browserCheck(dir, why)   the browser check's pass and the lane's worktree
 *                          (its screenshots are never committed); the check runs again only when
 *                          the fingerprint changed, and returns its problem or null
 *   migration              `{ added, apply(dir, names) }` or null: `added` (phaseRun.migrations.added)
 *                          names the commit's new migrations, `apply` runs them as the last gate
 *   remote                 the remote to push the branch to, or null
 * `rebuild`, `regate` and `migration.apply` return null on a pass or `{ gate, output }`; `browserCheck`
 * returns its problem text or null, as run.mjs's gate callback does. A callback that throws fails its
 * step. Returns `{ status: "landed", commit, numbers, migrations, browserCheck, pushed, pushOutput? }`
 * or `{ status: "parked", step, detail, keptOn, attempt, branchMoved, numbers }`, either with
 * `cleanup` when the scratch worktree could not be removed. Any error of Landing's own parks too.
 * A park keeps the lane's commit as it passed (unnumbered, so it can land again); `attempt` is the
 * numbered commit that was tried, when there was one.
 */
export async function land(options) {
  const { repo, branch, ticket, commit } = options;
  const at = { step: "plan", plan: null, landed: null };
  const scratch = mkdtempSync(join(tmpdir(), "brigade-landing-"));
  let result;
  try {
    result = await landIn(join(scratch, "tree"), options, at);
  } catch (error) {
    result = { park: at.step, detail: `Landing stopped on an error of its own at the ${at.step} step:\n${tail(error?.stack ?? String(error))}` };
  }
  let cleanup = null;
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    cleanup = `The scratch worktree ${scratch} could not be removed (${error.code ?? error.message}); delete it, then run \`git worktree prune\`.`;
  }
  gitAt(repo, ["worktree", "prune"]);
  const extra = cleanup ? { cleanup } : {};
  if (!result.park) return { ...result, ...extra };

  const kept = keepParked(repo, branch, ticket, commit);
  return {
    status: "parked",
    step: result.park,
    detail: kept.keptOn ? result.detail : `${result.detail}\n\nThe lane's commit could not be kept on a parked branch: ${kept.output}`,
    keptOn: kept.keptOn,
    attempt: at.landed,
    branchMoved: Boolean(result.branchMoved),
    numbers: at.plan?.numbers ?? null,
    ...extra,
  };
}

/** The landing itself, in the scratch worktree `tree`: a landed result, or `{ park, detail, branchMoved? }`. `at` tracks the step. */
async function landIn(tree, { repo, branch, ticket, commit, hotspots, phase = null, rebuild = null, regate, fingerprint = null, shotsRoot = null, browserCheck = null, migration = null, remote = null }, at) {
  const tip = must(repo, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]).trim();
  const changes = changesOf(repo, commit);
  const files = {};
  for (const [status, path] of changes) {
    if (!hotspotKind(path, hotspots, phase)) continue; // git settles it: the plan never reads it
    files[path] = status === "D" ? null : textAt(repo, commit, path);
  }
  const tipFiles = {};
  // An own-file block is folded into the tip's file, so the tip's text of its target is read too.
  for (const path of Object.keys(files).flatMap((p) => (p.startsWith(`${LANE_DIR}/`) ? [p, p.slice(LANE_DIR.length + 1)] : [p]))) {
    const text = textAt(repo, tip, path);
    if (text !== null) tipFiles[path] = text;
  }
  const migrations = migration
    ? [...new Set(changes.filter(([status]) => status === "A").flatMap(([, path]) => {
        const match = path.match(migration.added);
        return match ? [match[1] ?? match[0]] : [];
      }))]
    : [];
  const plan = landingPlan({
    branch,
    ticket,
    tip,
    commit,
    files,
    message: must(repo, ["log", "-1", "--format=%B", commit]),
    tipFiles,
    last: readLast(repo, tip, hotspots, phase),
    hotspots,
    phase,
    migrations,
    fingerprint,
    push: Boolean(remote),
  });
  at.plan = plan;

  let landed = null;
  let browser = null;
  const park = (step, detail, extra = {}) => ({ park: step, detail, ...extra });
  must(repo, ["worktree", "add", "-q", "--detach", tree, tip]);
  const inTree = (args, input) => gitAt(tree, args, input);
  const owned = new Set();
  for (const step of plan.steps) {
    at.step = step.do;
    switch (step.do) {
      case "replay": {
        for (const s of plan.steps.filter((x) => x.write)) for (const path of Object.keys(s.write)) owned.add(path);
        const picked = inTree(["cherry-pick", "--no-commit", step.commit]);
        if (picked.ok) break;
        const conflicts = inTree(["diff", "--name-only", "--diff-filter=U", "-z"]).out.split("\0").filter(Boolean);
        const unowned = conflicts.filter((path) => !owned.has(path));
        if (conflicts.length === 0 || unowned.length > 0) {
          const where = unowned.length ? `in ${unowned.length === 1 ? "a file" : "files"} no hotspot row settles: ${unowned.join(", ")}` : `: ${tail(picked.output)}`;
          return park("replay", `Replaying #${ticket} onto ${branch}'s tip (${short(tip)}) conflicts ${where}. Landing never settles such a conflict itself: the lane's commit is kept as it passed, for a rebase by hand or a rebuild on the new tip.`);
        }
        break;
      }
      case "settle":
      case "number": {
        for (const [path, text] of Object.entries(step.write)) {
          const file = join(tree, path);
          if (text === null) rmSync(file, { force: true });
          else {
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, text);
          }
        }
        must(tree, ["add", "-A"]);
        break;
      }
      case "rebuild": {
        const failed = await attempt("rebuild", () => (rebuild ? rebuild(tree, step.rows) : { gate: "rebuild", output: "No rebuild was given for the generated rows." }));
        if (failed) return park("rebuild", `Rebuilding ${step.rows.join(", ")} on the numbered tree failed:\n${tail(failed.output)}`);
        must(tree, ["add", "-A"]);
        break;
      }
      case "commit": {
        const [name, email, date] = must(repo, ["log", "-1", "--format=%an%x00%ae%x00%aI", commit]).trim().split("\0");
        const made = inTree(["commit", "-q", "-F", "-", `--author=${name} <${email}>`, `--date=${date}`], step.message);
        if (!made.ok) return park("commit", `The replayed, numbered commit could not be made on ${branch}'s tip (${short(tip)}):\n${tail(made.output)}`);
        landed = must(tree, ["rev-parse", "HEAD"]).trim();
        at.landed = landed;
        break;
      }
      case "re-gate": {
        const failed = await attempt("re-gate", () => regate(tree, { base: tip, head: landed }));
        if (failed) return park("re-gate", `The re-gate on ${branch}'s tip (${short(tip)}) failed at ${failed.gate}:\n${tail(failed.output)}`);
        break;
      }
      case "browser-check": {
        // The sources are judged on the landed tree; the screenshots where the check saved them.
        const sources = compareFingerprint({ sources: step.fingerprint.sources ?? {}, screenshots: {} }, tree);
        const verdict = sources.verdict === "carry" ? compareFingerprint({ sources: {}, screenshots: step.fingerprint.screenshots ?? {} }, shotsRoot ?? tree) : sources;
        if (verdict.verdict === "carry") {
          browser = { ...verdict, note: CARRY_NOTE };
          break;
        }
        browser = verdict;
        const failed = await attempt("browser check", async () => {
          const problem = browserCheck ? await browserCheck(tree, verdict) : "No browser check was given to run again.";
          return problem ? { gate: "browser check", output: String(problem) } : null;
        });
        if (failed) return park("browser-check", `The browser check's fingerprint did not hold over the replay (${verdict.file} ${verdict.why}), and the check run again failed:\n${tail(failed.output)}`);
        break;
      }
      case "migrate": {
        const failed = await attempt("migration", () => migration.apply(tree, step.names));
        if (failed) return park("migrate", `The migration (${step.names.join(", ")}) failed, the re-gate's last step, so ${branch} was not moved:\n${tail(failed.output)}`);
        break;
      }
      case "fast-forward": {
        const expected = step.from;
        const swapped = gitAt(repo, ["update-ref", `refs/heads/${branch}`, landed, expected]);
        if (swapped.ok) break;
        const now = gitAt(repo, ["rev-parse", `refs/heads/${branch}`]).out.trim();
        if (now !== expected) {
          return park(
            "fast-forward",
            `${branch} moved during landing: it was ${short(expected)} when landing began and is ${short(now)} now, so the compare-and-swap left it alone. Nothing was forced; the lane's commit is kept unnumbered, to land again on the new tip.`,
            { branchMoved: true },
          );
        }
        return park("fast-forward", `${branch} is still at ${short(expected)}, but the compare-and-swap could not move it:\n${tail(swapped.output)}`);
      }
      case "push":
        break; // after the loop: the branch has moved, and nothing past the fast-forward parks
      default:
        throw new Error(`Landing has no step "${step.do}".`);
    }
  }
  const push = plan.steps.find((step) => step.do === "push");
  const pushed = push ? gitAt(repo, ["push", "-q", remote, `refs/heads/${push.branch}:refs/heads/${push.branch}`]) : null;
  return {
    status: "landed",
    commit: landed,
    numbers: plan.numbers,
    migrations: plan.steps.find((step) => step.do === "migrate")?.names ?? [],
    browserCheck: browser,
    pushed: pushed ? pushed.ok : false,
    ...(pushed && !pushed.ok ? { pushOutput: tail(pushed.output) } : {}),
  };
}
