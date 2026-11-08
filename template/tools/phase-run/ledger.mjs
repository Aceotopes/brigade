// The ledger: one priced row per session reading, kept per project in
// `.phase-run/ledger.jsonl` (gitignored by setup), so what a night cost
// outlives the run's own results and report.
//
//   { at, sessionId, transcript, kind, ticket, branch, brigade, costUsd,
//     tokens: { calls, input, cacheWrite, cacheRead, output }, peakContext,
//     byModel: { <model>: { requests, nanoUsd, costUsd } } }
//
// - A row is the session's whole cost at `at`, not what it added since its
//   last row: a session read twice has two rows, and the views keep its latest.
// - `kind` is `night` (the runner, one row as each ticket ends) or `attended`
//   (the plugin's Stop hook). Any other label, a probe's for one, is counted
//   under `other` and kept as it is in the CSV.
// - `brigade` is the version that judged the session: a night's is the
//   project's stamp (.claude/workflow-version.json), `null` with no stamp.
//
// The views (status.mjs --ledger and --csv) cut weeks on the machine's local
// date, from `ledger.weekStarts` in .claude/workflow.json.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DEFAULT_LEDGER, WEEK_DAYS } from "./config.mjs";

/** Where a project keeps its ledger, from its root. */
export const LEDGER_PATH = join(".phase-run", "ledger.jsonl");

/** The kinds a row is counted under in the views; any other label counts under `other`. */
export const KINDS = ["night", "attended"];

/** The Brigade version a project is stamped with, or null when it has no readable stamp. */
export function stampVersion(root) {
  try {
    const version = JSON.parse(readFileSync(join(root, ".claude", "workflow-version.json"), "utf8")).version;
    return typeof version === "string" && version ? version : null;
  } catch {
    return null; // no stamp, or one that is not JSON: the row says so with null
  }
}

/** One ledger row from a session's cost (metrics.mjs sessionCost). `at` is a time in milliseconds or a Date. */
export function ledgerRow({ at, sessionId, transcript = null, kind, ticket = null, branch = null, brigade = null, cost }) {
  return {
    at: new Date(at).toISOString(),
    sessionId,
    transcript,
    kind,
    ticket,
    branch,
    brigade,
    costUsd: cost.costUsd,
    tokens: { calls: cost.calls, input: cost.input, cacheWrite: cost.cacheWrite, cacheRead: cost.cacheRead, output: cost.output },
    peakContext: cost.peakContext,
    // nanoUsd kept beside costUsd: the views add a model's cost across rows exactly, then round.
    byModel: Object.fromEntries(Object.entries(cost.byModel ?? {}).map(([model, m]) => [model, { requests: m.requests, nanoUsd: m.nanoUsd, costUsd: m.costUsd }])),
  };
}

/** Appends one row as one line. Throws when it cannot: the caller decides what a lost row means. */
export function appendRow(file, row) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(row)}\n`);
}

/** Every row the file holds; a line that does not parse (one still being written) is skipped. */
export function readLedger(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a line still being written, or a torn one
    }
  }
  return out;
}

/** Each session's latest row by `at` (rows are cumulative), oldest first. */
export function latestPerSession(rows) {
  const latest = new Map();
  for (const row of rows) {
    const seen = latest.get(row.sessionId);
    if (!seen || Date.parse(row.at) >= Date.parse(seen.at)) latest.set(row.sessionId, row);
  }
  return [...latest.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** The kind a row is counted under: its own, or `other`. */
export const kindGroup = (row) => (KINDS.includes(row.kind) ? row.kind : "other");

const pad = (n) => String(n).padStart(2, "0");
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The local date (YYYY-MM-DD) the week holding `at` starts on. */
export function weekOf(at, weekStarts = DEFAULT_LEDGER.weekStarts) {
  const d = new Date(at);
  const back = (d.getDay() - WEEK_DAYS.indexOf(weekStarts) + 7) % 7;
  return localDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back));
}

// Sums go in whole cents, so a week's total is the sum of what its rows show.
const cents = (usd) => Math.round((usd ?? 0) * 100);

/**
 * The weekly view: per week, its sessions and cost, by kind (night, attended,
 * other) and by model, oldest week first. Takes each session's latest row.
 */
export function weeklyView(rows, { weekStarts = DEFAULT_LEDGER.weekStarts } = {}) {
  const weeks = new Map();
  for (const row of latestPerSession(rows)) {
    const week = weekOf(row.at, weekStarts);
    if (!weeks.has(week)) weeks.set(week, { week, sessions: 0, cents: 0, kinds: Object.fromEntries([...KINDS, "other"].map((k) => [k, { sessions: 0, cents: 0 }])), models: {} });
    const w = weeks.get(week);
    const kind = w.kinds[kindGroup(row)];
    w.sessions += 1;
    kind.sessions += 1;
    w.cents += cents(row.costUsd);
    kind.cents += cents(row.costUsd);
    for (const [model, m] of Object.entries(row.byModel ?? {})) w.models[model] = (w.models[model] ?? 0) + (m.nanoUsd ?? cents(m.costUsd) * 1e7);
  }
  const usd = (c) => c / 100;
  return [...weeks.values()]
    .sort((a, b) => a.week.localeCompare(b.week))
    .map((w) => ({
      week: w.week,
      sessions: w.sessions,
      costUsd: usd(w.cents),
      kinds: Object.fromEntries(Object.entries(w.kinds).map(([k, v]) => [k, { sessions: v.sessions, costUsd: usd(v.cents) }])),
      // Each model's sum is rounded on its own, so they can differ from the week's total by a cent.
      models: Object.fromEntries(Object.entries(w.models).sort((a, b) => b[1] - a[1]).map(([m, nano]) => [m, Math.round(nano / 1e7) / 100])),
    }));
}

const money = (usd) => `$${usd.toFixed(2)}`;
const capital = (word) => word[0].toUpperCase() + word.slice(1);

/** The weekly view as the terminal prints it. */
export function ledgerText(rows, { weekStarts = DEFAULT_LEDGER.weekStarts } = {}) {
  const weeks = weeklyView(rows, { weekStarts });
  if (!weeks.length) return [`The ledger has no rows yet (${LEDGER_PATH.replaceAll("\\", "/")}).`];
  const sessions = weeks.reduce((sum, w) => sum + w.sessions, 0);
  const total = weeks.reduce((sum, w) => sum + cents(w.costUsd), 0) / 100;
  const out = [`Ledger: ${sessions} session(s), ${money(total)} at API rates (a usage gauge, not a bill). Weeks start on ${capital(weekStarts)}.`];
  for (const w of weeks) {
    out.push("", `Week of ${w.week} · ${w.sessions} session(s) · ${money(w.costUsd)}`);
    for (const [kind, v] of Object.entries(w.kinds)) out.push(`  ${kind.padEnd(9)} ${String(v.sessions).padStart(3)}  ${money(v.costUsd)}`);
    const models = Object.entries(w.models);
    out.push(`  by model  ${models.length ? models.map(([m, usd]) => `${m} ${money(usd)}`).join(" · ") : "none"}`);
  }
  return out;
}

const CSV_COLUMNS = ["at", "week", "kind", "label", "sessionId", "ticket", "branch", "brigade", "costUsd", "calls", "input", "cacheWrite", "cacheRead", "output", "peakContext", "byModel", "transcript"];

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * The CSV: each session's latest row, oldest first. `kind` is what the views
 * count it under; `label` is the row's own kind, kept as written.
 */
export function ledgerCsv(rows, { weekStarts = DEFAULT_LEDGER.weekStarts } = {}) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of latestPerSession(rows)) {
    const t = row.tokens ?? {};
    const byModel = Object.entries(row.byModel ?? {}).map(([m, v]) => `${m}=${v.costUsd}`).join(";");
    const values = [row.at, weekOf(row.at, weekStarts), kindGroup(row), row.kind, row.sessionId, row.ticket, row.branch, row.brigade, row.costUsd, t.calls, t.input, t.cacheWrite, t.cacheRead, t.output, row.peakContext, byModel, row.transcript];
    lines.push(values.map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}
