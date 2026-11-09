// 0.7.0 (#30, ADR 0006): a lane writes the token `NNN` wherever a number goes, and a pure numbering
// step fills the numbers in from the phase branch's tip, following the `phaseRun.hotspots` rows.
// What Landing does with the result (replay, rebuild, re-gate) is #36's.
// Run: node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { NUMBER_TOKEN } from "../template/tools/doc-config.mjs";
import { HOTSPOT_TOKEN, parseRunConfig } from "../template/tools/phase-run/config.mjs";
import { LANE_DIR, numberLane, scratchFor } from "../template/tools/phase-run/numbering.mjs";
import { promptValues, render, runVariables } from "../template/tools/phase-run/run.mjs";

/** The message an error carries: `assert.throws` tests a RegExp against `Error: …` (the #29 gotcha). */
function refusal(fn) {
  try {
    fn();
  } catch (error) {
    return error.message;
  }
  return "(nothing thrown)";
}

const ROWS = [
  { path: "docs/history/devlog.md", kind: "log" },
  { path: "docs/history/implementation-log", kind: "log" },
  { path: "docs/history/implementation-log/README.md", kind: "generated" },
  { path: "docs/README.md", kind: "generated" },
  { path: "docs/agents/gotchas/{phase}.md", kind: "own-file" },
];
const HOTSPOTS = parseRunConfig({ version: 1, phaseRun: { hotspots: { rows: ROWS } } }).hotspots;

const PREAMBLE = "---\njob: The timeline.\nkind: log\n---\n# Devlog\n\n";
const TIP_DEVLOG = `${PREAMBLE}## #41 · feat · the tip's own\n- landed first\n\n---\n\n## #40 · feat · older\n- x\n\n---\n`;
const LANE_DEVLOG = `${PREAMBLE}## #NNN · feat · the lane's work\n- built in lane 2\n**Record:** implementation log NNN.\n\n---\n\n## #40 · feat · older\n- x\n\n---\n`;
const LANE_LOG = "# #NNN — The lane's work\n\n**Ticket:** `#7` · **Devlog:** `#NNN`\n**Date:** 2026-11-09\n";
const TIP_GOTCHAS = "# Gotchas — Phase two-lanes\n\n## The blocks\n\n**`#6` — the tip's block (built 2026-11-09):**\n- one\n";
const BLOCK = "**`#7` — the lane's block (built 2026-11-09):**\n- see devlog #NNN\n";

function landing(overrides = {}) {
  return numberLane({
    files: {
      "docs/history/devlog.md": LANE_DEVLOG,
      "docs/history/implementation-log/NNN-lane-work.md": LANE_LOG,
      "docs/README.md": "the lane's index",
      [scratchFor("docs/agents/gotchas/two-lanes.md")]: BLOCK,
      "src/app.mjs": "// NNN stays: this file is on no row\n",
      "src/gone.mjs": null,
    },
    message: "feat(app): the lane's work — devlog #NNN, Closes #7\n",
    tip: { "docs/history/devlog.md": TIP_DEVLOG, "docs/README.md": "the tip's index", "docs/agents/gotchas/two-lanes.md": TIP_GOTCHAS },
    last: { devlog: 41, log: 15 },
    hotspots: HOTSPOTS,
    phase: "two-lanes",
    ...overrides,
  });
}

test("doc-config's token is the runner's phaseRun.hotspots.token default", () => {
  assert.equal(NUMBER_TOKEN, HOTSPOT_TOKEN);
  assert.equal(HOTSPOT_TOKEN, "NNN");
});

test("given a tip at devlog N, the lane's entry becomes N+1 in its heading, its log and the message", () => {
  const out = landing();
  assert.deepEqual(out.numbers, { devlog: 42, log: 16 });
  assert.equal(out.message, "feat(app): the lane's work — devlog #42, Closes #7\n");
  // The devlog: the lane's one entry, numbered, on top of the tip's own entries.
  const devlog = out.files["docs/history/devlog.md"];
  assert.ok(devlog.startsWith(`${PREAMBLE}## #42 · feat · the lane's work\n- built in lane 2\n**Record:** implementation log 016.\n\n---\n\n## #41 · feat`), devlog);
  assert.equal((devlog.match(/^## #40 /gm) ?? []).length, 1, "the older entry is the tip's, not doubled");
  // The log: renamed to the next number, its title the log's number, its devlog line the devlog's.
  assert.equal(out.files["docs/history/implementation-log/NNN-lane-work.md"], null);
  assert.equal(out.files["docs/history/implementation-log/016-lane-work.md"], "# #016 — The lane's work\n\n**Ticket:** `#7` · **Devlog:** `#42`\n**Date:** 2026-11-09\n");
  assert.ok(!JSON.stringify(out).includes("#NNN"), "no token left in a hotspot file or the message");
});

test("files on no hotspot row are left as the lane wrote them, the token included", () => {
  const out = landing();
  assert.equal(out.files["src/app.mjs"], "// NNN stays: this file is on no row\n");
  assert.equal(out.files["src/gone.mjs"], null);
});

test("a generated file keeps the tip's text, and every generated row is listed for the rebuild", () => {
  const out = landing();
  assert.equal(out.files["docs/README.md"], "the tip's index");
  assert.deepEqual(out.rebuild, ["docs/README.md", "docs/history/implementation-log/README.md"]);
});

test("a lane's gotchas block in .lane/ is folded into the phase's gotchas file by the own-file rule", () => {
  assert.equal(scratchFor("docs/agents/gotchas/two-lanes.md"), `${LANE_DIR}/docs/agents/gotchas/two-lanes.md`);
  const out = landing();
  assert.equal(out.files["docs/agents/gotchas/two-lanes.md"], `${TIP_GOTCHAS}\n**\`#7\` — the lane's block (built 2026-11-09):**\n- see devlog #42\n`);
  assert.equal(out.files[scratchFor("docs/agents/gotchas/two-lanes.md")], null, "the scratch file goes");
  // No gotchas file on the tip yet: the block starts it.
  const first = landing({ tip: { "docs/history/devlog.md": TIP_DEVLOG } });
  assert.equal(first.files["docs/agents/gotchas/two-lanes.md"], "**`#7` — the lane's block (built 2026-11-09):**\n- see devlog #42\n");
});

test("a row may name its files by a pattern, and keeps the tip's line endings", () => {
  const rows = [
    { path: "docs/history/devlog.md", kind: "log" },
    { path: "docs/history/implementation-log/*.md", kind: "log" },
    { path: "docs/agents/gotchas/*.md", kind: "own-file" },
  ];
  const out = numberLane({
    files: { "docs/history/devlog.md": LANE_DEVLOG, "docs/history/implementation-log/NNN-lane-work.md": LANE_LOG, [scratchFor("docs/agents/gotchas/two-lanes.md")]: BLOCK },
    message: "x — devlog #NNN",
    tip: { "docs/history/devlog.md": TIP_DEVLOG.replace(/\n/g, "\r\n"), "docs/agents/gotchas/two-lanes.md": TIP_GOTCHAS },
    last: { devlog: 9, log: 99 },
    hotspots: { token: null, rows },
    phase: null,
  });
  assert.ok(out.files["docs/history/implementation-log/100-lane-work.md"].startsWith("# #100 — "));
  assert.ok(out.files["docs/agents/gotchas/two-lanes.md"].endsWith("- see devlog #10\n"));
  const devlog = out.files["docs/history/devlog.md"];
  assert.ok(devlog.includes("## #10 · feat · the lane's work\r\n- built in lane 2\r\n"), JSON.stringify(devlog.slice(0, 200)));
  assert.ok(!/[^\r]\n/.test(devlog), "every line ends as the tip's do");
});

test("a project's own token is filled in, and the default one then left alone", () => {
  const out = numberLane({
    files: { "docs/history/devlog.md": LANE_DEVLOG.replaceAll("NNN", "XX") },
    message: "x — devlog #XX (not NNN)",
    tip: { "docs/history/devlog.md": TIP_DEVLOG },
    last: { devlog: 41, log: 15 },
    hotspots: { token: "XX", rows: ROWS },
  });
  assert.equal(out.message, "x — devlog #42 (not NNN)");
  assert.match(out.files["docs/history/devlog.md"], /^## #42 · feat/m);
});

test("two unnumbered entries in one file, or two unnumbered logs, are refused: one ticket, one number", () => {
  const twice = LANE_DEVLOG.replace("## #40", "## #NNN · fix · again\n- y\n\n---\n\n## #40");
  assert.match(refusal(() => landing({ files: { "docs/history/devlog.md": twice } })), /^docs\/history\/devlog\.md has 2 unnumbered entries \(## #NNN\); a lane commit carries one\./);
  const logs = { "docs/history/implementation-log/NNN-a.md": LANE_LOG, "docs/history/implementation-log/NNN-b.md": LANE_LOG };
  assert.match(refusal(() => landing({ files: logs })), /^The lane wrote 2 unnumbered logs \(NNN-a\.md, NNN-b\.md\); a lane commit carries one\./);
  assert.match(refusal(() => landing({ last: { devlog: "41" } })), /^The tip's last numbers must be whole numbers/);
});

test("a lane session's prompt tells it to write NNN where a number goes; a one-lane prompt says nothing of it", () => {
  const config = parseRunConfig({ version: 1 });
  const ticket = { N: 7, BASE: "abc", GOTCHAS_FILE: "docs/agents/gotchas/two-lanes.md" };
  assert.equal(promptValues(config, "", ticket).LANE_NUMBERS, "");
  const lane = promptValues(config, "", { ...ticket, LANE: "2" }).LANE_NUMBERS;
  assert.match(lane, /You are lane `2`/);
  assert.match(lane, /`## #NNN · <type> · <title>`/);
  assert.match(lane, /`NNN-<slug>\.md`/);
  assert.match(lane, /`devlog #NNN`/);
  assert.match(lane, /`\.lane\/docs\/agents\/gotchas\/two-lanes\.md`/);
  assert.equal(render("a.{{LANE_NUMBERS}}\nb", { LANE_NUMBERS: "" }), "a.\nb");
  // A token doc-check would refuse is never handed to a lane.
  const custom = parseRunConfig({ version: 1, phaseRun: { hotspots: { token: "XX", rows: [] } } });
  assert.match(refusal(() => promptValues(custom, "", { ...ticket, LANE: "2" })), /^phaseRun\.hotspots\.token is "XX", but tools\/doc-config\.mjs's NUMBER_TOKEN is "NNN"/);
  assert.equal(promptValues(custom, "", ticket).LANE_NUMBERS, "", "a one-lane run never reads the token");
});

test("a lane session runs under PHASE_RUN_LANE; a one-lane session never does", () => {
  const base = { ticket: 7, base: "abc", spec: 5, runner: "r", root: "/repo" };
  assert.equal("PHASE_RUN_LANE" in runVariables(base), false);
  assert.equal(runVariables({ ...base, lane: "2" }).PHASE_RUN_LANE, "2");
});
