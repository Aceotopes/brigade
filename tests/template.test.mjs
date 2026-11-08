// Tests for template/ as a whole: the starting copy a project gets must pass its own checks on day
// one, before the project has written anything. Lives here, not in template/tools/, because once
// copied into a project the template's root is the project's root.
// Run: node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { docConfigText, render, scaffoldFiles, templateFiles } from "../scripts/setup.mjs";
import { PLUGIN, repo, write } from "./helpers.mjs";

/** The scaffold, rendered as /setup-workflow renders it: the files the template's own docs cite. */
function scaffold() {
  const values = { NAME: "Test", SUMMARY: "A test project.", DATE: "2026-10-27", MODE: "new mode", COMMANDS: "- `node --test`: the tests" };
  return Object.fromEntries(scaffoldFiles().map((rel) => [rel, render(readFileSync(join(PLUGIN, "scaffold", rel), "utf8"), values)]));
}

test("every doc Brigade ships starts at 90% of its line budget or less, so a new project is not told to trim on day one", () => {
  const docs = [
    ...templateFiles().filter((rel) => rel.endsWith(".md")).map((rel) => [rel, readFileSync(join(PLUGIN, "template", rel), "utf8")]),
    ...Object.entries(scaffold()).filter(([rel]) => rel.endsWith(".md")),
  ];
  const full = docs.flatMap(([rel, text]) => {
    const limit = Number(text.match(/^max-lines:\s*(\d+)\s*$/m)?.[1]);
    const lines = text.replace(/\n$/, "").split("\n").length;
    return limit && lines > limit * 0.9 ? [`${rel}: ${lines} of ${limit} lines (${Math.round((lines / limit) * 100)}%)`] : [];
  });
  assert.deepEqual(full, []);
});

test("the whole template, with the scaffold setup writes, passes doc-check on day one", () => {
  const { dir, git } = repo("brigade-template-");
  cpSync(join(PLUGIN, "template"), dir, { recursive: true });
  write(dir, scaffold());
  spawnSync(process.execPath, ["tools/doc-index.mjs"], { cwd: dir });
  git("add", "-A");
  const node = (...args) => spawnSync(process.execPath, ["tools/doc-check.mjs", ...args], { cwd: dir, encoding: "utf8" });
  const check = node();
  assert.equal(check.status, 0, check.stderr);
  const commit = node("--message", "chore: adopt the workflow — devlog #1");
  assert.equal(commit.status, 0, commit.stderr);
});

// 0.6.1: setup adds a project's own top folders to doc-check's PATH_ROOTS, so a template doc that
// names an example path under a common one (`tests/…`) breaks every such project's commits.
test("the template passes doc-check in a project whose code lives in the usual folders", () => {
  const { dir, git } = repo("brigade-template-roots-");
  cpSync(join(PLUGIN, "template"), dir, { recursive: true });
  write(dir, { ...scaffold(), "tools/doc-config.mjs": docConfigText({ pathRoots: ["src", "app", "lib", "test", "tests", "spec", "packages", "scripts"] }) });
  spawnSync(process.execPath, ["tools/doc-index.mjs"], { cwd: dir });
  git("add", "-A");
  const check = spawnSync(process.execPath, ["tools/doc-check.mjs"], { cwd: dir, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});
