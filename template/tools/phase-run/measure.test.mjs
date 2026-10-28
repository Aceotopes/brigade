// Tests for the runner's measuring, its display and the session's helpers:
// the per-ticket numbers (metrics.mjs), the size budget (ticket-size.mjs),
// the terminal table (display.mjs), the report's scoreboard, the
// tests-passed receipt (receipt.mjs), quiet test output (stop-tests.mjs), the
// waits (wait-subagents.mjs, wait-url.mjs) and the prompt's rules on waiting. Plain
// node:test, like run.test.mjs: no database, no GitHub, no Claude session.
// Run: node --test tools/phase-run/measure.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Screen, makePaint, progressText, resultLines, scoreboard, shortStat, shortTitle, visible } from "./display.mjs";
import { costOf, hookTime, loadPrices, stepKind, stepRules, ticketMetrics, toolTime, usageOf } from "./metrics.mjs";
import { readReceipt, receiptHolds, receiptPath, treeKey } from "./receipt.mjs";
import { promptValues, report } from "./run.mjs";
import { quietOutput } from "./stop-tests.mjs";
import { DEFAULT_RULES, measureTicket } from "./ticket-size.mjs";
import { findTicketSession, subagentsOf } from "./wait-subagents.mjs";
import { answers } from "./wait-url.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const temp = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const lines = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

// ------------------------------------------------------------------ metrics

const prices = { fallback: "m", perMillion: { m: { input: 4, cacheWrite: 8, cacheRead: 0.2, output: 20 } } };

test("tokens are counted once per response, and priced per model", () => {
  const file = join(temp("phase-run-usage-"), "s.jsonl");
  const usage = { input_tokens: 10, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 2_000_000, output_tokens: 100_000 };
  // One response written as two lines (text, then a tool call), plus a second response.
  writeFileSync(file, lines([
    { type: "assistant", message: { id: "r1", model: "m", usage, content: [] } },
    { type: "assistant", message: { id: "r1", model: "m", usage, content: [] } },
    { type: "assistant", message: { id: "r2", model: "m", usage: { ...usage, cache_creation_input_tokens: 0 }, content: [] } },
  ]));
  const total = usageOf(file);
  assert.equal(total.calls, 2);
  assert.equal(total.cacheRead, 4_000_000);
  assert.equal(total.peakContext, 3_000_010);
  // 1M write × $8 + 4M read × $0.20 + 0.2M out × $20 + 20 in = 8 + 0.8 + 4 + 0.00008
  assert.equal(costOf(total, prices), 12.8);
});

test("a response that called the advisor is left out of the peak context", () => {
  const file = join(temp("phase-run-advisor-"), "s.jsonl");
  writeFileSync(file, lines([
    { type: "assistant", message: { id: "r1", model: "m", usage: { input_tokens: 100 }, content: [] } },
    { type: "assistant", message: { id: "r2", model: "m", usage: { input_tokens: 900, iterations: [{ type: "advisor_message" }] }, content: [] } },
  ]));
  assert.equal(usageOf(file).peakContext, 100);
});

test("each kind of step gets a plain word, from Brigade's rows", () => {
  assert.equal(stepKind("Bash", "node tools/phase-run/stop-tests.mjs"), "testing");
  assert.equal(stepKind("PowerShell", "pnpm exec vitest run test/x.test.ts"), "testing");
  assert.equal(stepKind("Bash", "pnpm exec tsc --noEmit -p ."), "checking");
  assert.equal(stepKind("Bash", "node tools/phase-run/wait-url.mjs http://localhost:3000"), "browser");
  assert.equal(stepKind("Bash", "node .phase-run/tmp/pause.mjs 240"), "waiting");
  assert.equal(stepKind("Bash", "node tools/phase-run/wait-subagents.mjs"), "reviewing"); // not a pause: its time is the review's
  assert.equal(stepKind("Agent", "design-reviewer"), "reviewing");
  assert.equal(stepKind("Read", "src/lib/report.ts"), "reading");
  assert.equal(stepKind("Edit", "src/lib/report.ts"), "writing");
  assert.equal(stepKind("Bash", "git status"), "working");
});

test("a project's own rows and its stop checks sort a command before Brigade's rows", () => {
  const rules = stepRules({
    steps: [{ kind: "browser", match: /walks\// }],
    stopChecks: [
      { label: "Tests", run: "make check-changed BASE={base}", receipt: true },
      { label: "Format", run: "make fmt-check", receipt: false },
    ],
  });
  assert.equal(stepKind("Bash", "node scripts/walks/12-export.mjs", rules), "browser");
  assert.equal(stepKind("Bash", "make check-changed BASE=abc123", rules), "testing");
  assert.equal(stepKind("Bash", "make fmt-check", rules), "checking");
  assert.equal(stepKind("Bash", "sleep 30", rules), "waiting");
});

test("a ticket's minutes: the measured waits, the hook and the gates, and Claude as the rest", () => {
  const dir = temp("phase-run-time-");
  const file = join(dir, "s.jsonl");
  const at = (minute) => new Date(Date.UTC(2026, 9, 28, 0, minute)).toISOString();
  const call = (id, name, command, minute) => ({ type: "assistant", timestamp: at(minute), message: { id: `r-${id}`, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", id, name, input: { command } }] } });
  const done = (id, minute) => ({ type: "user", timestamp: at(minute), message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
  writeFileSync(file, lines([
    call("t1", "Bash", "node tools/phase-run/stop-tests.mjs", 10), done("t1", 15),
    call("w1", "Bash", "node .phase-run/tmp/pause.mjs 240", 20), done("w1", 24),
    call("b1", "Bash", "node tools/phase-run/wait-url.mjs http://localhost:3000", 30), done("b1", 33),
  ]));
  assert.deepEqual(toolTime(file), { testing: 5 * 60_000, waiting: 4 * 60_000, browser: 3 * 60_000 });

  const log = join(dir, "stop-check-log.jsonl");
  const start = Date.UTC(2026, 9, 28, 0, 0);
  writeFileSync(log, lines([
    { ticket: 7, startedAt: start + 50 * 60_000, endedAt: start + 60 * 60_000 },
    { ticket: 8, startedAt: start + 50 * 60_000, endedAt: start + 60 * 60_000 }, // another ticket's
    { ticket: 7, startedAt: start - 99 * 60_000, endedAt: start - 90 * 60_000 }, // an earlier run's
  ]));
  assert.equal(hookTime(log, 7, start), 10 * 60_000);

  const metrics = ticketMetrics({ transcript: file, startedAt: start, endedAt: start + 80 * 60_000, gatesMs: 7 * 60_000, hookMs: 10 * 60_000, prices });
  assert.deepEqual(metrics.minutes, { total: 80, claude: 51, tests: 5, checks: 0, browser: 3, waiting: 4, reviewing: 0, hook: 10, gates: 7 });
});

test("prices.json names a fallback it has a row for, and four rates per row", () => {
  const real = loadPrices();
  assert.ok(real.perMillion[real.fallback]);
  for (const rate of Object.values(real.perMillion)) assert.deepEqual(Object.keys(rate).sort(), ["cacheRead", "cacheWrite", "input", "output"]);
});

// -------------------------------------------------------------- ticket size

test("a ticket's size: checkboxes and bullets under their section, and words", () => {
  const body = ["## Acceptance criteria", "", "- [ ] one", "- [ ] two", "- [x] three", "", "## Areas", "", "- src/lib/a.ts", "- src/lib/b.ts", "", "## Read first", "- not an area"].join("\n");
  const measures = measureTicket(body, DEFAULT_RULES);
  assert.deepEqual(Object.fromEntries(measures.map((m) => [m.key, m.value])), { criteria: 3, areas: 2, words: body.split(/\s+/).filter(Boolean).length });
  assert.ok(measures.every((m) => !m.over));
  assert.equal(measureTicket(body, [{ key: "areas", kind: "bullets", section: "Areas", max: 1, label: "Areas entries" }])[0].over, true);
  assert.throws(() => measureTicket(body, [{ kind: "lines", max: 1 }]), /unknown rule kind/);
});

// ------------------------------------------------------------------ display

const plain = makePaint(false);
const built = {
  number: 35,
  title: "2B: Export the report — as a spreadsheet",
  status: "built",
  hash: "ad1bb62",
  stat: " 37 files changed, 3119 insertions(+), 77 deletions(-)",
  assumptions: ["Question for the owner: should an empty month export?", "Totals are rounded on export."],
  session: { calls: 2, minutes: 131, turns: 404, denials: [], metrics: { costUsd: 32.2, peakContext: 655_577, minutes: { total: 131, claude: 74, tests: 22, checks: 0, browser: 0, waiting: 11, reviewing: 0, hook: 10, gates: 14 }, size: { criteria: 8, areas: 6, words: 766 } } },
};

test("a finished ticket is one row and its detail lines", () => {
  const [row, time, facts] = resultLines(built, plain);
  assert.match(row, /^ {2}35 {3}Export the report +131m +\$32\.20 {2}✔ ad1bb62 · 1 fix$/);
  assert.equal(time.trim(), "Claude 74 · tests 22 · slept 11 · hook 10 · gates 14");
  assert.equal(facts.trim(), "37 files +3119 −77 · peak 656k · 8 criteria · 6 areas · 1 for you");
  const [parked] = resultLines({ number: 9, title: "x", status: "parked", detail: "Which rule?", session: null }, plain);
  assert.match(parked, /⏸ parked: needs you/);
  assert.equal(shortTitle("2B: Monthly totals — the per-store view"), "Monthly totals");
  assert.equal(shortStat("2 files changed, 5 insertions(+)"), "2 files +5 −0");
});

test("a row is green when built clean, yellow after a fix round, red when it failed", () => {
  const colour = makePaint(true);
  const clean = { ...built, session: { ...built.session, calls: 1 } };
  assert.match(resultLines(clean, colour)[0], /\x1b\[32m✔/);
  assert.match(resultLines(built, colour)[0], /\x1b\[33m✔/);
  assert.match(resultLines({ number: 3, title: "x", status: "failed", session: null }, colour)[0], /\x1b\[31m✖ failed/);
});

test("the progress line counts '6 of 10 · 4 after this' and estimates the end", () => {
  const start = new Date(2026, 9, 28, 0, 0).getTime();
  const now = start + 451 * 60_000; // 7h31m in
  const progress = { label: "2B phase run", done: 5, total: 10, startedAt: start, avgMinutes: 80, current: { number: 37, title: "x", startedAt: now - 45 * 60_000 } };
  const text = progressText(progress, now);
  assert.match(text, /■■■■■▣□□□□ {2}6 of 10 · 4 after this · 7h31m in · done ≈ /);
  // 35 min left of this one, then 4 × 80: 355 min after 07:31 is 13:26.
  assert.match(text, /done ≈ 13:26$/);
});

test("off a terminal the screen prints plain lines and draws nothing in place", () => {
  let written = "";
  const out = { write: (text) => (written += text), isTTY: false };
  const screen = new Screen(out);
  screen.begin({ label: "2B phase run", done: 0, total: 2, startedAt: Date.now(), avgMinutes: 80, current: null });
  screen.update({ label: "2B phase run", done: 0, total: 2, startedAt: Date.now(), avgMinutes: 80, current: null });
  screen.note("[10:00:00] #1: tests failed. Fix round 1 of 3.");
  assert.equal(written, "[10:00:00] #1: tests failed. Fix round 1 of 3.\n");
});

test("on a terminal a note is printed above the live area, which is cleared and drawn again", () => {
  let written = "";
  const out = { write: (text) => (written += text), isTTY: true, columns: 100 };
  const screen = new Screen(out, { tty: true, colour: false });
  const progress = { label: "2B phase run", done: 0, total: 2, startedAt: Date.now(), avgMinutes: 80, current: { number: 1, title: "One", startedAt: Date.now(), stage: "testing", steps: 3 } };
  screen.update(progress);
  written = "";
  screen.note("a note");
  assert.ok(written.startsWith("\r\x1b[2K\x1b[1A\x1b[2K"), "the two live lines are cleared first");
  assert.match(written, /a note\n2B phase run .*\n▶ 1 +One .*testing · 3 steps/);
  assert.match(written, /\x1b\]0;2B phase run 1\/2 · #1 0m\x07$/); // the tab title
});

test("NO_COLOR turns colour off on a terminal", () => {
  const before = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    let written = "";
    const screen = new Screen({ write: (text) => (written += text), isTTY: true, columns: 100 });
    screen.ticketDone(built);
    assert.doesNotMatch(written, /\x1b\[3\dm/);
  } finally {
    if (before === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = before;
  }
});

test("the scoreboard ends with the totals", () => {
  const board = scoreboard([built, { ...built, number: 36, session: { calls: 1, metrics: { ...built.session.metrics, costUsd: 10 } } }], plain).map(visible);
  assert.match(board.at(-1), /2 ticket\(s\) · built 2 · 4h22m of work · \$42\.20 at API rates \(2 priced\)/);
});

test("the morning report opens with the scoreboard, cost and size beside each ticket", () => {
  const run = { branch: "phase-2b", results: [{ ...built, outside: [], migrations: [], destructive: [], runByHand: [], foundElsewhere: [], handedForward: [], notes: [] }], carried: [] };
  const text = report(run, {}, []);
  assert.match(text, /### Scoreboard/);
  assert.match(text, /\| 35 \| 2B: Export the report — as a spreadsheet \| built, 1 fix \| 131 \| 74 \| 22 \| 0 \| 0 \| 11 \| 0 \| 10 \| 14 \| \$32\.20 \| 656K \| 8 \| 6 \| 766 \|/);
  assert.match(text, /\$32\.20 at API rates, context up to 656K/);
});

// ------------------------------------------------------------------ receipt

function gitRepo(files = {}) {
  const dir = temp("phase-run-receipt-test-");
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, ".gitignore"), ".phase-run/\n");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  return { dir, git };
}

test("the receipt's tree key is the same before and after the code is committed", () => {
  const { dir, git } = gitRepo();
  writeFileSync(join(dir, "a.txt"), "two\n");
  const before = treeKey(dir);
  git("commit", "-q", "-am", "second");
  assert.equal(treeKey(dir), before);
});

test("any edit, or a new untracked file, changes the tree key; the real index is left alone", () => {
  const { dir, git } = gitRepo();
  const clean = treeKey(dir);
  writeFileSync(join(dir, "new.txt"), "untracked\n");
  const withNew = treeKey(dir);
  assert.notEqual(withNew, clean);
  assert.equal(git("status", "--porcelain").stdout.trim(), "?? new.txt"); // still untracked: nothing was staged
  writeFileSync(join(dir, "a.txt"), "edited\n");
  assert.notEqual(treeKey(dir), withNew);
});

test("a receipt holds only for the same tree, base and command, and a pass", () => {
  const receipt = { tree: "t1", base: "b1", commands: ["npm test"], passed: true };
  const now = { tree: "t1", base: "b1", command: "npm test" };
  assert.equal(receiptHolds(receipt, now), true);
  assert.equal(receiptHolds(receipt, { ...now, tree: "t2" }), false);
  assert.equal(receiptHolds(receipt, { ...now, base: "b2" }), false);
  assert.equal(receiptHolds(receipt, { ...now, command: "npm run test:all" }), false);
  assert.equal(receiptHolds({ ...receipt, passed: false }, now), false);
  assert.equal(receiptHolds(null, now), false);
  assert.equal(receiptHolds(receipt, { ...now, tree: null }), false);
});

// -------------------------------------------------------------- quiet tests

const LOG = [" RUN  v3", "·····x··", " ❯ test/a.test.ts (3 tests | 1 failed)", " FAIL  test/a.test.ts > adds", "AssertionError: expected 2 to be 3", " Test Files  1 failed | 177 passed (178)", "      Tests  1 failed | 4112 passed (4113)", "   Duration  281.4s"].join("\n");
const PAIR = { totals: /^\s*(Test Files|Tests|Duration)\s/, failures: /^\s*FAIL\s/ };

test("with a quiet pair, a pass prints its totals and a failure its failures and totals", () => {
  assert.equal(quietOutput(LOG.replace(/1 failed \| /g, ""), true, PAIR).split("\n").length, 3);
  const failed = quietOutput(LOG, false, PAIR);
  assert.match(failed, /^FAIL {2}test\/a\.test\.ts > adds/);
  assert.match(failed, /Tests {2}1 failed/);
  assert.doesNotMatch(failed, /·····/);
});

test("without a pair, a pass prints its last lines and a failure its tail", () => {
  const passed = quietOutput(`${"noise\n".repeat(50)}ok 1\nok 2\n# pass 2\n# fail 0\n`, true);
  assert.equal(passed, "noise\nok 1\nok 2\n# pass 2\n# fail 0");
  const long = quietOutput(`${"x".repeat(20_000)}\nnot ok 1`, false);
  assert.match(long, /^…\(cut to the last 15000 characters\)/);
  assert.match(long, /not ok 1$/);
});

/** A project with this folder's runner copied in, and the given test command as its receipt row. */
function stopTestsProject(testRun) {
  const files = Object.fromEntries(["stop-tests.mjs", "receipt.mjs", "config.mjs", "metrics.mjs", "ticket-size.mjs"].map((name) => [`tools/phase-run/${name}`, readFileSync(join(HERE, name), "utf8")]));
  files["tools/phase-run/prices.json"] = readFileSync(join(HERE, "prices.json"), "utf8");
  files[".claude/workflow.json"] = JSON.stringify({ version: 1, stopGate: { checks: [{ label: "Tests", run: testRun, receipt: true }] } });
  const project = gitRepo(files);
  const run = () => spawnSync(process.execPath, [join(project.dir, "tools/phase-run/stop-tests.mjs"), "main"], { cwd: project.dir, encoding: "utf8", env: { ...process.env, PHASE_RUN_TICKET: "7" } });
  return { ...project, run, receipt: () => readReceipt(receiptPath(project.dir, "7")) };
}

test("stop-tests.mjs writes a receipt on a pass, skips on the same code, and writes none on a failure", () => {
  const passing = stopTestsProject('node -e "console.log(1)"');
  assert.equal(passing.run().status, 0);
  const receipt = passing.receipt();
  assert.deepEqual(receipt.commands, ['node -e "console.log(1)"']);
  assert.equal(receipt.tree, treeKey(passing.dir));
  assert.match(passing.run().stdout, /already passed on exactly this code/);

  const failing = stopTestsProject('node -e "process.exit(3)"');
  const result = failing.run();
  assert.equal(result.status, 3);
  assert.match(result.stdout, /Tests: FAILED/);
  assert.equal(failing.receipt(), null);
});

// ------------------------------------------------------------ the waits

test("the wait finds a ticket's session by its agent name, and reads its subagents' finished flags", () => {
  const projects = temp("phase-run-projects-");
  const folder = join(projects, "D--repo");
  mkdirSync(join(folder, "s-38", "subagents"), { recursive: true });
  writeFileSync(join(folder, "s-other.jsonl"), lines([{ type: "agent-name", agentName: "ticket-37-export" }]));
  writeFileSync(join(folder, "s-38.jsonl"), lines([{ type: "agent-name", agentName: "ticket-38-export" }]));
  const subagents = join(folder, "s-38", "subagents");
  writeFileSync(join(subagents, "agent-a.meta.json"), JSON.stringify({ description: "Design review", finished: true }));
  writeFileSync(join(subagents, "agent-b.meta.json"), JSON.stringify({ description: "/code-review" })); // still running: no flag yet

  const session = findTicketSession(projects, 38);
  assert.deepEqual(session, { folder, sessionId: "s-38" });
  const agents = subagentsOf(session.folder, session.sessionId);
  assert.deepEqual(agents.filter((a) => !a.finished).map((a) => a.description), ["/code-review"]);
  assert.equal(findTicketSession(projects, 999), null);
});

test("the URL wait reads any answer as up, and a closed port as not yet", async () => {
  const server = createServer((request, response) => response.writeHead(404).end()).listen(0);
  await once(server, "listening");
  const { port } = server.address();
  assert.equal(await answers(`http://127.0.0.1:${port}/`), true);
  server.close();
  await once(server, "close");
  assert.equal(await answers(`http://127.0.0.1:${port}/`), false);
});

// ------------------------------------------------------------ the prompt

test("the ticket prompt waits on things, never for a fixed time, and reads in parts", () => {
  const prompt = readFileSync(join(HERE, "ticket-prompt.md"), "utf8");
  assert.match(prompt, /node tools\/phase-run\/wait-subagents\.mjs/);
  assert.match(prompt, /node tools\/phase-run\/wait-url\.mjs/);
  assert.match(prompt, /never a fixed-length pause/i);
  assert.match(prompt, /\*\*Read in parts\.\*\*/);
  // No instruction to pause for a set time: "wait N minutes", "sleep N", a pause script.
  assert.doesNotMatch(prompt, /\bwait \d+ ?(min|minutes|s|seconds)\b|\bsleep \d|Start-Sleep|pause\.mjs/i);
});

test("a project with a receipt row is told to test through stop-tests.mjs; one without is not", () => {
  const project = (stopChecks) => ({ stopChecks, sessionEnv: {}, migrations: null, browserCheck: null, qa: null });
  const withReceipt = promptValues(project([{ label: "Lint", run: "npm run lint" }, { label: "Tests", run: "npm test -- --since {base}", receipt: true }]), "", { BASE: "abc", N: 1 });
  assert.equal(withReceipt.STOP_CHECKS, "`npm run lint`, `node tools/phase-run/stop-tests.mjs` (the tests)");
  assert.match(withReceipt.RECEIPT, /stop-tests\.mjs`, never by hand/);
  const without = promptValues(project([{ label: "Tests", run: "npm test" }]), "", { BASE: "abc", N: 1 });
  assert.equal(without.STOP_CHECKS, "`npm test`");
  assert.equal(without.RECEIPT, "");
});

/** Claude Code's permission rule match: `*` is any run of characters, everything else literal. */
function globMatch(pattern, text) {
  const parts = pattern.split("*");
  if (parts.length === 1) return text === pattern;
  if (!text.startsWith(parts[0]) || !text.endsWith(parts.at(-1))) return false;
  let at = parts[0].length;
  for (const part of parts.slice(1, -1)) {
    const found = text.indexOf(part, at);
    if (found === -1) return false;
    at = found + part.length;
  }
  return at <= text.length - parts.at(-1).length;
}

test("every helper script the prompt names is one a session's allow list lets it run", () => {
  assert.equal(globMatch("rm .phase-run/tmp/*", "rm src/app.ts"), false);
  const prompt = readFileSync(join(HERE, "ticket-prompt.md"), "utf8");
  const allow = JSON.parse(readFileSync(join(HERE, "settings.json"), "utf8")).permissions.allow;
  const named = [...new Set([...prompt.matchAll(/`(node tools\/phase-run\/[\w-]+\.mjs)/g)].map((m) => m[1]))];
  assert.ok(named.length >= 2, "the prompt names its helper scripts");
  for (const tool of ["Bash", "PowerShell"]) {
    for (const command of named) {
      const allowed = allow.some((rule) => rule.startsWith(`${tool}(`) && globMatch(rule.slice(tool.length + 1, -1), command));
      assert.ok(allowed, `${tool} may run ${command}`);
    }
  }
});
