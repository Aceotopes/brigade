// Tests for hooks/ledger.mjs, the attended ledger hook: at the end of every reply in a set-up project
// it appends the session's running total to .phase-run/ledger.jsonl, priced with the plugin's own
// code and price list. Each case runs the real hook process (runHook), PHASE_RUN* stripped.
// Run: node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { latestPerSession, readLedger } from "../template/tools/phase-run/ledger.mjs";
import { loadPrices, sessionCost } from "../template/tools/phase-run/metrics.mjs";
import { PLUGIN, repo, runHook, write } from "./helpers.mjs";

const VERSION = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8")).version;
const PRICES = loadPrices(join(PLUGIN, "template", "tools", "phase-run", "prices.json"));

const USAGE = { input_tokens: 10, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 50_000, output_tokens: 400 };
const reply = (id, usage = USAGE, model = "claude-opus-5-5") => ({ type: "assistant", message: { id, model, usage, content: [] } });
const lines = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

/** A set-up project: a git repo with a .claude/workflow.json. */
function project(files = {}) {
  return repo("brigade-ledger-", { ".claude/workflow.json": '{ "version": 1 }\n', ...files }).dir;
}

/** A session transcript of `rows`, outside the project as Claude Code keeps it. */
function transcript(rows) {
  const file = join(mkdtempSync(join(tmpdir(), "brigade-transcript-")), "session.jsonl");
  writeFileSync(file, lines(rows));
  return file;
}

/** One reply's end: the Stop hook's input as Claude Code sends it. */
function stop(dir, file, { session = "session-1", env = {}, plugin } = {}) {
  const input = { session_id: session, transcript_path: file, cwd: dir, hook_event_name: "Stop", stop_hook_active: false };
  return runHook("ledger.mjs", input, { CLAUDE_PROJECT_DIR: dir, ...env }, { plugin });
}

/** A copy of the plugin's folders the hook reads, for a test to alter. */
function pluginCopy(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "brigade-plugin-"));
  for (const rel of ["hooks", ".claude-plugin", "scripts/versions.mjs", "template/tools/phase-run"]) cpSync(join(PLUGIN, rel), join(dir, rel), { recursive: true });
  write(dir, files);
  return dir;
}

const ledgerOf = (dir) => readLedger(join(dir, ".phase-run", "ledger.jsonl"));

function silent(result) {
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
}

test("a reply in a set-up project appends the session's priced row, attended, at the plugin's version", () => {
  const dir = project();
  const file = transcript([reply("r1"), reply("r1"), reply("r2", { ...USAGE, output_tokens: 900 })]);
  silent(stop(dir, file));

  const rows = ledgerOf(dir);
  assert.equal(rows.length, 1);
  const [row] = rows;
  const cost = sessionCost(file, PRICES);
  assert.equal(row.kind, "attended");
  assert.equal(row.sessionId, "session-1");
  assert.equal(row.transcript, file);
  assert.equal(row.ticket, null);
  assert.equal(row.branch, "main");
  assert.equal(row.brigade, VERSION);
  assert.equal(row.costUsd, cost.costUsd);
  assert.ok(row.costUsd > 0);
  assert.equal(row.tokens.calls, 2);
  assert.equal(row.peakContext, cost.peakContext);
  assert.deepEqual(Object.keys(row.byModel), ["claude-opus-5-5"]);
});

test("a later reply prices only the bytes added since, and its row is the session's running total", () => {
  const dir = project();
  const first = lines([reply("r1"), reply("r2")]);
  const file = transcript([reply("r1"), reply("r2")]);
  silent(stop(dir, file));

  // Bytes already read are changed in place, the same length: only a reader that starts again sees it.
  writeFileSync(file, first.replaceAll('"output_tokens":400', '"output_tokens":999'));
  const added = lines([reply("r3", { ...USAGE, output_tokens: 7_000 })]);
  appendFileSync(file, added);
  silent(stop(dir, file));

  const expected = sessionCost(transcript([reply("r1"), reply("r2"), reply("r3", { ...USAGE, output_tokens: 7_000 })]), PRICES);
  const rows = ledgerOf(dir);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].costUsd, expected.costUsd);
  assert.equal(rows[1].tokens.calls, 3);
  assert.ok(rows[1].costUsd > rows[0].costUsd);
  assert.equal(latestPerSession(rows)[0].costUsd, expected.costUsd);

  // The state names the transcript read to its end, and a rename leaves no temporary file behind.
  const stateDir = join(dir, ".phase-run", "ledger-state");
  assert.deepEqual(readdirSync(stateDir), ["session-1.json"]);
  const state = JSON.parse(readFileSync(join(stateDir, "session-1.json"), "utf8"));
  assert.deepEqual(Object.values(state.files).map((f) => f.offset), [statSync(file).size]);

  silent(stop(dir, file)); // nothing new since: no row
  assert.equal(ledgerOf(dir).length, 2);
});

test("each session keeps its own state, named safely whatever its id", () => {
  const dir = project();
  silent(stop(dir, transcript([reply("a1")]), { session: "one" }));
  silent(stop(dir, transcript([reply("b1"), reply("b2")]), { session: "../two" }));
  assert.deepEqual(readdirSync(join(dir, ".phase-run", "ledger-state")).sort(), ["___two.json", "one.json"]);
  assert.deepEqual(ledgerOf(dir).map((row) => [row.sessionId, row.tokens.calls]), [["one", 1], ["../two", 2]]);
});

test("in a repo without .claude/workflow.json it writes nothing", () => {
  const { dir } = repo("brigade-ledger-plain-");
  silent(stop(dir, transcript([reply("r1")])));
  assert.equal(existsSync(join(dir, ".phase-run")), false);
});

test("ledger.attended: false turns it off", () => {
  const dir = project({ ".claude/workflow.json": '{ "version": 1, "ledger": { "attended": false } }\n' });
  silent(stop(dir, transcript([reply("r1")])));
  assert.equal(existsSync(join(dir, ".phase-run")), false);
});

test("with PHASE_RUN=1 it does nothing, and loads no pricing code first", () => {
  const dir = project();
  const marker = join(mkdtempSync(join(tmpdir(), "brigade-marker-")), "loaded");
  // A pricing module that leaves a marker when it is loaded.
  const plugin = pluginCopy({ "template/tools/phase-run/metrics.mjs": 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.LEDGER_TEST_MARKER, "loaded");\n' });
  const file = transcript([reply("r1")]);

  silent(stop(dir, file, { plugin, env: { LEDGER_TEST_MARKER: marker } }));
  assert.equal(existsSync(marker), true, "the marker module is not loaded at all: the test proves nothing");

  const again = join(mkdtempSync(join(tmpdir(), "brigade-marker-")), "loaded");
  silent(stop(dir, file, { plugin, env: { LEDGER_TEST_MARKER: again, PHASE_RUN: "1" } }));
  assert.equal(existsSync(again), false);

  silent(stop(dir, file, { env: { PHASE_RUN: "1" } })); // the real plugin: no row
  assert.deepEqual(ledgerOf(dir), []);
});

test("a config this plugin refuses still records unless it says attended: false; one that isn't JSON writes nothing", () => {
  // A project a release ahead: a key this plugin's loader doesn't know.
  const ahead = project({ ".claude/workflow.json": '{ "version": 1, "laterKey": {}, "ledger": { "weekStarts": "monday", "later": 1 } }\n' });
  silent(stop(ahead, transcript([reply("r1")])));
  assert.equal(ledgerOf(ahead).length, 1);

  for (const config of ["{ not json", '{ "version": 1, "laterKey": {}, "ledger": { "attended": false } }\n']) {
    const dir = project({ ".claude/workflow.json": config });
    silent(stop(dir, transcript([reply("r1")])));
    assert.equal(existsSync(join(dir, ".phase-run")), false, config);
  }
});

test("a saved state not of the shape the hook writes is read again from the start, not left to stall the session", () => {
  const dir = project();
  const file = transcript([reply("r1"), reply("r2")]);
  // The transcript's own entry with no offset: kept as it is, every later reply would throw.
  const noOffset = JSON.stringify({ files: { [resolve(file)]: { seen: [] } }, total: { nanoUsd: 5 } });
  for (const state of [noOffset, '{ "files": {}, "total": {} }', "[]"]) {
    write(dir, { ".phase-run/ledger-state/session-1.json": state });
    silent(stop(dir, file));
    assert.equal(ledgerOf(dir).at(-1).costUsd, sessionCost(file, PRICES).costUsd, state);
  }
});

test("a missing transcript or an unreadable price list: exit 0, nothing printed, nothing written", () => {

  const dir = project();
  silent(stop(dir, join(dir, "no-such-session.jsonl")));
  silent(runHook("ledger.mjs", { session_id: "s", cwd: dir }, { CLAUDE_PROJECT_DIR: dir })); // no transcript_path at all
  silent(runHook("ledger.mjs", "", { CLAUDE_PROJECT_DIR: dir })); // input that is no object
  assert.equal(existsSync(join(dir, ".phase-run")), false);

  for (const prices of ["{", '{ "fallback": "x", "perMillion": {} }\n']) {
    const plugin = pluginCopy({ "template/tools/phase-run/prices.json": prices });
    silent(stop(dir, transcript([reply("r1")]), { plugin }));
    assert.equal(existsSync(join(dir, ".phase-run")), false, prices);
  }
});

test("a row that cannot be appended saves no state, so the next reply records the whole session", () => {
  const dir = project();
  const ledger = join(dir, ".phase-run", "ledger.jsonl");
  mkdirSync(ledger, { recursive: true }); // a folder where the ledger goes
  const file = transcript([reply("r1")]);
  silent(stop(dir, file));
  assert.equal(existsSync(join(dir, ".phase-run", "ledger-state")), false);

  rmSync(ledger, { recursive: true });
  appendFileSync(file, lines([reply("r2")]));
  silent(stop(dir, file));
  assert.deepEqual(ledgerOf(dir).map((row) => row.tokens.calls), [2]);
});

test("beside a 0.5.x project, whose copied runner has no incremental pricing, the row is priced by the plugin", () => {
  const dir = project({
    ".claude/workflow-version.json": '{ "plugin": "brigade", "version": "0.5.2" }\n',
    // A 0.5.x runner: no sessionCostFrom, no ledger, a four-rate price list with a Haiku row.
    "tools/phase-run/metrics.mjs": "export function sessionUsage() { throw new Error(\"the project's copy was used\"); }\n",
    "tools/phase-run/prices.json": '{ "perMillion": { "claude-haiku-4-5": { "input": 1, "cacheWrite": 1.25, "cacheRead": 0.1, "output": 5 } } }\n',
  });
  const file = transcript([reply("r1"), reply("r2")]);
  silent(stop(dir, file));
  const [row] = ledgerOf(dir);
  assert.equal(row.costUsd, sessionCost(file, PRICES).costUsd);
  assert.equal(row.brigade, VERSION); // the plugin's, not the project's stamp
});

test("the plugin runs it as its own Stop group, with a short timeout and no status line", () => {
  const groups = JSON.parse(readFileSync(join(PLUGIN, "hooks", "hooks.json"), "utf8")).hooks.Stop;
  const mine = groups.filter((group) => group.hooks.some((hook) => hook.command.includes("ledger.mjs")));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].hooks.length, 1);
  const [hook] = mine[0].hooks;
  assert.equal(hook.command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/ledger.mjs"');
  assert.ok(hook.timeout > 0 && hook.timeout <= 30, `timeout ${hook.timeout}`);
  assert.equal(hook.statusMessage, undefined);
});
