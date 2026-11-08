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
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Screen, makePaint, progressText, resultLines, scoreboard, shortStat, shortTitle, visible } from "./display.mjs";
import { PRICES_STALE_DAYS, addCost, hookTime, loadPrices, pricesAgeDays, sessionCost, sessionCostFrom, stepKind, stepRules, ticketMetrics, toolTime } from "./metrics.mjs";
import { appendRow, latestPerSession, ledgerCsv, ledgerRow, ledgerText, readLedger, stampVersion, weeklyView, weekOf } from "./ledger.mjs";
import { readReceipt, receiptGroups, receiptHolds, receiptPath, treeKey, treeKeys } from "./receipt.mjs";
import { promptValues, report } from "./run.mjs";
import { quietOutput } from "./stop-tests.mjs";
import { DEFAULT_RULES, measureTicket } from "./ticket-size.mjs";
import { unreadMatcher } from "./unread.mjs";
import { findTicketSession, subagentsOf } from "./wait-subagents.mjs";
import { answers } from "./wait-url.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const temp = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const lines = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

// ------------------------------------------------------------------ metrics

const prices = {
  checkedOn: "2026-11-07",
  fallback: "m",
  perMillion: {
    m: { input: 4, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20 },
    adv: { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25, output: 50 },
  },
};

/** A large-prompt tier for row `m`: double its rates over 200K prompt tokens. */
const ABOVE = { promptTokens: 200_000, input: 8, cacheWrite5m: 10, cacheWrite1h: 16, cacheRead: 0.4, output: 40 };

const reply = (id, usage, model = "m") => ({ type: "assistant", message: { id, model, usage, content: [] } });

/** One transcript of the given rows, priced whole. */
function priced(rows, list = prices) {
  const file = join(temp("phase-run-cost-"), "s.jsonl");
  writeFileSync(file, lines(rows));
  return sessionCost(file, list);
}

test("tokens are counted once per response, and priced per request", () => {
  const usage = { input_tokens: 10, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 2_000_000, output_tokens: 100_000 };
  // One response written as two lines (text, then a tool call), plus a second response.
  const total = priced([reply("r1", usage), reply("r1", usage), reply("r2", { ...usage, cache_creation_input_tokens: 0 })]);
  assert.equal(total.calls, 2);
  assert.equal(total.cacheRead, 4_000_000);
  assert.equal(total.peakContext, 3_000_010);
  // 1M write with no lifetime split × $8 + 4M read × $0.20 + 0.2M out × $20 + 20 in × $4 = 8 + 0.8 + 4 + 0.00008
  assert.equal(total.nanoUsd, 12_800_080_000);
  assert.equal(total.costUsd, 12.8);
});

test("a cache write is priced at its lifetime's rate, and what the split leaves out at the one-hour rate", () => {
  const write = (split) => priced([reply("r1", { cache_creation_input_tokens: 1_000_000, ...(split && { cache_creation: split }) })]).nanoUsd;
  assert.equal(write({ ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 0 }), 5e9);
  assert.equal(write({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 }), 8e9);
  assert.equal(write(null), 8e9);
  assert.equal(write({ ephemeral_5m_input_tokens: 400_000, ephemeral_1h_input_tokens: 0 }), 6.8e9); // 0.4M × $5 + 0.6M × $8
});

test("a request over a tier's promptTokens is priced at that tier, and an unlisted model at the fallback", () => {
  const tiered = { ...prices, perMillion: { m: { ...prices.perMillion.m, above: ABOVE } } };
  assert.equal(priced([reply("r1", { input_tokens: 200_000 })], tiered).nanoUsd, 800_000_000); // at the threshold: base rate
  assert.equal(priced([reply("r1", { input_tokens: 100_001, cache_read_input_tokens: 100_000, output_tokens: 1_000 })], tiered).nanoUsd, 800_008_000 + 40_000_000 + 40_000_000);
  assert.equal(priced([reply("r1", { input_tokens: 1_000_000 }, "claude-unlisted-9")]).nanoUsd, 4e9);
});

// The shape of a real response that called the advisor: its top-level usage is the
// session's own two requests, and the advisor's pass is only in `iterations`.
const ADVISED = {
  input_tokens: 4,
  cache_creation_input_tokens: 4360,
  cache_read_input_tokens: 266_038,
  output_tokens: 2287,
  cache_creation: { ephemeral_1h_input_tokens: 2424, ephemeral_5m_input_tokens: 0 },
  iterations: [
    { type: "message", input_tokens: 2, output_tokens: 26, cache_read_input_tokens: 131_807, cache_creation_input_tokens: 2424, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2424 } },
    { type: "advisor_message", model: "adv", input_tokens: 135_883, output_tokens: 9959, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    { type: "message", input_tokens: 2, output_tokens: 2261, cache_read_input_tokens: 134_231, cache_creation_input_tokens: 1936, cache_creation: { ephemeral_5m_input_tokens: 1936, ephemeral_1h_input_tokens: 0 } },
  ],
};

test("an advisor pass is priced at the advisor's model, beside the session's own requests", () => {
  const total = priced([reply("r1", ADVISED)]);
  // Own: 4 in × $4 + 266,038 read × $0.20 + 2,424 1h write × $8 + 1,936 5m write × $5 + 2,287 out × $20 = $0.128035600
  // Advisor at adv: 135,883 in × $10 + 9,959 out × $50 = $1.856780000
  assert.equal(total.nanoUsd, 1_984_815_600);
  assert.equal(total.costUsd, 1.98);
  assert.equal(total.advisorCalls, 1);
  assert.equal(total.output, 2287); // the session's own tokens; the advisor's are only priced
});

test("a response that called the advisor is left out of the peak context", () => {
  const total = priced([reply("r1", { input_tokens: 100 }), reply("r2", { input_tokens: 900, iterations: [{ type: "advisor_message", model: "adv" }] })]);
  assert.equal(total.peakContext, 100);
});

test("a session's cost includes the subagent transcripts beside it; its peak is its own", () => {
  const dir = temp("phase-run-subagents-");
  const file = join(dir, "s.jsonl");
  writeFileSync(file, lines([reply("r1", { input_tokens: 1_000_000 })]));
  mkdirSync(join(dir, "s", "subagents"), { recursive: true });
  writeFileSync(join(dir, "s", "subagents", "agent-a.jsonl"), lines([reply("a1", { input_tokens: 2_000_000, output_tokens: 1_000_000 }, "adv")]));
  const total = sessionCost(file, prices);
  assert.equal(total.nanoUsd, 4e9 + 20e9 + 50e9);
  assert.equal(total.calls, 2);
  assert.equal(total.peakContext, 1_000_000);
});

test("the incremental form prices only what was added, and two steps equal the whole", () => {
  const dir = temp("phase-run-steps-");
  const file = join(dir, "s.jsonl");
  const usage = { input_tokens: 10, cache_creation_input_tokens: 5_000, cache_read_input_tokens: 70_000, output_tokens: 300 };
  const text = lines([reply("r1", usage), reply("r1", usage), reply("r2", ADVISED), reply("r3", { ...usage, output_tokens: 9 })]);
  const firstLine = text.indexOf("\n") + 1;
  const midSecondResponse = text.indexOf('"r2"') + 20;

  writeFileSync(file, text.slice(0, firstLine)); // between the two lines of one response
  const one = sessionCostFrom(file, prices);
  appendFileSync(file, text.slice(firstLine, midSecondResponse)); // ends mid-line
  const two = sessionCostFrom(file, prices, one.state);
  appendFileSync(file, text.slice(midSecondResponse));
  mkdirSync(join(dir, "s", "subagents"), { recursive: true });
  writeFileSync(join(dir, "s", "subagents", "agent-a.jsonl"), lines([reply("a1", usage, "adv")])); // a subagent started late
  const three = sessionCostFrom(file, prices, two.state);

  assert.equal(two.cost.calls, 0); // the duplicate line and the half-written one add nothing yet
  const whole = sessionCost(file, prices);
  assert.equal(one.cost.nanoUsd + two.cost.nanoUsd + three.cost.nanoUsd, whole.nanoUsd);
  assert.equal(one.cost.calls + two.cost.calls + three.cost.calls, whole.calls);
  assert.equal(whole.calls, 4);
  assert.equal(Math.max(one.cost.peakContext, two.cost.peakContext, three.cost.peakContext), whole.peakContext);
  assert.equal(sessionCostFrom(file, prices, three.state).cost.nanoUsd, 0); // nothing new
});

test("the incremental form knows a file however its path is spelled, and never counts a response twice when a file is rewritten", () => {
  const dir = temp("phase-run-rewrite-");
  const file = join(dir, "s.jsonl");
  writeFileSync(file, lines([reply("r1", { input_tokens: 1_000_000 }), reply("r2", { input_tokens: 1_000_000 })]));
  const one = sessionCostFrom(file, prices);
  assert.equal(sessionCostFrom(`${dir}/./s.jsonl`, prices, one.state).cost.nanoUsd, 0);
  writeFileSync(file, lines([reply("r1", { input_tokens: 1_000_000 })])); // shorter than the saved offset
  const two = sessionCostFrom(file, prices, one.state);
  assert.equal(two.cost.nanoUsd, 0);
  appendFileSync(file, lines([reply("r3", { input_tokens: 1_000_000 })]));
  assert.equal(sessionCostFrom(file, prices, two.state).cost.nanoUsd, 4e9);
});

test("a running total adds each step's cost exactly, per model too, and keeps the peak as a max", () => {
  const dir = temp("phase-run-running-");
  const file = join(dir, "s.jsonl");
  const usage = { input_tokens: 10, cache_creation_input_tokens: 5_000, cache_read_input_tokens: 70_000, output_tokens: 300 };
  writeFileSync(file, lines([reply("r1", { ...usage, cache_read_input_tokens: 90_000 }), reply("r2", ADVISED)]));
  const one = sessionCostFrom(file, prices);
  appendFileSync(file, lines([reply("r3", usage, "adv")]));
  const two = sessionCostFrom(file, prices, one.state);

  const total = addCost(addCost(undefined, one.cost), two.cost);
  const whole = sessionCost(file, prices);
  assert.deepEqual(total, whole);
  assert.equal(total.peakContext, 95_010); // the first step's, not the sum
  assert.deepEqual(addCost(total, sessionCostFrom(file, prices, two.state).cost), whole); // nothing new adds nothing
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

// ------------------------------------------------------------------- ledger

test("a session's cost is split by model: an advisor pass under the advisor's model", () => {
  const total = priced([reply("r1", ADVISED), reply("r2", { input_tokens: 1_000_000 })]);
  // Own: $0.1280356 + 1M in × $4; advisor: $1.85678 (the advisor test above)
  assert.deepEqual(total.byModel, {
    m: { requests: 3, nanoUsd: 4_128_035_600, costUsd: 4.13 },
    adv: { requests: 1, nanoUsd: 1_856_780_000, costUsd: 1.86 },
  });
});

/** A fixture ledger row: a session's whole cost at `at`, all of it at one model. */
const ledgerFixture = (at, sessionId, kind, costUsd, model = "claude-opus-5-5") => ({
  at: at.toISOString(),
  sessionId,
  transcript: `/t/${sessionId}.jsonl`,
  kind,
  ticket: kind === "night" ? 14 : null,
  branch: kind === "night" ? "phase-x" : null,
  brigade: "0.6.0",
  costUsd,
  tokens: { calls: 1, input: 1, cacheWrite: 0, cacheRead: 0, output: 1 },
  peakContext: 1,
  byModel: { [model]: { requests: 1, costUsd } },
});
// Local noon, so a fixture's day is the same in every time zone. 2026-11-08 is a Sunday.
const noon = (month, day, hour = 12) => new Date(2026, month - 1, day, hour);
const FIXTURE_LEDGER = [
  ledgerFixture(noon(11, 3, 9), "night-a", "night", 0.4), // superseded by its later row
  ledgerFixture(noon(11, 4), "attended-b", "attended", 0.5, "claude-sonnet-5-5"),
  ledgerFixture(noon(11, 3, 15), "night-a", "night", 1),
  ledgerFixture(noon(11, 5), "probe-c", "probe", 0.25, "claude-fable-5-1"),
  ledgerFixture(noon(11, 10), "night-d", "night", 2),
];

test("a ledger row has the agreed shape, from a session's cost, the session and the stamp", () => {
  const cost = priced([reply("r1", ADVISED)]);
  const row = ledgerRow({ at: Date.UTC(2026, 10, 8, 1), sessionId: "s1", transcript: "/t/s1.jsonl", kind: "night", ticket: 14, branch: "phase-x", brigade: "0.6.0", cost });
  assert.deepEqual(Object.keys(row), ["at", "sessionId", "transcript", "kind", "ticket", "branch", "brigade", "costUsd", "tokens", "peakContext", "byModel"]);
  assert.equal(row.at, "2026-11-08T01:00:00.000Z");
  assert.equal(row.costUsd, 1.98);
  assert.deepEqual(row.tokens, { calls: 1, input: 4, cacheWrite: 4360, cacheRead: 266_038, output: 2287 });
  assert.deepEqual(row.byModel, { m: { requests: 2, nanoUsd: 128_035_600, costUsd: 0.13 }, adv: { requests: 1, nanoUsd: 1_856_780_000, costUsd: 1.86 } });
});

test("a model's cost is summed across rows exactly before it is rounded", () => {
  // Three sessions of $0.004 each at one model: rounding each row first would show $0.00.
  const tiny = (id) => ({ ...ledgerFixture(noon(11, 3), id, "night", 0), byModel: { m: { requests: 1, nanoUsd: 4_000_000, costUsd: 0 } } });
  assert.deepEqual(weeklyView([tiny("a"), tiny("b"), tiny("c")])[0].models, { m: 0.01 });
});

test("rows are appended one line each, and a torn line is skipped on reading", () => {
  const file = join(temp("phase-run-ledger-"), ".phase-run", "ledger.jsonl");
  appendRow(file, FIXTURE_LEDGER[0]);
  appendFileSync(file, '{"at":"2026-11-0');
  appendFileSync(file, "\n");
  appendRow(file, FIXTURE_LEDGER[1]);
  assert.deepEqual(readLedger(file), FIXTURE_LEDGER.slice(0, 2));
  assert.deepEqual(readLedger(join(temp("phase-run-ledger-"), "none.jsonl")), []);
});

test("a night row's version is the project's stamp, and null with no stamp", () => {
  const stamped = temp("phase-run-stamp-");
  mkdirSync(join(stamped, ".claude"));
  writeFileSync(join(stamped, ".claude", "workflow-version.json"), JSON.stringify({ plugin: "brigade", version: "0.6.0" }));
  assert.equal(stampVersion(stamped), "0.6.0");
  assert.equal(stampVersion(temp("phase-run-stamp-")), null);
  const broken = temp("phase-run-stamp-");
  mkdirSync(join(broken, ".claude"));
  writeFileSync(join(broken, ".claude", "workflow-version.json"), "{ not json");
  assert.equal(stampVersion(broken), null);
});

test("the views keep each session's latest row by `at`, whatever order the rows were written in", () => {
  const latest = latestPerSession(FIXTURE_LEDGER);
  assert.deepEqual(latest.map((r) => [r.sessionId, r.costUsd]), [["night-a", 1], ["attended-b", 0.5], ["probe-c", 0.25], ["night-d", 2]]);
  assert.deepEqual(latestPerSession([...FIXTURE_LEDGER].reverse()).map((r) => r.costUsd), [1, 0.5, 0.25, 2]);
});

test("a week starts on weekStarts, Monday by default, on the local date", () => {
  assert.equal(weekOf(noon(11, 8)), "2026-11-02"); // a Sunday ends the Monday week
  assert.equal(weekOf(noon(11, 9)), "2026-11-09");
  assert.equal(weekOf(noon(11, 8), "sunday"), "2026-11-08");
  assert.equal(weekOf(noon(11, 7), "sunday"), "2026-11-01");
  assert.equal(weekOf(noon(11, 4), "wednesday"), "2026-11-04");
});

test("the weekly view counts by kind and by model; a kind not night or attended counts under other", () => {
  const [first, second] = weeklyView(FIXTURE_LEDGER);
  assert.deepEqual(first, {
    week: "2026-11-02",
    sessions: 3,
    costUsd: 1.75,
    kinds: { night: { sessions: 1, costUsd: 1 }, attended: { sessions: 1, costUsd: 0.5 }, other: { sessions: 1, costUsd: 0.25 } },
    models: { "claude-opus-5-5": 1, "claude-sonnet-5-5": 0.5, "claude-fable-5-1": 0.25 },
  });
  assert.equal(second.week, "2026-11-09");
  assert.equal(second.kinds.night.costUsd, 2);
  const text = ledgerText(FIXTURE_LEDGER).join("\n");
  assert.match(text, /4 session\(s\), \$3\.75 at API rates/);
  assert.match(text, /Week of 2026-11-02 · 3 session\(s\) · \$1\.75/);
  assert.match(text, /other\s+1\s+\$0\.25/);
  assert.match(text, /by model\s+claude-opus-5-5 \$1\.00 · claude-sonnet-5-5 \$0\.50 · claude-fable-5-1 \$0\.25/);
  assert.match(ledgerText([]).join("\n"), /no rows yet/);
});

test("the CSV has each session's latest row, its group under kind and its own label kept", () => {
  const rows = [...FIXTURE_LEDGER, { ...ledgerFixture(noon(11, 6), "comma", "attended", 0.1), transcript: 'C:\\a, "b".jsonl' }];
  const [header, ...lines] = ledgerCsv(rows).trimEnd().split("\n");
  assert.equal(header, "at,week,kind,label,sessionId,ticket,branch,brigade,costUsd,calls,input,cacheWrite,cacheRead,output,peakContext,byModel,transcript");
  assert.equal(lines.length, 5);
  const probe = lines.find((line) => line.includes("probe-c")).split(",");
  assert.deepEqual(probe.slice(1, 5), ["2026-11-02", "other", "probe", "probe-c"]);
  assert.match(lines.find((line) => line.includes("night-a")), /,night,night,night-a,14,phase-x,0\.6\.0,1,1,1,0,0,1,1,claude-opus-5-5=1,/);
  assert.match(lines.find((line) => line.includes(",comma,")), /,"C:\\a, ""b""\.jsonl"$/);
  assert.equal(ledgerCsv(rows, { weekStarts: "sunday" }).split("\n")[1].split(",")[1], "2026-11-01");
});

/** A project with this folder's runner copied in and the fixture ledger in its .phase-run/. */
function ledgerProject(ledger, rest = {}) {
  const dir = temp("phase-run-status-");
  for (const name of ["status.mjs", "display.mjs", "metrics.mjs", "ledger.mjs", "config.mjs", "ticket-size.mjs", "prices.json"]) {
    mkdirSync(join(dir, "tools", "phase-run"), { recursive: true });
    writeFileSync(join(dir, "tools", "phase-run", name), readFileSync(join(HERE, name), "utf8"));
  }
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, ".claude", "workflow.json"), JSON.stringify({ version: 1, ...rest, ...(ledger && { ledger }) }));
  mkdirSync(join(dir, ".phase-run"));
  writeFileSync(join(dir, ".phase-run", "ledger.jsonl"), lines(FIXTURE_LEDGER));
  const status = (...args) => spawnSync(process.execPath, [join(dir, "tools/phase-run/status.mjs"), ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { dir, status };
}

test("status --ledger prints the weekly view, from the config's weekStarts", () => {
  const monday = ledgerProject().status("--ledger");
  assert.equal(monday.status, 0, monday.stderr);
  assert.match(monday.stdout, /Weeks start on Monday/);
  assert.match(monday.stdout, /Week of 2026-11-02 · 3 session\(s\) · \$1\.75/);
  const sunday = ledgerProject({ weekStarts: "sunday" }).status("--ledger");
  assert.match(sunday.stdout, /Weeks start on Sunday/);
  assert.match(sunday.stdout, /Week of 2026-11-01 · 3 session\(s\) · \$1\.75/);
  assert.match(sunday.stdout, /Week of 2026-11-08 · 1 session\(s\) · \$2\.00/);
  // A mistake elsewhere in the file is preflight's to report: the weeks still start on Sunday.
  const elsewhere = ledgerProject({ weekStarts: "sunday" }, { phaseRun: { gatez: [] } }).status("--ledger");
  assert.equal(elsewhere.status, 0, elsewhere.stderr);
  assert.match(elsewhere.stdout, /Weeks start on Sunday/);
  const broken = ledgerProject({ weekStarts: "Sunday" }).status("--ledger");
  assert.match(broken.stderr, /ledger\.weekStarts must be a day in lowercase/);
  assert.match(broken.stdout, /Weeks start on Monday/);
});

test("status --csv prints the CSV, and --csv <file> writes it", () => {
  const project = ledgerProject();
  const printed = project.status("--csv");
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout, ledgerCsv(FIXTURE_LEDGER));
  assert.equal(project.status("--csv", "-").stdout, ledgerCsv(FIXTURE_LEDGER));
  const written = project.status("--csv", "out/ledger.csv");
  assert.equal(written.status, 0, written.stderr);
  assert.equal(readFileSync(join(project.dir, "out", "ledger.csv"), "utf8"), ledgerCsv(FIXTURE_LEDGER));
  assert.match(written.stdout, /4 row\(s\)/);
});

test("prices.json lists Opus 5.5, Sonnet 5.5 and Fable 5.1 only, five rates each, Opus as the fallback", () => {
  const real = loadPrices();
  assert.equal(real.fallback, "claude-opus-5-5");
  assert.match(real.checkedOn, /^\d{4}-\d{2}-\d{2}$/);
  // US dollars per million tokens: input, 5-minute write, 1-hour write, cache read, output (spec #11, D1).
  assert.deepEqual(real.perMillion, {
    "claude-opus-5-5": { input: 4, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20 },
    "claude-sonnet-5-5": { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2, output: 10 },
    "claude-fable-5-1": { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25, output: 50 },
  });
});

const RATE = prices.perMillion.m;

/** A price list of the one row `m`, written to a file and loaded as loadPrices reads one. */
function loadRow(row, fallback = "m") {
  const file = join(temp("phase-run-prices-"), "prices.json");
  writeFileSync(file, JSON.stringify({ checkedOn: "2026-11-07", fallback, perMillion: { m: row } }));
  return loadPrices(file);
}

test("loading the price list refuses a row missing any of the five rates", () => {
  for (const missing of Object.keys(RATE)) {
    const { [missing]: _, ...row } = RATE;
    assert.throws(() => loadRow(row), new RegExp(`"m".*${missing}`));
  }
});

test("loading the price list refuses a fallback that names no row", () => {
  assert.throws(() => loadRow(RATE, "gone"), /fallback "gone"/);
});

test("an `above` tier is accepted with a promptTokens and five rates, and refused short of a rate", () => {
  assert.equal(loadRow({ ...RATE, above: ABOVE }).perMillion.m.above.promptTokens, 200_000);
  const { output: _, ...short } = ABOVE;
  assert.throws(() => loadRow({ ...RATE, above: short }), /"m".*above.*output/);
  const { promptTokens: __, ...noThreshold } = ABOVE;
  assert.throws(() => loadRow({ ...RATE, above: noThreshold }), /"m".*above.*promptTokens/);
});

test("a price list's age is counted in whole days from its checkedOn", () => {
  const list = { checkedOn: "2026-11-07" };
  assert.equal(pricesAgeDays(list, Date.UTC(2027, 1, 5, 12)), 90); // 5 Feb 2027: not yet stale
  assert.equal(pricesAgeDays(list, Date.UTC(2027, 1, 6, 12)), 91);
  assert.equal(pricesAgeDays({}, Date.UTC(2027, 1, 6)), null);
});

// The one test that reads the real clock, so it only ever warns.
test("prices.json was checked in the last 90 days (a warning, never a failure)", (t) => {
  const age = pricesAgeDays(loadPrices(), Date.now());
  if (age == null || age > PRICES_STALE_DAYS) t.diagnostic(`WARNING: tools/phase-run/prices.json's checkedOn is ${age ?? "missing"} days old; check the rates against Claude's price list and update it.`);
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

test("with unread paths, a docs-only edit keeps the tree key; code, a new code file or a nested .md change it", () => {
  const unread = ["docs/**", "*.md"];
  const { dir, git } = gitRepo({ "README.md": "# r\n", "docs/x.md": "x\n", "src/a.js": "1\n", "src/notes.md": "n\n" });
  const clean = treeKey(dir, unread);
  assert.ok(clean);
  writeFileSync(join(dir, "docs/x.md"), "edited\n");
  writeFileSync(join(dir, "README.md"), "# edited\n");
  writeFileSync(join(dir, "docs/new.md"), "new\n");
  assert.equal(treeKey(dir, unread), clean);
  assert.equal(git("status", "--porcelain").stdout.trim().split("\n").length, 3); // nothing was staged in the real index
  git("add", "-A");
  git("commit", "-q", "-m", "docs");
  assert.equal(treeKey(dir, unread), clean, "the same after the docs are committed");

  writeFileSync(join(dir, "src/notes.md"), "edited\n"); // `*.md` is the root only
  assert.notEqual(treeKey(dir, unread), clean);
  git("checkout", "--", "src/notes.md");
  writeFileSync(join(dir, "src/b.js"), "new code\n");
  assert.notEqual(treeKey(dir, unread), clean);
  rmSync(join(dir, "src/b.js"));
  writeFileSync(join(dir, "src/a.js"), "2\n");
  assert.notEqual(treeKey(dir, unread), clean);
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

test("a receipt holds only under the unread list it was made under; a 0.4.0 receipt only under none", () => {
  const now = { tree: "t1", base: "b1", command: "npm test", unread: ["docs/**", "*.md"] };
  const made = { tree: "t1", base: "b1", commands: ["npm test"], passed: true, unread: ["*.md", "docs/**"] };
  assert.equal(receiptHolds(made, now), true, "the same list in another order");
  assert.equal(receiptHolds({ ...made, unread: ["docs/**"] }, now), false);
  const older = { tree: "t1", base: "b1", commands: ["npm test"], passed: true };
  assert.equal(receiptHolds(older, now), false);
  assert.equal(receiptHolds(older, { ...now, unread: [] }), true);
  assert.equal(receiptHolds(made, { ...now, unread: undefined }), false);
  assert.equal(receiptHolds(made, { ...now, unread: null }), false, "a null list is no list, never a crash");
});

test("an unread list that leaves out every file gives no tree key, so no receipt can hold", () => {
  const { dir } = gitRepo();
  assert.equal(treeKey(dir, ["*.txt", ".gitignore"]), null);
  assert.ok(treeKey(dir, [".gitignore"]));
});

// 0.6.0 (#17, ADR 0004): one JS matcher for every unread list, and one key per check.

test("the matcher: * and ? stay in a folder, **/ crosses folders, a folder covers what is under it, the last match wins, ! puts back", () => {
  const cases = [
    [["*.md"], ["README.md", ".x.md"], ["docs/a.md", "README.mdx"]],
    [["**/*.md"], ["README.md", "docs/a.md", "a/b/c.md"], ["a.mdx", "docs/a.json"]],
    [["docs/**"], ["docs/a.md", "docs/a/b.json"], ["docs", "docsy/a.md"]],
    [["docs", "src/"], ["docs/a.md", "src/x/y.js"], ["docsy/a", "src"]],
    [["src/**/test.js"], ["src/test.js", "src/a/b/test.js"], ["src/atest.js", "test.js"]],
    [["?.txt"], ["a.txt"], ["ab.txt", "a/b.txt"]],
    [["[ab]*.txt", "[!c]?.log"], ["a1.txt", "b.txt", "d1.log"], ["c1.txt", "c1.log", "a/b.txt"]],
    [["docs**"], ["docsy", "docs"], ["docs/a.md"]], // `**` inside a name is a `*`
    [["docs/**", "!docs/fixtures/**"], ["docs/a.md"], ["docs/fixtures/x.json", "src/a.js"]],
    [["!docs/a.md", "docs/**"], ["docs/a.md"], []], // the last match wins: put back, then left out again
    [["notes.[md"], ["notes.[md"], ["notes.m"]], // a class that never closes is a literal `[`
    [["[[:upper:]]*.md", "[]x]y"], ["README.md", "]y", "xy"], ["readme.md", "docs/README.md"]], // named classes; a leading `]` is a member
    [["[[:bogus:]]*"], [], ["a", "README.md"]], // an unknown class name matches nothing, as in git
  ];
  for (const [list, unread, read] of cases) {
    const matches = unreadMatcher(list);
    for (const path of unread) assert.equal(matches(path), true, `${JSON.stringify(list)} leaves out ${path}`);
    for (const path of read) assert.equal(matches(path), false, `${JSON.stringify(list)} keeps ${path}`);
  }
  assert.equal(unreadMatcher([])("README.md"), false);
});

/** 0.5.2's key: git's own `:(glob)` pathspecs remove the list from a copy of the index. */
function gitGlobKey(dir, unread) {
  const index = join(temp("phase-run-old-key-"), "index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const git = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8", env });
  git("read-tree", "HEAD");
  git("add", "-A");
  git("rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...unread.map((p) => `:(glob)${p}`));
  return git("write-tree").stdout.trim();
}

test("the JS matcher keys a tree as git's :(glob) did, for today's lists and others", () => {
  const { dir } = gitRepo({
    "README.md": "r\n", "CHANGELOG.md": "c\n", "docs/a.md": "a\n", "docs/sub/b.json": "{}\n", "docsy/c.md": "c\n",
    "src/x.js": "x\n", "src/notes.md": "n\n", "src/deep/test.js": "t\n", "b.txt": "b\n",
  });
  writeFileSync(join(dir, "docs/new.md"), "untracked\n");
  writeFileSync(join(dir, "src/x.js"), "edited\n");
  for (const list of [["docs/**", "*.md"], ["**/*.md"], ["docs/*.md"], ["docs"], ["docs/"], ["?.txt"], ["src/**/test.js"], ["**/*.json", "CHANGELOG.md"], ["[[:upper:]]*.md", "doc*/**"], ["[!R]*.md", "src/[a-n]*"]]) {
    assert.equal(treeKey(dir, list), gitGlobKey(dir, list), JSON.stringify(list));
  }
});

test("treeKeys gives each list its own key from one staging, and a list that leaves out everything no key", () => {
  const { dir } = gitRepo({ "README.md": "r\n", "docs/a.md": "a\n", "docs/data.json": "{}\n" });
  const lists = [["**/*.md"], ["docs/**", "*.md"], [], ["*.txt", ".gitignore", "*.md", "docs/**"]];
  const before = treeKeys(dir, lists);
  assert.deepEqual(before.slice(0, 3), lists.slice(0, 3).map((list) => treeKey(dir, list)));
  assert.equal(new Set(before.slice(0, 3)).size, 3);
  assert.equal(before[3], null);
  writeFileSync(join(dir, "docs/data.json"), '{ "edited": true }\n');
  const after = treeKeys(dir, lists);
  assert.deepEqual([after[0] === before[0], after[1] === before[1], after[2] === before[2]], [false, true, false]);
});

test("a check's receipt file is named for it, and a nameless check keeps 0.5.x's", () => {
  assert.equal(receiptPath("/p", "7", "lint"), join("/p", ".phase-run", "lint-receipt-7.json"));
  assert.equal(receiptPath("/p", "7"), join("/p", ".phase-run", "test-receipt-7.json"));
  assert.equal(receiptPath("/p", undefined, "lint"), join("/p", ".phase-run", "lint-receipt.json"));
});

test("a receipt vouches for the command with {base} filled in; a 0.5.x one, written unfilled, still holds under its base", () => {
  const now = { tree: "t1", base: "b1", command: "npm test -- --since {base}" };
  assert.equal(receiptHolds({ tree: "t1", base: "b1", commands: ["npm test -- --since b1"], passed: true }, now), true);
  assert.equal(receiptHolds({ tree: "t1", base: "b1", commands: ["npm test -- --since {base}"], passed: true }, now), true);
  assert.equal(receiptHolds({ tree: "t1", base: "b1", commands: ["npm test -- --since b0"], passed: true }, now), false);
});

test("receipt groups: a named check alone, the nameless ones together", () => {
  const rows = [
    { name: "lint", label: "Lint", run: "l", receipt: true, unread: ["**/*.md"] },
    { name: null, label: "Format", run: "f", receipt: false, unread: [] },
    { name: null, label: "Unit", run: "u", receipt: true, unread: ["docs/**"] },
    { name: null, label: "E2E", run: "e", receipt: true, unread: ["docs/**"] },
  ];
  assert.deepEqual(receiptGroups(rows).map((g) => [g.name, g.checks.map((c) => c.label), g.unread]), [["lint", ["Lint"], ["**/*.md"]], [null, ["Unit", "E2E"], ["docs/**"]]]);
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

/** What stop-tests.mjs needs of the runner to run: itself and what it imports. */
const STOP_TESTS_FILES = ["stop-tests.mjs", "receipt.mjs", "unread.mjs", "config.mjs", "metrics.mjs", "ticket-size.mjs", "prices.json"];

/**
 * A project with this folder's runner copied in, and the given test command as its receipt row (or,
 * with `rows`, those stop-check rows).
 */
function stopTestsProject(testRun, row = {}, rows = null) {
  const files = Object.fromEntries(STOP_TESTS_FILES.map((name) => [`tools/phase-run/${name}`, readFileSync(join(HERE, name), "utf8")]));
  files[".claude/workflow.json"] = JSON.stringify({ version: 1, stopGate: { checks: rows ?? [{ label: "Tests", run: testRun, receipt: true, ...row }] } });
  const project = gitRepo(files);
  const run = () => spawnSync(process.execPath, [join(project.dir, "tools/phase-run/stop-tests.mjs"), "main"], { cwd: project.dir, encoding: "utf8", env: { ...outsideRun(), PHASE_RUN_TICKET: "7" } });
  return { ...project, run, receipt: (name) => readReceipt(receiptPath(project.dir, "7", name)) };
}

/**
 * This process's environment without the phase run's variables: the suite runs inside a run (the
 * stop check, a gate), and an inherited PHASE_RUN_ROOT would point a test project's stop-tests.mjs
 * at the real repo.
 */
function outsideRun() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PHASE_RUN/.test(key)));
}

test("stop-tests.mjs run from the run's copy reads the copy's config and keys and records the repo's code", () => {
  // The live config's tests fail; the copy's (taken at run start) pass.
  const project = stopTestsProject('node -e "process.exit(1)"');
  const copy = join(project.dir, ".phase-run", "phase-x", "runner");
  mkdirSync(join(copy, "tools/phase-run"), { recursive: true });
  for (const name of STOP_TESTS_FILES) writeFileSync(join(copy, "tools/phase-run", name), readFileSync(join(project.dir, "tools/phase-run", name)));
  mkdirSync(join(copy, ".claude"), { recursive: true });
  writeFileSync(join(copy, ".claude/workflow.json"), JSON.stringify({ version: 1, stopGate: { checks: [{ label: "Tests", run: 'node -e "console.log(1)"', receipt: true }] } }));
  const result = spawnSync(process.execPath, [join(copy, "tools/phase-run/stop-tests.mjs"), "main"], {
    cwd: project.dir,
    encoding: "utf8",
    env: { ...outsideRun(), PHASE_RUN_TICKET: "7", PHASE_RUN_ROOT: project.dir },
  });
  assert.equal(result.status, 0, result.stdout);
  const receipt = project.receipt();
  assert.deepEqual(receipt.commands, ['node -e "console.log(1)"'], "the copy's command");
  assert.equal(receipt.tree, treeKey(project.dir), "the repo's code, in the repo's .phase-run/");
  assert.equal(existsSync(join(copy, ".phase-run")), false, "nothing is written inside the copy");
});

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

test("stop-tests.mjs records its unread list, and a docs-only edit after the pass skips the tests", () => {
  const project = stopTestsProject('node -e "console.log(1)"', { unread: ["docs/**", "*.md"] });
  assert.equal(project.run().status, 0);
  assert.deepEqual(project.receipt().unread, ["docs/**", "*.md"]);
  mkdirSync(join(project.dir, "docs"), { recursive: true });
  writeFileSync(join(project.dir, "docs", "devlog.md"), "the ticket's entry\n");
  assert.match(project.run().stdout, /already passed on exactly this code/);
  writeFileSync(join(project.dir, "a.txt"), "code edited\n");
  assert.match(project.run().stdout, /Tests: passed/);
});

test("stop-tests.mjs says so when git cannot key the code, and records no receipt", () => {
  const project = stopTestsProject('node -e "console.log(1)"', { unread: ["tools/**", ".claude/**", "*.txt", ".gitignore"] });
  const result = project.run();
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"unread" list.*no receipt is recorded/);
  assert.equal(project.receipt(), null);
});

test("stop-tests.mjs says so when the tests changed a tracked file, and records no receipt", () => {
  const project = stopTestsProject("node -e \"require('fs').writeFileSync('a.txt', 'rewritten by the tests')\"");
  const result = project.run();
  assert.equal(result.status, 0);
  assert.match(result.stdout, /code changed while the checks ran.*no receipt is recorded/);
  assert.equal(project.receipt(), null);
});

// 0.6.0 (#17): every receipt check runs, each keeps its own receipt.
const failingWith = (text, status) => `node -e "process.stdout.write('${text}'.repeat(20000)); process.exit(${status})"`;

test("stop-tests.mjs runs every receipt check after a failure, caps the failures together, and records each pass's receipt", () => {
  const rows = [
    { name: "typecheck", label: "Typecheck", run: failingWith("T", 4), receipt: true },
    { name: "lint", label: "Lint", run: 'node -e "console.log(1)"', receipt: true, unread: ["**/*.md"] },
    { label: "Tests", run: failingWith("U", 5), receipt: true },
    { label: "Not a receipt check", run: 'node -e "process.exit(9)"' },
  ];
  const project = stopTestsProject(null, {}, rows);
  const result = project.run();
  assert.equal(result.status, 4, "the first failure's status");
  assert.match(result.stdout, /Typecheck: FAILED[\s\S]*Lint: passed[\s\S]*Tests: FAILED/);
  assert.doesNotMatch(result.stdout, /Not a receipt check/);
  assert.match(result.stdout, /Typecheck FAILED:\n…\(cut to the last 7500 characters\)/);
  assert.match(result.stdout, /Tests FAILED:\n…\(cut to the last 7500 characters\)/);
  assert.ok(result.stdout.length < 16_000, `the failures share one cap (${result.stdout.length})`);
  assert.deepEqual([project.receipt("typecheck"), project.receipt()], [null, null]);
  const lint = project.receipt("lint");
  assert.deepEqual([lint.name, lint.commands, lint.unread, lint.tree], ["lint", ['node -e "console.log(1)"'], ["**/*.md"], treeKey(project.dir, ["**/*.md"])]);
});

test("stop-tests.mjs runs its checks in the config's order, nameless and named mixed, and exits with the first failure's status", () => {
  const rows = [
    { label: "Unit", run: 'node -e "console.log(1)"', receipt: true },
    { name: "lint", label: "Lint", run: 'node -e "process.exit(7)"', receipt: true },
    { label: "E2E", run: 'node -e "process.exit(6)"', receipt: true },
  ];
  const result = stopTestsProject(null, {}, rows).run();
  assert.equal(result.status, 7);
  assert.match(result.stdout, /Unit: passed[\s\S]*Lint: FAILED[\s\S]*E2E: FAILED/);
});

test("stop-tests.mjs skips only the checks whose own receipt still holds, and fills {base} into what it records", () => {
  const rows = [
    { name: "lint", label: "Lint", run: 'node -e "console.log(1)" {base}', receipt: true, unread: ["**/*.md"] },
    { label: "Tests", run: 'node -e "console.log(2)"', receipt: true, unread: ["docs/**", "*.md"] },
  ];
  const project = stopTestsProject(null, {}, rows);
  assert.equal(project.run().status, 0);
  assert.deepEqual(project.receipt("lint").commands, ['node -e "console.log(1)" main']);
  mkdirSync(join(project.dir, "docs"), { recursive: true });
  writeFileSync(join(project.dir, "docs", "data.json"), "{}\n"); // lint might read it; the tests never do
  const again = project.run();
  assert.match(again.stdout, /Tests: already passed on exactly this code/);
  assert.match(again.stdout, /Lint: passed/);
  writeFileSync(join(project.dir, "docs", "devlog.md"), "the entry\n");
  assert.match(project.run().stdout, /Every check already passed on exactly this code\. Nothing to run\./);
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
  assert.match(withReceipt.RECEIPT, /docs and logs first.*tests last/s, "a devlog written after the pass no longer costs a re-run");
  assert.match(withReceipt.RECEIPT, /docs included/, "with no unread list, a docs edit runs them again");
  const listed = promptValues(project([{ label: "Tests", run: "npm test", receipt: true, unread: ["docs/**", "*.md"] }]), "", { BASE: "abc", N: 1 });
  assert.match(listed.RECEIPT, /except to `docs\/\*\*`, `\*\.md`.*docs and logs first.*tests last/s);
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
