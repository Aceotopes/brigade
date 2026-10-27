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
const READERS = ["hooks/guard-shell.mjs", "hooks/stop-gate.mjs", "template/tools/doc-check.mjs"];
/** Set by the owner when starting a run, not by the runner. */
const OWNER_SET = ["PHASE_RUN_NET_HOSTS"];

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
  for (const rel of READERS) {
    for (const [name] of read(rel).matchAll(NAME)) {
      if (OWNER_SET.includes(name)) continue;
      assert.ok(set.has(name), `${rel} reads ${name}, which run.mjs never sets`);
    }
  }
});
