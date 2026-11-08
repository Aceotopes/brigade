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
//         "quiet": { "totals": "<regex>", "failures": "<regex>" },   what stop-tests.mjs prints of them
//         "unread": ["docs/**", "*.md"] } ] },   git globs the tests never read: an edit there keeps the receipt
//     "stack": { "language", "framework", "packageManager", "database", "migrations", "testDatabase",
//                "storage": "<any text>", "other": ["<any text>"] },   what the project is built with
//     "roadmap": { "artifact": "<the roadmap page's link>" },
//     "ledger": { "attended": true, "weekStarts": "monday" }   the attended ledger hook's switch, and the
//                                                               day the ledger's weekly view starts on
//   }
//
// `stack` is the project's declared stack, written by /setup-workflow and changed by its refresh; an
// undecided part is left out. `roadmap` is /roadmap's. `{base}` in a check's `run` is the phase run's base commit. A `note` key is allowed anywhere
// (JSON has no comments). Every other key is checked, so a typo fails loudly instead of turning a
// rule off, except inside `phaseRun`, which belongs to the phase runner and is checked by its
// preflight (template/tools/phase-run/config.mjs). The rules the workflow itself needs (no --no-verify, no trailer, the phase-run
// discipline) stay in guard-shell.mjs; this file holds only one project's habits.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const CONFIG_PATH = join(".claude", "workflow.json");

const WHEN = ["always", "phase-run"];
const RULE_KEYS = ["when", "command", "text", "with", "unless", "message", "note"];
const CHECK_KEYS = ["label", "run", "receipt", "quiet", "unread", "note"];
/** The stack's parts, in the order the discovery template's table lists them. */
export const STACK_KEYS = ["language", "framework", "packageManager", "database", "migrations", "testDatabase", "storage", "other"];
/** What the guard strips before a rule is tested, when the project names none: the wrappers it always knew. */
export const DEFAULT_WRAPPERS = ["pnpm exec", "pnpm dlx", "pnpm", "npx"];
/** The days a ledger week may start on; template/tools/phase-run/config.mjs keeps the same list. */
const WEEK_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
/** The `ledger` section's defaults: the attended hook on, weeks from Monday. */
export const DEFAULT_LEDGER = { attended: true, weekStarts: "monday" };

/**
 * The project's rules and checks, or `error` naming what is wrong with the file. A missing file is
 * no rules at all, which is how a project starts.
 */
export function loadWorkflowConfig(root) {
  const path = join(root, CONFIG_PATH);
  if (!existsSync(path)) return noRules(null);
  try {
    return { ...parseWorkflowConfig(JSON.parse(readFileSync(path, "utf8"))), error: null };
  } catch (error) {
    return noRules(`${CONFIG_PATH.replaceAll("\\", "/")}: ${error.message}`);
  }
}

/** What a loader returns with no rules to give: no file (`error` null), or one it refuses. */
function noRules(error) {
  return { rules: [], checks: [], wrappers: DEFAULT_WRAPPERS, ledger: { ...DEFAULT_LEDGER }, error };
}

/**
 * Where the rules that judge this session live: the phase run's frozen copy of the runner and its
 * config (PHASE_RUN_RUNNER, ADR 0005), or the project itself when no run set one. The copy mirrors
 * the repo (`<copy>/.claude/workflow.json`, `<copy>/tools/phase-run/`), so either is read the same way.
 */
export function judgeRoot(root, env = process.env) {
  return env.PHASE_RUN_RUNNER ? resolve(root, env.PHASE_RUN_RUNNER) : root;
}

/**
 * The rules that judge this session (judgeRoot's). A copy that is named but gone, or has lost its
 * config (the runner always writes one into it), is an error, never a missing file's "no rules":
 * that would wave every command and every stop through.
 */
export function loadJudgeConfig(root, env = process.env) {
  const dir = judgeRoot(root, env);
  if (env.PHASE_RUN_RUNNER && !existsSync(join(dir, CONFIG_PATH))) {
    return noRules(`the phase run's runner copy (PHASE_RUN_RUNNER=${dir}) is missing, or has lost its ${CONFIG_PATH.replaceAll("\\", "/")}. Restart the run, which takes a fresh copy.`);
  }
  return loadWorkflowConfig(dir);
}

/** The file's JSON, checked and with its patterns compiled. Throws on the first problem. */
export function parseWorkflowConfig(data) {
  if (data?.version !== 1) throw new Error(`"version" must be 1 (it is ${JSON.stringify(data?.version)}).`);
  // `phaseRun` is the phase runner's (template/tools/phase-run/config.mjs checks it at preflight).
  onlyKeys(data, ["version", "guard", "stopGate", "phaseRun", "stack", "roadmap", "ledger", "note"], "the file");
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
  const ledger = parseLedger(data.ledger);
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
    return { label: check.label, run: check.run, receipt: check.receipt === true, unread: unreadList(check, where) };
  });
  sharedUnread(checks, "stopGate.checks");
  return { rules, checks, wrappers: wrappers.map((w) => w.trim()), ledger };
}

/**
 * The top-level `ledger` section, `{ attended?, weekStarts? }`: checked here as the runner checks it
 * (template/tools/phase-run/config.mjs), with the same refusals, because the two cannot share code.
 */
function parseLedger(ledger) {
  if (ledger === undefined) return { ...DEFAULT_LEDGER };
  onlyKeys(ledger, ["attended", "weekStarts", "note"], "ledger");
  if (ledger.attended !== undefined && typeof ledger.attended !== "boolean") throw new Error("ledger.attended must be true or false.");
  if (ledger.weekStarts !== undefined && !WEEK_DAYS.includes(ledger.weekStarts)) {
    throw new Error(`ledger.weekStarts must be a day in lowercase, one of ${WEEK_DAYS.join(", ")} (it is ${JSON.stringify(ledger.weekStarts)}).`);
  }
  return { attended: ledger.attended ?? DEFAULT_LEDGER.attended, weekStarts: ledger.weekStarts ?? DEFAULT_LEDGER.weekStarts };
}

/**
 * A row's unread paths: git globs the receipt's key leaves out, only on a row with "receipt": true. A
 * glob that names no folder or file (`**`, `*.*`, `.`) could leave out every file, so no edit would make
 * the receipt stale; one that leaves the repo is one git refuses.
 */
function unreadList(check, where) {
  if (check.unread === undefined) return [];
  if (check.receipt !== true) throw new Error(`${where}.unread belongs on the tests' row, the one with "receipt": true.`);
  if (!Array.isArray(check.unread)) throw new Error(`${where}.unread must be a list of git globs, such as ["docs/**", "*.md"].`);
  check.unread.forEach((glob, j) => {
    const at = `${where}.unread[${j}]`;
    if (typeof glob !== "string" || !glob.trim()) throw new Error(`${at} must be a git glob, such as "docs/**".`);
    if (glob !== glob.trim()) throw new Error(`${at} "${glob}" has spaces around it, which git would match as written.`);
    if (/^\.?\//.test(glob) || glob.split("/").includes("..")) throw new Error(`${at} "${glob}" must be a path inside the repo, from its root, such as "docs/**".`);
    if (!/[\p{L}\p{N}]/u.test(glob)) {
      throw new Error(`${at} "${glob}" names no folder or file, so it could leave out every file; name only what the tests never read, such as "docs/**".`);
    }
  });
  return check.unread;
}

/** The receipt keeps one key, so every row with "receipt": true leaves out the same paths. */
function sharedUnread(checks, where) {
  const rows = checks.map((check, i) => ({ check, i })).filter(({ check }) => check.receipt);
  const key = (list) => [...list].sort().join("\n");
  const differing = rows.find(({ check }) => key(check.unread) !== key(rows[0].check.unread));
  if (differing) {
    throw new Error(`${where}[${differing.i}].unread differs from ${where}[${rows[0].i}].unread: every row with "receipt": true shares one unread list.`);
  }
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
