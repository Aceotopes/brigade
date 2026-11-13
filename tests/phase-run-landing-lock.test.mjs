// 0.7.0 (#37, D13, ADR 0008, ADR 0007): the landing lock. One lane lands at a time, under one lock
// in the primary checkout's `.phase-run/<branch>/`, and the primary checkout is always left in a good
// state: attached again after a landing however it ends (undo-detach), handed back on the phase
// branch's tip by the last lane out, and a restarted lane's unlanded passes found and landed first.
// Every test runs real git on a throwaway repo; the lock races run in real processes.
// Run: node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { claimNext, clearParked, readClaims, readParked, releaseClaim, takeClaim } from "../template/tools/phase-run/claim.mjs";
import { parseRunConfig } from "../template/tools/phase-run/config.mjs";
import { land } from "../template/tools/phase-run/landing.mjs";
import { dropUnlanded, handBack, keepUnlanded, landingLockPath, restartSteps, underLandingLock, unlandedCommits, unlandedRef } from "../template/tools/phase-run/landing-lock.mjs";
import { prepareWorktree, writeLaneLock } from "../template/tools/phase-run/lane.mjs";
import { PLUGIN, repo, write } from "./helpers.mjs";

const BRANCH = "phase-two-lanes";
const PHASE = "two-lanes";
const DEVLOG = "docs/history/devlog.md";
const LOGS = "docs/history/implementation-log";
const ROWS = [
  { path: DEVLOG, kind: "log" },
  { path: LOGS, kind: "log" },
];
const HOTSPOTS = parseRunConfig({ version: 1, phaseRun: { hotspots: { rows: ROWS } } }).hotspots;
const PREAMBLE = "---\njob: The timeline.\nkind: log\n---\n# Devlog\n\n";
const entry = (n, title) => `## #${n} · feat · ${title}\n- x\n\n---\n\n`;
const moduleUrl = (name) => JSON.stringify(pathToFileURL(join(PLUGIN, "template", "tools", "phase-run", name)).href);

/**
 * A phase branch at its base (devlog #5) and two lanes' unlanded passes cut from it: lane 1's #6
 * and lane 2's #7, each with an unnumbered devlog entry and log, on its own lane branch. The
 * primary checkout is on main, where a lane leaves it.
 */
function phaseRepo() {
  const { dir, git } = repo("brigade-landing-lock-");
  git("config", "core.autocrlf", "false");
  write(dir, { [DEVLOG]: `${PREAMBLE}${entry(5, "base")}`, [`${LOGS}/005-base.md`]: "# #005 — base\n", "src/shared.mjs": "export const shared = 1;\n" });
  git("add", "-A");
  git("commit", "-q", "-m", "base — devlog #5");
  git("branch", BRANCH);
  const base = git("rev-parse", "HEAD");
  const message = (n) => `feat(app): lane work — devlog #NNN, Closes #${n}\n`;
  const commitOn = (branch, n, slug) => {
    git("checkout", "-q", branch);
    write(dir, {
      // A lane's one unnumbered entry on top of the base's: numbering refuses two (gotcha #36).
      [DEVLOG]: `${PREAMBLE}## #NNN · feat · ${slug}\n- see implementation log NNN\n\n---\n\n${entry(5, "base")}`,
      [`${LOGS}/NNN-${slug}.md`]: `# #NNN — ${slug}\n`,
      [`src/${slug}.mjs`]: `export const ${slug} = ${n};\n`,
    });
    git("add", "-A");
    writeFileSync(join(dir, ".git", "MSG"), message(n));
    git("commit", "-q", "-F", join(".git", "MSG"));
    const hash = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    return hash;
  };
  git("branch", `${BRANCH}-lane-1`, base);
  git("branch", `${BRANCH}-lane-2`, base);
  const one = commitOn(`${BRANCH}-lane-1`, 6, "one");
  const two = commitOn(`${BRANCH}-lane-2`, 7, "two");
  const runDir = join(dir, ".phase-run", BRANCH);
  return { dir, git, base, one, two, commitOn, runDir, state: join(dir, ".phase-run") };
}

const landOne = (setup, commit, ticket, over = {}) =>
  land({ repo: setup.dir, branch: BRANCH, ticket, commit, hotspots: HOTSPOTS, phase: PHASE, regate: async () => null, ...over });

/** The primary checkout's HEAD: the branch it is on, or null when detached. */
const attachedTo = (setup) => {
  try {
    return setup.git("symbolic-ref", "-q", "--short", "HEAD");
  } catch {
    return null;
  }
};

async function until(check, what, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

/** A node process running `body` (an ES module's text) with the landing modules imported. */
function child(body) {
  const script = [
    `import { underLandingLock } from ${moduleUrl("landing-lock.mjs")};`,
    `import { land } from ${moduleUrl("landing.mjs")};`,
    `import { parseRunConfig } from ${moduleUrl("config.mjs")};`,
    `import { appendFileSync, existsSync, writeFileSync } from "node:fs";`,
    `const hotspots = parseRunConfig({ version: 1, phaseRun: { hotspots: { rows: ${JSON.stringify(ROWS)} } } }).hotspots;`,
    `const pause = (ms) => new Promise((done) => setTimeout(done, ms));`,
    body,
  ].join("\n");
  const proc = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (chunk) => (stderr += chunk));
  return { proc, exited: new Promise((done) => proc.on("close", (code, signal) => done({ code, signal, stderr }))) };
}

// ------------------------------------------------------------------ one lane at a time

test("two lanes landing at once: one holds the lock, the other waits, then lands on the newer tip", { timeout: 120_000 }, async () => {
  const setup = phaseRepo();
  const sync = mkdtempSync(join(tmpdir(), "brigade-landing-race-"));
  const at = (name) => join(sync, name);
  const lanes = { 1: { commit: setup.one, ticket: 6 }, 2: { commit: setup.two, ticket: 7 } };
  const children = [1, 2].map((i) =>
    child(
      [
        `writeFileSync(${JSON.stringify(at(`ready-${i}`))}, "");`,
        `while (!existsSync(${JSON.stringify(at("go"))})) await pause(5);`,
        `const { value } = await underLandingLock({ dir: ${JSON.stringify(setup.runDir)}, root: ${JSON.stringify(setup.dir)}, branch: ${JSON.stringify(BRANCH)}, lane: "${i}", pollMs: 25, onWait: () => writeFileSync(${JSON.stringify(at(`waited-${i}`))}, "") }, async () => {`,
        `  appendFileSync(${JSON.stringify(at("order"))}, "in ${i}\\n");`,
        `  const result = await land({ repo: ${JSON.stringify(setup.dir)}, branch: ${JSON.stringify(BRANCH)}, ticket: ${lanes[i].ticket}, commit: ${JSON.stringify(lanes[i].commit)}, hotspots, phase: ${JSON.stringify(PHASE)}, regate: async () => (await pause(400), null) });`,
        `  appendFileSync(${JSON.stringify(at("order"))}, "out ${i}\\n");`,
        `  return result;`,
        `});`,
        `writeFileSync(${JSON.stringify(at(`result-${i}`))}, JSON.stringify(value));`,
      ].join("\n"),
    ),
  );
  await until(() => existsSync(at("ready-1")) && existsSync(at("ready-2")), "both lanes to start");
  writeFileSync(at("go"), "");
  for (const { exited } of children) {
    const { code, stderr } = await exited;
    assert.equal(code, 0, stderr);
  }
  const order = readFileSync(at("order"), "utf8").trim().split("\n");
  assert.equal(order.length, 4);
  assert.deepEqual([order[0].slice(-1), order[1]], [order[0].slice(-1), `out ${order[0].slice(-1)}`], `one landing at a time (${order.join(", ")})`);
  const first = order[0].slice(-1);
  const second = first === "1" ? "2" : "1";
  assert.deepEqual(order.slice(2), [`in ${second}`, `out ${second}`]);
  assert.ok(existsSync(at(`waited-${second}`)), "the second lane waited on the lock");
  assert.ok(!existsSync(at(`waited-${first}`)));

  const results = Object.fromEntries([1, 2].map((i) => [i, JSON.parse(readFileSync(at(`result-${i}`), "utf8"))]));
  assert.equal(results[first].status, "landed", JSON.stringify(results[first]));
  assert.equal(results[second].status, "landed", JSON.stringify(results[second]));
  const { git } = setup;
  assert.equal(git("rev-parse", BRANCH), results[second].commit);
  assert.equal(git("rev-parse", `${BRANCH}^`), results[first].commit, "the second landed on the tip the first made");
  assert.equal(git("rev-parse", `${BRANCH}^^`), setup.base);
  assert.deepEqual([results[first].numbers.devlog, results[second].numbers.devlog], [6, 7], "and was numbered past it");
  assert.equal(existsSync(landingLockPath(setup.runDir)), false, "the lock is gone");
  assert.equal(attachedTo(setup), "main", "a primary checkout off the phase branch is never touched");
});

// ------------------------------------------------------------------ undo-detach

test("a landing that throws leaves the primary checkout attached and releases the lock; a landing that passes leaves it on the new tip, clean", async () => {
  const setup = phaseRepo();
  setup.git("checkout", "-q", BRANCH); // the one case Landing guards: the owner left the primary on the phase branch
  const lock = landingLockPath(setup.runDir);
  assert.equal(lock, join(setup.dir, ".phase-run", BRANCH, "landing.lock"), "run state, in the primary checkout's branch folder (ADR 0007)");
  await assert.rejects(
    underLandingLock({ dir: setup.runDir, root: setup.dir, branch: BRANCH, lane: "1" }, async () => {
      assert.equal(attachedTo(setup), null, "detached while the branch may move");
      assert.equal(JSON.parse(readFileSync(lock, "utf8")).detached.branch, BRANCH, "the lock records the detach, for a crash");
      throw new Error("boom in the landing");
    }),
    /boom in the landing/,
  );
  assert.equal(attachedTo(setup), BRANCH, "attached again");
  assert.equal(existsSync(lock), false, "and the lock released");

  const { value, notes } = await underLandingLock({ dir: setup.runDir, root: setup.dir, branch: BRANCH, lane: "1" }, () => landOne(setup, setup.one, 6));
  assert.equal(value.status, "landed", JSON.stringify(value));
  assert.deepEqual(notes, []);
  assert.equal(attachedTo(setup), BRANCH);
  assert.equal(setup.git("rev-parse", "HEAD"), value.commit, "on the new tip");
  assert.equal(setup.git("status", "--porcelain", "--untracked-files=no"), "", "with nothing left staged: the branch never moved under a checked-out HEAD");
});

test("a process that exits mid-landing leaves the primary checkout attached and the lock gone", { timeout: 60_000 }, async () => {
  const setup = phaseRepo();
  setup.git("checkout", "-q", BRANCH);
  const { exited } = child(`await underLandingLock({ dir: ${JSON.stringify(setup.runDir)}, root: ${JSON.stringify(setup.dir)}, branch: ${JSON.stringify(BRANCH)}, lane: "1" }, async () => process.exit(7));`);
  const { code, stderr } = await exited;
  assert.equal(code, 7, stderr);
  assert.equal(attachedTo(setup), BRANCH);
  assert.equal(existsSync(landingLockPath(setup.runDir)), false);
});

test("a lane killed mid-landing: its lock lapses, and the next landing attaches the primary checkout again before its own", { timeout: 60_000 }, async () => {
  const setup = phaseRepo();
  setup.git("checkout", "-q", BRANCH);
  const sync = mkdtempSync(join(tmpdir(), "brigade-landing-kill-"));
  const ready = join(sync, "ready");
  const { proc, exited } = child(
    `await underLandingLock({ dir: ${JSON.stringify(setup.runDir)}, root: ${JSON.stringify(setup.dir)}, branch: ${JSON.stringify(BRANCH)}, lane: "2" }, () => { writeFileSync(${JSON.stringify(ready)}, ""); return new Promise(() => setInterval(() => {}, 1000)); });`,
  );
  await until(() => existsSync(ready), "the lane to hold the lock");
  proc.kill("SIGKILL"); // no exit handler runs
  await exited;
  const lock = landingLockPath(setup.runDir);
  assert.ok(existsSync(lock), "a hard kill leaves its lock");
  assert.equal(JSON.parse(readFileSync(lock, "utf8")).detached.branch, BRANCH);
  assert.equal(attachedTo(setup), null, "and the primary detached");

  let during = "unset";
  const { value, notes } = await underLandingLock({ dir: setup.runDir, root: setup.dir, branch: BRANCH, lane: "1" }, () => {
    during = JSON.parse(readFileSync(lock, "utf8")).pid;
    return "landed";
  });
  assert.equal(value, "landed");
  assert.equal(during, process.pid, "the dead lane's lock lapsed and was taken");
  assert.match(notes.join("\n"), /lane 2.*attached again/i, "the crashed landing's detach is undone, and said");
  assert.equal(attachedTo(setup), BRANCH);
  assert.equal(existsSync(lock), false);
});

// ------------------------------------------------------------------ the hand-back

test("the last lane out hands the primary checkout back on the phase branch's tip; while a lane is live it is not touched", () => {
  const setup = phaseRepo();
  setup.git("update-ref", `refs/heads/${BRANCH}`, setup.one, setup.base); // the night landed something
  writeLaneLock(setup.state, { id: "2", pid: 4242, branch: BRANCH, at: 0 });
  const live = handBack({ root: setup.dir, state: setup.state, branch: BRANCH, lane: "1", alive: () => true });
  assert.equal(live.handedBack, false);
  assert.match(live.why, /lane 2/);
  assert.equal(attachedTo(setup), "main", "lane 2 still runs: the primary is left alone");

  write(setup.dir, { "README.md": "an edit of the owner's\n" });
  const dirty = handBack({ root: setup.dir, state: setup.state, branch: BRANCH, lane: "1", alive: () => false });
  assert.equal(dirty.handedBack, false);
  assert.match(dirty.why, /uncommitted/);
  assert.equal(attachedTo(setup), "main", "an owner's edit is never carried or lost");
  setup.git("checkout", "--", "README.md");

  const last = handBack({ root: setup.dir, state: setup.state, branch: BRANCH, lane: "1", alive: () => false });
  assert.equal(last.handedBack, true, last.why);
  assert.equal(attachedTo(setup), BRANCH);
  assert.equal(setup.git("rev-parse", "HEAD"), setup.one, "on the tip");
  assert.equal(handBack({ root: setup.dir, state: setup.state, branch: BRANCH, lane: "1", alive: () => false }).handedBack, true, "already there: nothing to do");
});

// ------------------------------------------------------------------ the restart

test("a restarted lane finds its unlanded passes, kept past the worktree's reset, and lands only those not landed or parked", async () => {
  const setup = phaseRepo();
  const { git, dir } = setup;
  const laneBranch = `${BRANCH}-lane-1`;
  // Lane 1 built #6, landed it, then built #8 and died before landing it: its branch holds both.
  const eight = setup.commitOn(laneBranch, 8, "eight");
  const landed6 = await landOne(setup, setup.one, 6);
  assert.equal(landed6.status, "landed");
  const tree = join(mkdtempSync(join(tmpdir(), "brigade-landing-lanes-")), "lane-1");
  assert.throws(() => prepareWorktree({ root: dir, tree, branch: BRANCH, ownBranch: laneBranch }), /holds commits/, "today's refusal stands without the keep");

  const { kept } = keepUnlanded({ root: dir, branch: BRANCH, laneBranch });
  assert.equal(kept, eight);
  assert.equal(git("rev-parse", unlandedRef(laneBranch)), eight, "kept on a hidden ref, never a branch");
  prepareWorktree({ root: dir, tree, branch: BRANCH, ownBranch: laneBranch, kept });
  assert.equal(git("rev-parse", laneBranch), git("rev-parse", BRANCH), "the lane is reset to the tip");

  const found = unlandedCommits({ root: dir, branch: BRANCH, laneBranch });
  assert.deepEqual(found.map(({ commit, ticket, state }) => ({ commit, ticket, state })), [
    { commit: setup.one, ticket: 6, state: "landed" },
    { commit: eight, ticket: 8, state: "unlanded" },
  ], "oldest first, #6 already on the branch by its Closes #6");

  git("branch", `${BRANCH}-parked-8`, eight);
  assert.deepEqual(unlandedCommits({ root: dir, branch: BRANCH, laneBranch })[1], { commit: eight, ticket: 8, state: "parked", keptOn: `${BRANCH}-parked-8` }, "a kept park is not landed again");
  git("branch", "-D", `${BRANCH}-parked-8`);

  const landed8 = await landOne(setup, eight, 8);
  assert.equal(landed8.status, "landed", JSON.stringify(landed8));
  assert.equal(unlandedCommits({ root: dir, branch: BRANCH, laneBranch })[1].state, "landed");
  dropUnlanded({ root: dir, laneBranch });
  assert.deepEqual(unlandedCommits({ root: dir, branch: BRANCH, laneBranch }), []);
  assert.equal(keepUnlanded({ root: dir, branch: BRANCH, laneBranch }).kept, null, "nothing left to keep");
});

test("a restart's action for each kept commit: land a recorded pass, keep one never recorded, finish a record the last start died before writing", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const c = "c".repeat(40);
  const d = "d".repeat(40);
  const results = [
    { number: 6, lane: "1", status: "built", landed: false, hash: "aaaaaaa", commit: a },
    { number: 7, lane: "1", status: "built", landed: true, laneHash: "ccccccc", hash: "1234567", commit: "1".repeat(40) },
    { number: 9, lane: "1", status: "built", landed: false, hash: "ddddddd", commit: d },
    { number: 9, lane: "2", status: "built", landed: false, hash: "ddddddd", commit: d }, // another lane's: never this one's
  ];
  const found = [
    { commit: a, ticket: 6, state: "unlanded" },
    { commit: b, ticket: 8, state: "unlanded" },
    { commit: c, ticket: 7, state: "landed" },
    { commit: d, ticket: 9, state: "parked", keptOn: `${BRANCH}-parked-9` },
  ];
  const steps = restartSteps({ found, results, lane: 1 });
  assert.deepEqual(steps.map((s) => [s.ticket, s.action]), [[6, "land"], [8, "keep"], [7, "skip"], [9, "record-parked"]]);
  assert.equal(steps[0].result, results[0], "the very result, changed in place by the landing");
  assert.equal(steps[3].result, results[2]);
  assert.equal(steps[3].keptOn, `${BRANCH}-parked-9`);
  const died = restartSteps({ found: [{ commit: a, ticket: 6, state: "landed" }], results, lane: "1" });
  assert.equal(died[0].action, "record-landed", "landed, but its result still says unlanded");
  const other = restartSteps({ found: [{ commit: a, ticket: 6, state: "unlanded" }], results: [{ ...results[0], commit: b, hash: "bbbbbbb" }], lane: "1" });
  assert.equal(other[0].action, "keep", "a result for another commit of the ticket is not this commit's pass");
  // The source's later fix: "built, not landed" was read off an older row of the same ticket. Two rows
  // for one commit (a pass, then its park at Landing): the newest says what the commit is.
  const older = { ...results[0] };
  const newer = { ...results[0], status: "failed", landed: false, keptOn: `${BRANCH}-parked-6` };
  const twice = restartSteps({ found: [{ commit: a, ticket: 6, state: "unlanded" }], results: [older, newer], lane: "1" });
  assert.equal(twice[0].result, newer, "the newest row for that very commit");
  assert.equal(twice[0].action, "keep", "its newest row is no pending pass, so it is never landed off the older one");
});

test("a dead landing's record is undone only while the checkout is still where it left it", async () => {
  const setup = phaseRepo();
  const lock = landingLockPath(setup.runDir);
  const deadRecord = (commit) => {
    write(setup.runDir, { "landing.lock": `${JSON.stringify({ pid: 999_999_999, token: "dead", lane: "2", detached: { branch: BRANCH, commit } })}\n` });
  };
  const under = () => underLandingLock({ dir: setup.runDir, root: setup.dir, branch: BRANCH, lane: "1", alive: (pid) => pid === process.pid }, () => "ran");
  // Handed back since (attached): nothing to undo, and no note claiming otherwise.
  deadRecord(setup.base);
  const back = await under();
  assert.deepEqual(back.notes, []);
  assert.equal(attachedTo(setup), "main");
  // The owner detached at another commit since: left there, and said.
  setup.git("checkout", "-q", "--detach", setup.one);
  deadRecord(setup.base);
  const elsewhere = await under();
  assert.match(elsewhere.notes.join("\n"), /left there/);
  assert.equal(attachedTo(setup), null);
  assert.equal(setup.git("rev-parse", "HEAD"), setup.one, "the owner's checkout is untouched");
  assert.equal(existsSync(lock), false);
});

test("a keep never overwrites another keep's unhandled commits", () => {
  const setup = phaseRepo();
  const laneBranch = `${BRANCH}-lane-1`;
  keepUnlanded({ root: setup.dir, branch: BRANCH, laneBranch });
  setup.git("branch", "-f", laneBranch, setup.two); // another unlanded commit, the keep still holding #6
  assert.throws(() => keepUnlanded({ root: setup.dir, branch: BRANCH, laneBranch }), new RegExp(unlandedRef(laneBranch).replaceAll("/", "\\/")));
});

// ------------------------------------------------------------------ the claim

test("a landed or parked ticket's claim is released under the lock; a parked one is listed, so the other lane never builds it", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "brigade-release-")), ".phase-run", BRANCH);
  const alive = () => true;
  takeClaim({ dir, lane: "1", pid: 111, at: 0, alive, choose: () => 6 });
  takeClaim({ dir, lane: "1", pid: 111, at: 0, alive, choose: () => 8 });
  takeClaim({ dir, lane: "2", pid: 222, at: 0, alive, choose: () => 7 });
  releaseClaim({ dir, ticket: 6, lane: "1", pid: 111, alive });
  assert.deepEqual(readClaims(dir).map((c) => c.ticket), [8, 7], "landed: released");
  releaseClaim({ dir, ticket: 8, lane: "1", parked: true, pid: 111, alive, at: Date.UTC(2026, 10, 10) });
  assert.deepEqual(readClaims(dir).map((c) => c.ticket), [7], "parked: released too");
  assert.deepEqual(readParked(dir).map(({ ticket, lane }) => ({ ticket, lane })), [{ ticket: 8, lane: "1" }]);
  releaseClaim({ dir, ticket: 7, lane: "1", pid: 111, alive });
  assert.deepEqual(readClaims(dir).map((c) => c.ticket), [7], "only the lane's own claim is released");

  let seen = null;
  await claimNext({ dir, lane: "2", pid: 222, alive, now: () => 0, sleep: async () => assert.fail("no wait"), choose: (claims, idle, parked) => ((seen = parked), { ticket: null, waitOn: [] }) });
  assert.deepEqual(seen, [8], "the choice sees the night's parks");
  clearParked(dir, { pid: 222, alive });
  assert.deepEqual(readParked(dir), [], "a new night starts with none");
  assert.deepEqual(readClaims(dir).map((c) => c.ticket), [7], "and keeps the live claims");
});

// ------------------------------------------------------------------ the runner (source pins)

test("a run without lanes never takes the landing lock and behaves as today; a restarted lane lands before it claims", () => {
  const source = readFileSync(join(PLUGIN, "template", "tools", "phase-run", "run.mjs"), "utf8").replace(/\r\n/g, "\n"); // a Windows checkout may have CRLF
  const body = (name) => {
    const at = source.indexOf(`function ${name}(`);
    return source.slice(at, source.indexOf("\n}\n", at));
  };
  const count = (pattern) => (source.match(pattern) ?? []).length;
  assert.equal(count(/\bunderLandingLock\(/g), 1, "one way to the lock");
  assert.match(body("landPass"), /underLandingLock\(/);
  assert.equal(count(/\blandPass\(/g), 3, "landPass is defined once and called from two places");
  assert.match(body("finishBuilt"), /const outcome = lane \? await landPass\(/, "a pass lands only in a lane");
  assert.match(body("finishBuilt"), /const pushing = afterPass\(lane\)\.push;/, "one lane: pushed as today");
  assert.match(body("landUnlanded"), /restartSteps\(/);
  assert.ok(body("landUnlanded").indexOf("takeClaim(") < body("landUnlanded").indexOf("await landPass("), "a restart claims its pass before landing it");
  assert.match(body("landUnlanded"), /if \(kept\) dropUnlanded\(/, "the keep goes only once every commit is kept elsewhere");
  assert.match(body("landPass"), /if \(!landing\.keptOn\) \{[\s\S]*?return "stop";\n {4}\}\n {2}\}\n[\s\S]*resetWorktree\(/, "a park kept nowhere is never reset away");
  const main = body("main");
  assert.match(main, /if \(lane\) \{\n {4}try \{\n {6}outcome = await landUnlanded\(/, "the restart's landing only in a lane");
  assert.ok(main.indexOf("landUnlanded(") < main.indexOf("nextTicket(inScope"), "and before the first claim");
  assert.match(main, /if \(lane\) \{\n {4}process\.on\("exit", \(\) => \{\n {6}const back = handBack\(/, "the hand-back only in a lane");
  assert.ok(main.indexOf('process.on("exit", release)') < main.indexOf("handBack("), "after the lane's own lock is released");
  assert.equal(count(/\bkeepUnlanded\(/g), 1);
  assert.match(main, /const \{ kept \} = keepUnlanded\([^)]*\);\n {6}made = prepareWorktree\(\{[^}]*kept \}\);/, "the keep comes just before the reset");
  assert.match(body("park"), /if \(lane\) releaseParked\(run, n\);/, "a session's park releases its claim in a lane");
  assert.match(body("releaseParked"), /releaseClaim\(\{[^}]*parked: true \}\);/, "as parked, so the other lane never builds it tonight");
});
