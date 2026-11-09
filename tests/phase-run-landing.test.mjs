// 0.7.0 (#36, D13, ADR 0008): Landing puts a lane's passing commit on the phase branch. A pure plan
// (the tip, its last numbers, the lane's commit and the hotspot rows in; the steps out) and an
// executor that carries them out on throwaway repos: replay, settle, number, rebuild, re-gate (the
// migration last), then a compare-and-swap fast-forward and a push. Anything else parks the ticket on
// `<branch>-parked-<N>`, with the phase branch unmoved. The lock and a live lane's call are #37's.
// Run: node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseRunConfig } from "../template/tools/phase-run/config.mjs";
import { takeFingerprint } from "../template/tools/phase-run/fingerprint.mjs";
import { commandStep, land, landingPlan, lastNumbers } from "../template/tools/phase-run/landing.mjs";
import { scratchFor } from "../template/tools/phase-run/numbering.mjs";
import { PLUGIN, repo, write } from "./helpers.mjs";

const ROWS = [
  { path: "docs/history/devlog.md", kind: "log" },
  { path: "docs/history/implementation-log", kind: "log" },
  { path: "docs/history/implementation-log/README.md", kind: "generated" },
  { path: "docs/agents/gotchas/{phase}.md", kind: "own-file" },
];
const HOTSPOTS = parseRunConfig({ version: 1, phaseRun: { hotspots: { rows: ROWS } } }).hotspots;
const PHASE = "two-lanes";
const BRANCH = "phase-two-lanes";
const GOTCHAS = "docs/agents/gotchas/two-lanes.md";
const INDEX = "docs/history/implementation-log/README.md";
const DEVLOG = "docs/history/devlog.md";
const LOGS = "docs/history/implementation-log";

// ------------------------------------------------------------------ the plan (pure)

const PREAMBLE = "---\njob: The timeline.\nkind: log\n---\n# Devlog\n\n";
const entry = (n, title) => `## #${n} · feat · ${title}\n- x\n\n---\n\n`;

function planInputs(over = {}) {
  return {
    branch: BRANCH,
    ticket: 7,
    tip: "a".repeat(40),
    commit: "b".repeat(40),
    files: {
      [DEVLOG]: `${PREAMBLE}## #NNN · feat · the lane's work\n- see implementation log NNN\n\n---\n\n${entry(5, "base")}`,
      [`${LOGS}/NNN-lane-work.md`]: "# #NNN — The lane's work\n\n**Devlog:** `#NNN`\n",
      [INDEX]: "the lane's index\n",
      [scratchFor(GOTCHAS)]: "**`#7` — the lane's block:**\n- see devlog #NNN\n",
      "src/lane.mjs": "export const lane = 2; // NNN stays\n",
    },
    message: "feat(app): the lane's work — devlog #NNN, Closes #7\n",
    tipFiles: { [DEVLOG]: `${PREAMBLE}${entry(6, "the other lane")}${entry(5, "base")}`, [INDEX]: "the tip's index\n", [GOTCHAS]: "# Gotchas\n\n**`#6` — theirs:**\n- one\n" },
    last: { devlog: 6, log: 6 },
    hotspots: HOTSPOTS,
    phase: PHASE,
    ...over,
  };
}

test("the plan is plain data: the same inputs give the same steps, in D13's order, the migration last of the gates", () => {
  const plan = landingPlan(planInputs({ migrations: ["0002_users"], fingerprint: { sources: { "src/lane.mjs": "f".repeat(64) }, screenshots: {} } }));
  assert.deepEqual(plan, landingPlan(planInputs({ migrations: ["0002_users"], fingerprint: { sources: { "src/lane.mjs": "f".repeat(64) }, screenshots: {} } })));
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan, "nothing in it but data");
  assert.deepEqual(
    plan.steps.map((step) => step.do),
    ["replay", "settle", "number", "rebuild", "commit", "re-gate", "browser-check", "migrate", "fast-forward", "push"],
  );
  assert.deepEqual(plan.numbers, { devlog: 7, log: 7 });
  const step = (name) => plan.steps.find((s) => s.do === name);
  assert.deepEqual(step("replay"), { do: "replay", commit: "b".repeat(40), onto: "a".repeat(40) });
  // settle: the index keeps the tip's text (rebuilt next), and the block is folded into the tip's file.
  assert.deepEqual(Object.keys(step("settle").write).sort(), [scratchFor(GOTCHAS), GOTCHAS, INDEX].sort());
  assert.equal(step("settle").write[scratchFor(GOTCHAS)], null);
  assert.equal(step("settle").write[INDEX], "the tip's index\n");
  assert.match(step("settle").write[GOTCHAS], /theirs[\s\S]*the lane's block:\*\*\n- see devlog #7/);
  // number: the entry on top of the tip's, the log renamed; a file on no row is left to git.
  assert.deepEqual(Object.keys(step("number").write).sort(), [DEVLOG, `${LOGS}/007-lane-work.md`, `${LOGS}/NNN-lane-work.md`].sort());
  assert.match(step("number").write[DEVLOG], /^## #7 · feat · the lane's work\n- see implementation log 007\n[\s\S]*^## #6 /m);
  assert.equal(step("number").write[`${LOGS}/NNN-lane-work.md`], null);
  assert.equal(step("rebuild").rows.join(), INDEX);
  assert.deepEqual(step("commit"), { do: "commit", message: "feat(app): the lane's work — devlog #7, Closes #7\n" });
  assert.deepEqual(step("migrate"), { do: "migrate", names: ["0002_users"] });
  assert.deepEqual(step("fast-forward"), { do: "fast-forward", branch: BRANCH, from: "a".repeat(40) });
  assert.deepEqual(step("push"), { do: "push", branch: BRANCH });
});

test("the plan leaves out the steps with nothing to do: no fingerprint, no migration, no generated row, no push", () => {
  const hotspots = parseRunConfig({ version: 1, phaseRun: { hotspots: { rows: ROWS.filter((row) => row.kind !== "generated") } } }).hotspots;
  const plan = landingPlan(planInputs({ hotspots, push: false }));
  assert.deepEqual(plan.steps.map((step) => step.do), ["replay", "settle", "number", "commit", "re-gate", "fast-forward"]);
});

test("the tip's last numbers count the devlog's entries, the numbers its commits cite and the log names", () => {
  // A rotated devlog holds no entries: the commits' citations still give the last number.
  assert.deepEqual(lastNumbers({ entries: [PREAMBLE], logNames: ["015-x.md", "README.md", "009-y.md"], messages: "feat: a — devlog #41, Closes #3\n\nfix: b — devlog #40\n" }), { devlog: 41, log: 15 });
  assert.deepEqual(lastNumbers({ entries: [`${PREAMBLE}${entry(44, "top")}`], logNames: [], messages: "devlog #41" }), { devlog: 44, log: 0 });
  assert.deepEqual(lastNumbers({}), { devlog: 0, log: 0 });
  assert.deepEqual(lastNumbers({ logNames: ["999-y.md", "1000-x.md"] }).log, 1000, "past three digits");
});

// ------------------------------------------------------------------ the executor (throwaway repos)

const BASE_DEVLOG = `${PREAMBLE}${entry(5, "base")}`;
// The rebuild: a tiny real index job, run on the numbered tree.
const INDEX_JOB = [
  'import { readdirSync, writeFileSync } from "node:fs";',
  `const dir = ${JSON.stringify(LOGS)};`,
  'const names = readdirSync(dir).filter((name) => /^\\d{3}-.+\\.md$/.test(name)).sort();',
  'writeFileSync(`${dir}/README.md`, names.map((name) => `- ${name}`).join("\\n") + "\\n");',
  "",
].join("\n");
const SHARED = Array.from({ length: 12 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join("\n") + "\n";

const gitIn = (dir) => (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

/**
 * A phase branch where the other lane landed #6 first, and lane 2's #7 commit, cut from the base,
 * on its own branch. `base` adds files to the base; `lane` and `other` add or replace files of each side's commit.
 */
function twoLanes({ base: baseFiles = {}, lane = {}, other = {}, laneMessage = "feat(app): the lane's work — devlog #NNN, Closes #7\n" } = {}) {
  const { dir, git } = repo("brigade-landing-");
  git("config", "core.autocrlf", "false");
  write(dir, {
    [DEVLOG]: BASE_DEVLOG,
    [`${LOGS}/005-base.md`]: "# #005 — base\n",
    [INDEX]: "- 005-base.md\n",
    [GOTCHAS]: "# Gotchas\n\n## The blocks\n",
    "src/shared.mjs": SHARED,
    "tools/index.mjs": INDEX_JOB,
    ...baseFiles,
  });
  git("add", "-A");
  git("commit", "-q", "-m", "base — devlog #5");
  git("branch", BRANCH);
  const base = git("rev-parse", "HEAD");

  const origin = mkdtempSync(join(tmpdir(), "brigade-landing-origin-"));
  execFileSync("git", ["init", "-q", "--bare", origin]);
  git("remote", "add", "origin", origin);

  const commitOn = (branch, files, message) => {
    git("checkout", "-q", branch);
    for (const [path, text] of Object.entries(files)) {
      if (text === null) git("rm", "-q", path);
      else write(dir, { [path]: text });
    }
    git("add", "-A");
    writeFileSync(join(dir, ".git", "MSG"), message);
    git("commit", "-q", "-F", join(".git", "MSG"));
    const hash = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    return hash;
  };

  git("branch", `${BRANCH}-lane-2`, base);
  const laneCommit = commitOn(
    `${BRANCH}-lane-2`,
    {
      [DEVLOG]: `${PREAMBLE}## #NNN · feat · the lane's work\n- see implementation log NNN\n\n---\n\n${entry(5, "base")}`,
      [`${LOGS}/NNN-lane-work.md`]: "# #NNN — The lane's work\n\n**Devlog:** `#NNN`\n",
      [INDEX]: "- 005-base.md\n- NNN-lane-work.md\n",
      [scratchFor(GOTCHAS)]: "**`#7` — the lane's block:**\n- see devlog #NNN\n",
      "src/lane.mjs": "export const lane = 2;\n",
      ...lane,
    },
    laneMessage,
  );
  const otherCommit = commitOn(
    BRANCH,
    {
      [DEVLOG]: `${PREAMBLE}${entry(6, "the other lane")}${entry(5, "base")}`,
      [`${LOGS}/006-other.md`]: "# #006 — other\n",
      [INDEX]: "- 005-base.md\n- 006-other.md\n",
      [GOTCHAS]: "# Gotchas\n\n## The blocks\n\n**`#6` — theirs:**\n- one\n",
      "src/other.mjs": "export const other = 1;\n",
      ...other,
    },
    "feat(app): the other lane — devlog #6, Closes #6\n",
  );
  git("push", "-q", "origin", BRANCH);
  return { dir, git, origin, base, laneCommit, otherCommit, originGit: gitIn(origin) };
}

const passing = (label) => commandStep(label, 'node -e "process.exit(0)"');
const failing = (label) => commandStep(label, `node -e "console.error('${label} failed here'); process.exit(1)"`);

function landIt(setup, over = {}) {
  return land({
    repo: setup.dir,
    branch: BRANCH,
    ticket: 7,
    commit: setup.laneCommit,
    hotspots: HOTSPOTS,
    phase: PHASE,
    remote: "origin",
    rebuild: commandStep("rebuild", "node tools/index.mjs"),
    regate: passing("tests"),
    ...over,
  });
}

/** Only the primary checkout is left: Landing's scratch worktree is gone on every way out. */
function onlyPrimary(setup) {
  const trees = setup.git("worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "));
  assert.equal(trees.length, 1, trees.join("\n"));
}

test("the other lane landed first: the lane's commit is replayed, numbered N+1, rebuilt, re-gated on the numbered tree, fast-forwarded and pushed", async () => {
  const setup = twoLanes();
  const seen = [];
  const result = await landIt(setup, {
    // Real jobs: each fails unless it runs on the numbered, rebuilt tree.
    regate: async (dir, at) => {
      seen.push(at.base);
      for (const check of [
        `node -e "require('fs').statSync('${LOGS}/007-lane-work.md')"`,
        `node -e "process.exit(require('fs').readFileSync('${DEVLOG}','utf8').includes('#NNN') ? 1 : 0)"`,
        `node -e "process.exit(require('fs').readFileSync('${INDEX}','utf8').includes('007-lane-work.md') ? 0 : 1)"`,
      ]) {
        const failed = await commandStep("tests", check)(dir);
        if (failed) return failed;
      }
      return null;
    },
  });
  assert.equal(result.status, "landed", JSON.stringify(result));
  assert.deepEqual(result.numbers, { devlog: 7, log: 7 });
  assert.deepEqual(seen, [setup.otherCommit], "the re-gate is told the tip it lands on");

  const { git } = setup;
  const tip = git("rev-parse", BRANCH);
  assert.equal(tip, result.commit);
  assert.equal(git("rev-parse", `${BRANCH}^`), setup.otherCommit, "a fast-forward of the other lane's tip");
  assert.equal(setup.originGit("rev-parse", BRANCH), tip, "pushed");
  assert.equal(git("log", "-1", "--format=%B", BRANCH), "feat(app): the lane's work — devlog #7, Closes #7");
  const at = (path) => git("show", `${BRANCH}:${path}`);
  assert.match(at(DEVLOG), /## #7 · feat · the lane's work\n- see implementation log 007\n[\s\S]*## #6 · feat · the other lane[\s\S]*## #5 /);
  assert.equal(at(`${LOGS}/007-lane-work.md`), "# #007 — The lane's work\n\n**Devlog:** `#7`");
  assert.equal(at(INDEX), "- 005-base.md\n- 006-other.md\n- 007-lane-work.md");
  assert.match(at(GOTCHAS), /theirs:\*\*\n- one\n\n\*\*`#7` — the lane's block:\*\*\n- see devlog #7$/);
  const tree = git("ls-tree", "-r", "--name-only", BRANCH);
  assert.doesNotMatch(tree, /NNN|^\.lane\//m);
  assert.match(tree, /^src\/lane\.mjs$/m);
  assert.match(tree, /^src\/other\.mjs$/m);
  assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "main", "the primary checkout is never touched");
  onlyPrimary(setup);
});

test("a conflict in a file on no hotspot row parks the ticket on -parked-<N>, the phase branch unmoved", async () => {
  const setup = twoLanes({ lane: { "src/shared.mjs": SHARED.replace("= 1;", "= 'lane';") }, other: { "src/shared.mjs": SHARED.replace("= 1;", "= 'other';") } });
  let gated = false;
  const result = await landIt(setup, { regate: async () => ((gated = true), null) });
  assert.equal(result.status, "parked");
  assert.equal(result.step, "replay");
  assert.equal(result.keptOn, `${BRANCH}-parked-7`);
  assert.match(result.detail, /src\/shared\.mjs/);
  assert.equal(setup.git("rev-parse", BRANCH), setup.otherCommit, "the phase branch is unmoved");
  assert.equal(setup.git("rev-parse", result.keptOn), setup.laneCommit, "the lane's commit is kept as it passed");
  assert.equal(gated, false);
  assert.equal(setup.originGit("rev-parse", BRANCH), setup.otherCommit);
  onlyPrimary(setup);
});

test("a failed re-gate parks the ticket the same way, the lane's commit kept and the numbered attempt named, and the migration never runs", async () => {
  const setup = twoLanes({ lane: { "migrations/0002_users.sql": "create table users();\n" } });
  const calls = [];
  const result = await landIt(setup, {
    regate: async (dir) => (calls.push("re-gate"), failing("tests")(dir)),
    migration: { added: /^migrations\/(\d+_[^/]+)\.sql$/, apply: async () => (calls.push("migrate"), null) },
  });
  assert.equal(result.status, "parked");
  assert.equal(result.step, "re-gate");
  assert.match(result.detail, /tests failed here/);
  assert.deepEqual(calls, ["re-gate"]);
  assert.equal(setup.git("rev-parse", BRANCH), setup.otherCommit);
  assert.equal(setup.git("rev-parse", result.keptOn), setup.laneCommit, "the lane's commit is kept unnumbered, so it can land again");
  assert.equal(setup.git("rev-parse", `${result.attempt}^`), setup.otherCommit, "the numbered attempt is named, on the tip it was tried on");
  assert.match(setup.git("log", "-1", "--format=%B", result.attempt), /devlog #7, Closes #7/);
  onlyPrimary(setup);
});

test("the migration runs last, after the re-gate: a failed one parks the ticket before the fast-forward, a passing one lands", async () => {
  const migrationFile = { "migrations/0002_users.sql": "create table users();\n" };
  const failed = twoLanes({ lane: migrationFile });
  const calls = [];
  const parked = await landIt(failed, {
    regate: async () => (calls.push("re-gate"), null),
    migration: { added: /^migrations\/(\d+_[^/]+)\.sql$/, apply: async (dir, names) => (calls.push(`migrate ${names.join()}`), failing("migration")(dir)) },
  });
  assert.equal(parked.status, "parked");
  assert.equal(parked.step, "migrate");
  assert.deepEqual(calls, ["re-gate", "migrate 0002_users"]);
  assert.equal(failed.git("rev-parse", BRANCH), failed.otherCommit);
  onlyPrimary(failed);

  const ok = twoLanes({ lane: migrationFile });
  const landed = await landIt(ok, { migration: { added: /^migrations\/(\d+_[^/]+)\.sql$/, apply: passing("migration") } });
  assert.equal(landed.status, "landed");
  assert.deepEqual(landed.migrations, ["0002_users"]);
});

test("a tip that moves between the re-gate and the fast-forward fails the compare-and-swap: parked, the branch left alone, the report saying it moved", async () => {
  const setup = twoLanes();
  let moved = null;
  const result = await landIt(setup, {
    // A third landing in the middle of this one: the branch moves while the re-gate runs.
    regate: async () => {
      const tree = setup.git("rev-parse", `${setup.otherCommit}^{tree}`);
      moved = setup.git("commit-tree", tree, "-p", setup.otherCommit, "-m", "landed meanwhile");
      setup.git("update-ref", `refs/heads/${BRANCH}`, moved);
      return null;
    },
  });
  assert.equal(result.status, "parked");
  assert.equal(result.step, "fast-forward");
  assert.equal(result.branchMoved, true);
  assert.match(result.detail, /moved during landing/);
  assert.equal(setup.git("rev-parse", BRANCH), moved, "the branch is left where the other landing put it");
  assert.equal(setup.git("rev-parse", result.keptOn), setup.laneCommit);
  assert.equal(setup.originGit("rev-parse", BRANCH), setup.otherCommit, "nothing pushed");
  onlyPrimary(setup);
});

test("a compare-and-swap that fails on a branch still at the tip is not reported as moved", async () => {
  const setup = twoLanes();
  const lock = join(setup.dir, ".git", "refs", "heads", `${BRANCH}.lock`);
  // Another git process holds the branch's ref lock while the re-gate runs.
  const result = await landIt(setup, { regate: async () => (writeFileSync(lock, ""), null) });
  rmSync(lock, { force: true });
  assert.equal(result.status, "parked");
  assert.equal(result.step, "fast-forward");
  assert.equal(result.branchMoved, false);
  assert.doesNotMatch(result.detail, /moved during landing/);
  assert.match(result.detail, /still at/);
  assert.equal(setup.git("rev-parse", BRANCH), setup.otherCommit);
});

test("a second park never overwrites the first: the next free parked name is taken", async () => {
  const setup = twoLanes({ lane: { "src/shared.mjs": SHARED.replace("= 1;", "= 'lane';") }, other: { "src/shared.mjs": SHARED.replace("= 1;", "= 'other';") } });
  setup.git("branch", `${BRANCH}-parked-7`, setup.base);
  const result = await landIt(setup);
  assert.equal(result.keptOn, `${BRANCH}-parked-7-2`);
  assert.equal(setup.git("rev-parse", `${BRANCH}-parked-7`), setup.base, "the earlier park's work is left alone");
  assert.equal(setup.git("rev-parse", result.keptOn), setup.laneCommit);
  // The same commit parked again reuses its branch.
  assert.equal((await landIt(setup)).keptOn, `${BRANCH}-parked-7-2`);
});

test("an error of Landing's own parks the ticket too: two unnumbered entries refused by the numbering", async () => {
  const two = `${PREAMBLE}## #NNN · feat · one\n- a\n\n## #NNN · feat · two\n- b\n\n${entry(5, "base")}`;
  const setup = twoLanes({ lane: { [DEVLOG]: two } });
  const result = await landIt(setup);
  assert.equal(result.status, "parked");
  assert.equal(result.step, "plan");
  assert.match(result.detail, /2 unnumbered entries/);
  assert.equal(setup.git("rev-parse", BRANCH), setup.otherCommit);
  onlyPrimary(setup);
});

test("a log row written as a pattern still finds the tip's logs, so the number does not restart", async () => {
  const rows = ROWS.map((row) => (row.path === LOGS ? { path: `${LOGS}/*.md`, kind: "log" } : row));
  const hotspots = parseRunConfig({ version: 1, phaseRun: { hotspots: { rows } } }).hotspots;
  const result = await landIt(twoLanes(), { hotspots });
  assert.equal(result.status, "landed", JSON.stringify(result));
  assert.deepEqual(result.numbers, { devlog: 7, log: 7 });
});

const PAGE = Array.from({ length: 12 }, (_, i) => `<p>${i + 1}</p>`).join("\n") + "\n";
const LANE_PAGE = PAGE.replace("<p>1</p>", "<p>the lane's</p>");

/** The lane's worktree as its browser check left it: its page, and the screenshot it counted (never committed). */
function laneTree() {
  const root = mkdtempSync(join(tmpdir(), "brigade-landing-lane-"));
  write(root, { "src/page.html": LANE_PAGE, "shots/7/home.png": "a screenshot" });
  return { root, fingerprint: takeFingerprint({ root, changed: ["src/page.html", DEVLOG], sourceFiles: /^src\//, shots: ["shots/7/home.png"] }) };
}

test("an unchanged fingerprint carries the browser check's pass; a changed one re-runs it, and its failure parks", async () => {
  // The base has the page, so each side's edit is a change, not an add.
  const withPage = (other = {}) => twoLanes({ base: { "src/page.html": PAGE }, lane: { "src/page.html": LANE_PAGE }, other });
  const lane = laneTree();
  const fp = { fingerprint: lane.fingerprint, shotsRoot: lane.root };

  const carried = withPage();
  let checks = 0;
  const carry = await landIt(carried, { ...fp, browserCheck: async () => (checks++, null) });
  assert.equal(carry.status, "landed", JSON.stringify(carry));
  assert.equal(carry.browserCheck.verdict, "carry");
  assert.match(carry.browserCheck.note, /a shared file the ticket never changed is not in the fingerprint/i, "it says what the carry vouches for (D12's scope)");
  assert.equal(checks, 0, "an unchanged fingerprint never re-runs the check");

  // The other lane edited the same page far from the lane's line: git merges it, and the page changed.
  const changed = withPage({ "src/page.html": PAGE.replace("<p>12</p>", "<p>theirs</p>") });
  const seen = [];
  const recheck = await landIt(changed, { ...fp, browserCheck: async (dir, why) => (seen.push(why), null) });
  assert.equal(recheck.status, "landed", JSON.stringify(recheck));
  assert.deepEqual(seen, [{ verdict: "re-check", file: "src/page.html", why: "changed" }]);
  assert.equal(recheck.browserCheck.verdict, "re-check");
  assert.match(changed.git("show", `${BRANCH}:src/page.html`), /the lane's[\s\S]*theirs/);

  const again = withPage({ "src/page.html": PAGE.replace("<p>12</p>", "<p>theirs</p>") });
  const parked = await landIt(again, { ...fp, browserCheck: async () => "The home screen shows the old list." });
  assert.equal(parked.status, "parked");
  assert.equal(parked.step, "browser-check");
  assert.match(parked.detail, /old list/);
  assert.equal(again.git("rev-parse", BRANCH), again.otherCommit);
});

test("Landing never forces: no force flag, no forced refspec, and the fast-forward names the tip it expects", () => {
  const src = readFileSync(join(PLUGIN, "template/tools/phase-run/landing.mjs"), "utf8");
  assert.doesNotMatch(src, /--force|"push", "-f"|"branch", "-f"|"\+refs/);
  assert.match(src, /"update-ref", `refs\/heads\/\$\{[\w.]+\}`, \w+, \w+/, "update-ref with the expected old value: a compare-and-swap");
});
