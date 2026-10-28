// The roadmap's format: two fixed tables, Modules and Phases, between `<!-- brigade:roadmap -->` and
// `<!-- /brigade:roadmap -->` in the roadmap (docs/status/roadmap.md), and a `## Noted for later`
// list. Read by doc-check, which refuses a commit that breaks the format, and by the Brigade
// plugin's /roadmap (scripts/roadmap.mjs), which draws the roadmap page from it. No imports, so the
// plugin can read this file from its own template.
//
// A roadmap without the markers (one written before Brigade 0.3.0) is not checked; /roadmap offers
// to convert it.

export const START = "<!-- brigade:roadmap -->";
export const END = "<!-- /brigade:roadmap -->";
export const MODULE_COLUMNS = ["#", "Module", "Depends on", "Stands"];
export const PHASE_COLUMNS = ["Phase", "Module", "Spec", "Branch", "Stands"];
export const MODULE_STANDS = ["planned", "building", "delivered", "blocked"];
export const PHASE_STANDS = ["planned", "building", "merged", "blocked"];

const NONE = /^(|—|-|none)$/i;

/** A table's cells, without the outer pipes. */
const cellsOf = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

/** The first table under `## <heading>` within `lines`: its header, and each row with its line number. */
function table(lines, offset, heading) {
  const at = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (at === -1) return null;
  const rows = [];
  let header = null;
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (/^## /.test(line)) break;
    if (!line.startsWith("|")) {
      if (header) break;
      continue;
    }
    if (!header) header = cellsOf(line);
    else if (!/^\|[\s:|-]+\|$/.test(line)) rows.push({ cells: cellsOf(line), line: offset + i + 1 });
  }
  return { header, rows };
}

/** A Stands cell: one of the allowed words, and for `blocked` its reason. */
function standsOf(cell, allowed) {
  const match = cell.match(/^([a-z]+)\s*(?::\s*(.*))?$/i);
  const word = match?.[1]?.toLowerCase();
  const reason = match?.[2]?.trim() || null;
  if (!allowed.includes(word)) return { error: `"${cell}" is not one of ${allowed.join(", ")} (blocked takes a reason: "blocked: <why>")` };
  if (word === "blocked" && !reason) return { error: 'blocked needs its reason: "blocked: <why>"' };
  if (word !== "blocked" && reason) return { error: `only blocked takes a reason; "${cell}" should be "${word}"` };
  return { stands: word, reason };
}

/** The bullets under `## Noted for later`, one idea each. */
function notesOf(lines) {
  const at = lines.findIndex((line) => line.trim() === "## Noted for later");
  if (at === -1) return [];
  const out = [];
  for (const line of lines.slice(at + 1)) {
    if (/^#{1,2} /.test(line)) break;
    const bullet = line.match(/^- (.+)$/);
    if (bullet && !/^nothing yet\.?$/i.test(bullet[1].trim())) out.push(bullet[1].trim());
  }
  return out;
}

/**
 * The roadmap's modules and phases, and every way it breaks the format (each `line: problem`).
 * `converted` is false for a roadmap without the markers: nothing in it is checked.
 */
export function parseRoadmap(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const notes = notesOf(lines);
  const start = lines.findIndex((line) => line.trim() === START);
  if (start === -1) return { converted: false, modules: [], phases: [], notes, problems: [] };
  const end = lines.findIndex((line, i) => i > start && line.trim() === END);
  const problems = [];
  if (end === -1) problems.push(`${start + 1}: ${START} has no closing ${END}`);
  const block = lines.slice(start + 1, end === -1 ? undefined : end);
  const offset = start + 1;

  const modules = [];
  const moduleTable = table(block, offset, "Modules");
  if (!moduleTable) problems.push(`${start + 1}: the roadmap block has no "## Modules" table`);
  else if (moduleTable.header?.join("|") !== MODULE_COLUMNS.join("|")) {
    problems.push(`${moduleTable.rows[0]?.line ?? start + 1}: the Modules table's columns must be: ${MODULE_COLUMNS.join(" | ")}`);
  } else {
    for (const { cells, line } of moduleTable.rows) {
      const [number, name, depends, stands] = cells;
      if (!/^\d+$/.test(number ?? "")) problems.push(`${line}: a module's # is its number, "${number}" is not one`);
      else if (modules.some((m) => m.number === Number(number))) problems.push(`${line}: module ${number} is listed twice`);
      if (!name) problems.push(`${line}: module ${number} has no name`);
      const status = standsOf(stands ?? "", MODULE_STANDS);
      if (status.error) problems.push(`${line}: module ${number}'s Stands: ${status.error}`);
      const dependsOn = NONE.test(depends ?? "") ? [] : depends.split(/[,\s]+/).filter(Boolean);
      modules.push({ number: Number(number), name, dependsOn, stands: status.stands ?? null, reason: status.reason ?? null, line });
    }
    for (const module of modules) {
      for (const dep of module.dependsOn) {
        if (!/^\d+$/.test(dep) || !modules.some((m) => m.number === Number(dep))) {
          problems.push(`${module.line}: module ${module.number} depends on "${dep}", which is not a module number in the table`);
        } else if (Number(dep) === module.number) problems.push(`${module.line}: module ${module.number} depends on itself`);
      }
      module.dependsOn = module.dependsOn.filter((dep) => /^\d+$/.test(dep)).map(Number);
    }
  }

  const phases = [];
  const phaseTable = table(block, offset, "Phases");
  if (!phaseTable) problems.push(`${start + 1}: the roadmap block has no "## Phases" table`);
  else if (phaseTable.header?.join("|") !== PHASE_COLUMNS.join("|")) {
    problems.push(`${phaseTable.rows[0]?.line ?? start + 1}: the Phases table's columns must be: ${PHASE_COLUMNS.join(" | ")}`);
  } else {
    for (const { cells, line } of phaseTable.rows) {
      const [phase, module, spec, branch, stands] = cells;
      if (!phase) problems.push(`${line}: a phase has no name`);
      if (!NONE.test(module ?? "") && !modules.some((m) => String(m.number) === module)) {
        problems.push(`${line}: phase "${phase}" is in module "${module}", which is not in the Modules table`);
      }
      if (!NONE.test(spec ?? "") && !/^#\d+$/.test(spec)) problems.push(`${line}: phase "${phase}"'s Spec is its issue, like #12; "${spec}" is not`);
      if (!NONE.test(branch ?? "") && !/^phase-[\w.-]+$/.test(branch)) problems.push(`${line}: phase "${phase}"'s Branch must start with phase-; "${branch}" does not`);
      const status = standsOf(stands ?? "", PHASE_STANDS);
      if (status.error) problems.push(`${line}: phase "${phase}"'s Stands: ${status.error}`);
      phases.push({
        phase,
        module: NONE.test(module ?? "") ? null : Number(module),
        spec: NONE.test(spec ?? "") ? null : Number(spec.slice(1)),
        branch: NONE.test(branch ?? "") ? null : branch,
        stands: status.stands ?? null,
        reason: status.reason ?? null,
        line,
      });
    }
  }
  return { converted: true, modules, phases, notes, problems };
}
