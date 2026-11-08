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
//     "stopGate": { "checks": [ { "label": "Format", "run": "pnpm fmt:check" },
//       { "name": "typecheck", "label": "Typecheck", "run": "pnpm typecheck", "receipt": true, "unread": ["**/*.md"] },
//       { "name": "tests", "label": "Tests", "run": "pnpm test", "receipt": true,   skipped while its own receipt holds
//         "quiet": { "totals": "<regex>", "failures": "<regex>" },   what stop-tests.mjs prints of it
//         "unread": ["docs/**", "*.md"] } ] },   globs that check never reads: an edit there keeps its receipt
//                                                  (`name` names its receipt file; rows without one share one)
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
// preflight (template/tools/phase-run/config.mjs); only a gate's `after` or `unreadOf` that names
// nothing, and any fault in `phaseRun.tampering` (the tampering gate's rules, which must never be
// read as none), are refused here too, with the runner's words. The shell guard loads only its own
// part (loadJudgeGuard): a fault elsewhere leaves the shell working, and the session-start notice
// names it. The rules the workflow itself needs (no --no-verify, no trailer, the phase-run
// discipline) stay in guard-shell.mjs; this file holds only one project's habits.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const CONFIG_PATH = join(".claude", "workflow.json");

const WHEN = ["always", "phase-run"];
const RULE_KEYS = ["when", "command", "text", "with", "unless", "message", "note"];
const CHECK_KEYS = ["name", "label", "run", "receipt", "quiet", "unread", "note"];
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

/**
 * What the shell guard needs (loadJudgeConfig's rules and wrappers), refusing only a fault in its own
 * part: a missing copy, a file that isn't JSON, a wrong `version`, or a bad `guard` section. A fault
 * anywhere else (a key from a newer Brigade, say: the reverse out-of-step, discovery 04) is returned
 * as `elsewhere`, and the guard's rules still apply, so the project's shell keeps working. The stop
 * gate and the runner's preflight stay strict about the rest.
 */
export function loadJudgeGuard(root, env = process.env) {
  const full = loadJudgeConfig(root, env);
  const path = join(judgeRoot(root, env), CONFIG_PATH);
  if (!full.error || !existsSync(path)) return { ...full, elsewhere: null };
  try {
    return { ...noRules(null), ...parseGuard(JSON.parse(readFileSync(path, "utf8"))), elsewhere: full.error };
  } catch (error) {
    return { ...noRules(`${CONFIG_PATH.replaceAll("\\", "/")}: ${error.message}`), elsewhere: null };
  }
}

/** The file's JSON, checked and with its patterns compiled. Throws on the first problem. */
export function parseWorkflowConfig(data) {
  const { rules, wrappers } = parseGuard(data); // `version` first, then the guard's own part
  // `phaseRun` is the phase runner's (template/tools/phase-run/config.mjs checks it at preflight).
  onlyKeys(data, ["version", "guard", "stopGate", "phaseRun", "stack", "roadmap", "ledger", "note"], "the file");
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
  const checks = list(data.stopGate?.checks, "stopGate.checks").map((check, i) => {
    const where = `stopGate.checks[${i}]`;
    onlyKeys(check, CHECK_KEYS, where);
    for (const key of ["label", "run"]) {
      if (typeof check[key] !== "string" || !check[key].trim()) throw new Error(`${where}.${key} is missing.`);
    }
    if (check.receipt !== undefined && typeof check.receipt !== "boolean") throw new Error(`${where}.receipt must be true or false.`);
    if (check.quiet !== undefined) {
      if (check.receipt !== true) throw new Error(`${where}.quiet belongs on a row with "receipt": true, one stop-tests.mjs runs.`);
      onlyKeys(check.quiet, ["totals", "failures", "note"], `${where}.quiet`);
      for (const key of ["totals", "failures"]) {
        if (check.quiet[key] === undefined) throw new Error(`${where}.quiet.${key} is missing.`);
        pattern(check.quiet[key], `${where}.quiet.${key}`);
      }
    }
    return { name: checkName(check, where), label: check.label, run: check.run, receipt: check.receipt === true, unread: unreadList(check, where) };
  });
  receiptFiles(checks, "stopGate.checks");
  // The one look inside `phaseRun`: a gate's `after` or `unreadOf` that names nothing (D13).
  gateReferences(data.phaseRun?.gates, checks.map((check) => check.name).filter(Boolean), "phaseRun.gates");
  // And the tampering section, in full (D15): a broken rule must stop the night wherever it is read.
  tamperingRules(data.phaseRun?.tampering, "phaseRun.tampering");
  return { rules, checks, wrappers, ledger };
}

/**
 * The guard's own part, `version` and `guard`, with its patterns compiled: all the shell guard reads.
 * Throws on a fault there; the rest of the file is not looked at.
 */
function parseGuard(data) {
  if (data?.version !== 1) throw new Error(`"version" must be 1 (it is ${JSON.stringify(data?.version)}).`);
  onlyKeys(data.guard ?? {}, ["block", "wrappers", "note"], "guard");
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
  return { rules, wrappers: wrappers.map((w) => w.trim()) };
}

/**
 * A gate's `after` names another gate's label, and its `unreadOf` a stop check's `name`. A name that
 * names nothing is refused by both loaders, word for word (template/tools/phase-run/config.mjs keeps
 * this same function); any other shape is left to the runner's own checks, so the hooks never break over it.
 */
function gateReferences(gates, checkNames, where) {
  if (!Array.isArray(gates)) return;
  const labels = gates.filter((gate) => typeof gate?.label === "string").map((gate) => gate.label);
  gates.forEach((gate, i) => {
    if (typeof gate?.after === "string" && !labels.includes(gate.after)) {
      throw new Error(`${where}[${i}].after ${JSON.stringify(gate.after)} names no gate: it must be another gate's label (${labels.join(", ") || "there are none"}).`);
    }
    if (typeof gate?.unreadOf === "string" && !checkNames.includes(gate.unreadOf)) {
      throw new Error(`${where}[${i}].unreadOf ${JSON.stringify(gate.unreadOf)} names no stop check: it must be a stopGate.checks row's "name" (${checkNames.join(", ") || "no row has one"}).`);
    }
  });
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
 * The `phaseRun.tampering` section (D15), or null when there is none: no section, no tampering gate.
 * Both loaders hold this function word for word (template/tools/phase-run/config.mjs and
 * hooks/workflow-config.mjs), so what one refuses the other refuses alike. Markers or assertions
 * with no test files would match nothing, a gate that quietly passes everything, so they are refused.
 */
function tamperingRules(section, where) {
  if (section === undefined) return null;
  const object = (value, at, allowed) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${at} must be an object.`);
    const unknown = Object.keys(value).filter((key) => key !== "note" && !allowed.includes(key));
    if (unknown.length) throw new Error(`${at} has unknown key(s) ${unknown.join(", ")}; allowed: ${allowed.join(", ")}.`);
    return value;
  };
  const rows = (value, at) => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error(`${at} must be a list.`);
    return value;
  };
  const words = (value, at) => {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${at} is missing.`);
    return value;
  };
  // Paths are matched as git prints them, from the root: `./package.json` or `../x` would match nothing.
  const repoPath = (value, at, example) => {
    if (typeof value !== "string" || !value.trim() || value !== value.trim() || /^\.?\//.test(value) || value.split("/").includes("..")) {
      throw new Error(`${at} must be a path from the repo's root, such as "${example}".`);
    }
    return value;
  };
  const globs = (value, at) => rows(value, at).map((entry, i) => repoPath(entry, `${at}[${i}]`, "**/*.test.mjs"));
  const regex = (source, at) => {
    if (typeof source !== "string" || !source) throw new Error(`${at} must be a pattern (a regex, as a string).`);
    try {
      return new RegExp(source);
    } catch (error) {
      throw new Error(`${at} is not a valid pattern: ${error.message}`);
    }
  };
  object(section, where, ["testFiles", "markers", "assertions", "guarded", "guardedScripts", "override"]);
  const testFiles = globs(section.testFiles, `${where}.testFiles`);
  const markers = rows(section.markers, `${where}.markers`).map((row, i) => {
    const at = `${where}.markers[${i}]`;
    object(row, at, ["name", "pattern"]);
    return { name: words(row.name, `${at}.name`), pattern: regex(row.pattern, `${at}.pattern`) };
  });
  let assertions = null;
  if (section.assertions !== undefined) {
    const at = `${where}.assertions`;
    object(section.assertions, at, ["pattern", "maxNetRemoved"]);
    const max = section.assertions.maxNetRemoved;
    if (!Number.isInteger(max) || max < 0) throw new Error(`${at}.maxNetRemoved must be a whole number, 0 or more (it is ${JSON.stringify(max)}).`);
    assertions = { pattern: regex(section.assertions.pattern, `${at}.pattern`), maxNetRemoved: max };
  }
  if ((markers.length > 0 || assertions) && testFiles.length === 0) {
    throw new Error(`${where}.testFiles is empty, so its markers and assertions would match no file: list the test files' globs, such as "**/*.test.mjs".`);
  }
  const guardedScripts = rows(section.guardedScripts, `${where}.guardedScripts`).map((row, i) => {
    const at = `${where}.guardedScripts[${i}]`;
    object(row, at, ["file", "script"]);
    return { file: repoPath(row.file, `${at}.file`, "package.json"), script: words(row.script, `${at}.script`) };
  });
  let override = null;
  if (section.override !== undefined) {
    object(section.override, `${where}.override`, ["heading"]);
    override = { heading: words(section.override.heading, `${where}.override.heading`).trim() };
  }
  return { testFiles, markers, assertions, guarded: globs(section.guarded, `${where}.guarded`), guardedScripts, override };
}

/**
 * A row's name, or null: it names the row's receipt file (`.phase-run/<name>-receipt-<ticket>.json`),
 * so it is a plain lowercase word, and never `test`, the file rows without a name share.
 */
function checkName(check, where) {
  if (check.name === undefined) return null;
  if (typeof check.name !== "string" || !check.name) throw new Error(`${where}.name must be text, such as "tests".`);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(check.name)) {
    throw new Error(`${where}.name "${check.name}" must be lowercase letters, digits, "-" or "_", starting with a letter or digit: it names the check's receipt file.`);
  }
  if (check.name === "test") throw new Error(`${where}.name "test" is the one rows without a name share (test-receipt-<ticket>.json); choose another, such as "tests".`);
  return check.name;
}

/**
 * A row's unread paths: globs its receipt's key leaves out, only on a row with "receipt": true. A
 * leading `!` puts paths back, and what follows it is held to the same rules. A glob that names no
 * folder or file (`**`, `*.*`, `.`) could leave out every file, so no edit would make the receipt
 * stale; one that leaves the repo could match nothing in it.
 */
function unreadList(check, where) {
  if (check.unread === undefined) return [];
  if (check.receipt !== true) throw new Error(`${where}.unread belongs on a row with "receipt": true, whose receipt it keeps.`);
  if (!Array.isArray(check.unread)) throw new Error(`${where}.unread must be a list of globs, such as ["docs/**", "*.md"].`);
  check.unread.forEach((entry, j) => {
    const at = `${where}.unread[${j}]`;
    if (typeof entry !== "string" || !entry.trim()) throw new Error(`${at} must be a glob, such as "docs/**".`);
    if (entry !== entry.trim()) throw new Error(`${at} "${entry}" has spaces around it, which would be matched as written.`);
    const glob = entry.replace(/^!/, "");
    if (/^\.?\//.test(glob) || glob.split("/").includes("..")) throw new Error(`${at} "${entry}" must be a path inside the repo, from its root, such as "docs/**".`);
    if (!/[\p{L}\p{N}]/u.test(glob)) {
      throw new Error(`${at} "${entry}" names no folder or file, so it could leave out every file; name only what the check never reads, such as "docs/**".`);
    }
  });
  return check.unread;
}

/**
 * Each receipt row keeps its own receipt file, so a name is used once. The rows without a name share
 * the one file 0.5.x wrote (`test-receipt-<ticket>.json`), so they share one key and one list.
 */
function receiptFiles(checks, where) {
  const named = new Map();
  checks.forEach((check, i) => {
    if (check.name === null) return;
    if (named.has(check.name)) throw new Error(`${where}[${i}].name "${check.name}" is also ${where}[${named.get(check.name)}]'s: each name names one receipt file.`);
    named.set(check.name, i);
  });
  const rows = checks.map((check, i) => ({ check, i })).filter(({ check }) => check.receipt && check.name === null);
  const key = (list) => [...list].sort().join("\n");
  const differing = rows.find(({ check }) => key(check.unread) !== key(rows[0].check.unread));
  if (differing) {
    throw new Error(
      `${where}[${differing.i}].unread differs from ${where}[${rows[0].i}].unread: receipt rows without a "name" share one receipt file, so they share one list. Give each its own "name".`,
    );
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
