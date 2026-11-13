// What one ticket cost and where its time went, read from its session's
// transcript after the fact. A background session reports no cost of its own
// (run.mjs runBackground), so the transcript is the only record.
//
// - Tokens: each assistant response's `usage`, once per message id (one
//   response is written as several lines), for the session and every
//   subagent it started (`<session>/subagents/*.jsonl`).
// - Cost: each request at prices.json's rates (requestCost), a usage gauge,
//   not a bill. A response that called the advisor lists its requests in
//   `usage.iterations`; its top-level usage leaves the advisor's pass out, so
//   the iterations are what is priced. sessionCostFrom prices only what a
//   transcript added since a saved state, for the ledger and the attended hook.
// - Time: each tool call's wait (its result's timestamp minus its call's),
//   sorted by what the call was (stepRules). The Stop hook's own minutes come
//   from .phase-run/stop-check-log.jsonl, the gates' from the runner's clock.
//   "Claude" is what is left: the ticket's wall time minus everything
//   measured, mostly the model thinking and writing. It is a remainder, not
//   a reading.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The five rates every price row carries, in US dollars per million tokens. */
const RATES = ["input", "cacheWrite5m", "cacheWrite1h", "cacheRead", "output"];

/** Past this many days since its checkedOn, the price list's test warns. */
export const PRICES_STALE_DAYS = 90;

const isRate = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** The price list, refused (thrown) when a row or its `above` tier misses a rate, or `fallback` names no row. */
export function loadPrices(file = join(HERE, "prices.json")) {
  const prices = JSON.parse(readFileSync(file, "utf8"));
  const rows = prices.perMillion ?? {};
  for (const [model, row] of Object.entries(rows)) {
    const missing = RATES.filter((rate) => !isRate(row?.[rate]));
    if (missing.length) throw new Error(`${file}: the row "${model}" has no ${missing.join(", ")}`);
    if (row.above === undefined) continue;
    const short = ["promptTokens", ...RATES].filter((rate) => !isRate(row.above?.[rate]));
    if (short.length) throw new Error(`${file}: the row "${model}"'s above tier has no ${short.join(", ")}`);
  }
  if (!Object.hasOwn(rows, prices.fallback)) throw new Error(`${file}: the fallback "${prices.fallback}" names no row`);
  return prices;
}

/** Whole days from the price list's checkedOn to `at`, or null when it has none. */
export function pricesAgeDays(prices, at) {
  const checked = Date.parse(`${prices.checkedOn}T00:00:00Z`);
  return Number.isNaN(checked) ? null : Math.floor((at - checked) / 86_400_000);
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

// ------------------------------------------------------------------ pricing

/**
 * One request's cost in nano-dollars (a whole number: dollars × 1e9), so
 * costs add up exactly in any order, and two steps sum to the whole. The cache
 * write goes at its lifetime's rate; what `cache_creation` does not split goes
 * at the one-hour rate. A prompt (input + writes + reads) over a row's
 * `above.promptTokens` is priced at that tier; an unlisted model at `fallback`.
 */
function requestCost(model, usage, prices) {
  const write = usage.cache_creation_input_tokens ?? 0;
  const fiveMinutes = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const oneHour = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const tokens = {
    input: usage.input_tokens ?? 0,
    cacheWrite5m: fiveMinutes,
    cacheWrite1h: oneHour + Math.max(0, write - fiveMinutes - oneHour),
    cacheRead: usage.cache_read_input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
  };
  const prompt = tokens.input + tokens.cacheWrite5m + tokens.cacheWrite1h + tokens.cacheRead;
  let rate = prices.perMillion[model] ?? prices.perMillion[prices.fallback];
  if (rate.above && prompt > rate.above.promptTokens) rate = rate.above;
  // per million tokens → nano-dollars: tokens × rate / 1e6 × 1e9
  return RATES.reduce((sum, key) => sum + Math.round(tokens[key] * rate[key] * 1000), 0);
}

const isAdvisor = (iteration) => iteration.type === "advisor_message";

/** Nano-dollars to dollars and cents, rounded only here. */
const dollars = (nanoUsd) => Math.round(nanoUsd / 1e7) / 100;

/** The requests one response made: its iterations when it lists them (an advisor pass at its own model), else its usage. */
function requestsOf(message) {
  const usage = message.usage;
  const model = message.model ?? "unknown";
  const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
  if (!iterations.some((it) => !isAdvisor(it))) {
    return [{ model, usage }, ...iterations.map((it) => ({ model: it.model ?? model, usage: it, advisor: true }))];
  }
  return iterations.map((it) => ({ model: it.model ?? model, usage: it, advisor: isAdvisor(it) }));
}

const emptyCost = () => ({ nanoUsd: 0, costUsd: 0, calls: 0, advisorCalls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, peakContext: 0, byModel: {} });

/**
 * Adds one response: its cost (in all, and under each request's model, so an advisor pass counts
 * under the advisor's), the session's own tokens (top-level usage), and its context unless it
 * called the advisor.
 */
function addResponse(total, message, prices, ownPeak) {
  const usage = message.usage;
  total.calls += 1;
  for (const request of requestsOf(message)) {
    const nano = requestCost(request.model, request.usage, prices);
    total.nanoUsd += nano;
    const model = (total.byModel[request.model] ??= { requests: 0, nanoUsd: 0, costUsd: 0 });
    model.requests += 1;
    model.nanoUsd += nano;
    if (request.advisor) total.advisorCalls += 1;
  }
  total.input += usage.input_tokens ?? 0;
  total.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  total.cacheRead += usage.cache_read_input_tokens ?? 0;
  total.output += usage.output_tokens ?? 0;
  const context = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  if (ownPeak && !(usage.iterations ?? []).some(isAdvisor)) total.peakContext = Math.max(total.peakContext, context);
}

/**
 * The complete lines a file gained since byte `offset`, and the offset after
 * them. A last line still being written is left for next time, unless it
 * already parses. A file shorter than the offset was replaced: read it again
 * (its counted ids still skip what was priced). A transcript is only ever
 * appended to, so a replacement as long or longer is not looked for.
 */
function linesSince(file, offset) {
  if (!existsSync(file)) return { text: "", next: 0 };
  const size = statSync(file).size;
  const from = size < offset ? 0 : offset;
  if (size === from) return { text: "", next: from };
  const bytes = Buffer.alloc(size - from);
  const fd = openSync(file, "r");
  try {
    readSync(fd, bytes, 0, bytes.length, from);
  } finally {
    closeSync(fd);
  }
  const end = bytes.lastIndexOf(0x0a) + 1;
  const tail = bytes.subarray(end).toString("utf8");
  let whole = false;
  try {
    JSON.parse(tail);
    whole = true;
  } catch {
    // still being written
  }
  return whole ? { text: bytes.toString("utf8"), next: size } : { text: bytes.subarray(0, end).toString("utf8"), next: from + end };
}

/** The session's own transcript, then each subagent's beside it (`<session>/subagents/*.jsonl`). */
function sessionFiles(transcript) {
  if (!transcript) return [];
  transcript = resolve(transcript); // the state's keys: one spelling per file
  const dir = join(transcript.replace(/\.jsonl$/, ""), "subagents");
  const subagents = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort().map((n) => join(dir, n)) : [];
  return [transcript, ...subagents];
}

/**
 * What a session's transcript and its subagents' added since `state`, priced
 * per request; with no state, the whole session. Returns the cost of the
 * added part and the new state. The state is plain JSON, one entry per file:
 * the byte offset read to, and the response ids already counted (a response
 * is written as several lines, which can fall either side of a step).
 */
export function sessionCostFrom(transcript, prices, state = { files: {} }) {
  const cost = emptyCost();
  const files = { ...state.files };
  sessionFiles(transcript).forEach((file, index) => {
    const before = files[file] ?? { offset: 0, seen: [] };
    const read = linesSince(file, before.offset);
    const seen = new Set(before.seen); // kept across a rewrite too, so nothing is counted twice
    for (const line of read.text.split("\n")) {
      if (!line) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const message = row.message;
      if (row.type !== "assistant" || !message?.usage) continue;
      const key = message.id ?? row.uuid;
      if (seen.has(key)) continue;
      seen.add(key);
      addResponse(cost, message, prices, index === 0);
    }
    files[file] = { offset: read.next, seen: [...seen] };
  });
  return { cost: priceInDollars(cost), state: { files } };
}

/** A cost's dollar figures, its own and each model's, set from its nano-dollars (rounded only here). */
function priceInDollars(cost) {
  cost.costUsd = dollars(cost.nanoUsd);
  for (const model of Object.values(cost.byModel)) model.costUsd = dollars(model.nanoUsd);
  return cost;
}

/** The counters two costs add (addCost): every number in a cost but the peak and the rounded dollars. */
const SUMMED = Object.keys(emptyCost()).filter((key) => !["costUsd", "peakContext", "byModel"].includes(key));

/**
 * Two costs added, for a reader that steps through a session (sessionCostFrom) and keeps its whole
 * cost: sums in nano-dollars, rounded only for costUsd; the peak context as a max. `total` may be
 * undefined, nothing counted yet. Returns a new cost; neither argument is changed.
 */
export function addCost(total, step) {
  const sum = emptyCost();
  for (const part of [total, step]) {
    if (!part) continue;
    for (const key of SUMMED) sum[key] += part[key] ?? 0;
    sum.peakContext = Math.max(sum.peakContext, part.peakContext ?? 0);
    for (const [name, m] of Object.entries(part.byModel ?? {})) {
      const model = (sum.byModel[name] ??= { requests: 0, nanoUsd: 0, costUsd: 0 });
      model.requests += m.requests ?? 0;
      model.nanoUsd += m.nanoUsd ?? 0;
    }
  }
  return priceInDollars(sum);
}

/** A whole session's cost and tokens: its transcript and its subagents', each request priced on its own. */
export function sessionCost(transcript, prices) {
  return sessionCostFrom(transcript, prices).cost;
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
 * `{ ticket, startedAt, endedAt, passed, testsSkipped, skipped, receipt }` (`skipped`, the checks a
 * receipt covered, since 0.6.0).
 */
export function hookTime(logFile, ticket, from, to = Infinity) {
  return rows(logFile)
    .filter((entry) => entry.ticket === ticket && entry.startedAt >= from && entry.endedAt <= to)
    .reduce((sum, entry) => sum + (entry.endedAt - entry.startedAt), 0);
}

const minutes = (ms) => Math.round(ms / 60_000);

/**
 * A lane ticket's metrics with its landing added (0.7.0, ADR 0008): the wait for the landing lock
 * as slept (`waiting`), the landing itself (the replay, the rebuild, the re-gate, the push) as
 * `gates`, and both in `total`. `claude`, the rest of the session's own time, is unchanged. A new
 * object; null metrics stay null.
 */
export function withLanding(metrics, { waitedMs = 0, landingMs = 0 }) {
  if (!metrics?.minutes) return metrics ?? null;
  const m = metrics.minutes;
  return {
    ...metrics,
    minutes: { ...m, total: m.total + minutes(waitedMs + landingMs), waiting: m.waiting + minutes(waitedMs), gates: m.gates + minutes(landingMs) },
  };
}

/**
 * One ticket's numbers, as the report, the terminal table and status.mjs show them.
 * Minutes: total = start to the end; the named buckets are measured; claude is the rest.
 */
export function ticketMetrics({ transcript, startedAt, endedAt, gatesMs, hookMs, prices, rules = DEFAULT_RULES }) {
  const cost = sessionCost(transcript, prices);
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
    costUsd: cost.costUsd,
    tokens: { calls: cost.calls, input: cost.input, cacheWrite: cost.cacheWrite, cacheRead: cost.cacheRead, output: cost.output },
    peakContext: cost.peakContext,
    minutes: { total: minutes(totalMs), claude: minutes(rest), ...Object.fromEntries(Object.entries(measured).map(([k, v]) => [k, minutes(v)])) },
  };
}
