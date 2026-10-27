// Tests for template/ as a whole: the starting copy a project gets must pass its own checks on day
// one, before the project has written anything. Lives here, not in template/tools/, because once
// copied into a project the template's root is the project's root.
// Run: node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { PLUGIN, repo, write } from "./helpers.mjs";

/**
 * What /setup-workflow (README step 8, not built yet) must write beside the template, because the
 * template's own docs cite these files: this list is that skill's contract. The devlog is read on
 * every commit; the rest are named by docs/agents/ and the ticket prompt (issue-tracker.md may come
 * from mattpocock's /setup-matt-pocock-skills instead).
 */
const header = (job, kind = "living") => `---\njob: ${job}\nkind: ${kind}\nmax-lines: 120\n---\n`;
const SETUP_WRITES = {
  "docs/history/devlog.md": "---\njob: The timeline.\nkind: log\nmax-entry-lines: 15\n---\n# Devlog\n\n## #1 · chore · adopt the workflow\n- the template\n\n---\n",
  "docs/status/roadmap.md": `${header("Where every phase stands.")}# Roadmap\n`,
  "docs/status/handoff.md": `${header("Where things stand and the next step.")}# Handoff\n`,
  "docs/agents/gotchas/README.md": `${header("The traps each phase found.")}# Gotchas\n`,
  "docs/agents/issue-tracker.md": `${header("Where issues live and how they are labelled.")}# Issue tracker\n`,
};

test("the whole template, with the files setup writes, passes doc-check on day one", () => {
  const { dir, git } = repo("brigade-template-");
  cpSync(join(PLUGIN, "template"), dir, { recursive: true });
  write(dir, SETUP_WRITES);
  git("add", "-A");
  const node = (...args) => spawnSync(process.execPath, ["tools/doc-check.mjs", ...args], { cwd: dir, encoding: "utf8" });
  const check = node();
  assert.equal(check.status, 0, check.stderr);
  const commit = node("--message", "chore: adopt the workflow — devlog #1");
  assert.equal(commit.status, 0, commit.stderr);
});
