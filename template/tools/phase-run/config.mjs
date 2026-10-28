// The phase runner's project config: the `phaseRun` section of `.claude/workflow.json`. Everything
// the runner knows about one project (its commands, its databases, what a session's prompt adds)
// is here; run.mjs knows only the workflow. The plugin's hooks read the same file's `guard` and
// `stopGate` sections and skip this one, so a mistake in it is caught by the runner's preflight.
//
//   "phaseRun": {
//     "prompt": "docs/agents/phase-run-prompt.md",   the project's prose for a session (## Read, ## Build,
//                                                   ## Browser check, ## Review, ## Fix sections)
//     "preflight": [{ "label", "run", "hint"? }],    must pass before a run starts
//     "ports": [{ "port", "what", "freeAfterEachTicket"? }],   must be free at the start
//     "qa": { "name", "url" },                       the database a session works on
//     "sessionEnv": { NAME: value },                 pinned in every session, so `.env` cannot hand it a live value
//     "strayProcess": "<regex>",                     a node process under node_modules that must not outlive a session
//     "gates": [{ "label", "run", "when"?, "env"?, "freePorts"?, "alone"? } | { "builtin": "browser-check" }],
//     "browserCheck": { "screenFiles", "sourceFiles", "screenshots", "minimum", "redo" },
//     "migrations": { "added", "target": { "name", "urlFrom", "direct"? }, "apply", "rollBack"?, "destructive"? },
//     "alwaysInScope": ["<regex>"],                  never "outside the ticket's areas"
//     "permissions": { "allow"?: [], "deny"?: [] }   added to tools/phase-run/settings.json's rules
//     "steps": [{ "kind", "match" }],                what a session's shell command was, for the time split
//                                                   (metrics.mjs); tested before Brigade's own rows
//     "ticketSize": [{ "key", "kind", "section"?, "max", "label" }]   the size budget /ticket-check warns on
//                                                   (ticket-size.mjs); left out, Brigade's defaults
//   }
//
// Placeholders, each allowed only where it makes sense (a gate cannot reach the migration target):
// {base} the ticket's base commit, {N} the ticket number, {qaUrl} the QA database's address,
// {targetUrl} the migration target's address, {name} a migration's name. In `qa.url` only,
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

const KEYS = {
  phaseRun: ["prompt", "preflight", "ports", "qa", "sessionEnv", "strayProcess", "gates", "browserCheck", "migrations", "alwaysInScope", "permissions", "steps", "ticketSize"],
  preflight: ["label", "run", "hint"],
  port: ["port", "what", "freeAfterEachTicket"],
  qa: ["name", "url"],
  gate: ["label", "run", "when", "env", "freePorts", "alone"],
  builtin: ["builtin"],
  browserCheck: ["screenFiles", "sourceFiles", "screenshots", "minimum", "redo"],
  migrations: ["added", "target", "apply", "rollBack", "destructive"],
  target: ["name", "urlFrom", "direct"],
  command: ["run", "env"],
  permissions: ["allow", "deny"],
  step: ["kind", "match"],
  sizeRule: ["key", "kind", "section", "max", "label"],
};

/** Which placeholders each kind of value may use. */
const ALLOWED = {
  preflight: ["qaUrl"],
  sessionEnv: ["qaUrl"],
  gate: ["base", "N", "qaUrl"],
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
  return {
    prompt: optionalText(run.prompt, `${where}.prompt`),
    preflight: list(run.preflight, `${where}.preflight`).map((row, i) => {
      const at = `${where}.preflight[${i}]`;
      keys(row, KEYS.preflight, at);
      return { label: text(row.label, `${at}.label`), run: command(row.run, `${at}.run`, ALLOWED.preflight), hint: optionalText(row.hint, `${at}.hint`) };
    }),
    ports: list(run.ports, `${where}.ports`).map((row, i) => {
      const at = `${where}.ports[${i}]`;
      keys(row, KEYS.port, at);
      if (!Number.isInteger(row.port) || row.port < 1 || row.port > 65535) throw new Error(`${at}.port must be a port number.`);
      return { port: row.port, what: text(row.what, `${at}.what`), freeAfterEachTicket: flag(row.freeAfterEachTicket, `${at}.freeAfterEachTicket`) };
    }),
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
    // The hooks check stopGate (hooks/workflow-config.mjs); a bad pattern here only falls back to the plain tail.
    stopChecks: list(data?.stopGate?.checks, "stopGate.checks").map((check) => ({
      label: String(check.label),
      run: String(check.run),
      receipt: check.receipt === true,
      quiet: quietPair(check.quiet),
    })),
  };
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
  };
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
  if (unknown.length) throw new Error(`${at} has unknown key(s) ${unknown.join(", ")}; allowed: ${allowed.join(", ")}.`);
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
