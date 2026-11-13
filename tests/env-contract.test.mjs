// The phase run's environment contract. The runner (template/tools/phase-run/run.mjs) sets the
// variables a session runs under; the hooks (hooks/*.mjs) and doc-check read them. The two halves
// live in different places once installed (the plugin's cache, the project's repo), so neither can
// import the other's names: this test is what keeps them in step.
//
// Run: node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = "template/tools/phase-run/run.mjs";
const READERS = [
  "hooks/guard-shell.mjs",
  "hooks/ledger.mjs",
  "hooks/stop-gate.mjs",
  "hooks/version-check.mjs",
  "hooks/workflow-config.mjs",
  "template/tools/doc-check.mjs",
  // What a session runs, under the runner's variables.
  "template/tools/phase-run/stop-tests.mjs",
  "template/tools/phase-run/wait-subagents.mjs",
  "template/tools/phase-run/display.mjs",
];
/** Set by the owner when starting a run, not by the runner. */
const OWNER_SET = ["PHASE_RUN_NET_HOSTS", "PHASE_RUN_NOTIFY"];
/** A lane session's values (0.7.0 D2): run.mjs sets them from the lane's row. */
const LANE_SET = ["PHASE_RUN_LANE", "PHASE_RUN_QA_PORT", "PHASE_RUN_QA_DATABASE", "PHASE_RUN_TEST_DB_PREFIX"];
/** Reserved by Brigade (D16) for a project's browser scripts' fake clock: a project's tools may read it, and no runner code sets it. */
const RESERVED = ["PHASE_RUN_FAKE_NOW"];
const RUNNER_CODE = ["template/tools/phase-run/run.mjs", "template/tools/phase-run/lane.mjs", "template/tools/phase-run/config.mjs"];

const NAME = /\bPHASE_RUN(?:_[A-Z]+)*\b/g;

function files(rel) {
  const abs = join(PLUGIN, rel);
  if (statSync(abs).isFile()) return [rel];
  return readdirSync(abs).flatMap((name) => (name === "node_modules" ? [] : files(join(rel, name))));
}

const read = (rel) => readFileSync(join(PLUGIN, rel), "utf8");

test("no Steak To Juan env name is left in the hooks or the template", () => {
  const hits = [...files("hooks"), ...files("template")]
    .map((rel) => rel.replaceAll("\\", "/"))
    .filter((rel) => /\bSTJ_[A-Z]/.test(read(rel)));
  assert.deepEqual(hits, []);
});

test("every PHASE_RUN name a hook or doc-check reads is one the runner sets", () => {
  const runner = read(RUNNER);
  // The names in the session's env block: `PHASE_RUN_X:` keys.
  const set = new Set([...runner.matchAll(/\b(PHASE_RUN(?:_[A-Z]+)*)\s*:/g)].map((m) => m[1]));
  assert.ok(set.has("PHASE_RUN"), "run.mjs no longer sets PHASE_RUN: the hooks would never switch on");
  // The frozen runner copy (ADR 0005): the hooks read the copy, and the copy's scripts find the repo.
  assert.ok(set.has("PHASE_RUN_RUNNER"), "run.mjs no longer sets PHASE_RUN_RUNNER: the hooks would judge by the live tree");
  assert.ok(set.has("PHASE_RUN_ROOT"), "run.mjs no longer sets PHASE_RUN_ROOT: the copy's stop-tests.mjs would test the copy");
  assert.match(read("hooks/workflow-config.mjs"), /PHASE_RUN_RUNNER/, "the hooks' config loader reads the copy");
  assert.match(read("template/tools/phase-run/stop-tests.mjs"), /PHASE_RUN_ROOT/, "stop-tests.mjs finds the repo from the copy");
  for (const rel of READERS) {
    for (const [name] of read(rel).matchAll(NAME)) {
      if (OWNER_SET.includes(name) || RESERVED.includes(name)) continue;
      assert.ok(set.has(name), `${rel} reads ${name}, which run.mjs never sets`);
    }
  }
});

test("a lane session's PHASE_RUN names join the contract: four the runner sets, and PHASE_RUN_FAKE_NOW reserved", () => {
  const runner = read(RUNNER);
  const set = new Set([...runner.matchAll(/\b(PHASE_RUN(?:_[A-Z]+)*)\s*:/g)].map((m) => m[1]));
  for (const name of LANE_SET) assert.ok(set.has(name), `run.mjs no longer sets ${name} for a lane session`);
  for (const name of RESERVED) {
    for (const rel of RUNNER_CODE) assert.doesNotMatch(read(rel), new RegExp(`\\b${name}\\b`), `${rel} names ${name}, which Brigade reserves and no runner code sets`);
  }
});
