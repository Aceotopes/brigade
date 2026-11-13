// The landing lock (0.7.0, #37, D13, ADR 0008): one lane lands at a time, and the primary checkout
// is always left in a good state, whatever happens to a lane.
//
//   underLandingLock  one lock, `.phase-run/<branch>/landing.lock` in the primary checkout (ADR 0007),
//                     held for a whole landing (Landing, landing.mjs `land`). It lapses when its
//                     holder's process is gone. While it is held, a primary checkout that is on the
//                     phase branch is detached: Landing moves the branch with `update-ref`, which
//                     under a checked-out HEAD would leave the index and files on the old commit.
//                     The detach is undone on every way out: the landing's end, its throw, the
//                     process's exit (a `process.exit`, the runner's Ctrl-C), and, for a process
//                     killed outright, by the next taker of the lapsed lock, which reads the detach
//                     the lock recorded.
//   handBack          the last lane out puts the primary checkout on the phase branch's tip; while
//                     another lane of the branch is live, it is not touched.
//   keepUnlanded,     a restarted lane's unlanded passes: kept on a hidden ref before its worktree is
//   unlandedCommits,  reset to the tip, then each found, oldest first, as landed, parked or unlanded,
//   restartSteps      and given its action against the lane's results, so the restart lands its own
//                     before it claims new work, and finishes the record of one it died landing.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { builtOn, lockTaker } from "./claim.mjs";
import { liveLanes, pidAlive } from "./lane.mjs";

export const LANDING_LOCK = "landing.lock";
/** How long a lane waits on another lane's landing before it gives up: far past any re-gate. */
export const LANDING_WAIT_MS = 3 * 60 * 60 * 1000;
/** How often a waiting lane looks at the lock again. */
export const LANDING_POLL_MS = 5_000;

const short = (hash) => String(hash).slice(0, 9);

function gitAt(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const stdout = (result.stdout ?? "").replace(/\r\n/g, "\n").trim();
  return { ok: result.status === 0, stdout, output: `${stdout}\n${result.stderr ?? ""}${result.error?.message ?? ""}`.trim() };
}

/** The landing lock in a branch's run folder (`laneRoots(...).copyDir`), shared by both lanes. */
export function landingLockPath(dir) {
  return join(dir, LANDING_LOCK);
}

/** The branch the checkout at `root` is on, or null when its HEAD is detached. */
function attachedTo(root) {
  const head = gitAt(root, ["symbolic-ref", "-q", "HEAD"]);
  return head.ok ? head.stdout.replace(/^refs\/heads\//, "") : null;
}

/**
 * Detaches the primary checkout at `root` when it is on `branch`, keeping its files: `{ branch,
 * commit }`, what undoDetach needs, or null when it is elsewhere (where a lane leaves it) and the
 * branch can move without touching it.
 */
export function detachPrimary(root, branch) {
  if (attachedTo(root) !== branch) return null;
  const commit = gitAt(root, ["rev-parse", "HEAD"]).stdout;
  const done = gitAt(root, ["checkout", "-q", "--detach"]);
  if (!done.ok) throw new Error(`The primary checkout (${root}) is on ${branch} and could not be detached for the landing:\n${done.output}`);
  return { branch, commit };
}

/**
 * Puts a detached primary checkout back on its branch (`detached`, detachPrimary's record): a
 * checkout of the branch, which carries its files to wherever the branch is now. Only a checkout
 * still detached at the recorded commit is the landing's to undo: one that is attached, or detached
 * elsewhere (the owner looking at a commit), is someone else's since, and left alone. Returns
 * `{ undone, problem }`: whether it checked the branch out, and what went wrong, for the run's log.
 */
export function undoDetach(root, detached) {
  if (!detached) return { undone: false, problem: null };
  const now = attachedTo(root);
  if (now !== null) return { undone: false, problem: null }; // attached again already (a hand-back), or by the owner
  const head = gitAt(root, ["rev-parse", "HEAD"]).stdout;
  if (head !== detached.commit) return { undone: false, problem: `The primary checkout was detached for a landing at ${short(detached.commit)}, and is detached at ${short(head)} now: it was left there.` };
  const back = gitAt(root, ["checkout", "-q", detached.branch]);
  if (back.ok) return { undone: true, problem: null };
  return { undone: false, problem: `The primary checkout could not be put back on ${detached.branch} after a landing, and is detached at ${short(detached.commit)}: run \`git checkout ${detached.branch}\` there.\n${back.output}` };
}

/**
 * Runs `fn` (a landing) holding the landing lock. A live holder is waited on, `pollMs` at a time
 * through the injected `sleep`, `onWait(holder)` called once, and refused past `waitMs`. A lapsed
 * holder's lock is taken over, and the detach it recorded undone first. Returns `{ value, notes }`:
 * `fn`'s value and what the lock had to say (a crashed landing undone, a checkout it could not put
 * back). The lock is released and the detach undone however `fn` ends; a throw is passed on.
 */
export async function underLandingLock(
  { dir, root, branch, lane = null, pid = process.pid, alive = pidAlive, now = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), waitMs = LANDING_WAIT_MS, pollMs = LANDING_POLL_MS, onWait = () => {} },
  fn,
) {
  mkdirSync(dir, { recursive: true });
  const lock = landingLockPath(dir);
  const taker = lockTaker(lock, { pid, alive, now, body: { lane: lane === null ? null : String(lane), branch, detached: null } });
  const started = now();
  let waited = false;
  let broken = [];
  for (;;) {
    const attempt = taker.attempt();
    if (attempt.taken) {
      broken = attempt.broken;
      break;
    }
    if (now() - started >= waitMs) {
      const who = attempt.holder?.lane ? `lane ${attempt.holder.lane} (process ${attempt.holder.pid})` : `process ${attempt.holder?.pid ?? "unknown"}`;
      throw new Error(`The landing lock, ${lock}, is held by ${who}, and this lane waited ${Math.round(waitMs / 60_000)} min for it. If no lane is landing, delete the lock and start the lane again.`);
    }
    if (!waited) onWait(attempt.holder);
    waited = true;
    await sleep(pollMs);
  }

  const notes = [];
  let detached = null;
  const undo = () => {
    const { problem } = undoDetach(root, detached);
    detached = null;
    taker.update({ detached: null });
    return problem;
  };
  // First of the exit handlers, so a hand-back on the same exit finds the checkout attached.
  const onExit = () => {
    const problem = undo();
    if (problem) console.error(`phase-run: ${problem}`);
    taker.release();
  };
  process.prependListener("exit", onExit);
  let value;
  let failure = null;
  try {
    for (const dead of broken.filter((holder) => holder?.detached)) {
      const { undone, problem } = undoDetach(root, dead.detached);
      if (problem) notes.push(problem);
      if (undone) notes.push(`${dead.lane ? `Lane ${dead.lane}'s` : "A"} landing (process ${dead.pid}) died with the primary checkout detached; it is attached again, on ${dead.detached.branch}.`);
    }
    detached = detachPrimary(root, branch);
    if (detached) taker.update({ detached });
    value = await fn();
  } catch (error) {
    failure = error;
  } finally {
    const problem = undo();
    if (problem) notes.push(problem);
    process.removeListener("exit", onExit);
    taker.release();
  }
  if (failure) {
    if (notes.length && failure instanceof Error) failure.message += `\n${notes.join("\n")}`;
    throw failure;
  }
  return { value, notes };
}

/**
 * The hand-back (D13): lane `lane`, on its way out, puts the primary checkout at `root` on `branch`,
 * the phase branch's tip, when no other lane of the branch is live (`state`'s lane locks; this
 * lane's own is released first). An owner's uncommitted edit is never carried or lost: the checkout
 * is left where it is. Returns `{ handedBack, why }`.
 */
export function handBack({ root, state, branch, lane, alive = pidAlive }) {
  const others = liveLanes(state, alive).filter((lock) => lock.branch === branch && lock.lane !== String(lane));
  if (others.length) return { handedBack: false, why: `lane ${others.map((lock) => lock.lane).join(", ")} still runs on ${branch}, so the primary checkout is left as it is for the last lane out.` };
  if (attachedTo(root) === branch) return { handedBack: true, why: `The primary checkout is on ${branch} already.` };
  const dirty = gitAt(root, ["status", "--porcelain", "--untracked-files=no"]).stdout;
  if (dirty) return { handedBack: false, why: `The primary checkout has uncommitted changes, so it was not moved to ${branch}:\n${dirty}\nCommit or put them aside, then run \`git checkout ${branch}\`.` };
  const done = gitAt(root, ["checkout", "-q", branch]);
  if (!done.ok) return { handedBack: false, why: `\`git checkout ${branch}\` failed in the primary checkout:\n${done.output}` };
  return { handedBack: true, why: `The primary checkout is on ${branch}, at ${short(gitAt(root, ["rev-parse", "HEAD"]).stdout)}.` };
}

// ------------------------------------------------------------------ the restart

/** Where a restart keeps its lane's unlanded commits while the worktree is reset: a ref, never a branch. */
export function unlandedRef(laneBranch) {
  return `refs/phase-run/unlanded/${laneBranch}`;
}

function commitOf(root, ref) {
  const found = gitAt(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return found.ok ? found.stdout : null;
}

/**
 * Before a restarted lane's worktree is reset to the tip (lane.mjs prepareWorktree): its branch's
 * commits the phase branch lacks are kept on `unlandedRef`. `{ kept }`, the head kept (prepareWorktree's
 * `kept`), or null when the lane holds nothing unlanded. A keep from an earlier start with commits
 * still to land is never overwritten: that start is refused.
 */
export function keepUnlanded({ root, branch, laneBranch }) {
  const head = commitOf(root, `refs/heads/${laneBranch}`);
  if (!head || !gitAt(root, ["rev-list", `${branch}..${head}`]).stdout) return { kept: null };
  const ref = unlandedRef(laneBranch);
  const held = commitOf(root, ref);
  if (held && held !== head) {
    const open = unlandedCommits({ root, branch, laneBranch }).filter((found) => found.state === "unlanded");
    if (open.length) {
      throw new Error(
        `${ref} still keeps commits an earlier start never landed (${open.map((found) => `${short(found.commit)}${found.ticket ? ` #${found.ticket}` : ""}`).join(", ")}), and ${laneBranch} holds others. ` +
          `Land or drop one set by hand (\`git update-ref -d ${ref}\` drops the kept one), then start the lane again.`,
      );
    }
  }
  const made = gitAt(root, ["update-ref", ref, head]);
  if (!made.ok) throw new Error(`${laneBranch}'s unlanded commits could not be kept on ${ref}:\n${made.output}`);
  return { kept: head };
}

/**
 * The kept commits, oldest first, each `{ commit, ticket, state, keptOn? }`: `ticket` from its
 * `Closes #N` (null without one); `state` "landed" when the phase branch carries `Closes #N` (Landing
 * gave it a new hash), "parked" when a `<branch>-parked-<N>` branch (`keptOn`) keeps this very
 * commit, else "unlanded".
 */
export function unlandedCommits({ root, branch, laneBranch }) {
  const ref = unlandedRef(laneBranch);
  if (!commitOf(root, ref)) return [];
  const git = (...args) => gitAt(root, args);
  return gitAt(root, ["rev-list", "--reverse", `${branch}..${ref}`])
    .stdout.split("\n")
    .filter(Boolean)
    .map((commit) => {
      const number = gitAt(root, ["log", "-1", "--format=%B", commit]).stdout.match(/\bcloses #(\d+)\b/i)?.[1];
      const ticket = number ? Number(number) : null;
      if (ticket !== null && builtOn(git, branch, ticket)) return { commit, ticket, state: "landed" };
      const parked = ticket === null ? "" : gitAt(root, ["for-each-ref", "--format=%(objectname) %(refname:short)", `refs/heads/${branch}-parked-${ticket}`, `refs/heads/${branch}-parked-${ticket}-*`]).stdout;
      const keptOn = parked.split("\n").find((line) => line.startsWith(`${commit} `))?.slice(commit.length + 1);
      return keptOn ? { commit, ticket, state: "parked", keptOn } : { commit, ticket, state: "unlanded" };
    });
}

/**
 * What a restart does with each kept commit (`found`, unlandedCommits'), given the lane's results
 * (`results`, results.json's): pure. Each comes back with an `action` and the lane's `result` for it,
 * the last one recorded for that ticket and that very commit (or null):
 *   "land"            unlanded, with a recorded pass still `landed: false`
 *   "keep"            unlanded, with no recorded pass (the lane died before its gates passed): kept
 *                     on a parked branch, never landed
 *   "record-landed"   landed, but the lane died before its result said so
 *   "record-parked"   parked by Landing, but the lane died before the park was posted
 *   "skip"            landed or parked, and its result already says so
 */
export function restartSteps({ found, results, lane }) {
  const self = String(lane);
  const laneCommitOf = (r) => (r.landed ? r.laneHash : (r.commit ?? r.hash));
  return found.map((step) => {
    const result =
      [...results].reverse().find((r) => r.lane === self && r.number === step.ticket && typeof laneCommitOf(r) === "string" && step.commit.startsWith(laneCommitOf(r))) ?? null;
    const pending = result !== null && result.status === "built" && result.landed === false;
    const action = { unlanded: pending ? "land" : "keep", landed: pending ? "record-landed" : "skip", parked: pending ? "record-parked" : "skip" }[step.state];
    return { ...step, action, result };
  });
}

/** Drops the keep once every kept commit is landed or parked. */
export function dropUnlanded({ root, laneBranch }) {
  gitAt(root, ["update-ref", "-d", unlandedRef(laneBranch)]);
}
