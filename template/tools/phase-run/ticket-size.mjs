// A ticket's size against the budget: `phaseRun.ticketSize` in
// .claude/workflow.json, or Brigade's defaults below.
//
//   node tools/phase-run/ticket-size.mjs --spec <N>      every sub-issue of a spec
//   node tools/phase-run/ticket-size.mjs <N> [<N> …]     the named tickets
//
// /ticket-check runs it: a ticket over a limit may be two sessions' work, and
// a long session costs more per step (each step re-reads a bigger context: a
// 100-step ticket has cost a third of a 400-step one). A size only warns:
// whether to split is the owner's call. The runner also keeps each ticket's
// sizes beside its cost, which is what the limits are retuned from.
//
// It also checks each ticket's lane declaration (D6, `laneProblems`): a
// `## Lane` that does not hold is refused, and the script exits 1; an Areas
// entry that is an own-file hotspot's folder, with none of its files, warns.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The three kinds of rule this script knows. */
export const RULE_KINDS = ["checkboxes", "bullets", "words"];

/**
 * Brigade's starting rows, from one real phase's tickets (criteria 3-9, Areas
 * 2-11, 360-810 words). Text size barely predicted cost there, so a warning is
 * a lead, not a rule.
 */
export const DEFAULT_RULES = [
  { key: "criteria", kind: "checkboxes", section: "Acceptance criteria", max: 8, label: "acceptance criteria" },
  { key: "areas", kind: "bullets", section: "Areas", max: 8, label: "Areas entries" },
  { key: "words", kind: "words", section: null, max: 800, label: "words" },
];

/** The lines under the first heading `isHeading` accepts, up to the next `## `; null when there is none. */
function sectionLines(body, isHeading) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex(isHeading);
  if (start === -1) return null;
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/** The text under `## <section>`, up to the next `## `. */
function section(body, name) {
  return (sectionLines(body, (line) => line.startsWith(`## ${name}`)) ?? []).join("\n");
}

const MEASURE = {
  checkboxes: (body, rule) => (section(body, rule.section).match(/^\s*- \[[ x]\]/gim) ?? []).length,
  bullets: (body, rule) => (section(body, rule.section).match(/^- /gm) ?? []).length,
  words: (body) => body.split(/\s+/).filter(Boolean).length,
};

/** Each rule's measure for one ticket body: [{ key, label, value, max, over }]. */
export function measureTicket(body, rules = DEFAULT_RULES) {
  return rules.map((rule) => {
    const measure = MEASURE[rule.kind];
    if (!measure) throw new Error(`unknown rule kind "${rule.kind}"; the kinds are ${RULE_KINDS.join(", ")}.`);
    const value = measure(body, rule);
    return { key: rule.key, label: rule.label, value, max: rule.max, over: value > rule.max };
  });
}

// ------------------------------------------------------- the lane declaration (D6)

/** The `## Lane` section's lines, or null when the ticket has none (`## Lanes` is another section). */
function laneSection(body) {
  return sectionLines(body, (line) => /^## Lane\b(?!s)/.test(line));
}

/** The lane a `## Lane` names: its first line, a list marker, backticks and a "Lane " before the id left off. */
function laneNamed(lines) {
  const first = lines.map((line) => line.replace(/<!--.*?-->/g, "").replace(/`/g, "").trim()).find(Boolean);
  return first?.replace(/^[-*]\s+/, "").match(/^(?:lane\s+)?([a-z0-9][a-z0-9-]*)/i)?.[1].toLowerCase() ?? null;
}

/** An Areas entry (a `-` or `*` bullet, as run.mjs's ticketAreas reads it) as a path: its backticked text, else its first word, with no trailing `/`, `/*` or `/**`. */
function areaPath(line) {
  const text = line.replace(/^\s*[-*]\s+/, "");
  const path = text.match(/`([^`]+)`/)?.[1] ?? text.split(/\s+/)[0];
  return path.replace(/\/\*{1,2}$/, "").replace(/\/+$/, "");
}

/** A hotspot path as a regex source: `{phase}` and `*` match within one segment, as numbering.mjs's rowMatcher reads them. */
const pathSource = (path) => path.replaceAll("{phase}", "*").split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");

/**
 * An own-file row's folder and matchers: the row's parent when its last part is a file (`name.ext`)
 * or a pattern, else the row itself. `isFolder` tests an Areas entry against the folder, `covers`
 * against the row (one of its files).
 */
function ownFolder(row) {
  const path = row.path.replace(/\/+$/, "");
  const last = path.split("/").pop();
  const folder = /\*|\{phase\}|\.[a-z][a-z0-9]*$/i.test(last) ? path.slice(0, -last.length - 1) : path;
  return { row: row.path, folder, isFolder: new RegExp(`^${pathSource(folder)}$`), covers: new RegExp(`^${pathSource(path)}(?:/.+)?$`) };
}

/**
 * A ticket's lane declaration against the lane table (D6). `ticket` is `{ body, labels }`; `lanes`
 * and `hotspots` are the loaded `phaseRun` sections (or null); `anyTicket` is config.mjs's
 * ANY_TICKET, passed in because config.mjs imports this file.
 *   refusals  a `## Lane` that does not hold: it names no lane, or one no row has, or the ticket
 *             lacks the label its row takes. The label is what is read, never the Areas.
 *   warnings  an Areas entry that is an own-file hotspot row's folder, with none of its files named.
 * A ticket with no `## Lane` is never refused.
 */
export function laneProblems({ body, labels = [] }, { lanes = null, hotspots = null, anyTicket }) {
  const refusals = [];
  const lines = laneSection(body);
  if (lines !== null) {
    const id = laneNamed(lines);
    const rows = lanes?.rows ?? [];
    const row = rows.find((lane) => lane.id === id);
    if (id === null) refusals.push("its ## Lane names no lane: write the lane's id on its first line, such as \"- 2\", or take the section out.");
    else if (rows.length === 0) refusals.push(`its ## Lane names lane ${id}, but .claude/workflow.json has no phaseRun.lanes: take the section out, or add the lane rows first.`);
    else if (!row) refusals.push(`its ## Lane names lane ${id}, and no phaseRun.lanes row has that id (the lanes are ${rows.map((lane) => lane.id).join(", ")}): name one of them, or take the section out.`);
    else if (row.takes !== anyTicket && !labels.includes(row.takes)) {
      refusals.push(`its ## Lane names lane ${id}, which takes tickets labelled "${row.takes}", and this ticket does not carry that label: add it, or take the section out.`);
    }
  }
  const areas = section(body, "Areas").split(/\r?\n/).filter((line) => /^\s*[-*]\s+/.test(line)).map(areaPath);
  const warnings = [];
  for (const own of (hotspots?.rows ?? []).filter((row) => row.kind === "own-file").map(ownFolder)) {
    const folder = areas.find((path) => own.isFolder.test(path));
    if (folder === undefined) continue;
    if (areas.some((path) => path !== folder && own.covers.test(path))) continue;
    warnings.push(`its Areas name ${folder}/, which holds the own-file hotspot ${own.row}, but none of its files: name the one this ticket adds its block to.`);
  }
  return { refusals, warnings };
}

function gh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`gh ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout;
}

async function main() {
  const args = process.argv.slice(2);
  // Imported here, not at the top: config.mjs imports RULE_KINDS from this file.
  const { ANY_TICKET, loadRunConfig } = await import("./config.mjs");
  const loaded = loadRunConfig(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."));
  if (loaded.error) {
    console.log(loaded.error);
    return 2;
  }
  const rules = loaded.config.ticketSize ?? DEFAULT_RULES;
  let numbers = args.filter((arg) => /^\d+$/.test(arg)).map(Number);
  const at = args.indexOf("--spec");
  if (at !== -1) {
    const repo = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
    numbers = JSON.parse(gh(["api", `repos/${repo}/issues/${args[at + 1]}/sub_issues`, "--paginate"])).map((issue) => issue.number);
  }
  if (numbers.length === 0) {
    console.log("Usage: node tools/phase-run/ticket-size.mjs --spec <N> | <ticket> [<ticket> …]");
    return 2;
  }
  let flagged = 0;
  let refused = 0;
  for (const number of numbers) {
    const issue = JSON.parse(gh(["issue", "view", String(number), "--json", "title,body,labels"]));
    const measures = measureTicket(issue.body ?? "", rules);
    const over = measures.filter((m) => m.over);
    if (over.length) flagged += 1;
    const ticket = { body: issue.body ?? "", labels: (issue.labels ?? []).map((label) => label.name) };
    const lane = laneProblems(ticket, { lanes: loaded.config.lanes, hotspots: loaded.config.hotspots, anyTicket: ANY_TICKET });
    if (lane.refusals.length) refused += 1;
    const sizes = measures.map((m) => `${m.value} ${m.label}`).join(" · ");
    const mark = lane.refusals.length ? "✗" : over.length || lane.warnings.length ? "⚠" : " ";
    const notes = [...lane.refusals.map((text) => `refused: ${text}`), ...lane.warnings.map((text) => `warning: ${text}`)].map((text) => `\n    ${text}`).join("");
    console.log(`${mark} #${number} ${issue.title.slice(0, 60)}\n    ${sizes}${over.length ? `\n    over: ${over.map((m) => `${m.label} ${m.value} > ${m.max}`).join(", ")}` : ""}${notes}`);
  }
  const source = loaded.config.ticketSize ? "phaseRun.ticketSize in .claude/workflow.json" : "Brigade's default budget";
  console.log(`\n${flagged} of ${numbers.length} ticket(s) over ${source}. A warning is a lead: split a ticket only if it is really two sessions' work.`);
  if (refused) console.log(`${refused} ticket(s) refused on their ## Lane: fix the label or the section before the ticket gets run-ready.`);
  return refused ? 1 : 0;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main().then((code) => process.exit(code));
