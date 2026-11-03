// Tests for hooks/version-check.mjs, the out-of-step notice: at a new session it compares the
// installed Brigade with the project's stamp and names the fix, or says nothing.
// Run: node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { PLUGIN, repo, runHook, write } from "./helpers.mjs";

const VERSION = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8")).version;

/** A set-up project whose stamp records `version`. */
function project(version) {
  const { dir } = repo();
  write(dir, { ".claude/workflow-version.json": `${JSON.stringify({ plugin: "brigade", version }, null, 2)}\n` });
  return dir;
}

function launch(dir, env = {}) {
  return runHook("version-check.mjs", { cwd: dir, hook_event_name: "SessionStart", source: "startup" }, { CLAUDE_PROJECT_DIR: dir, ...env });
}

test("a project older than the plugin is told to type /update-workflow, and Claude is told not to act on it", () => {
  const result = launch(project("0.0.0"));
  assert.equal(result.status, 0);
  const out = JSON.parse(result.stdout);
  const line = `Brigade ${VERSION} is installed, but this project's files are from 0.0.0. Type /update-workflow to see what changed.`;
  assert.equal(out.systemMessage, line);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(out.hookSpecificOutput.additionalContext, /do not act on it unless the owner asks/i);
});

test("a project newer than the plugin names the plugin update, by the plugin's catalog ID, and the reload", () => {
  const out = JSON.parse(launch(project("99.0.0")).stdout);
  assert.equal(
    out.systemMessage,
    `This project is on Brigade 99.0.0, but this machine has ${VERSION}. Run \`claude plugin marketplace update aceotopes\`, then \`claude plugin update brigade@aceotopes\`, then /reload-plugins.`,
  );
});

test("a repo with Brigade on but no stamp is told to type /setup-workflow", () => {
  const { dir } = repo();
  const out = JSON.parse(launch(dir).stdout);
  assert.equal(out.systemMessage, "Brigade is on here, but this repo isn't set up yet. Type /setup-workflow.");
});

test("a project on the plugin's own version starts quietly", () => {
  const result = launch(project(VERSION));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

// Meaningful only while a text comparison would get it wrong ("0.10.0" sorts before "0.4.1" as text);
// scripts/versions.mjs's own test covers the comparison at every version.
const TEXT_SORT_WRONG = /^0\.[2-9]\./.test(VERSION);

test("versions compare as numbers: a 0.10.0 stamp is newer than a 0.x plugin", { skip: !TEXT_SORT_WRONG && `the plugin is ${VERSION}` }, () => {
  assert.match(JSON.parse(launch(project("0.10.0")).stdout).systemMessage, /^This project is on Brigade 0\.10\.0, but this machine has /);
});

test("a stamp it cannot read says nothing and never fails the session start", () => {
  for (const text of ["{ not json", `${JSON.stringify({ plugin: "brigade" })}\n`, `${JSON.stringify({ version: "next" })}\n`]) {
    const { dir } = repo();
    write(dir, { ".claude/workflow-version.json": text });
    const result = launch(dir);
    assert.equal(result.status, 0, text);
    assert.equal(result.stdout, "", text);
  }
});

test("without CLAUDE_PROJECT_DIR the project is the input's cwd", () => {
  const result = launch(project("0.0.0"), { CLAUDE_PROJECT_DIR: "" });
  assert.match(JSON.parse(result.stdout).systemMessage, /this project's files are from 0\.0\.0/);
});

test("inside a phase run it says nothing, whatever the stamp", () => {
  const { dir } = repo();
  for (const at of [project("0.0.0"), project("99.0.0"), dir]) {
    const result = launch(at, { PHASE_RUN: "1" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  }
});

test("the plugin runs it at a fresh launch only, not on resume, /clear or compaction", () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN, "hooks", "hooks.json"), "utf8")).hooks.SessionStart;
  const entries = (hooks ?? []).filter((entry) => entry.hooks.some((hook) => hook.command.includes("version-check.mjs")));
  assert.deepEqual(entries.map((entry) => entry.matcher), ["startup"]);
});
