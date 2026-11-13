// The findings record and the night read across lanes (0.7.0, #38, D14, ADR 0007).
//
//   - A **finding** is something a session saw in code its ticket did not own: its verdict's
//     `foundElsewhere`. Each one goes into the phase branch's one record,
//     `.phase-run/<branch>/findings.json` in the primary checkout, whichever lane built the ticket,
//     changed only under the claim lock (claim.mjs) and renamed into place, so two lanes writing at
//     once never lose each other's rows.
//   - Its **outcome** is one of four: `fixed` (the code was put right), `ticketed` (an issue now
//     tracks it), `taken` (a named later ticket takes it on) or `dropped` (looked at, not worth
//     acting on). A session that already knows writes the item as `{ finding, outcome }`; a plain
//     string is recorded open (`outcome: null`), for the finish or the owner to decide.
//   - **The night across lanes**: a branch folder holds a one-lane run's `results.json` and each
//     lane's `lane-<id>/results.json`. `branchResults` reads them all, each result tagged with the
//     lane its folder names, so the morning report, the pull request and `status.mjs` see every lane.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { liveClaims, readClaims, withClaimLock } from "./claim.mjs";
import { liveText, progressText } from "./display.mjs";
import { liveLanes, pidAlive } from "./lane.mjs";

export const FINDINGS_FILE = "findings.json";
export const OUTCOMES = ["fixed", "ticketed", "taken", "dropped"];

/** The findings record in a branch's run folder (the primary checkout's `.phase-run/<branch>/`). */
export function findingsPath(dir) {
  return join(dir, FINDINGS_FILE);
}

/** A verdict's `foundElsewhere` item as `{ finding, outcome }`: a string, or an object whose outcome is one of the four, is open otherwise. */
export function findingOf(item) {
  if (typeof item === "string") return { finding: item, outcome: null };
  if (item && typeof item === "object" && typeof item.finding === "string") return { finding: item.finding, outcome: OUTCOMES.includes(item.outcome) ? item.outcome : null };
  return { finding: JSON.stringify(item), outcome: null };
}

/** An item as a report line's text: a string as it is, an object with its outcome after it. */
export function findingText(item) {
  if (typeof item === "string") return item;
  const { finding, outcome } = findingOf(item);
  return outcome ? `${finding} (${outcome})` : finding;
}

/** The record's rows; none when there is no file yet. A file that can't be read throws: it is never read as empty, or a write would drop its rows. */
export function readFindings(dir) {
  const path = findingsPath(dir);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  let rows = null;
  try {
    rows = JSON.parse(text)?.findings;
  } catch {}
  if (!Array.isArray(rows)) throw new Error(`${path} can't be read as a findings record. Fix or move it; nothing was written to it.`);
  return rows;
}

/**
 * Ticket `ticket`'s findings added to the branch's record, under the claim lock: each item once (a
 * finding already recorded for the ticket, word for word, is passed over: a restart's second record),
 * numbered on from the ticket's last (`<ticket>-<k>`). Returns the rows it added.
 */
export function recordFindings({ dir, ticket, lane = null, night = null, items, at, pid = process.pid, alive = pidAlive, now, pause, waitMs }) {
  if (!items?.length) return [];
  return withClaimLock(
    dir,
    () => {
      const rows = readFindings(dir);
      const added = [];
      let k = rows.filter((row) => row.ticket === ticket).length;
      for (const item of items) {
        const { finding, outcome } = findingOf(item);
        if ([...rows, ...added].some((row) => row.ticket === ticket && row.finding === finding)) continue;
        k += 1;
        added.push({ id: `${ticket}-${k}`, ticket, lane: lane == null ? null : String(lane), night, finding, outcome, at: new Date(at).toISOString() });
      }
      if (added.length === 0) return added;
      const path = findingsPath(dir);
      const part = `${path}.${pid}.part`;
      writeFileSync(part, `${JSON.stringify({ findings: [...rows, ...added] }, null, 2)}\n`);
      renameSync(part, path);
      return added;
    },
    { pid, alive, now, pause, waitMs },
  );
}

// ------------------------------------------------------ the night across lanes

/** The lane ids with a folder in a branch's run folder, in name order. */
function laneIds(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^lane-.+/.test(entry.name))
    .map((entry) => entry.name.slice("lane-".length))
    .sort();
}

/** A branch's results files: the one-lane run's, then each lane's, those that exist. */
export function resultFiles(dir) {
  return [join(dir, "results.json"), ...laneIds(dir).map((id) => join(dir, `lane-${id}`, "results.json"))].filter((file) => existsSync(file));
}

function readList(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Every result in a branch's run folder: the one-lane run's, then each lane's, a lane's tagged with the lane its folder names. */
export function branchResults(dir) {
  const own = existsSync(join(dir, "results.json")) ? readList(join(dir, "results.json")) : [];
  const lanes = laneIds(dir).flatMap((id) => readList(join(dir, `lane-${id}`, "results.json")).map((result) => ({ ...result, lane: id })));
  return [...own, ...lanes];
}

/** Where a result stands: built (a run without lanes), landed, unlanded, parked, parked at Landing, or failed. */
export function laneState(result) {
  if (result.status === "built") return result.lane == null ? "built" : result.landed === false ? "unlanded" : "landed";
  if (result.status === "parked") return "parked";
  return result.landing ? "parked at Landing" : "failed";
}

/** The results whose commit is on the phase branch: every one but a lane's unlanded pass. */
export function onBranch(results) {
  return results.filter((result) => laneState(result) !== "unlanded");
}

/**
 * `status.mjs`'s lane section: each lane of `branch` (a live lock under `state`, or a folder in its
 * run folder `dir`), whether it runs, and what it holds: its live claims, its unlanded passes, and
 * the ticket it is on now (its `live.json`).
 */
export function laneStatus({ dir, state, branch, alive = pidAlive, now = Date.now() }) {
  const live = liveLanes(state, alive).filter((lock) => lock.branch === branch);
  const ids = [...new Set([...live.map((lock) => String(lock.lane)), ...laneIds(dir)])].sort();
  if (ids.length === 0) return [];
  let claims = [];
  let claimProblem = null;
  try {
    claims = liveClaims(readClaims(dir), alive);
  } catch (error) {
    claimProblem = error.message;
  }
  const results = branchResults(dir);
  const out = ["  Lanes"];
  for (const id of ids) {
    const lock = live.find((entry) => String(entry.lane) === id);
    const holds = [
      ...claims.filter((claim) => String(claim.lane) === id).map((claim) => `the claim on #${claim.ticket}`),
      ...results.filter((result) => result.lane === id && laneState(result) === "unlanded").map((result) => `the unlanded pass #${result.number} (\`${result.hash}\`${result.laneBranch ? ` on \`${result.laneBranch}\`` : ""})`),
    ];
    out.push(`  lane ${id} · ${lock ? `live (pid ${lock.pid})` : "not running"} · ${holds.length ? `holds ${holds.join(", ")}` : "holds nothing"}`);
    const file = join(dir, `lane-${id}`, "live.json");
    if (!lock || !existsSync(file)) continue;
    try {
      const progress = JSON.parse(readFileSync(file, "utf8"));
      out.push(`    ${progressText(progress, now)}`);
      if (progress.current) out.push(`    ${liveText(progress.current, now)}`);
    } catch {} // a live.json caught mid-write: the lane's line is still shown
  }
  if (claimProblem) out.push(`  ⚠ ${claimProblem}`);
  return out;
}
