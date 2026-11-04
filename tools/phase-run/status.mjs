// The phase run's scoreboard, from any terminal, any time.
//
//   node tools/phase-run/status.mjs            the newest phase's table
//   node tools/phase-run/status.mjs 12         one ticket's full card
//   node tools/phase-run/status.mjs --dir .phase-run/phase-2b
//
// It reads the runner's results.json and, while a run is on, its live.json.
// A result from before the runner measured tickets (Brigade 0.3.0 and
// earlier) has its cost and peak context worked out here from the session's
// transcript.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { forYou, liveText, makePaint, progressText, scoreboard, shortStat } from "./display.mjs";
import { costOf, loadPrices, sessionUsage } from "./metrics.mjs";

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
  const usage = sessionUsage(build.transcript);
  return { ...result, session: { ...result.session, metrics: { costUsd: costOf(usage, prices), peakContext: usage.peakContext, estimated: true } } };
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

function main() {
  const args = process.argv.slice(2);
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

process.exit(main());
