// 0.7.0 (#38, D14, ADR 0007): the findings record and the reports' lane reading. One findings record
// per phase branch, in the primary checkout's `.phase-run/<branch>/findings.json`, written by either
// lane under the claim lock; every lane's results read back from `lane-<id>/results.json`, so the
// morning report shows the whole night and says which lane built each ticket. A run without lanes
// reports exactly as before: its report is pinned word for word by a fixture.
// Run: node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { OUTCOMES, branchResults, findingOf, findingsPath, laneState, laneStatus, onBranch, readFindings, recordFindings, resultFiles } from "../template/tools/phase-run/findings.mjs";
import { loadResults, pullRequestBody, recordResult, report } from "../template/tools/phase-run/run.mjs";
import { PLUGIN, write } from "./helpers.mjs";

const AT = Date.UTC(2026, 10, 10, 2, 0);
const NIGHT = "2026-11-10T01:00:00.000Z";
const OTHER_NIGHT = "2026-11-09T01:00:00.000Z";
const temp = (prefix = "brigade-findings-") => mkdtempSync(join(tmpdir(), prefix));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const moduleUrl = JSON.stringify(pathToFileURL(join(PLUGIN, "template", "tools", "phase-run", "findings.mjs")).href);

// ------------------------------------------------------------------ the record

test("a finding is recorded with its ticket, lane, night and outcome; a plain string is open", () => {
  const dir = temp();
  const added = recordFindings({ dir, ticket: 36, lane: "1", night: NIGHT, at: AT, items: ["#34's claim lapses on a reused pid.", { finding: "#33's lock never lapses.", outcome: "ticketed" }, { finding: "A typo in #35's log.", outcome: "ignored" }] });
  assert.deepEqual(OUTCOMES, ["fixed", "ticketed", "taken", "dropped"]);
  assert.deepEqual(
    readFindings(dir).map(({ id, ticket, lane, night, finding, outcome, at }) => ({ id, ticket, lane, night, finding, outcome, at })),
    [
      { id: "36-1", ticket: 36, lane: "1", night: NIGHT, finding: "#34's claim lapses on a reused pid.", outcome: null, at: "2026-11-10T02:00:00.000Z" },
      { id: "36-2", ticket: 36, lane: "1", night: NIGHT, finding: "#33's lock never lapses.", outcome: "ticketed", at: "2026-11-10T02:00:00.000Z" },
      // An outcome outside the four is never taken as one: the finding stays open, its words kept.
      { id: "36-3", ticket: 36, lane: "1", night: NIGHT, finding: "A typo in #35's log.", outcome: null, at: "2026-11-10T02:00:00.000Z" },
    ],
  );
  assert.equal(added.length, 3);
  assert.equal(findingsPath(dir), join(dir, "findings.json"));
});

test("the same finding recorded again (a restart, a second night) is kept once; a new one numbers on", () => {
  const dir = temp();
  recordFindings({ dir, ticket: 36, lane: "1", night: NIGHT, at: AT, items: ["One."] });
  const again = recordFindings({ dir, ticket: 36, lane: "1", night: OTHER_NIGHT, at: AT + 1, items: ["One.", { finding: "Two.", outcome: "taken" }] });
  assert.deepEqual(again.map((row) => row.id), ["36-2"]);
  assert.deepEqual(readFindings(dir).map((row) => [row.id, row.finding, row.outcome]), [["36-1", "One.", null], ["36-2", "Two.", "taken"]]);
  assert.deepEqual(recordFindings({ dir, ticket: 37, lane: null, at: AT, items: [] }), [], "nothing to record writes nothing");
});

test("findingOf reads both shapes of a verdict's foundElsewhere item", () => {
  assert.deepEqual(findingOf("Plain."), { finding: "Plain.", outcome: null });
  assert.deepEqual(findingOf({ finding: "Fixed it.", outcome: "fixed" }), { finding: "Fixed it.", outcome: "fixed" });
  assert.deepEqual(findingOf({ outcome: "dropped" }), { finding: '{"outcome":"dropped"}', outcome: null }, "a shapeless item keeps its words, open");
});

test("a findings record that can't be read is never overwritten: the write is refused", () => {
  const dir = temp();
  writeFileSync(findingsPath(dir), "{ half a file");
  assert.throws(() => recordFindings({ dir, ticket: 36, lane: "1", at: AT, items: ["One."] }), /findings\.json can't be read/);
  assert.equal(readFileSync(findingsPath(dir), "utf8"), "{ half a file");
  assert.deepEqual(readFindings(temp()), [], "no file yet reads as no findings");
});

test("two lanes recording at once lose none of each other's findings", async () => {
  const dir = temp();
  const writer = (lane, ticket) =>
    new Promise((resolve, reject) => {
      const script = `const { recordFindings } = await import(${moduleUrl});
for (let k = 0; k < 15; k += 1) recordFindings({ dir: ${JSON.stringify(dir)}, ticket: ${ticket}, lane: "${lane}", at: ${AT}, items: ["finding " + k] });`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      child.stderr.on("data", (chunk) => (err += chunk));
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err))));
    });
  await Promise.all([writer("1", 36), writer("2", 37)]);
  const rows = readFindings(dir);
  assert.equal(rows.length, 30);
  assert.equal(new Set(rows.map((row) => row.id)).size, 30);
});

// ------------------------------------------------------- every lane's results

/** A branch folder with a one-lane night's results, lane 1's and lane 2's. */
function branchFolder() {
  const dir = temp("brigade-night-");
  const built = (number, title, extra = {}) => ({ number, title, status: "built", hash: `l${number}`, stat: "1 file changed, 2 insertions(+)", summary: `${title}, done.`, outside: [], migrations: [], destructive: [], assumptions: [], runByHand: [], foundElsewhere: [], handedForward: [], notes: [], session: null, reported: false, ...extra });
  write(dir, {
    "results.json": json([built(20, "From a one-lane night", { hash: "o20", runId: "night-0", reported: true })]),
    "lane-1/results.json": json([
      built(30, "Another night's", { lane: "1", landed: true, night: OTHER_NIGHT, reported: true }),
      built(36, "The fingerprint", { lane: "1", landed: true, laneHash: "a36", commit: "c36", night: NIGHT, assumptions: ["Paths stored with /."] }),
      { number: 39, title: "The listed-code rule", status: "parked", detail: "Void the skip too? Recommended: yes.", keptOn: null, session: null, night: NIGHT, reported: false },
    ]),
    "lane-2/results.json": json([
      built(37, "The landing lock", { lane: "2", landed: false, laneBranch: "phase-x-lane-2", night: NIGHT, notes: ["Not landed: the lock was held. The pass stays on phase-x-lane-2; the lane's next start lands it first."], handedForward: ["#38 owes the body."] }),
      { number: 40, title: "Setup's items", status: "failed", lane: "2", landed: false, detail: "Landing parked #40 at its re-gate step, with phase-x unmoved.", keptOn: "phase-x-parked-40", landing: { step: "re-gate" }, session: null, night: NIGHT, reported: false },
      { number: 41, title: "The release night", status: "failed", detail: "The lint gate failed.", keptOn: null, session: null, night: NIGHT, reported: false },
    ]),
  });
  recordFindings({ dir, ticket: 30, lane: "1", night: OTHER_NIGHT, at: AT, items: ["An old night's finding."] });
  recordFindings({ dir, ticket: 36, lane: "1", night: NIGHT, at: AT, items: ["#34's claim lapses on a reused pid."] });
  recordFindings({ dir, ticket: 37, lane: "2", night: NIGHT, at: AT, items: [{ finding: "#33's lane lock never lapses.", outcome: "ticketed" }] });
  return dir;
}

test("every lane's results are read from the branch folder, each tagged with the lane its folder names", () => {
  const dir = branchFolder();
  const results = branchResults(dir);
  assert.deepEqual(results.map((r) => [r.number, r.lane ?? null]), [[20, null], [30, "1"], [36, "1"], [39, "1"], [37, "2"], [40, "2"], [41, "2"]]);
  assert.deepEqual(results.map(laneState), ["built", "landed", "landed", "parked", "unlanded", "parked at Landing", "failed"]);
  assert.deepEqual(onBranch(results).map((r) => r.number), [20, 30, 36, 39, 40, 41], "an unlanded pass is not on the branch");
  assert.deepEqual(resultFiles(dir).map((file) => file.slice(dir.length + 1).replaceAll("\\", "/")), ["results.json", "lane-1/results.json", "lane-2/results.json"]);
  assert.deepEqual(branchResults(temp()), [], "an empty folder has no results");
});

test("the pull request's body lists every lane's landed tickets, saying which lane built each", () => {
  const body = pullRequestBody(onBranch(branchResults(branchFolder())), { spec: 27 });
  assert.match(body, /- #36 The fingerprint \(`l36`\) · lane 1/);
  assert.match(body, /- #20 From a one-lane night \(`o20`\)\n/, "a one-lane result names no lane");
  assert.doesNotMatch(body, /#37/, "an unlanded pass is not on the branch yet");
});

// --------------------------------------------------------------- the report

/** A lane run's state as main() keeps it: lane 2, in the branch folder `claims`. */
function laneRun(dir) {
  return { branch: "phase-x", dir: join(dir, "lane-2"), claims: dir, night: NIGHT, runId: NIGHT, results: loadResults(join(dir, "lane-2", "results.json")), all: [], carried: [], othersLive: ["1"] };
}

test("the lane report lists every lane's tickets of the night, landed, unlanded, parked and failed, saying which lane built each", () => {
  const text = report(laneRun(branchFolder()), { spec: 27 }, []);
  assert.match(text, /lanes 1, 2 · landed 1 · unlanded 1 · parked 2 · failed 1/);
  assert.match(text, /Lane 1 is still running/);
  assert.match(text, /\| # \| Lane \| Ticket \|/);
  assert.match(text, /### Landed\n\n\*\*#36 The fingerprint\*\* · lane 1 · `l36`\n- The fingerprint, done\./);
  assert.match(text, /### Unlanded: passed, not on the branch yet\n\n\*\*#37 The landing lock\*\* · lane 2 · `l37` on `phase-x-lane-2`/);
  assert.match(text, /- ⚠ Not landed: the lock was held\./);
  assert.match(text, /- #36 \(lane 1\): Paths stored with \/\./);
  assert.match(text, /- #37 \(lane 2\): #38 owes the body\./);
  assert.match(text, /### Parked: your decision is needed\n\n\*\*#39 The listed-code rule\*\* · lane 1\n\nVoid the skip too\?/);
  assert.match(text, /\*\*#40 Setup's items\*\* · lane 2\n\nLanding parked #40 at its re-gate step/);
  assert.match(text, /### Failed\n\n\*\*#41 The release night\*\* · lane 2/);
  assert.doesNotMatch(text, /#30|#20/, "only this night's tickets");
});

test("the lane report lists every finding of the night with its outcome, and the record's place", () => {
  const text = report(laneRun(branchFolder()), { spec: 27 }, []);
  assert.match(text, /### Findings/);
  assert.match(text, /- #36 \(lane 1\): #34's claim lapses on a reused pid\. · \*\*open\*\*/);
  assert.match(text, /- #37 \(lane 2\): #33's lane lock never lapses\. · ticketed/);
  assert.match(text, /findings\.json/);
  assert.doesNotMatch(text, /An old night's finding/);
  assert.doesNotMatch(text, /Found in other tickets' code/, "the findings section takes its place");
});

test("a lane report whose findings record can't be read says so, and still reports the tickets", () => {
  const dir = branchFolder();
  writeFileSync(findingsPath(dir), "{ half");
  const text = report(laneRun(dir), { spec: 27 }, []);
  assert.match(text, /⚠ The findings record can't be read/);
  assert.match(text, /#36 The fingerprint/);
});

test("recording a result writes its findings to the branch's one record: a lane's to the shared folder", () => {
  const dir = temp();
  const run = { branch: "phase-x", dir: join(dir, "lane-2"), claims: dir, night: NIGHT, runId: "lane-2-start", results: [], all: [], carried: [] };
  write(dir, { "lane-2/.keep": "" });
  const stamped = recordResult(run, { number: 37, title: "The landing lock", status: "built", hash: "l37", lane: "2", landed: false, assumptions: [], runByHand: [], foundElsewhere: ["#33's lane lock never lapses."], handedForward: [], notes: [], outside: [], migrations: [], destructive: [] });
  assert.equal(stamped.night, NIGHT);
  assert.equal(loadResults(join(dir, "lane-2", "results.json"))[0].night, NIGHT);
  assert.deepEqual(readFindings(dir).map((row) => [row.ticket, row.lane, row.night, row.outcome]), [[37, "2", NIGHT, null]]);

  // A run without lanes: its record is its own branch folder, and its results carry no night.
  const one = { branch: "phase-x", dir: temp(), runId: "night-1", results: [], all: [], carried: [] };
  const plain = recordResult(one, { number: 12, title: "A", status: "built", hash: "h12", assumptions: [], runByHand: [], foundElsewhere: ["#11 drops a row."], handedForward: [], notes: [], outside: [], migrations: [], destructive: [] });
  assert.equal("night" in plain, false);
  assert.deepEqual(readFindings(one.dir).map((row) => [row.ticket, row.lane, row.night]), [[12, null, null]]);
});

test("a findings record that can't be written leaves a note on the result, and the result is still saved", () => {
  const run = { branch: "phase-x", dir: temp(), runId: "night-1", results: [], all: [], carried: [] };
  writeFileSync(findingsPath(run.dir), "{ half");
  const stamped = recordResult(run, { number: 12, title: "A", status: "built", hash: "h12", assumptions: [], runByHand: [], foundElsewhere: ["#11 drops a row."], handedForward: [], notes: [], outside: [], migrations: [], destructive: [] });
  assert.match(stamped.notes.join("\n"), /findings record could not be written/);
  assert.equal(loadResults(join(run.dir, "results.json")).length, 1);
});

// ------------------------------------------------------- a run without lanes

const session = { denials: ["rm -rf x"], minutes: 9, turns: 3, calls: 2, watch: "w1", metrics: { costUsd: 5, peakContext: 120_000, minutes: { total: 9, claude: 5, tests: 1, checks: 1, browser: 0, waiting: 0, reviewing: 1, hook: 0, gates: 1 }, size: { criteria: 4, areas: 2, words: 300 } } };
const built = (number, title, extra = {}) => ({ number, title, status: "built", hash: `h${number}`, stat: "2 files changed, 10 insertions(+), 1 deletion(-)", summary: `A person can do ${number}.`, outside: [], migrations: [], destructive: [], assumptions: [], runByHand: [], foundElsewhere: [], handedForward: [], notes: [], screenshots: null, session, runId: "night-1", reported: false, ...extra });

/** Every section a one-lane report can have: the fixture `tests/fixtures/report-one-lane.txt` was written from the runner before #38. */
function oneLaneRun(dir) {
  return {
    branch: "phase-test",
    dir,
    runId: "night-1",
    brigade: "0.7.0",
    stamp: "0.6.2",
    catalog: { catalog: null, why: "no catalog" },
    pullRequest: "https://github.com/o/r/pull/4",
    docHealth: "docs/a.md   90  /  100  90%  near the limit\ndocs/b.md   10  /  100  10%\n",
    carried: [
      built(160, "Carried build", { runId: "night-0", assumptions: ["Kept the old sort."], foundElsewhere: ["#150's list skips one."] }),
      { number: 161, title: "Carried park", status: "parked", detail: "Who may see it? Recommended: owners.", keptOn: "phase-test-parked-161", runId: "night-0", reported: false },
    ],
    results: [
      built(180, "Announcements", { outside: ["src/x.ts"], migrations: ["0003_add.sql"], destructive: ["0003_add.sql"], screenshots: ".shots/180/", notes: ["The push failed: no network"], assumptions: ["Sorted newest first."], runByHand: ["Set the SMTP secret."], foundElsewhere: ["#170's form drops a field."], handedForward: ["#185 owes the badge."] }),
      built(181, "Calendar | view", { ledger: "not written", ledgerError: "no transcript" }),
      { number: 182, title: "Payroll", status: "parked", detail: "Round half up or down? Recommended: up.", keptOn: "phase-test-parked-182", notPosted: true, session: null, runId: "night-1", reported: false },
      { number: 183, title: "Leave", status: "failed", detail: "The lint gate failed.", keptOn: null, leftOnTarget: ["0004_x.sql"], session, runId: "night-1", reported: false },
    ],
    all: [],
  };
}

test("a run without lanes reports exactly as before #38, word for word", () => {
  const text = report(oneLaneRun(temp()), { spec: 179 }, ["#190 Later: ready, not reached this run"]);
  const expected = readFileSync(join(PLUGIN, "tests", "fixtures", "report-one-lane.txt"), "utf8").replace(/\r\n/g, "\n");
  assert.equal(text.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/m, "<at> UTC"), expected);
});

test("main() stamps a lane's night from the shared copy, only the last lane out posts the report, and results are renamed into place (source pins)", () => {
  const source = readFileSync(join(PLUGIN, "template", "tools", "phase-run", "run.mjs"), "utf8").replace(/\r\n/g, "\n");
  const body = (name) => source.slice(source.indexOf(`function ${name}(`), source.indexOf("\n}\n", source.indexOf(`function ${name}(`)));
  assert.match(body("main"), /if \(lane\) run\.night = snapshot\.manifest\.runId;/);
  // The lane's own lock is released before it looks for others: two lanes stopping together never both wait on each other.
  const main = body("main");
  assert.ok(main.indexOf("if (lane) release();") !== -1 && main.indexOf("if (lane) release();") < main.indexOf("const lastOut = !lane || run.othersLive.length === 0;"));
  assert.match(main, /if \(run\.pullRequest && lastOut\) exec\("gh", \["pr", "comment"/);
  assert.match(main, /if \(lastOut\) finishSnapshot\(run\.runner\);/);
  // The other lane reads this lane's results.json: it is renamed into place, never seen half-written.
  assert.match(body("saveResults"), /writeFileSync\(part,[\s\S]*renameSync\(part, resultsFile\(run\)\)/);
  // The body read every lane's landed results, so a lane edits it as a run without lanes does (owed by #37).
  assert.match(body("ensurePullRequest"), /const all = lane \? onBranch\(branchResults\(run\.claims\)\) : run\.all;/);
  assert.doesNotMatch(body("ensurePullRequest"), /if \(!lane\) exec\("gh", \["pr", "edit"/);
});

// ------------------------------------------------------------- status.mjs

test("laneStatus shows each lane on the branch, live or not, and what it holds", () => {
  const dir = branchFolder();
  const state = temp("brigade-state-");
  write(state, { "lane-1.lock": json({ lane: "1", pid: 111, branch: "phase-x", startedAt: "2026-11-10T01:00:00.000Z" }), "lane-9.lock": json({ lane: "9", pid: 111, branch: "phase-other", startedAt: "2026-11-10T01:00:00.000Z" }) });
  write(dir, {
    "claims.json": json({ claims: [{ ticket: 38, lane: "1", pid: 111, at: "2026-11-10T01:05:00.000Z" }, { ticket: 42, lane: "2", pid: 222, at: "2026-11-10T01:05:00.000Z" }], waiting: [], parked: [] }),
    "lane-1/live.json": json({ label: "X phase run", done: 1, total: 3, startedAt: AT - 60 * 60_000, avgMinutes: 40, finished: [40], current: { number: 38, title: "Findings", startedAt: AT - 10 * 60_000, stage: "gates" } }),
  });
  const lines = laneStatus({ dir, state, branch: "phase-x", alive: (pid) => pid === 111, now: AT });
  const text = lines.join("\n");
  assert.match(text, /Lanes/);
  assert.match(text, /lane 1 · live \(pid 111\) · holds the claim on #38/);
  assert.match(text, /▶ 38 {3}Findings .* gates/);
  assert.match(text, /lane 2 · not running · holds the unlanded pass #37 \(`l37` on `phase-x-lane-2`\)/);
  assert.doesNotMatch(text, /#42/, "a dead lane's claim has lapsed");
  assert.doesNotMatch(text, /lane 9/, "a lane on another branch is not this branch's");
});
