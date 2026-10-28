// The project's own rules for the hooks: `.claude/workflow.json` in the project.
//
//   {
//     "version": 1,
//     "guard": { "block": [
//       { "when": "always" | "phase-run",
//         "command": "<regex, tested on each simple command>"  — or —  "text": "<regex, on the whole command line>",
//         "with": "<optional regex the same simple command must also match>",
//         "unless": "<optional regex on the whole command line that lets it through>",
//         "message": "<what the session is told>" } ],
//       "wrappers": ["pnpm exec", "pnpm dlx", "pnpm", "npx"] },   prefixes stripped before a rule is tested
//     "stopGate": { "checks": [ { "label": "Typecheck", "run": "pnpm typecheck" },
//       { "label": "Tests", "run": "pnpm test", "receipt": true,     the tests: skipped while their receipt holds
//         "quiet": { "totals": "<regex>", "failures": "<regex>" } } ] },   what stop-tests.mjs prints of them
//     "stack": { "language", "framework", "packageManager", "database", "migrations", "testDatabase",
//                "storage": "<any text>", "other": ["<any text>"] },   what the project is built with
//     "roadmap": { "artifact": "<the roadmap page's link>" }
//   }
//
// `stack` is the project's declared stack, written by /setup-workflow and changed by its refresh; an
// undecided part is left out. `roadmap` is /roadmap's. `{base}` in a check's `run` is the phase run's base commit. A `note` key is allowed anywhere
// (JSON has no comments). Every other key is checked, so a typo fails loudly instead of turning a
// rule off, except inside `phaseRun`, which belongs to the phase runner and is checked by its
// preflight (template/tools/phase-run/config.mjs). The rules the workflow itself needs (no --no-verify, no trailer, the phase-run
// discipline) stay in guard-shell.mjs; this file holds only one project's habits.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_PATH = join(".claude", "workflow.json");

const WHEN = ["always", "phase-run"];
const RULE_KEYS = ["when", "command", "text", "with", "unless", "message", "note"];
const CHECK_KEYS = ["label", "run", "receipt", "quiet", "note"];
/** The stack's parts, in the order the discovery template's table lists them. */
export const STACK_KEYS = ["language", "framework", "packageManager", "database", "migrations", "testDatabase", "storage", "other"];
/** What the guard strips before a rule is tested, when the project names none: the wrappers it always knew. */
export const DEFAULT_WRAPPERS = ["pnpm exec", "pnpm dlx", "pnpm", "npx"];

/**
 * The project's rules and checks, or `error` naming what is wrong with the file. A missing file is
 * no rules at all, which is how a project starts.
 */
export function loadWorkflowConfig(root) {
  const path = join(root, CONFIG_PATH);
  if (!existsSync(path)) return { rules: [], checks: [], wrappers: DEFAULT_WRAPPERS, error: null };
  try {
    return { ...parseWorkflowConfig(JSON.parse(readFileSync(path, "utf8"))), error: null };
  } catch (error) {
    return { rules: [], checks: [], wrappers: DEFAULT_WRAPPERS, error: `${CONFIG_PATH.replaceAll("\\", "/")}: ${error.message}` };
  }
}

/** The file's JSON, checked and with its patterns compiled. Throws on the first problem. */
export function parseWorkflowConfig(data) {
  if (data?.version !== 1) throw new Error(`"version" must be 1 (it is ${JSON.stringify(data?.version)}).`);
  // `phaseRun` is the phase runner's (template/tools/phase-run/config.mjs checks it at preflight).
  onlyKeys(data, ["version", "guard", "stopGate", "phaseRun", "stack", "roadmap", "note"], "the file");
  onlyKeys(data.guard ?? {}, ["block", "wrappers", "note"], "guard");
  onlyKeys(data.stopGate ?? {}, ["checks", "note"], "stopGate");
  onlyKeys(data.stack ?? {}, [...STACK_KEYS, "note"], "stack");
  for (const key of STACK_KEYS.filter((k) => k !== "other" && data.stack?.[k] !== undefined)) {
    if (typeof data.stack[key] !== "string" || !data.stack[key].trim()) throw new Error(`stack.${key} must be text (leave an undecided part out).`);
  }
  if (data.stack?.other !== undefined && !(Array.isArray(data.stack.other) && data.stack.other.every((s) => typeof s === "string" && s.trim()))) {
    throw new Error("stack.other must be a list of texts.");
  }
  onlyKeys(data.roadmap ?? {}, ["artifact", "note"], "roadmap");
  if (data.roadmap?.artifact !== undefined && typeof data.roadmap.artifact !== "string") throw new Error("roadmap.artifact must be text.");
  const wrappers = data.guard?.wrappers === undefined ? DEFAULT_WRAPPERS : list(data.guard.wrappers, "guard.wrappers");
  if (!wrappers.every((w) => typeof w === "string" && w.trim())) throw new Error("guard.wrappers must be a list of command prefixes, such as \"pnpm exec\".");
  const rules = list(data.guard?.block, "guard.block").map((rule, i) => {
    const where = `guard.block[${i}]`;
    onlyKeys(rule, RULE_KEYS, where);
    if (!WHEN.includes(rule.when)) throw new Error(`${where}.when must be one of ${WHEN.join(", ")}.`);
    if (Boolean(rule.command) === Boolean(rule.text)) throw new Error(`${where} needs exactly one of "command" and "text".`);
    if (typeof rule.message !== "string" || !rule.message.trim()) throw new Error(`${where}.message is missing.`);
    return {
      when: rule.when,
      command: pattern(rule.command, `${where}.command`),
      text: pattern(rule.text, `${where}.text`),
      with: pattern(rule.with, `${where}.with`),
      unless: pattern(rule.unless, `${where}.unless`),
      message: rule.message,
    };
  });
  const checks = list(data.stopGate?.checks, "stopGate.checks").map((check, i) => {
    const where = `stopGate.checks[${i}]`;
    onlyKeys(check, CHECK_KEYS, where);
    for (const key of ["label", "run"]) {
      if (typeof check[key] !== "string" || !check[key].trim()) throw new Error(`${where}.${key} is missing.`);
    }
    if (check.receipt !== undefined && typeof check.receipt !== "boolean") throw new Error(`${where}.receipt must be true or false.`);
    if (check.quiet !== undefined) {
      if (check.receipt !== true) throw new Error(`${where}.quiet belongs on the tests' row, the one with "receipt": true.`);
      onlyKeys(check.quiet, ["totals", "failures", "note"], `${where}.quiet`);
      for (const key of ["totals", "failures"]) {
        if (check.quiet[key] === undefined) throw new Error(`${where}.quiet.${key} is missing.`);
        pattern(check.quiet[key], `${where}.quiet.${key}`);
      }
    }
    return { label: check.label, run: check.run, receipt: check.receipt === true };
  });
  return { rules, checks, wrappers: wrappers.map((w) => w.trim()) };
}

function list(value, where) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${where} must be a list.`);
  return value;
}

function onlyKeys(object, allowed, where) {
  if (typeof object !== "object" || object === null || Array.isArray(object)) throw new Error(`${where} must be an object.`);
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${where} has unknown key(s) ${unknown.join(", ")}; allowed: ${allowed.join(", ")}.`);
}

function pattern(source, where) {
  if (source === undefined) return null;
  if (typeof source !== "string") throw new Error(`${where} must be a string.`);
  try {
    return new RegExp(source);
  } catch (error) {
    throw new Error(`${where} is not a valid pattern: ${error.message}`);
  }
}
