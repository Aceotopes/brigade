// The phase run's scoreboard, from any terminal, any time.
//
//   node tools/phase-run/status.mjs            the newest phase's table
//   node tools/phase-run/status.mjs 12         one ticket's full card
//   node tools/phase-run/status.mjs --dir .phase-run/phase-2b
//   node tools/phase-run/status.mjs --ledger    the ledger's weekly view, by kind and by model
//   node tools/phase-run/status.mjs --csv [file]   the ledger as CSV, written to the file or printed (no file, or -)
//
// It reads the runner's results.json and, while a run is on, its live.json.
// The ledger (.phase-run/ledger.jsonl, ledger.mjs) is the project's, across
// every run and every attended session; its weeks start on the config's
// `ledger.weekStarts`.
// A result from before the runner measured tickets (Brigade 0.3.0 and
// earlier) has its cost and peak context worked out here from the session's
// transcript.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG_PATH, DEFAULT_LEDGER, parseLedger } from "./config.mjs";
import { forYou, liveText, makePaint, progressText, scoreboard, shortStat } from "./display.mjs";
import { LEDGER_PATH, latestPerSession, ledgerCsv, ledgerText, readLedger } from "./ledger.mjs";
import { loadPrices, sessionCost } from "./metrics.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** The phase folder whose results.json changed last. */
function newestRunDir(state) {
  if (!existsSync(state)) return null;
  const dirs = readdirSync(state)
    .map((name) => join(state, name))
    .filter((dir) => existsSync(join(dir, "results.json")));
  dirs.sort((a, b) => statSync(join(b, "results.json")).mtimeMs - statSync(join(a, "results.json")).mtimeMs);
  return dirs[0] ?? null;
}

/** Cost and peak for a result the runner did not measure, from its build transcript. */
function backfill(result, dir, prices) {
  if (result.session?.metrics) return result;
  const build = readJson(join(dir, `ticket-${result.number}-build.json`));
  if (!build?.transcript || !existsSync(build.transcript)) return result;
  const cost = sessionCost(build.transcript, prices);
  return { ...result, session: { ...result.session, metrics: { costUsd: cost.costUsd, peakContext: cost.peakContext, estimated: true } } };
}

function card(result, paint) {
  const metrics = result.session?.metrics ?? {};
  const m = metrics.minutes;
  const fixes = Math.max(0, (result.session?.calls ?? 1) - 1);
  const out = [paint.bold(`#${result.number} ${result.title}`), `  result   ${result.status}${result.hash ? ` ${result.hash}` : ""}${fixes ? ` · ${fixes} fix round(s)` : ""}`];
  out.push(`  time     ${m ? `${m.total} min: Claude ${m.claude} · tests ${m.tests} · checks ${m.checks} · browser ${m.browser} · slept ${m.waiting} · reviews ${m.reviewing} · hook ${m.hook} · gates ${m.gates}` : `${result.session?.minutes ?? "?"} min`}`);
  if (metrics.costUsd != null) out.push(`  cost     $${metrics.costUsd.toFixed(2)} at API rates${metrics.estimated ? " (worked out from the transcript)" : ""}`);
  if (metrics.peakContext) out.push(`  context  peak ${Math.round(metrics.peakContext / 1000)}k tokens${metrics.tokens ? ` · ${metrics.tokens.calls} model calls` : ""}`);
  if (result.stat) out.push(`  size     ${shortStat(result.stat)}${metrics.size ? ` · ${metrics.size.criteria} criteria · ${metrics.size.areas} areas · ${metrics.size.words} words` : ""}`);
  const questions = forYou(result);
  out.push(`  for you  ${questions.length ? "" : "nothing"}`);
  for (const q of questions) out.push(paint.yellow(`    - ${q}`));
  if (result.session?.watch) out.push(`  session  claude attach ${result.session.watch}`);
  return out;
}

/**
 * The config's `ledger.weekStarts`, read from that section alone: a mistake elsewhere in the file
 * (a phaseRun key) is preflight's to report, and does not move the weeks.
 */
function ledgerWeekStarts() {
  try {
    return parseLedger(readJson(join(ROOT, CONFIG_PATH), {})?.ledger).weekStarts;
  } catch (error) {
    console.error(`${CONFIG_PATH}: ${error.message}\nWeeks start on ${DEFAULT_LEDGER.weekStarts} until it is fixed.`);
    return DEFAULT_LEDGER.weekStarts;
  }
}

/** `--ledger` and `--csv [file]`: the project's ledger, whatever phase folders exist. */
function ledgerMain(args) {
  const weekStarts = ledgerWeekStarts();
  const rows = readLedger(join(ROOT, LEDGER_PATH));
  const csv = args.indexOf("--csv");
  if (csv === -1) {
    console.log(ledgerText(rows, { weekStarts }).join("\n"));
    return 0;
  }
  const text = ledgerCsv(rows, { weekStarts });
  const target = args[csv + 1];
  const file = target && target !== "-" && !target.startsWith("--") ? resolve(target) : null;
  if (!file) {
    process.stdout.write(text);
    return 0;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  console.log(`Wrote ${latestPerSession(rows).length} row(s), each session's latest, to ${file}.`);
  return 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--ledger") || args.includes("--csv")) return ledgerMain(args);
  const at = args.indexOf("--dir");
  const dir = at !== -1 ? resolve(args[at + 1]) : newestRunDir(join(ROOT, ".phase-run"));
  if (!dir) {
    console.log("No phase run has written results yet (.phase-run/<branch>/results.json).");
    return 1;
  }
  const paint = makePaint(Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);
  const prices = loadPrices();
  const results = (readJson(join(dir, "results.json"), []) ?? []).map((r) => backfill(r, dir, prices));
  const number = args.find((arg) => /^\d+$/.test(arg) && args[args.indexOf(arg) - 1] !== "--dir");
  if (number) {
    const result = [...results].reverse().find((r) => r.number === Number(number));
    console.log(result ? card(result, paint).join("\n") : `#${number} has no result in ${dir}.`);
    return result ? 0 : 1;
  }

  console.log(paint.bold(`\n  ${dir.split(/[\\/]/).pop()} · ${results.length} result(s)\n`));
  console.log(scoreboard(results, paint).join("\n"));
  const live = existsSync(join(dir, "..", "lock")) ? readJson(join(dir, "live.json")) : null;
  if (live) {
    const now = Date.now();
    console.log(`\n${paint.bold(progressText(live, now))}`);
    if (live.current) console.log(paint.cyan(liveText(live.current, now)));
  } else console.log(paint.dim("\n  No run is on now."));
  return 0;
}

// exitCode, not exit(): a long CSV piped elsewhere is flushed before the process ends.
process.exitCode = main();
