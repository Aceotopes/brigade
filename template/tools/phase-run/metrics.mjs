// What one ticket cost and where its time went, read from its session's
// transcript after the fact. A background session reports no cost of its own
// (run.mjs runBackground), so the transcript is the only record.
//
// - Tokens: each assistant response's `usage`, once per message id (one
//   response is written as several lines), for the session and every
//   subagent it started (`<session>/subagents/*.jsonl`).
// - Cost: those tokens at prices.json's rates. A usage gauge, not a bill.
// - Time: each tool call's wait (its result's timestamp minus its call's),
//   sorted by what the call was (stepRules). The Stop hook's own minutes come
//   from .phase-run/stop-check-log.jsonl, the gates' from the runner's clock.
//   "Claude" is what is left: the ticket's wall time minus everything
//   measured, mostly the model thinking and writing. It is a remainder, not
//   a reading.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadPrices(file = join(HERE, "prices.json")) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function rows(file) {
  if (!file || !existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a line still being written
    }
  }
  return out;
}

const emptyUsage = () => ({ calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, peakContext: 0, byModel: {} });

function addUsage(total, model, usage) {
  const tokens = {
    input: usage.input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
  };
  total.calls += 1;
  const mine = (total.byModel[model] ??= { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
  for (const [key, value] of Object.entries(tokens)) {
    total[key] += value;
    mine[key] += value;
  }
  return tokens.input + tokens.cacheWrite + tokens.cacheRead;
}

/** Token totals of one transcript file. `peakContext` leaves out a response that called the advisor (it adds the advisor's read). */
export function usageOf(file, total = emptyUsage()) {
  const seen = new Set();
  for (const row of rows(file)) {
    const message = row.message;
    if (row.type !== "assistant" || !message?.usage) continue;
    const key = message.id ?? row.uuid;
    if (seen.has(key)) continue;
    seen.add(key);
    const context = addUsage(total, message.model ?? "unknown", message.usage);
    if (!(message.usage.iterations ?? []).some((it) => it.type === "advisor_message")) total.peakContext = Math.max(total.peakContext, context);
  }
  return total;
}

/** A session's tokens with its subagents' added (the peak is the session's own). */
export function sessionUsage(transcript) {
  const total = usageOf(transcript);
  const peak = total.peakContext;
  const dir = transcript ? join(transcript.replace(/\.jsonl$/, ""), "subagents") : null;
  if (dir && existsSync(dir)) {
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) usageOf(join(dir, name), total);
  }
  total.peakContext = peak;
  return total;
}

export function costOf(usage, prices) {
  let dollars = 0;
  for (const [model, tokens] of Object.entries(usage.byModel)) {
    const rate = prices.perMillion[model] ?? prices.perMillion[prices.fallback];
    for (const key of ["input", "cacheWrite", "cacheRead", "output"]) dollars += (tokens[key] * rate[key]) / 1e6;
  }
  return Math.round(dollars * 100) / 100;
}

// ------------------------------------------------------------- step kinds

/** The plain words a step can be. The display and the time split know these and no others. */
export const STEP_KINDS = ["testing", "checking", "browser", "waiting", "reviewing", "reading", "writing", "working"];

/**
 * Brigade's own rows, tested after the project's. The runner's helper
 * scripts first: waiting on a reviewer is the review's time, so "waiting" is
 * left for pauses, which should fall to zero.
 */
const GENERIC_ROWS = [
  { kind: "testing", match: /stop-tests\.mjs|\bvitest\b|\bjest\b|\bpytest\b|node --test|\b(npm|pnpm|yarn|bun) (run )?test\b/ },
  { kind: "reviewing", match: /wait-subagents\.mjs/ },
  { kind: "browser", match: /wait-url\.mjs|playwright/i },
  { kind: "checking", match: /\btsc\b|typecheck|eslint|\blint\b|doc-check|doc-index/ },
  { kind: "waiting", match: /\bsleep\b|Start-Sleep|setTimeout|\bwait-|\bpause\b|\buntil / },
];

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The rows a shell command is sorted by, first match wins: the project's own
 * (`phaseRun.steps`), then rows made from its stop checks (a `receipt` row is
 * its tests, any other a check), then Brigade's generic rows.
 */
export function stepRules({ steps = [], stopChecks = [] } = {}) {
  const fromChecks = stopChecks.map((check) => ({
    kind: check.receipt ? "testing" : "checking",
    match: new RegExp(escape(check.run).replaceAll(escape("{base}"), "\\S+")),
  }));
  return [...steps, ...fromChecks, ...GENERIC_ROWS];
}

const DEFAULT_RULES = stepRules();

/**
 * What a step was, in a plain word. `name` is the tool, `text` its command or
 * path. The same words serve the live row ("reviewing · 194 steps") and the
 * time split.
 */
export function stepKind(name, text = "", rules = DEFAULT_RULES) {
  if (name === "Bash" || name === "PowerShell" || name === "Monitor") {
    return rules.find((rule) => rule.match.test(text))?.kind ?? "working";
  }
  if (name === "Agent" || name === "Task" || name === "Skill") return "reviewing";
  if (name === "Read" || name === "Grep" || name === "Glob") return "reading";
  if (name === "Edit" || name === "Write" || name === "NotebookEdit") return "writing";
  return "working";
}

/** Milliseconds each kind of step kept the session waiting on its tool. */
export function toolTime(file, rules = DEFAULT_RULES) {
  const open = new Map();
  const spent = {};
  for (const row of rows(file)) {
    const at = row.timestamp ? Date.parse(row.timestamp) : NaN;
    const content = row.message?.content;
    if (!Array.isArray(content) || Number.isNaN(at)) continue;
    for (const block of content) {
      if (row.type === "assistant" && block.type === "tool_use") {
        const input = block.input ?? {};
        open.set(block.id, { kind: stepKind(block.name, String(input.command ?? input.file_path ?? input.skill ?? ""), rules), at });
      }
      if (row.type === "user" && block.type === "tool_result") {
        const call = open.get(block.tool_use_id);
        if (!call) continue;
        open.delete(block.tool_use_id);
        spent[call.kind] = (spent[call.kind] ?? 0) + Math.max(0, at - call.at);
      }
    }
  }
  return spent;
}

/**
 * The Stop hook's milliseconds for a ticket between two times, from the rows
 * hooks/stop-gate.mjs appends to stop-check-log.jsonl:
 * `{ ticket, startedAt, endedAt, passed, testsSkipped }`.
 */
export function hookTime(logFile, ticket, from, to = Infinity) {
  return rows(logFile)
    .filter((entry) => entry.ticket === ticket && entry.startedAt >= from && entry.endedAt <= to)
    .reduce((sum, entry) => sum + (entry.endedAt - entry.startedAt), 0);
}

const minutes = (ms) => Math.round(ms / 60_000);

/**
 * One ticket's numbers, as the report, the terminal table and status.mjs show them.
 * Minutes: total = start to the end; the named buckets are measured; claude is the rest.
 */
export function ticketMetrics({ transcript, startedAt, endedAt, gatesMs, hookMs, prices, rules = DEFAULT_RULES }) {
  const usage = sessionUsage(transcript);
  const tools = toolTime(transcript, rules);
  const measured = {
    tests: tools.testing ?? 0,
    checks: tools.checking ?? 0,
    browser: tools.browser ?? 0,
    waiting: tools.waiting ?? 0,
    reviewing: tools.reviewing ?? 0,
    hook: hookMs,
    gates: gatesMs,
  };
  const totalMs = endedAt - startedAt;
  const rest = Math.max(0, totalMs - Object.values(measured).reduce((a, b) => a + b, 0));
  return {
    costUsd: costOf(usage, prices),
    tokens: { calls: usage.calls, input: usage.input, cacheWrite: usage.cacheWrite, cacheRead: usage.cacheRead, output: usage.output },
    peakContext: usage.peakContext,
    minutes: { total: minutes(totalMs), claude: minutes(rest), ...Object.fromEntries(Object.entries(measured).map(([k, v]) => [k, minutes(v)])) },
  };
}
