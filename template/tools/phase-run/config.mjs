// The phase runner's project config: the `phaseRun` section of `.claude/workflow.json`. Everything
// the runner knows about one project (its commands, its databases, what a session's prompt adds)
// is here; run.mjs knows only the workflow. The plugin's hooks read the same file's `guard` and
// `stopGate` sections and skip this one, so a mistake in it is caught by the runner's preflight.
//
//   "phaseRun": {
//     "prompt": "docs/agents/phase-run-prompt.md",   the project's prose for a session (## Read, ## Build,
//                                                   ## Browser check, ## Review, ## Fix sections)
//     "preflight": [{ "label", "run", "hint"? }],    must pass before a run starts
//     "ports": [{ "port", "what", "freeAfterEachTicket"?, "name"? }],   must be free at the start; a lane's
//                                                   port named "qa" is its QA server's
//     "qa": { "name", "url" },                       the database a session works on
//     "sessionEnv": { NAME: value },                 pinned in every session, so `.env` cannot hand it a live value
//     "strayProcess": "<regex>",                     a node process under node_modules that must not outlive a session
//     "gates": [{ "label", "run", "when"?, "env"?, "freePorts"?, "alone"?, "after"?, "unreadOf"? } | { "builtin": "browser-check" }],
//                                                   side by side; `after` waits for that gate's pass,
//                                                   `alone` runs by itself after the group, `unreadOf`
//                                                   skips on a diff wholly on that stop check's list
//     "browserCheck": { "screenFiles", "sourceFiles", "screenshots", "minimum", "redo" },
//     "migrations": { "added", "target": { "name", "urlFrom", "direct"? }, "apply", "rollBack"?, "destructive"? },
//     "alwaysInScope": ["<regex>"],                  never "outside the ticket's areas"
//     "permissions": { "allow"?: [], "deny"?: [] }   added to tools/phase-run/settings.json's rules
//     "steps": [{ "kind", "match" }],                what a session's shell command was, for the time split
//                                                   (metrics.mjs); tested before Brigade's own rows
//     "ticketSize": [{ "key", "kind", "section"?, "max", "label" }]   the size budget /ticket-check warns on
//                                                   (ticket-size.mjs); left out, Brigade's defaults
//     "tampering": { "testFiles"?, "markers"?: [{ "name", "pattern" }], "assertions"?: { "pattern", "maxNetRemoved" },
//                    "guarded"?, "guardedScripts"?: [{ "file", "script" }], "override"?: { "heading" } }
//                                                   the tampering gate (tampering.mjs), first of the gates;
//                                                   its rules are read from the base commit, never the tree
//     "keep": { "plugins"?: [], "skills"?: [] }      user plugins and skills this project's nights keep,
//                                                   whatever the machine's trim.json says (trim.mjs, D16)
//     "lanes": { "rows": [{ "id", "takes", "worktree", "qa"?, "ports"?, "testDbPrefix"?, "env"? }],
//                "claims"?, "worktreeSetup"?: { "copy"?, "commands"?, "leaves"? }, "landing"? }
//                                                   0.7.0's lanes, two at most; left out, a one-lane run
//                                                   as before. A row's values are the project's: none
//                                                   has a default here. `claims` and `landing` have no
//                                                   keys yet; the tickets that use them add theirs
//     "hotspots": { "token"?, "rows": [{ "path", "kind" }] }   the files every commit writes at one spot,
//                                                   and how Landing settles each (ADR 0006)
//   }
//
// The top-level `ledger` section, `{ "attended"?, "weekStarts"? }` (ledger.mjs), is read here too,
// with the hooks' refusals: `attended` (default true) is the attended hook's switch, and
// `weekStarts` (a lowercase day, default "monday") cuts the ledger's weekly view.
//
// Placeholders, each allowed only where it makes sense (a gate cannot reach the migration target):
// {base} the ticket's base commit, {N} the ticket number, {qaUrl} the QA database's address,
// {targetUrl} the migration target's address, {name} a migration's name, {cache} a folder the runner
// empties before each gate run (a tool's fresh-cache flag points into it). In `qa.url` only,
// {loopbackNotUsedBy:VAR} is `localhost` or `127.0.0.1`, whichever the URL in VAR does not use.
//
// `rollBack` relies on `apply` printing each migration's name as it starts it, as Prisma does: every
// name printed before the last one applied, and the rest are rolled back. A tool that prints
// otherwise leaves `rollBack` out.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { STEP_KINDS } from "./metrics.mjs";
import { RULE_KINDS } from "./ticket-size.mjs";

export const CONFIG_PATH = ".claude/workflow.json";
export const BROWSER_CHECK = "browser-check";

/** The days a ledger week may start on, in Date.getDay() order. hooks/workflow-config.mjs keeps the same list. */
export const WEEK_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
/** The top-level `ledger` section's defaults: the attended hook on, weeks from Monday. */
export const DEFAULT_LEDGER = { attended: true, weekStarts: "monday" };

const KEYS = {
  phaseRun: ["prompt", "preflight", "ports", "qa", "sessionEnv", "strayProcess", "gates", "browserCheck", "migrations", "alwaysInScope", "permissions", "steps", "ticketSize", "tampering", "keep", "lanes", "hotspots"],
  preflight: ["label", "run", "hint"],
  port: ["port", "what", "freeAfterEachTicket", "name"],
  lanes: ["rows", "claims", "worktreeSetup", "landing"],
  lane: ["id", "takes", "worktree", "qa", "ports", "testDbPrefix", "env"],
  worktreeSetup: ["copy", "commands", "leaves"],
  claims: [],
  landing: [],
  hotspots: ["token", "rows"],
  hotspot: ["path", "kind"],
  qa: ["name", "url"],
  gate: ["label", "run", "when", "env", "freePorts", "alone", "after", "unreadOf"],
  builtin: ["builtin"],
  browserCheck: ["screenFiles", "sourceFiles", "screenshots", "minimum", "redo"],
  migrations: ["added", "target", "apply", "rollBack", "destructive"],
  target: ["name", "urlFrom", "direct"],
  command: ["run", "env"],
  permissions: ["allow", "deny"],
  keep: ["plugins", "skills"],
  step: ["kind", "match"],
  sizeRule: ["key", "kind", "section", "max", "label"],
};

/** How many lanes may run at once (D5). The lane code is row-generic: lifting the cap is this line, plus a trial. */
export const MAX_LANES = 2;
/** What a lane row may take besides a label: any ticket. At most one row takes it (D6). */
export const ANY_TICKET = "any";
/** The kinds of hotspot row (ADR 0006); a file on no row is left to git. What each kind does is Landing's. */
export const HOTSPOT_KINDS = ["log", "generated", "own-file"];

/** Which placeholders each kind of value may use. */
const ALLOWED = {
  preflight: ["qaUrl"],
  sessionEnv: ["qaUrl"],
  laneEnv: [],
  gate: ["base", "N", "qaUrl", "cache"],
  screenshots: ["N"],
  apply: ["targetUrl", "base"],
  rollBack: ["targetUrl", "name"],
};

/**
 * The run config, or `error` naming what is wrong. A file with no `phaseRun` section is a project
 * with no project gates: the runner's own checks still run.
 */
export function loadRunConfig(root) {
  const path = join(root, CONFIG_PATH);
  try {
    const data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    return { config: parseRunConfig(data), error: null };
  } catch (error) {
    return { config: null, error: `${CONFIG_PATH}: ${error.message}` };
  }
}

/** The whole file's JSON in, the runner's view of it out. Throws on the first problem. */
export function parseRunConfig(data) {
  const run = data?.phaseRun ?? {};
  const where = "phaseRun";
  keys(run, KEYS.phaseRun, where);
  const gates = list(run.gates, `${where}.gates`).map((gate, i) => parseGate(gate, `${where}.gates[${i}]`));
  const browserCheck = run.browserCheck === undefined ? null : parseBrowserCheck(run.browserCheck, `${where}.browserCheck`);
  const marked = gates.some((gate) => gate.builtin === BROWSER_CHECK);
  if (marked && !browserCheck) throw new Error(`${where}.gates names the browser-check gate, but there is no ${where}.browserCheck section.`);
  if (browserCheck && !marked) gates.push({ builtin: BROWSER_CHECK });
  // Notes are prose: one may mention {qaUrl} without using it.
  const used = JSON.stringify([run.preflight, run.sessionEnv, run.gates], (key, value) => (key === "note" ? undefined : value));
  if (run.qa === undefined && used.includes("{qaUrl}")) {
    throw new Error(`${where} uses {qaUrl}, but there is no ${where}.qa section to give it a value.`);
  }
  // The hooks check stopGate (hooks/workflow-config.mjs); a bad pattern here only falls back to the plain tail.
  // `name` and `unread` are checked here too, as the hooks check them: they decide which receipt a
  // check keeps and what it vouches for.
  const stopChecks = receiptFiles(
    list(data?.stopGate?.checks, "stopGate.checks").map((check, i) => ({
      name: checkName(check, `stopGate.checks[${i}]`),
      label: String(check.label),
      run: String(check.run),
      receipt: check.receipt === true,
      quiet: quietPair(check.quiet),
      unread: unreadList(check, `stopGate.checks[${i}]`),
    })),
    "stopGate.checks",
  );
  gateReferences(run.gates, stopChecks.map((check) => check.name).filter(Boolean), `${where}.gates`);
  gateOrder(gates, `${where}.gates`);
  const config = {
    prompt: optionalText(run.prompt, `${where}.prompt`),
    preflight: list(run.preflight, `${where}.preflight`).map((row, i) => {
      const at = `${where}.preflight[${i}]`;
      keys(row, KEYS.preflight, at);
      return { label: text(row.label, `${at}.label`), run: command(row.run, `${at}.run`, ALLOWED.preflight), hint: optionalText(row.hint, `${at}.hint`) };
    }),
    ports: parsePorts(run.ports, `${where}.ports`),
    qa: run.qa === undefined ? null : parseQa(run.qa, `${where}.qa`),
    sessionEnv: envBlock(run.sessionEnv, `${where}.sessionEnv`, ALLOWED.sessionEnv),
    strayProcess: run.strayProcess === undefined ? null : pattern(run.strayProcess, `${where}.strayProcess`),
    gates,
    browserCheck,
    migrations: run.migrations === undefined ? null : parseMigrations(run.migrations, `${where}.migrations`),
    alwaysInScope: list(run.alwaysInScope, `${where}.alwaysInScope`).map((source, i) => pattern(source, `${where}.alwaysInScope[${i}]`)),
    permissions: parsePermissions(run.permissions ?? {}, `${where}.permissions`),
    steps: list(run.steps, `${where}.steps`).map((row, i) => parseStep(row, `${where}.steps[${i}]`)),
    ticketSize: run.ticketSize === undefined ? null : list(run.ticketSize, `${where}.ticketSize`).map((row, i) => parseSizeRule(row, `${where}.ticketSize[${i}]`)),
    stopChecks,
    tampering: tamperingRules(run.tampering, `${where}.tampering`),
    keep: parseKeep(run.keep === undefined ? {} : run.keep, `${where}.keep`),
    ledger: parseLedger(data?.ledger),
  };
  // Last, so a config with no lanes is refused, if at all, as before. A lane row's qa is checked
  // against phaseRun.qa, loaded above.
  config.lanes = run.lanes === undefined ? null : parseLanes(run.lanes, `${where}.lanes`, config.qa);
  config.hotspots = run.hotspots === undefined ? null : parseHotspots(run.hotspots, `${where}.hotspots`);
  return config;
}

// tampering.mjs reads the base commit's section through this same function.
export { tamperingRules };

/**
 * The top-level `ledger` section, `{ attended?, weekStarts? }`: checked here as the hooks check it
 * (hooks/workflow-config.mjs), with the same refusals, because the two cannot share code.
 */
export function parseLedger(ledger) {
  if (ledger === undefined) return { ...DEFAULT_LEDGER };
  keys(ledger, ["attended", "weekStarts", "note"], "ledger"); // "note" listed, so the refusal reads as the hooks' does
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
  return checks;
}

function parseStep(row, at) {
  keys(row, KEYS.step, at);
  if (!STEP_KINDS.includes(row.kind)) throw new Error(`${at}.kind must be one of ${STEP_KINDS.join(", ")}.`);
  return { kind: row.kind, match: pattern(row.match, `${at}.match`) };
}

function parseSizeRule(row, at) {
  keys(row, KEYS.sizeRule, at);
  if (!RULE_KINDS.includes(row.kind)) throw new Error(`${at}.kind must be one of ${RULE_KINDS.join(", ")}.`);
  if (row.kind !== "words") text(row.section, `${at}.section`);
  if (!Number.isInteger(row.max) || row.max < 1) throw new Error(`${at}.max must be a whole number, 1 or more.`);
  return { key: text(row.key, `${at}.key`), kind: row.kind, section: row.section ?? null, max: row.max, label: text(row.label, `${at}.label`) };
}

function quietPair(quiet) {
  try {
    return quiet ? { totals: new RegExp(quiet.totals), failures: new RegExp(quiet.failures) } : null;
  } catch {
    return null;
  }
}

function parseGate(gate, at) {
  if (gate?.builtin !== undefined) {
    keys(gate, KEYS.builtin, at);
    if (gate.builtin !== BROWSER_CHECK) throw new Error(`${at}.builtin must be "${BROWSER_CHECK}", the one built-in gate a project places.`);
    return { builtin: BROWSER_CHECK };
  }
  keys(gate, KEYS.gate, at);
  return {
    label: text(gate.label, `${at}.label`),
    run: command(gate.run, `${at}.run`, ALLOWED.gate),
    when: gate.when === undefined ? null : pattern(gate.when, `${at}.when`),
    env: envBlock(gate.env, `${at}.env`, ALLOWED.gate),
    freePorts: flag(gate.freePorts, `${at}.freePorts`),
    alone: flag(gate.alone, `${at}.alone`),
    after: optionalText(gate.after, `${at}.after`),
    unreadOf: optionalText(gate.unreadOf, `${at}.unreadOf`),
  };
}

/**
 * A gate's `after` names another gate's label, and its `unreadOf` a stop check's `name`. A name that
 * names nothing is refused by both loaders, word for word (hooks/workflow-config.mjs keeps this same
 * function); any other shape is left to the runner's own checks, so the hooks never break over it.
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
 * The runner's own rules for `after` (D12): it links two gates of the parallel group, by a label only
 * one gate has, and never in a circle. Each would otherwise leave a gate waiting forever.
 */
function gateOrder(gates, where) {
  const byLabel = new Map();
  for (const gate of gates) if (gate.label) byLabel.set(gate.label, [...(byLabel.get(gate.label) ?? []), gate]);
  gates.forEach((gate, i) => {
    if (!gate.after) return;
    const at = `${where}[${i}].after`;
    if (gate.alone) throw new Error(`${at} belongs on a gate of the parallel group: an "alone" gate already runs after all of it.`);
    const named = byLabel.get(gate.after);
    if (named.length > 1) throw new Error(`${at} ${JSON.stringify(gate.after)} names a label two gates share: give each its own label.`);
    if (named[0].alone) throw new Error(`${at} ${JSON.stringify(gate.after)} names an "alone" gate, which runs after the whole parallel group: this gate would never start.`);
    const path = [gate.label];
    for (let next = named[0]; next; next = next.after ? byLabel.get(next.after)[0] : null) {
      path.push(next.label);
      if (next === gate) throw new Error(`${at} ${JSON.stringify(gate.after)} waits on itself: ${path.join(" → ")}.`);
      if (path.length > gates.length + 1) break;
    }
  });
}

function parseQa(qa, at) {
  keys(qa, KEYS.qa, at);
  const url = text(qa.url, `${at}.url`);
  for (const [whole, name] of url.matchAll(/\{(\w+)(?::\w+)?\}/g)) {
    if (name !== "loopbackNotUsedBy") throw new Error(`${at}.url uses ${whole}; the only placeholder allowed here is {loopbackNotUsedBy:VAR}.`);
  }
  return { name: text(qa.name, `${at}.name`), url };
}

function parseBrowserCheck(check, at) {
  keys(check, KEYS.browserCheck, at);
  if (!Number.isInteger(check.minimum) || check.minimum < 1) throw new Error(`${at}.minimum must be a whole number of screenshots, 1 or more.`);
  return {
    screenFiles: pattern(check.screenFiles, `${at}.screenFiles`),
    sourceFiles: pattern(check.sourceFiles, `${at}.sourceFiles`),
    screenshots: command(check.screenshots, `${at}.screenshots`, ALLOWED.screenshots),
    minimum: check.minimum,
    redo: text(check.redo, `${at}.redo`),
  };
}

function parseMigrations(migrations, at) {
  keys(migrations, KEYS.migrations, at);
  const target = migrations.target;
  keys(target, KEYS.target, `${at}.target`);
  const direct = list(target.direct, `${at}.target.direct`).map((pair, i) => {
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((part) => typeof part === "string")) {
      throw new Error(`${at}.target.direct[${i}] must be a pair: ["text to find", "text to put instead"].`);
    }
    return pair;
  });
  const added = pattern(migrations.added, `${at}.added`);
  // `pattern|` matches the empty string, so exec's result has one slot per group plus the whole match.
  if (new RegExp(`${added.source}|`).exec("").length < 2) throw new Error(`${at}.added needs a group, ( ), around the migration's name.`);
  return {
    added,
    target: { name: text(target.name, `${at}.target.name`), urlFrom: text(target.urlFrom, `${at}.target.urlFrom`), direct },
    apply: parseCommand(migrations.apply, `${at}.apply`, ALLOWED.apply),
    rollBack: migrations.rollBack === undefined ? null : parseCommand(migrations.rollBack, `${at}.rollBack`, ALLOWED.rollBack),
    destructive: migrations.destructive === undefined ? null : pattern(migrations.destructive, `${at}.destructive`, "i"),
  };
}

function parseCommand(value, at, allowed) {
  keys(value, KEYS.command, at);
  return { run: command(value.run, `${at}.run`, allowed), env: envBlock(value.env, `${at}.env`, allowed) };
}

function parsePermissions(value, at) {
  keys(value, KEYS.permissions, at);
  const rules = (name) => list(value[name], `${at}.${name}`).map((rule, i) => text(rule, `${at}.${name}[${i}]`));
  return { allow: rules("allow"), deny: rules("deny") };
}

/** `phaseRun.keep` (D16): the user plugins (`name@marketplace`) and skills this project's nights never trim. */
function parseKeep(value, at) {
  keys(value, KEYS.keep, at);
  const names = (name) => list(value[name], `${at}.${name}`).map((entry, i) => text(entry, `${at}.${name}[${i}]`).trim());
  const plugins = names("plugins");
  // trim.mjs's isPluginId, written out: config.mjs imports nothing the stop-tests copy lacks (measure.test.mjs).
  for (const id of plugins) {
    if (!/^[^@\s]+@[^@\s]+$/.test(id)) throw new Error(`${at}.plugins: "${id}" is not a plugin id (name@marketplace, as \`claude plugin list\` prints it).`);
  }
  return { plugins, skills: names("skills") };
}

/**
 * Port rows, in `phaseRun.ports` and a lane row's `ports` alike. A `name` finds a port by its job: a
 * lane's port named "qa" is its QA server's (PHASE_RUN_QA_PORT), and the rest are only checked free.
 */
function parsePorts(value, where) {
  const named = new Map();
  return list(value, where).map((row, i) => {
    const at = `${where}[${i}]`;
    keys(row, KEYS.port, at);
    if (!Number.isInteger(row.port) || row.port < 1 || row.port > 65535) throw new Error(`${at}.port must be a port number.`);
    const port = { port: row.port, what: text(row.what, `${at}.what`), freeAfterEachTicket: flag(row.freeAfterEachTicket, `${at}.freeAfterEachTicket`), name: null };
    if (row.name !== undefined) {
      if (typeof row.name !== "string" || !/^[a-z][a-z0-9_-]*$/.test(row.name)) throw new Error(`${at}.name must be a lowercase word (lowercase letters, digits, "-" or "_", starting with a letter), such as "qa" (it is ${JSON.stringify(row.name)}).`);
      if (named.has(row.name)) throw new Error(`${at}.name "${row.name}" is also ${where}[${named.get(row.name)}]'s: a name finds one port.`);
      named.set(row.name, i);
      port.name = row.name;
    }
    return port;
  });
}

/**
 * `phaseRun.lanes` (D3–D6): at most MAX_LANES rows, each one lane's own resources. Every value in a
 * row is the project's, so one a row leaves out stays null: nothing here makes one up. Across rows,
 * two lanes never share an id, a worktree, a port or a QA database, and only one takes any ticket.
 * `qa` is phaseRun.qa as loaded (or null), whose url a row's database goes into.
 */
function parseLanes(section, where, qa) {
  keys(section, KEYS.lanes, where);
  const rows = list(section.rows, `${where}.rows`);
  if (rows.length === 0) throw new Error(`${where}.rows is empty: list one row per lane, or leave ${where} out.`);
  if (rows.length > MAX_LANES) {
    const extra = rows.slice(MAX_LANES).map((_, i) => `rows[${MAX_LANES + i}]`);
    throw new Error(`${where}.rows has ${rows.length} rows, and at most ${MAX_LANES} lanes run: take out ${extra.join(", ")}.`);
  }
  const at = (i) => `${where}.rows[${i}]`;
  const lanes = rows.map((row, i) => parseLane(row, at(i), qa));
  // A row's QA database: its own `qa`, else phaseRun.qa's own (its `name`), as lane 1's is.
  const database = (lane) => lane.qa ?? qa?.name ?? null;
  const databaseFrom = (j) => (lanes[j].qa === null ? `phaseRun.qa.name, as it has no "qa"` : `${at(j)}.qa`);
  lanes.forEach((lane, i) => {
    const earlier = (same) => lanes.findIndex((other, j) => j < i && same(other));
    let j = earlier((other) => other.id === lane.id);
    if (j !== -1) throw new Error(`${at(i)}.id "${lane.id}" is also ${at(j)}'s: each lane has its own id.`);
    j = earlier((other) => other.takes === ANY_TICKET);
    if (lane.takes === ANY_TICKET && j !== -1) {
      throw new Error(
        `${at(i)}.takes is "${ANY_TICKET}", as ${at(j)}.takes is: at most one lane takes any ticket. A second lane that takes any ticket whose Areas don't overlap the other lane's is an upgrade 0.7.0 leaves out of scope, until this rule is lifted on purpose; give this lane a label it takes instead.`,
      );
    }
    j = earlier((other) => other.worktree === lane.worktree);
    if (j !== -1) throw new Error(`${at(i)}.worktree "${lane.worktree}" is also ${at(j)}'s: each lane builds in its own worktree.`);
    const name = database(lane);
    j = name === null ? -1 : earlier((other) => database(other) === name);
    if (j !== -1) {
      const clash = lane.qa === null ? `${at(i)} has no "qa", so its QA database is phaseRun.qa.name "${name}", which is also ${at(j)}'s` : `${at(i)}.qa "${name}" is also ${at(j)}'s QA database`;
      throw new Error(`${clash} (${databaseFrom(j)}): each lane needs its own.`);
    }
    // A test database's name starts with the prefix, so one prefix that starts another's ("lane",
    // "lane2_") would match the other lane's databases too.
    const prefix = lane.testDbPrefix;
    j = prefix === null ? -1 : earlier((other) => other.testDbPrefix !== null && (other.testDbPrefix.startsWith(prefix) || prefix.startsWith(other.testDbPrefix)));
    if (j !== -1) {
      throw new Error(`${at(i)}.testDbPrefix "${prefix}" overlaps ${at(j)}.testDbPrefix "${lanes[j].testDbPrefix}": one starts the other, so a test database could be either lane's. Give each lane a prefix the other's doesn't start.`);
    }
    lane.ports.forEach((port, p) => {
      for (const [k, other] of lanes.slice(0, i).entries()) {
        const q = other.ports.findIndex((theirs) => theirs.port === port.port);
        if (q !== -1) throw new Error(`${at(i)}.ports[${p}].port ${port.port} is also ${at(k)}.ports[${q}]'s: two lanes never bind one port.`);
      }
    });
  });
  return {
    rows: lanes,
    claims: noKeysYet(section.claims, `${where}.claims`, KEYS.claims),
    worktreeSetup: parseWorktreeSetup(section.worktreeSetup ?? {}, `${where}.worktreeSetup`),
    landing: noKeysYet(section.landing, `${where}.landing`, KEYS.landing),
  };
}

/** One lane row. `takes` is "any" or a label the project picks; `testDbPrefix` may be left out, never set empty. */
function parseLane(row, at, qa) {
  keys(row, KEYS.lane, at);
  const lane = {
    id: laneId(row.id, `${at}.id`),
    takes: text(row.takes, `${at}.takes`),
    worktree: text(row.worktree, `${at}.worktree`),
    qa: optionalText(row.qa, `${at}.qa`),
    ports: parsePorts(row.ports, `${at}.ports`),
    testDbPrefix: row.testDbPrefix === undefined ? null : testDbPrefix(row.testDbPrefix, `${at}.testDbPrefix`),
    env: envBlock(row.env, `${at}.env`, ALLOWED.laneEnv),
  };
  if (lane.qa !== null && !qa) throw new Error(`${at}.qa is set, but there is no phaseRun.qa section whose url it goes into.`);
  if (lane.qa !== null && !lane.ports.some((port) => port.name === "qa")) {
    throw new Error(`${at}.qa is set, but ${at}.ports has no port named "qa": the lane's browser check would reach another lane's QA server.`);
  }
  return lane;
}

/** A lane's id names it in `--lane <id>` and its folders: a whole number or a lowercase word, kept as text. */
function laneId(value, at) {
  if (Number.isInteger(value) && value >= 1) return String(value);
  if (typeof value === "string" && /^[a-z0-9][a-z0-9-]*$/.test(value)) return value;
  throw new Error(`${at} must be a whole number, 1 or more, or a lowercase word (lowercase letters, digits or "-", starting with a letter or digit), such as 2 or "docs": it names the lane in --lane and its folders (it is ${JSON.stringify(value)}).`);
}

/** A test database's name starts with the prefix, so one that is empty or holds other characters could match every one. */
function testDbPrefix(value, at) {
  if (value === "") throw new Error(`${at} is set but empty: leave it out to keep the project's own test-database names, or name this lane's, such as "lane2_".`);
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(`${at} ${JSON.stringify(value)} is unsafe: a test database's name starts with it, so it is a lowercase letter, then lowercase letters, digits or "_", such as "lane2_".`);
  }
  return value;
}

/** `worktreeSetup` (D8): untracked files to `copy` in, the `commands` to run, and the files they `leaves`. */
function parseWorktreeSetup(value, at) {
  keys(value, KEYS.worktreeSetup, at);
  const paths = (name, example) => list(value[name], `${at}.${name}`).map((entry, i) => repoPath(entry, `${at}.${name}[${i}]`, example));
  return {
    copy: paths("copy", ".env"),
    commands: list(value.commands, `${at}.commands`).map((line, i) => text(line, `${at}.commands[${i}]`)),
    leaves: paths("leaves", "node_modules/.bin/tsc"),
  };
}

/**
 * A section whose keys a later ticket defines (only a note for now): its keys are checked against
 * `allowed` and kept as written, so adding a key to KEYS is all that ticket needs here.
 */
function noKeysYet(value, at, allowed) {
  if (value === undefined) return {};
  keys(value, allowed, at);
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "note"));
}

/** `phaseRun.hotspots` (ADR 0006): checked here; what each kind does, and the token's default, are Landing's. */
function parseHotspots(section, where) {
  keys(section, KEYS.hotspots, where);
  if (section.token !== undefined && (typeof section.token !== "string" || !/^\S+$/.test(section.token))) {
    throw new Error(`${where}.token must be a word with no spaces, such as "NNN" (it is ${JSON.stringify(section.token)}).`);
  }
  const rows = list(section.rows, `${where}.rows`).map((row, i) => {
    const at = `${where}.rows[${i}]`;
    keys(row, KEYS.hotspot, at);
    if (!HOTSPOT_KINDS.includes(row.kind)) throw new Error(`${at}.kind must be one of ${HOTSPOT_KINDS.join(", ")} (it is ${JSON.stringify(row.kind)}). A file on no row is left to git.`);
    return { path: repoPath(row.path, `${at}.path`, "docs/history/devlog.md"), kind: row.kind };
  });
  return { token: section.token ?? null, rows };
}

// ------------------------------------------------------------------ the values

/**
 * Fills a value's placeholders. Every placeholder was checked against its field when the config
 * loaded, so a missing value here is the runner's bug, and fails loudly rather than running a
 * command with `{qaUrl}` still in it.
 */
export function fill(value, values) {
  return value.replace(/\{(\w+)\}/g, (whole, key) => {
    if (values[key] === undefined || values[key] === null) throw new Error(`No value for ${whole} in "${value}".`);
    return String(values[key]);
  });
}

/** An env block with its placeholders filled. */
export function fillEnv(env, values) {
  return Object.fromEntries(Object.entries(env).map(([name, value]) => [name, fill(value, values)]));
}

/**
 * The QA database's address. `lookup(NAME)` reads a variable (the runner: the process, else `.env`).
 * {loopbackNotUsedBy:VAR} exists because two databases in one container need two names for it: a
 * test setup that refuses to start when its two addresses look alike compares hostnames.
 */
export function qaUrl(config, lookup) {
  if (!config.qa) return null;
  return config.qa.url.replace(/\{loopbackNotUsedBy:(\w+)\}/g, (_, name) => {
    let host = "localhost";
    try {
      host = new URL(lookup(name) ?? "").hostname;
    } catch {
      host = "localhost";
    }
    return host === "127.0.0.1" ? "localhost" : "127.0.0.1";
  });
}

/** The migration target's address as the migrations reach it (after the `direct` rewrites), or null. */
export function targetUrl(config, lookup) {
  const target = config.migrations?.target;
  const url = target && lookup(target.urlFrom);
  if (!url) return null;
  return target.direct.reduce((address, [find, put]) => address.replaceAll(find, put), url);
}

/** What the runner remembers of the target on its first run: the host, never a credential. */
export function targetFingerprint(url) {
  return new URL(url).hostname;
}

/** The values a session's environment pins. */
export function sessionEnv(config, lookup) {
  return fillEnv(config.sessionEnv, { qaUrl: qaUrl(config, lookup) });
}

// -------------------------------------------------------------------- checking

function keys(value, allowed, at) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${at} must be an object.`);
  const unknown = Object.keys(value).filter((key) => key !== "note" && !allowed.includes(key));
  if (unknown.length) throw new Error(`${at} has unknown key(s) ${unknown.join(", ")}; allowed: ${allowed.join(", ") || "none yet"}.`);
}

/**
 * A path as git prints it, from the repo's root: `./x`, `/x` or `../x` would match nothing in it. The
 * twin of tamperingRules' own `repoPath`, which stays inside it to keep that function word for word
 * the hooks'.
 */
function repoPath(value, at, example) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || /^\.?\//.test(value) || value.split("/").includes("..")) {
    throw new Error(`${at} must be a path from the repo's root, such as "${example}".`);
  }
  return value;
}

function list(value, at) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${at} must be a list.`);
  return value;
}

function text(value, at) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${at} is missing.`);
  return value;
}

function optionalText(value, at) {
  return value === undefined ? null : text(value, at);
}

function flag(value, at) {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error(`${at} must be true or false.`);
  return value;
}

/** A command (or a path) whose placeholders must each be allowed where it stands. */
function command(value, at, allowed) {
  const line = text(value, at);
  for (const [whole, name] of line.matchAll(/\{(\w+)\}/g)) {
    if (!allowed.includes(name)) {
      throw new Error(`${at} uses ${whole}; allowed here: ${allowed.length ? allowed.map((a) => `{${a}}`).join(", ") : "none"}.`);
    }
  }
  return line;
}

function envBlock(value, at, allowed) {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${at} must be an object of NAME: value.`);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name]) => name !== "note")
      .map(([name, line]) => [name, command(line, `${at}.${name}`, allowed)]),
  );
}

function pattern(source, at, flags = "") {
  if (typeof source !== "string" || !source) throw new Error(`${at} must be a pattern (a regex, as a string).`);
  try {
    return new RegExp(source, flags);
  } catch (error) {
    throw new Error(`${at} is not a valid pattern: ${error.message}`);
  }
}
