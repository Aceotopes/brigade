// The end-of-phase move of the devlog into its archive. Run once, in a phase's
// finish ticket, after its last commit but before the finish commit's own entry:
//
//   node tools/doc-rotate.mjs --phase 6g --label "Phase 6G — Payroll run & payslips" [--dry-run]
//
// Every closed entry in the current devlog (one a commit message has cited)
// moves, in order, to <DEVLOG_ARCHIVE>/<phase>.md, which is frozen from then on.
// An open entry stays. Work done between two phases rotates with the next one.
// The phase is added to the archive list (PHASES) with today as its end, and
// every index is regenerated. Paths come from tools/doc-config.mjs.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DEVLOG, DEVLOG_ARCHIVE, PHASES } from "./doc-config.mjs";
import { writeIndexes } from "./doc-index.mjs";
import { ROOT, citedDevlogNumbers, devlogEntries, devlogPreamble, isMain, loadPhases, read, today, write } from "./doc-lib.mjs";

/** The archive file's own header: frozen, what it holds, how to find the rest. */
export function archiveHeader(label) {
  return [
    "---",
    `job: The devlog of ${label}, moved here when it finished. Frozen; never edited.`,
    "kind: record",
    "---",
    `# Devlog — ${label}`,
    "",
    "Newest entry first. The current phase's entries are in the devlog itself; every archive is listed in",
    "this folder's README.md.",
    "",
    "---",
    "",
  ].join("\n");
}

/** Splits the devlog into what stays (its preamble and open entries) and what moves. */
export function planRotation(text, cited) {
  const entries = devlogEntries(text, cited);
  const body = (list) => list.map((entry) => entry.lines.join("\n").replace(/\n+$/, "")).join("\n\n");
  const moving = entries.filter((entry) => !entry.open);
  const staying = entries.filter((entry) => entry.open);
  const preamble = devlogPreamble(text).replace(/\n+$/, "\n\n");
  return {
    moving: moving.map((entry) => entry.number),
    staying: staying.map((entry) => entry.number),
    devlog: staying.length ? `${preamble}${body(staying)}\n` : preamble,
    archived: body(moving),
  };
}

function main() {
  const args = process.argv.slice(2);
  const valueOf = (name) => {
    const at = args.indexOf(name);
    return at === -1 ? null : args[at + 1];
  };
  const phase = valueOf("--phase");
  const label = valueOf("--label") ?? (phase ? `Phase ${phase.toUpperCase()}` : null);
  const dryRun = args.includes("--dry-run");
  if (!phase || !/^[a-z0-9][a-z0-9.-]*$/.test(phase)) {
    console.error('doc-rotate: name the phase, lower case: --phase 6g [--label "Phase 6G — Payroll run & payslips"]');
    process.exit(1);
  }

  const archive = `${DEVLOG_ARCHIVE}/${phase}.md`;
  if (existsSync(join(ROOT, archive))) {
    console.error(`doc-rotate: ${archive} already exists. A phase is rotated once.`);
    process.exit(1);
  }
  const phases = loadPhases(PHASES);
  if (phases.some((p) => p.name === phase)) {
    console.error(`doc-rotate: ${PHASES} already lists "${phase}".`);
    process.exit(1);
  }

  const plan = planRotation(read(DEVLOG), citedDevlogNumbers());
  if (plan.moving.length === 0) {
    console.log("doc-rotate: no closed entry to move. Nothing changed.");
    return;
  }
  const summary = `#${plan.moving.at(-1)}–#${plan.moving[0]} (${plan.moving.length} entries) → ${archive}`;
  if (dryRun) {
    console.log(`doc-rotate (dry run): would move ${summary}; ${plan.staying.length} open entry(ies) stay.`);
    return;
  }

  mkdirSync(dirname(join(ROOT, archive)), { recursive: true });
  writeFileSync(join(ROOT, archive), `${archiveHeader(label)}${plan.archived}\n`);
  write(DEVLOG, plan.devlog);
  phases.push({ name: phase, label, until: today(), last: Number(plan.moving[0]) });
  writeFileSync(join(ROOT, PHASES), `${JSON.stringify(phases, null, 2)}\n`);
  const indexes = writeIndexes();
  console.log(`doc-rotate: moved ${summary}.${indexes.length ? ` Rewrote ${indexes.join(", ")}.` : ""}`);
}

if (isMain(import.meta.url)) main();
