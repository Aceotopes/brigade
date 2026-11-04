// A ticket's size against the budget: `phaseRun.ticketSize` in
// .claude/workflow.json, or Brigade's defaults below.
//
//   node tools/phase-run/ticket-size.mjs --spec <N>      every sub-issue of a spec
//   node tools/phase-run/ticket-size.mjs <N> [<N> …]     the named tickets
//
// /ticket-check runs it: a ticket over a limit may be two sessions' work, and
// a long session costs more per step (each step re-reads a bigger context: a
// 100-step ticket has cost a third of a 400-step one). It warns and exits 0
// either way: whether to split is the owner's call. The runner also keeps each
// ticket's sizes beside its cost, which is what the limits are retuned from.
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

/** The text under `## <section>`, up to the next `## `. */
function section(body, name) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`## ${name}`));
  if (start === -1) return "";
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
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

function gh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`gh ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout;
}

async function main() {
  const args = process.argv.slice(2);
  // Imported here, not at the top: config.mjs imports RULE_KINDS from this file.
  const { loadRunConfig } = await import("./config.mjs");
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
  for (const number of numbers) {
    const issue = JSON.parse(gh(["issue", "view", String(number), "--json", "title,body"]));
    const measures = measureTicket(issue.body ?? "", rules);
    const over = measures.filter((m) => m.over);
    if (over.length) flagged += 1;
    const sizes = measures.map((m) => `${m.value} ${m.label}`).join(" · ");
    console.log(`${over.length ? "⚠" : " "} #${number} ${issue.title.slice(0, 60)}\n    ${sizes}${over.length ? `\n    over: ${over.map((m) => `${m.label} ${m.value} > ${m.max}`).join(", ")}` : ""}`);
  }
  const source = loaded.config.ticketSize ? "phaseRun.ticketSize in .claude/workflow.json" : "Brigade's default budget";
  console.log(`\n${flagged} of ${numbers.length} ticket(s) over ${source}. A warning is a lead: split a ticket only if it is really two sessions' work.`);
  return 0;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main().then((code) => process.exit(code));
