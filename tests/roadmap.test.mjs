// Tests for scripts/roadmap.mjs, the work behind /roadmap: GitHub's facts read through a stubbed `gh`,
// the Stands changes they suggest, the rewrite of roadmap.md, the page's data and the filled page.
// Run: node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { applyChanges, githubFacts, pageData, proposeChanges, renderPage } from "../scripts/roadmap.mjs";
import { parseRoadmap } from "../template/tools/roadmap-format.mjs";
import { PLUGIN, repo, write } from "./helpers.mjs";

const ROADMAP = [
  "# Roadmap",
  "",
  "<!-- brigade:roadmap -->",
  "## Modules",
  "",
  "| # | Module | Depends on | Stands |",
  "|---|---|---|---|",
  "| 1 | Accounts | — | building |",
  "| 2 | Inventory | 1 | planned |",
  "| 3 | Payroll | 1, 2 | planned |",
  "",
  "## Phases",
  "",
  "| Phase | Module | Spec | Branch | Stands |",
  "|---|---|---|---|---|",
  "| 0 Skeleton |  | #3 | phase-0 | merged |",
  "| 1A Sign-up | 1 | #12 | phase-1a | building |",
  "| 1B Roles | 1 | #18 | phase-1b | planned |",
  "| 2A Stock counts | 2 | #24 | phase-2a | blocked: waiting on the supplier list |",
  "<!-- /brigade:roadmap -->",
  "",
  "## Noted for later",
  "",
  "- A loyalty card.",
  "",
].join("\n");

/** A stand-in for `gh`: each phase branch's pull request, the specs, and spec #18's tickets. */
function stubGh(prs) {
  return (args) => {
    if (args[0] === "repo") return { url: "https://github.com/owner/gym" };
    if (args[0] === "pr") return prs[args[args.indexOf("--head") + 1]] ? [prs[args[args.indexOf("--head") + 1]]] : [];
    if (args[0] === "issue") return { state: "OPEN", url: `https://github.com/owner/gym/issues/${args[2]}` };
    if (args[0] === "api" && args[1].includes("/issues/18/")) {
      return [
        { number: 19, title: "Who may edit roles", state: "open", html_url: "https://github.com/owner/gym/issues/19", labels: [{ name: "needs-info" }] },
        { number: 20, title: "Role list", state: "open", labels: [{ name: "run-ready" }] },
      ];
    }
    return [];
  };
}

test("GitHub's facts: each phase's pull request by its branch, its spec, and its parked tickets", () => {
  const facts = githubFacts(parseRoadmap(ROADMAP), stubGh({ "phase-1a": { number: 40, state: "MERGED", url: "u40" } }));
  assert.equal(facts.repo, "https://github.com/owner/gym");
  assert.deepEqual(facts.phases["1A Sign-up"].pr, { number: 40, state: "MERGED", url: "u40" });
  assert.equal(facts.phases["1B Roles"].pr, null);
  assert.deepEqual(facts.phases["1B Roles"].parked, [{ number: 19, title: "Who may edit roles", url: "https://github.com/owner/gym/issues/19", label: "needs-info" }]);
});

test("the changes only move forward, never touch a blocked row, and deliver a module once every phase merged", () => {
  const roadmap = parseRoadmap(ROADMAP);
  const merged = (n) => ({ number: n, state: "MERGED", url: `u${n}` });
  const some = proposeChanges(roadmap, githubFacts(roadmap, stubGh({ "phase-1a": merged(40), "phase-2a": merged(41) })));
  assert.deepEqual(some.map((c) => [c.kind, c.name, c.from, c.to]), [["phase", "1A Sign-up", "building", "merged"]], "2A is blocked: the owner's call");
  const all = proposeChanges(roadmap, githubFacts(roadmap, stubGh({ "phase-1a": merged(40), "phase-1b": merged(42) })));
  assert.deepEqual(all.map((c) => [c.id, c.name, c.to]), [
    [1, "1A Sign-up", "merged"],
    [2, "1B Roles", "merged"],
    [3, "1 Accounts", "delivered"],
  ]);
  const open = proposeChanges(roadmap, githubFacts(roadmap, stubGh({ "phase-1b": { number: 43, state: "OPEN" }, "phase-0": { number: 2, state: "OPEN" } })));
  assert.deepEqual(open.map((c) => [c.name, c.to]), [["1B Roles", "building"]], "phase 0 is merged: an open pull request never moves it back");
});

test("applying changes rewrites only those rows' Stands, and keeps the file's line endings", () => {
  const roadmap = parseRoadmap(ROADMAP);
  const changes = proposeChanges(roadmap, githubFacts(roadmap, stubGh({ "phase-1a": { number: 40, state: "MERGED" }, "phase-1b": { number: 42, state: "MERGED" } })));
  const next = applyChanges(ROADMAP, changes);
  assert.match(next, /\| 1A Sign-up \| 1 \| #12 \| phase-1a \| merged \|/);
  assert.match(next, /\| 1 \| Accounts \| — \| delivered \|/);
  assert.equal(next.split("\n").length, ROADMAP.split("\n").length);
  assert.deepEqual(parseRoadmap(next).problems, []);
  const crlf = applyChanges(ROADMAP.replace(/\n/g, "\r\n"), changes);
  assert.ok(crlf.includes("| merged |\r\n") && !/[^\r]\n/.test(crlf));
});

test("the page's data: modules in order with their phases, the next thing to build, the handoff and the phase path", () => {
  const { dir } = repo("brigade-roadmap-", {
    "CLAUDE.md": "---\njob: x\nkind: living\n---\n# Gym Desk\n",
    "docs/status/handoff.md": "# Handoff\n\n## Next step\n\nFinish 1B tonight.\n\n## Waiting on the owner\n\n- The supplier list.\n",
    "docs/agents/workflow.md": "## The path of a phase (since 2026-10-07)\n\n```\n/grill-with-docs → /to-spec\n      → merge\n```\n",
  });
  const roadmap = parseRoadmap(ROADMAP);
  const data = pageData(dir, roadmap, githubFacts(roadmap, stubGh({})), "2026-11-01");
  assert.equal(data.project, "Gym Desk");
  assert.deepEqual(data.modules.map((m) => [m.number, m.phases.length]), [[1, 2], [2, 1], [3, 0]]);
  assert.deepEqual(data.loose.map((p) => p.phase), ["0 Skeleton"]);
  assert.deepEqual(data.next, { module: 1, phase: "1A Sign-up" }, "the first module whose dependencies are delivered, its first open phase");
  assert.equal(data.modules[0].phases[0].specUrl, "https://github.com/owner/gym/issues/12");
  assert.deepEqual(data.upNext, { steps: ["Finish 1B tonight."], waiting: ["The supplier list."] });
  assert.equal(data.waitingOnYou[0].number, 19);
  assert.equal(data.phasePath, "/grill-with-docs → /to-spec → merge");
  assert.deepEqual(data.notes, ["A loyalty card."]);
});

test("the page is Brigade's template, titled after the project, with the data in its data block", () => {
  const page = renderPage({ project: "Gym <Desk>", modules: [], notes: ["a </script> in a note"] });
  assert.match(page, /^<title>Gym &lt;Desk&gt; Roadmap<\/title>/);
  const block = page.match(/<script id="roadmap-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  assert.doesNotMatch(block, /<\/script>/i, "a note cannot close the data block");
  assert.equal(JSON.parse(block).notes[0], "a </script> in a note");
  assert.doesNotMatch(page, /"example":true/, "the example data is gone");
  assert.equal(readFileSync(join(PLUGIN, "skills", "roadmap", "page.html"), "utf8").match(/<script id="roadmap-data"/g).length, 1);
});

test("the command line: check lists the problems, render refuses a roadmap out of format and writes a page offline", () => {
  const { dir } = repo("brigade-roadmap-cli-", { "docs/status/roadmap.md": ROADMAP.replace("| 3 | Payroll | 1, 2 | planned |", "| 3 | Payroll | 1, 2 | someday |") });
  const run = (...args) => spawnSync(process.execPath, [join(PLUGIN, "scripts", "roadmap.mjs"), ...args], { encoding: "utf8" });
  const check = JSON.parse(run("check", dir).stdout);
  assert.equal(check.converted, true);
  assert.match(check.problems[0], /module 3's Stands: "someday"/);
  assert.match(run("render", dir, "--out", join(dir, ".git", "brigade", "roadmap.html"), "--offline").stderr, /out of format/);
  write(dir, { "docs/status/roadmap.md": ROADMAP });
  const out = join(dir, ".git", "brigade", "roadmap.html");
  assert.equal(run("render", dir, "--out", out, "--offline").status, 0);
  assert.match(readFileSync(out, "utf8"), /"name":"Inventory"/);
});
