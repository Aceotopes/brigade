// The phase runner: builds a phase's tickets one after another with nobody
// watching, each in its own fresh Claude Code session, on a `phase-*` branch.
//
//   node tools/phase-run/run.mjs --spec <N> --branch phase-6b [--max 4]
//   node tools/phase-run/run.mjs --only <ticket> --branch phase-trial
//   node tools/phase-run/run.mjs --spec <N> --dry-run
//
// A ticket's session is a Claude Code background session, so it can be
// watched while it works: `claude agents` lists them, `claude attach <id>`
// opens one. `--print` goes back to a hidden `claude -p` session, the way
// the first trial ran.
//
// Per ticket: a headless session builds it and commits once; this script then
// runs the gates itself (it trusts no session's word for them), sends a
// failure back to the same session up to --fix-rounds times, and either
// pushes the ticket or parks it. It never touches `main`: the owner's merge
// of the one draft pull request is the go-ahead.
//
// The owner's guide: docs/guides/phase-run.md.
// What a session is told: tools/phase-run/ticket-prompt.md, fix-prompt.md.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BROWSER_CHECK, fill, fillEnv, loadRunConfig, qaUrl, sessionEnv as pinnedEnv, targetFingerprint, targetUrl } from "./config.mjs";
import * as docConfig from "../doc-config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const STATE = join(ROOT, ".phase-run");
const WINDOWS = process.platform === "win32";

const PARK_LABEL = { question: "needs-info", failure: "ready-for-human" };
/** What Claude Code answers a background session in a folder nobody has trusted yet. */
const UNTRUSTED = /Workspace not trusted/i;
const TRUST_HELP =
  "Claude Code does not trust this folder yet, so it refuses every background session here. Open a terminal in it, run `claude` once, accept the trust prompt, exit, then start the run again.";
const READY_LABEL = "run-ready";

/** The project's commands, databases and prose: `phaseRun` in .claude/workflow.json (config.mjs). Set by preflight. */
let config = null;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const options = {
    spec: null,
    only: null,
    until: null,
    branch: null,
    max: 4,
    fixRounds: 3,
    minutes: 120,
    waitHours: 6,
    permissionMode: "acceptEdits",
    model: null,
    print: false,
    dryRun: false,
  };
  const numeric = { "--spec": "spec", "--only": "only", "--until": "until", "--max": "max", "--fix-rounds": "fixRounds", "--minutes": "minutes", "--wait-hours": "waitHours" };
  const text = { "--branch": "branch", "--permission-mode": "permissionMode", "--model": "model" };
  let maxGiven = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--max") maxGiven = true;
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--print") options.print = true;
    else if (numeric[arg]) options[numeric[arg]] = Number(String(argv[++i]).replace(/^#/, ""));
    else if (text[arg]) options[text[arg]] = argv[++i];
    else die(`Unknown argument: ${arg}`);
  }
  if (!options.spec && !options.only) {
    die("Say which tickets: --spec <spec issue number>, or --only <ticket number>.");
  }
  for (const key of ["spec", "only", "until", "max", "fixRounds", "minutes", "waitHours"]) {
    if (options[key] !== null && !Number.isFinite(options[key])) die(`--${key} needs a number.`);
  }
  if (options.until && !options.spec) die("--until needs --spec: it stops partway through a spec's tickets.");
  // "Build up to #N" names its own stopping point, so the nightly cap of 4
  // applies only when --max is given beside it.
  if (options.until && !maxGiven) options.max = Infinity;
  return options;
}

// ------------------------------------------------------------------ helpers

let logFile = null;

function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

function log(message) {
  const line = `[${stamp()}] ${message}`;
  console.log(line);
  if (logFile) appendFileSync(logFile, `${line}\n`);
}

function die(message) {
  console.error(`\nphase-run: ${message}\n`);
  process.exit(1);
}

/** Runs a program directly (no shell). Returns status and trimmed output. */
function exec(command, args, extra = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...extra,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout ?? "").replace(/\r\n/g, "\n").trim(),
    stderr: (result.stderr ?? "").replace(/\r\n/g, "\n").trim(),
  };
}

/** A project command, run as written: through the shell, since `pnpm`, `npm` and the like are .cmd shims on Windows. */
function shell(commandLine, env = {}) {
  const result = spawnSync(commandLine, {
    cwd: ROOT,
    encoding: "utf8",
    shell: true,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.replace(/\r\n/g, "\n").trim();
  return { ok: result.status === 0, output };
}

function git(...args) {
  const result = exec("git", args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function gitTry(...args) {
  return exec("git", args);
}

function gh(...args) {
  const result = exec("gh", args);
  if (!result.ok) throw new Error(`gh ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function jsonLines(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function tail(text, length = 6000) {
  return text.length <= length ? text : `…\n${text.slice(-length)}`;
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Reads `.env` into an object of its own, never into `process.env`. A
 * session inherits the runner's environment, and on the first trial run it
 * inherited the migration target's address that way: a script it meant to
 * point at the local database read the shared one instead. The runner takes
 * only the values its config names.
 */
function readDotEnv() {
  const values = {};
  const path = join(ROOT, ".env");
  if (!existsSync(path)) return values;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key) values[key] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return values;
}

/** A variable the config names: the runner's own environment first, then `.env`. */
function lookup(name) {
  return process.env[name] ?? readDotEnv()[name];
}

/** The migration target's address: what a ticket's migration is applied to, and nothing else. */
let migrationTargetUrl = null;

/**
 * What every session's environment pins (the config's `sessionEnv`). A
 * session can load `.env` without meaning to (`node --env-file=.env`, a
 * tool's own config, a script's own loader), and such loaders leave a
 * variable alone once it is set, so a value pinned here cannot be replaced
 * from the file: a script a session runs plainly reads the QA database, never
 * the migration target, and a live token can be pinned to a placeholder.
 * This stops accidents, not a session that reads `.env` on purpose.
 */
function sessionEnv() {
  return pinnedEnv(config, lookup);
}

/** A port the project names, freed after every ticket: a ticket's QA server must not block the next one. */
async function freeTicketPorts() {
  for (const { port } of config.ports.filter((p) => p.freeAfterEachTicket)) await freePort(port);
}

function listening(port) {
  return new Promise((done) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.setTimeout(800);
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    const no = () => {
      socket.destroy();
      done(false);
    };
    socket.once("error", no);
    socket.once("timeout", no);
  });
}

// A session talks to Anthropic; the runner talks to GitHub. Without both, a
// ticket cannot be built or pushed. PHASE_RUN_NET_HOSTS overrides the list
// (comma-separated, each `host` or `host:port`), which is how the offline
// path is tested.
const NET_HOSTS = (process.env.PHASE_RUN_NET_HOSTS ?? "api.anthropic.com,github.com").split(",").filter(Boolean);

function reachable(target) {
  const [host, port = "443"] = target.split(":");
  return new Promise((done) => {
    const socket = net.connect({ port: Number(port), host });
    const settle = (answer) => {
      socket.destroy();
      done(answer);
    };
    socket.setTimeout(6000);
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.once("timeout", () => settle(false));
  });
}

async function online() {
  return (await Promise.all(NET_HOSTS.map(reachable))).every(Boolean);
}

function waitDeadline(options) {
  return Date.now() + options.waitHours * 3_600_000;
}

/**
 * Returns true once the connection is there, waiting for it if it is not.
 * False means it did not come back before the deadline. Without this, an
 * outage reads as "the ticket failed", and a long one would set aside every
 * ticket of the night within minutes.
 */
async function waitForInternet(deadline, when) {
  if (await online()) return true;
  log(`No internet connection ${when}. Waiting, and checking every minute.`);
  while (Date.now() < deadline) {
    await sleep(60_000);
    if (await online()) {
      log("The connection is back.");
      return true;
    }
  }
  return false;
}

/** A ticket's QA server must not outlive its session and block the next one. */
async function freePort(port) {
  if (!(await listening(port))) return;
  if (WINDOWS) {
    exec("powershell", [
      "-NoProfile",
      "-Command",
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
    ]);
  } else {
    spawnSync(`lsof -ti :${port} | xargs kill -9`, { shell: true });
  }
  log(`Stopped a server left listening on :${port}.`);
}

function killTree(child) {
  if (WINDOWS) exec("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  else child.kill("SIGKILL");
}

// ------------------------------------------------------------------- GitHub

let repo = null;

function repoName() {
  repo ??= gh("repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner");
  return repo;
}

const ISSUE_SHAPE = "{number,title,state,body,labels:[.labels[].name]}";

function fetchIssue(number) {
  return JSON.parse(gh("api", `repos/${repoName()}/issues/${number}`, "--jq", ISSUE_SHAPE));
}

function fetchSubIssues(spec) {
  return jsonLines(
    gh("api", `repos/${repoName()}/issues/${spec}/sub_issues`, "--paginate", "--jq", `.[] | ${ISSUE_SHAPE}`),
  );
}

/**
 * The tickets this one waits on. A lookup that fails is never read as "it
 * waits on nothing": that would let a ticket be built before the one it
 * depends on. Three tries, then the run refuses to start. A ticket with no
 * blockers answers with an empty list, which is not a failure.
 */
async function fetchBlockers(number) {
  const args = ["api", `repos/${repoName()}/issues/${number}/dependencies/blocked_by`, "--paginate", "--jq", ".[] | {number,state}"];
  let result = exec("gh", args);
  for (let attempt = 2; !result.ok && attempt <= 3; attempt += 1) {
    await sleep(3000);
    result = exec("gh", args);
  }
  if (!result.ok) {
    die(
      `Could not read from GitHub which tickets #${number} waits on, after three tries:\n\n${tail(result.stderr || result.stdout, 400)}\n\n` +
        "A run does not guess the order of tickets, so nothing was started. Check the connection and `gh auth status`, then start again.",
    );
  }
  return jsonLines(result.stdout);
}

// ------------------------------------------------------------------ tickets

/**
 * Issues stay open until the pull request merges, so on a phase branch
 * "done" is: closed, or a commit on this branch carries `Closes #N`.
 */
function builtOnBranch(number) {
  const result = gitTry("log", "main..HEAD", "-i", "-E", `--grep=Closes #${number}([^0-9]|$)`, "--format=%h");
  return result.ok && result.stdout !== "";
}

function isDone(ticket) {
  return ticket.state === "closed" || builtOnBranch(ticket.number);
}

async function loadTickets(options) {
  const tickets = options.spec ? fetchSubIssues(options.spec) : [fetchIssue(options.only)];
  const wanted = options.only ? tickets.filter((t) => t.number === options.only) : tickets;
  if (options.only && wanted.length === 0) {
    die(`#${options.only} is not a sub-issue of spec #${options.spec}.`);
  }
  for (const ticket of wanted) ticket.blockers = await fetchBlockers(ticket.number);
  return wanted;
}

/** The phase's finish ticket: blocked by every other ticket of the spec, and built attended. */
function isFinishTicket(ticket, byNumber) {
  const others = [...byNumber.keys()].filter((number) => number !== ticket.number);
  return others.length > 0 && others.every((number) => ticket.blockers.some((blocker) => blocker.number === number));
}

/** Why a ticket cannot start now, or null when it can. */
function holdReason(ticket, byNumber) {
  if (isDone(ticket)) return "done";
  if (ticket.labels.includes(PARK_LABEL.question)) return `parked: waiting on your answer (${PARK_LABEL.question})`;
  if (ticket.labels.includes(PARK_LABEL.failure)) return `parked: needs a person (${PARK_LABEL.failure})`;
  if (!ticket.labels.includes(READY_LABEL)) {
    return isFinishTicket(ticket, byNumber) ? "the finish ticket: built attended, not by a run" : `not labelled ${READY_LABEL} (run /ticket-check first)`;
  }
  for (const blocker of ticket.blockers) {
    const known = byNumber.get(blocker.number);
    const done = known ? isDone(known) : blocker.state === "closed" || builtOnBranch(blocker.number);
    if (!done) return `waiting on #${blocker.number}`;
  }
  return null;
}

// ---------------------------------------------------------------- preflight

/** Claude Code's own state file (`~/.claude.json`), or null when it cannot be read. */
function readClaudeState() {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Whether Claude Code has trusted `root` (its trust prompt accepted): true, false, or null when its
 * state cannot say. A folder only ever touched by scripts was never shown the prompt, and every
 * background session there is refused.
 */
export function folderTrusted(state, root) {
  if (!state?.projects) return null;
  const key = (path) => resolve(path).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const entry = Object.entries(state.projects).find(([path]) => key(path) === key(root))?.[1];
  return entry?.hasTrustDialogAccepted === true;
}

async function preflight(options) {
  const problems = [];
  // A broken config refuses even a dry run: the hooks skip this section, so this is where a typo shows.
  const loaded = loadRunConfig(ROOT);
  if (loaded.error) die(`Not ready to run: ${loaded.error}`);
  config = loaded.config;
  try {
    gotchasFile("phase-check"); // only the pattern is checked: the branch is settled further down
  } catch (error) {
    die(`Not ready to run: tools/doc-config.mjs GOTCHAS_FILE: ${error.message} The only placeholder is {phase}.`);
  }
  migrationTargetUrl = targetUrl(config, lookup);
  if (config.prompt) {
    const path = join(ROOT, config.prompt);
    if (!existsSync(path)) die(`Not ready to run: phaseRun.prompt names ${config.prompt}, which does not exist.`);
    projectProse = readFileSync(path, "utf8");
    try {
      proseSections(projectProse);
    } catch (error) {
      die(`Not ready to run: ${config.prompt}: ${error.message}`);
    }
  }
  if (config.gates.length === 0) {
    console.log("No project gates in .claude/workflow.json (phaseRun.gates): each ticket gets the runner's own checks only.");
  }

  const current = git("branch", "--show-current");
  let branch = options.branch;
  if (!branch && current.startsWith("phase-")) branch = current;
  if (!branch) problems.push("No phase branch named. Add --branch phase-<name> (for example --branch phase-6b).");
  else if (!/^phase-[a-z0-9][a-z0-9-]*$/.test(branch)) problems.push(`"${branch}" must look like phase-6b.`);
  else if (current !== branch && current !== "main") {
    problems.push(`You are on "${current}". Start a run from main, or from the phase branch itself.`);
  }

  const dirty = git("status", "--porcelain");
  if (dirty) problems.push(`The working tree has uncommitted changes:\n${dirty}`);

  // The tickets, the pushes and the pull request all live on GitHub.
  const remote = exec("git", ["remote", "get-url", "origin"]).ok;
  if (!remote) problems.push("This repo has no GitHub remote (`origin`): a run reads its tickets there and pushes to it. Push the repo to GitHub first.");
  if (!(await online())) problems.push(`No internet connection (could not reach ${NET_HOSTS.join(" and ")}).`);
  if (!exec("gh", ["auth", "status"]).ok) problems.push("GitHub CLI is not signed in (`gh auth login`).");
  if (!exec("claude", ["--version"]).ok) problems.push("`claude` is not on the PATH.");
  if (folderTrusted(readClaudeState(), ROOT) === false) problems.push(TRUST_HELP);
  else if (!options.print && listSessions() === null) {
    problems.push(
      "Claude Code would not list its background sessions (`claude agents --json` failed). Open `claude agents` once in a second terminal and start again; " +
        "if it still fails, update Claude Code (`claude update`), or add --print to run the sessions hidden.",
    );
  }

  for (const row of config.preflight) {
    const result = shell(fill(row.run, { qaUrl: qaUrl(config, lookup) }));
    if (!result.ok) problems.push(`${row.label} failed (\`${row.run}\`).${row.hint ? ` ${row.hint}` : ""}\n${tail(result.output, 600)}`);
  }

  for (const { port, what } of config.ports) {
    if (await listening(port)) problems.push(`Something is listening on :${port} (${what}). Stop it before a run.`);
  }

  // Trust on first use: the migration target's host is remembered, and a
  // later run refuses a different one. A run applies migrations to it.
  if (config.migrations) {
    const { name, urlFrom } = config.migrations.target;
    if (!migrationTargetUrl) problems.push(`${urlFrom} is not set (in the environment or .env): it is the migration target, ${name}.`);
    else {
      const id = targetFingerprint(migrationTargetUrl);
      const recorded = join(STATE, "migration-target");
      if (!existsSync(recorded)) {
        if (!options.dryRun) {
          mkdirSync(STATE, { recursive: true });
          writeFileSync(recorded, `${id}\n`);
        }
        console.log(`Recorded ${id} as ${name}. If ${urlFrom} points anywhere else, stop now and delete .phase-run/migration-target.`);
      } else if (readFileSync(recorded, "utf8").trim() !== id) {
        problems.push(
          `${urlFrom} is ${id}, but runs here have used ${readFileSync(recorded, "utf8").trim()} as ${name}. ` +
            "A run migrates that database, so it refuses a changed one. If the change is right, delete .phase-run/migration-target.",
        );
      }
    }
  }

  const lock = join(STATE, "lock");
  if (existsSync(lock)) {
    problems.push(`A run is already going (or one crashed): ${readFileSync(lock, "utf8").trim()}. If none is running, delete .phase-run/lock.`);
  }

  if (problems.length > 0) {
    // A dry run still lists the tickets, so the owner sees both at once.
    if (!options.dryRun) die(`Not ready to run:\n\n- ${problems.join("\n- ")}`);
    console.log(`\nA real run would refuse to start:\n\n- ${problems.join("\n- ")}`);
  }
  return { branch: branch ?? "(no branch named)", current, remote };
}

// ------------------------------------------------------------------ session

/** The phase's gotchas file: doc-config's GOTCHAS_FILE, or the flat default when the project's copy predates it. */
function gotchasFile(branch) {
  return fill(docConfig.GOTCHAS_FILE ?? "docs/agents/gotchas/{phase}.md", { phase: branch.replace(/^phase-/, "") });
}

function render(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key) => (key in values ? String(values[key]) : whole));
}

/** The sections of the project's prose (phaseRun.prompt) the prompts have room for, and their markers. */
const PROSE_SECTIONS = { Read: "PROJECT_READ", Build: "PROJECT_BUILD", "Browser check": "PROJECT_BROWSER_CHECK", Review: "PROJECT_REVIEW", Fix: "PROJECT_FIX" };

/** The project's prose, read once at preflight: its text, or "" when the project has none. */
let projectProse = "";

/**
 * The project's prose split at its `## ` headings, its header dropped. A
 * heading the prompts have no room for is refused, so a typo cannot drop a
 * section without a word.
 */
function proseSections(text) {
  const sections = {};
  let current = null;
  for (const line of text.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n/, "").split("\n")) {
    const heading = line.match(/^## (.+?)\s*$/);
    if (heading) {
      current = heading[1];
      if (!(current in PROSE_SECTIONS)) {
        throw new Error(`its "## ${current}" section has no place in the prompt; the sections are ${Object.keys(PROSE_SECTIONS).join(", ")}.`);
      }
      sections[current] = [];
    } else if (current) sections[current].push(line);
  }
  return Object.fromEntries(Object.entries(sections).map(([name, lines]) => [name, lines.join("\n").trim()]));
}

/**
 * What the prompts say about this project: its prose, spliced in, and the
 * lines built from its config. `ticket` is the ticket's own values ({{N}},
 * {{BASE}}, …), which the prose may use too: each section is rendered with
 * them before it is spliced, since the prompt is rendered only once. A
 * section the project leaves out gets a line saying so, so the numbered
 * sections stay in order.
 */
function promptValues(project, prose, ticket) {
  const { BASE: base, N } = ticket;
  const sections = proseSections(prose);
  const spliced = Object.fromEntries(Object.entries(PROSE_SECTIONS).map(([name, key]) => [key, render(sections[name] ?? "", ticket)]));
  const target = project.migrations?.target.name ?? null;
  const pinned = Object.keys(project.sessionEnv).map((name) => `\`${name}\``);
  const check = project.browserCheck;
  return {
    ...spliced,
    PROJECT_BROWSER_CHECK: spliced.PROJECT_BROWSER_CHECK || "This project names no browser check of its own: walk each acceptance criterion in a headless browser if the ticket changes a screen.",
    PROJECT_REVIEW: spliced.PROJECT_REVIEW || "This project names no design review: skip this section.",
    QA: project.qa ? `\`${project.qa.name}\`` : "local data",
    TARGET: target ?? "a shared database",
    STOP_CHECKS: project.stopChecks.length ? project.stopChecks.map((c) => `\`${c.run.replaceAll("{base}", base)}\``).join(", ") : "nothing, as this project names no stop checks",
    MIGRATIONS: target
      ? `never apply a migration to ${target} yourself; the runner applies it after your checks pass`
      : "this project's runner applies none, so never apply one to a shared database",
    SHELL_ENV: pinned.length
      ? `**Your shell points at local data, on purpose.** ${pinned.join(", ")} ${pinned.length === 1 ? "is" : "are"} already set for this run, and \`--env-file=.env\` or a script's own \`.env\` loader changes none of them. Work on ${project.qa ? `\`${project.qa.name}\`` : "local data"}; never point anything at ${target ?? "a shared database"}, and never open or print \`.env\`.`
      : "**Never open or print `.env`**: it can hold live credentials.",
    BROWSER_GATE: check
      ? `The runner checks this itself: a ticket labelled \`frontend\`, or one that changes a screen's file, does not pass without at least ${check.minimum} screenshots saved to \`${fill(check.screenshots, { N })}/\` **after your last edit to a source file**. A fix you make after the walk (the code review's, a fix round's) means walking again.`
      : "The runner has no screenshot gate for this project; say in the implementation log what you checked.",
  };
}

// "You've hit your session limit · resets 3:30pm" is the wording past transcripts on this machine hold.
const LIMIT_PATTERN = /usage limit|rate.?limit|limit reached|hit your (\w+ )?limit|out of (extra )?usage|resets? (at|in)\b|overloaded/i;

/** A hidden `claude -p` session (`--print`): nothing to watch, one summary at the end. */
function runPrint({ prompt, sessionId, resume, options, env, settings, transcript }) {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    options.permissionMode,
    "--permission-prompts",
    "none",
    "--settings",
    settings,
    ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]),
    ...(options.model ? ["--model", options.model] : []),
  ];
  return new Promise((done) => {
    const child = spawn("claude", args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.minutes * 60_000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ timedOut, json: null, raw: String(error) });
    });
    child.on("close", () => {
      clearTimeout(timer);
      writeFileSync(transcript, stdout || stderr);
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = null;
      }
      done({ timedOut, json, raw: stdout || stderr });
    });
    // The prompt goes in on stdin: a long, quoted prompt as an argument does not survive Windows.
    child.stdin.end(prompt);
  });
}

// ------------------------------------------------------ a background session
//
// The default: each ticket is a Claude Code background session (`claude
// --bg`), which the owner can list with `claude agents` and open with `claude
// attach <id>` while it works. Five things were learned by probing it
// (2026-10-08), and each is a trap:
//
//  1. A background session takes NOTHING from the shell that starts it. It
//     runs under a background service that keeps the environment of whoever
//     started the service first. So the run's variables (PHASE_RUN*, the
//     pinned database and token) travel in the `env` block of a settings file
//     written per ticket, which the hooks and the session's commands both see.
//  2. `--permission-prompts none` is for `-p` only. Its stand-in is the
//     permission mode `dontAsk`: whatever would ask is refused at once, so
//     nothing waits for a person. Under it an edit needs an allow rule too.
//  3. A background session will not edit the shared checkout unless the
//     settings say `worktree.bgIsolation: "none"`. A run builds on the phase
//     branch in this folder, so they do.
//  4. `--session-id` is ignored: the id comes back from the launch. A long
//     prompt does not survive as an argument, so it goes in a file and the
//     argument is one line pointing at it.
//  5. A second instruction to the same session is `claude stop <id>`, then
//     `claude --bg --resume <full session id> "<prompt>"` with NO other flag.
//     Resuming while it still runs, or with any flag, quietly starts a copy.
//
// A sixth was learned on 6B's first night (2026-10-10), from #145 and #147:
//
//  6. A session whose Stop hook is running is not always listed as working,
//     and the hook's checks can take ten minutes (the changed tests of a
//     widely imported file). `claude stop` then ends the session and leaves
//     the hook's test run going. So the stop check says it is running with a
//     marker file (.claude/hooks/stop-gate.mjs), the wait below reads that
//     instead of the listing, and a stopped session's test runs are stopped
//     by this script: two suites on one test database fail each other.
//
// A seventh was learned on 6D's night (2026-10-17), from #181:
//
//  7. A session can be listed as working after its turn is over. #181's
//     ended at 04:28 with its commit and its verdict written, yet the runner
//     waited until the cap at 05:16 and parked a finished ticket. Most likely
//     the cause was two background wait loops it had left running (each
//     polling a reviewer's output file that stayed empty); what the listing
//     reports for a session with live background tasks was not confirmed. So
//     the listing is not the only word on "over": a turn the transcript
//     says has ended, with a verdict written since the turn started, is
//     over once it stays that way for SETTLE_MS, working or not, and
//     `claude stop` then ends whatever it left running. The verdict is what
//     tells this apart from a session that ends a turn to wait for a
//     subagent, which a notification wakes again in under a second.

const POLL_MS = 10_000;
const BEAT_MS = 5 * 60_000;
// Not working, no stop check running, yet no end of turn written: how long before that is taken as the end.
const QUIET_MS = 3 * 60_000;
// The Stop hook's own time limit (`"timeout": 1800` in .claude/settings.json). A marker older than that is a dead check's.
const STOP_CHECK_MAX_MS = 30 * 60_000;
// Point 7: how long a turn must stay ended, its verdict written, before a session still listed as working is taken as done.
const SETTLE_MS = 2 * 60_000;

/** Whether the ticket's verdict file was written at or after `since` (ms): this turn's, not an earlier round's. */
function verdictWrittenSince(number, since) {
  try {
    return statSync(join(STATE, `verdict-${number}.json`)).mtimeMs >= since;
  } catch {
    return false;
  }
}

/**
 * Whether one turn of a background session is over, and why; null to keep
 * waiting. Pure, so the night's cases can be tested (run.test.mjs).
 *  - `listed`: the session is in `claude agents`, not stopped.
 *  - `working`: the listing says it is working.
 *  - `ended`: the transcript's last turn has ended (readTurn).
 *  - `endedFor`: how long it has stayed ended, or null.
 *  - `verdictFresh`: the verdict was written during this turn.
 *  - `quietFor`: how long it has been idle with no end written, or null.
 *  - `stopCheck`: the session's stop check is running (point 6).
 */
function turnOver({ listed, working, ended, endedFor, verdictFresh, quietFor, stopCheck }) {
  if (!listed) return "stopped";
  if (!working) {
    if (ended) return "ended";
    if (stopCheck) return null;
    return quietFor !== null && quietFor > QUIET_MS ? "quiet" : null;
  }
  // Point 7: listed as working, but the turn is over and the verdict says so.
  if (ended && verdictFresh && endedFor !== null && endedFor >= SETTLE_MS) return "ended, still listed as working";
  return null;
}

/** The id that `claude agents`, `attach` and `stop` take. */
let liveBackground = null;

/** Sessions as Claude Code lists them, or null when the listing failed (taken as "ask again"). */
function listSessions() {
  const result = exec("claude", ["agents", "--json", "--all"]);
  if (!result.ok) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function stopBackground(id) {
  exec("claude", ["stop", id]);
  if (liveBackground === id) liveBackground = null;
}

function stopCheckMarker(number) {
  return join(STATE, `stop-check-${number}.json`);
}

/** True while the ticket's stop check is running: its marker names a live process (point 6). */
function stopCheckRunning(number) {
  try {
    const { pid, startedAt } = JSON.parse(readFileSync(stopCheckMarker(number), "utf8"));
    if (Date.now() - startedAt > STOP_CHECK_MAX_MS) return false;
    process.kill(pid, 0); // signal 0 sends nothing; it throws when there is no such process
    return true;
  } catch (error) {
    return error.code === "EPERM"; // it is there, and not ours to signal
  }
}

/**
 * A test run must not outlive the session that started it: a suite that
 * resets one shared test database fails when a second run is on it too
 * (duplicate ids, a deadlock on TRUNCATE). Stops every node process from this
 * checkout's node_modules whose command line matches the config's
 * `strayProcess`, and returns how many there were.
 */
function stopStray(when) {
  const pattern = config?.strayProcess;
  if (!pattern) return 0;
  let pids = [];
  if (WINDOWS) {
    const modules = `${ROOT}\\node_modules\\`.toLowerCase().replace(/'/g, "''");
    const match = pattern.source.replace(/'/g, "''");
    const found = exec("powershell", [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Replace('/', '\\').ToLower().Contains('${modules}') -and $_.CommandLine -match '${match}' } | ForEach-Object { $_.ProcessId }`,
    ]);
    pids = found.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    for (const pid of pids) exec("taskkill", ["/pid", pid, "/T", "/F"]);
  } else {
    const found = exec("ps", ["-eo", "pid=,args="]);
    pids = found.stdout
      .split("\n")
      .filter((line) => line.includes(`${ROOT}/node_modules/`) && pattern.test(line))
      .map((line) => line.trim().split(/\s+/)[0]);
    for (const pid of pids) exec("kill", ["-9", pid]);
  }
  if (pids.length > 0) log(`Stopped a ${pattern.source} process left going ${when}.`);
  return pids.length;
}

/**
 * The settings one ticket's session runs under: the run's own allowlist
 * (settings.json, the rules every project needs), the project's rows
 * (phaseRun.permissions), and the run's variables. A background session also
 * gets what points 1 to 3 above call for. The denials keep a session's hands
 * off the things that check it (the runner, the project's config and the
 * prose its prompt is built from), and off the three tools that would wait
 * for a person or move the work somewhere else.
 */
function sessionSettings(base, project, { branch, env, background, prompt }) {
  const allow = [...(base.permissions?.allow ?? []), ...project.allow];
  return {
    ...base,
    permissions: {
      ...base.permissions,
      allow: background ? [...allow, "Edit", "Write"] : allow,
      deny: [
        ...(base.permissions?.deny ?? []),
        ...project.deny,
        "Edit(./tools/phase-run/**)",
        "Edit(./.claude/workflow.json)",
        "Edit(./.claude/spec-issues.json)",
        ...(prompt ? [`Edit(./${prompt})`] : []),
        `Edit(./.phase-run/${branch}/**)`,
        "AskUserQuestion",
        "EnterPlanMode",
        "EnterWorktree",
      ],
    },
    env: { ...(base.env ?? {}), ...env },
    ...(background ? { worktree: { ...(base.worktree ?? {}), bgIsolation: "none" } } : {}),
  };
}

function writeSessionSettings(run, number, env, { background = true } = {}) {
  const base = JSON.parse(readFileSync(join(HERE, "settings.json"), "utf8"));
  const settings = sessionSettings(base, config.permissions, { branch: run.branch, env, background, prompt: config.prompt });
  const path = join(run.dir, `settings-${number}.json`);
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return path;
}

/** Where Claude Code keeps a session's transcript: one `.jsonl` per session, under a folder per project. */
function transcriptPath(sessionId) {
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  if (!existsSync(projects)) return null;
  for (const folder of readdirSync(projects)) {
    const path = join(projects, folder, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}

function transcriptLines(sessionId) {
  const path = transcriptPath(sessionId);
  return path ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

/**
 * What one turn did, read from the transcript after line `fromLine`. A
 * background session hands back no summary of its own (no cost, no error
 * flag), so this is where the runner's facts come from.
 *
 * Two shapes it relies on, both read off real transcripts (2026-10-08):
 *  - a turn ends with one `system/turn_duration` row. When the stop check
 *    sends the session back, no such row is written until the turn really ends.
 *  - a usage limit or a lost connection is an assistant row with
 *    `isApiErrorMessage`, an `error` of `rate_limit` (with `apiErrorStatus:
 *    429`) or `server_error`, and the turn ends right after it.
 */
function readTurn(sessionId, fromLine) {
  const turn = { ended: false, steps: 0, lastStep: "", lastText: "", apiError: false, apiStatus: null, denials: [], outputTokens: 0, peakContext: 0 };
  const used = new Map(); // tool call id -> what it was
  const counted = new Set(); // one response is written as several lines
  for (const line of transcriptLines(sessionId).slice(fromLine)) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // a line still being written
    }
    if (row.isSidechain) continue;
    if (row.type === "system" && row.subtype === "turn_duration") turn.ended = true;
    const content = row.message?.content;
    if (row.type === "user" && typeof content === "string") turn.ended = false; // a new prompt opened a turn
    if (!Array.isArray(content)) continue;
    if (row.type === "assistant") {
      const usage = row.message.usage;
      const key = row.message.id ?? row.uuid;
      if (usage && !counted.has(key)) {
        counted.add(key);
        turn.outputTokens += usage.output_tokens ?? 0;
        const context = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
        // A response that called the advisor adds the advisor's read to its own count; leave those out.
        if (!(usage.iterations ?? []).some((it) => it.type === "advisor_message")) turn.peakContext = Math.max(turn.peakContext, context);
      }
      for (const block of content) {
        if (block.type === "text" && block.text.trim()) {
          turn.lastText = block.text;
          turn.apiError = row.isApiErrorMessage === true;
          turn.apiStatus = turn.apiError ? (row.apiErrorStatus ?? (row.error === "rate_limit" ? 429 : null)) : null;
        }
        if (block.type !== "tool_use") continue;
        const input = block.input ?? {};
        const what = String(input.command ?? input.file_path ?? input.pattern ?? input.skill ?? input.description ?? "").replace(/\s+/g, " ");
        used.set(block.id, `${block.name} ${what}`.trim());
        turn.steps += 1;
        turn.lastStep = `${block.name} ${what.replace(ROOT, "").replace(/^[\\/]/, "")}`.slice(0, 90);
        turn.apiError = false;
        turn.apiStatus = null;
      }
    }
    if (row.type === "user") {
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
        if (/Permission to use \w+ has been denied|denied by your permission settings/.test(text)) {
          turn.denials.push(used.get(block.tool_use_id) ?? "?");
        }
      }
    }
  }
  return turn;
}

/**
 * One turn of a background session: start it (or wake it), wait until the
 * turn is over or the time cap passes, stop it, and hand back the same shape
 * `runPrint` does. It is stopped after every turn: point 5 needs that before
 * a fix round, and a stopped session can still be opened and read.
 */
async function runBackground({ prompt, sessionId, resume, options, settings, name, transcript, number }) {
  const promptFile = transcript.replace(/\.json$/, ".prompt.md");
  writeFileSync(promptFile, prompt);
  const ask = `Read the file ${relative(ROOT, promptFile).replace(/\\/g, "/")} and follow it exactly. It is your whole task for this turn.`;

  let id = null;
  let fromLine = 0;
  if (resume) {
    id = sessionId.slice(0, 8);
    stopBackground(id);
    fromLine = transcriptLines(sessionId).length;
    const woke = exec("claude", ["--bg", "--resume", sessionId, ask]);
    const said = `${woke.stdout}\n${woke.stderr}`;
    const copy = said.match(/started a copy(?: of that conversation)? as ([0-9a-f]{8})/);
    if (copy) stopBackground(copy[1]);
    if (!woke.ok || copy || !said.includes(id)) {
      // Returned, not thrown. A throw would stop the run with this ticket's
      // commit left on the branch, and the next run would read that commit as
      // "built" without its checks ever passing. A failed call fails the gates
      // instead, and the ticket is set aside by the code that already does that.
      const message = `Could not send #${number}'s next instruction to its session ${id}: ${tail(said, 600)}`;
      log(message);
      return { timedOut: false, json: null, raw: message };
    }
  } else {
    const args = ["--bg", "--name", name, "--permission-mode", "dontAsk", "--settings", settings, ...(options.model ? ["--model", options.model] : []), ask];
    const started = exec("claude", args);
    const said = `${started.stdout}\n${started.stderr}`;
    id = said.match(/backgrounded · ([0-9a-f]{8})/)?.[1] ?? null;
    if (!started.ok || !id) return { timedOut: false, json: null, raw: said };
    for (let tries = 0; tries < 10 && !sessionId?.startsWith(id); tries += 1) {
      sessionId = (listSessions() ?? []).find((session) => session.id === id)?.sessionId ?? sessionId;
      if (!sessionId?.startsWith(id)) await sleep(2000);
    }
    if (!sessionId?.startsWith(id)) {
      stopBackground(id);
      const message = `#${number}'s background session ${id} started but never appeared in \`claude agents --json\`.`;
      log(message);
      return { timedOut: false, json: null, raw: message };
    }
  }
  liveBackground = id;
  log(`#${number}: session ${id} is working. Watch it: claude attach ${id}   (or: claude agents)`);

  const startedAt = Date.now();
  const deadline = startedAt + options.minutes * 60_000;
  let timedOut = false;
  let lastBeat = startedAt;
  let quietSince = null;
  let endedSince = null;
  for (;;) {
    await sleep(POLL_MS);
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
    const sessions = listSessions();
    if (sessions === null) continue;
    const session = sessions.find((entry) => entry.id === id);
    const listed = Boolean(session) && session.state !== "stopped";
    const working = session?.status === "busy" || session?.state === "working";
    // "blocked" and "done" are both an idle session; the transcript says whether the turn is over.
    // While working, the transcript is read only once the verdict is fresh (point 7): it is large.
    const verdictFresh = verdictWrittenSince(number, startedAt);
    const ended = listed && (!working || verdictFresh) ? readTurn(sessionId, fromLine).ended : false;
    endedSince = ended ? (endedSince ?? Date.now()) : null;
    // The stop check is the session's work too, and outlasts QUIET_MS several times over (point 6).
    const stopCheck = listed && !working && !ended && stopCheckRunning(number);
    if (listed && !working && !ended && !stopCheck) quietSince ??= Date.now();
    else quietSince = null;
    const over = turnOver({
      listed,
      working,
      ended,
      endedFor: endedSince === null ? null : Date.now() - endedSince,
      verdictFresh,
      quietFor: quietSince === null ? null : Date.now() - quietSince,
      stopCheck,
    });
    if (over) {
      if (over === "ended, still listed as working") log(`#${number}: the turn is over and its verdict written, but the session is still listed as working; stopping what it left running.`);
      break;
    }
    if (Date.now() - lastBeat >= BEAT_MS) {
      lastBeat = Date.now();
      const sofar = readTurn(sessionId, fromLine);
      log(`#${number}: ${Math.round((lastBeat - startedAt) / 60_000)} min in, ${sofar.steps} steps. Last: ${sofar.lastStep || "(nothing yet)"}`);
    }
  }
  stopBackground(id);
  // Stopped at the time cap, or by hand, a session can leave its stop check's tests (or its own) running.
  stopStray(`by #${number}'s session`);
  rmSync(stopCheckMarker(number), { force: true });

  const turn = readTurn(sessionId, fromLine);
  const json = {
    session_id: sessionId,
    is_error: turn.apiError,
    result: turn.lastText,
    total_cost_usd: null, // a background session reports none; the tokens below stand in for it
    num_turns: turn.steps,
    duration_ms: Date.now() - startedAt,
    permission_denials: turn.denials.map((command) => ({ tool_input: { command } })),
    api_error_status: turn.apiStatus,
    output_tokens: turn.outputTokens,
    peak_context_tokens: turn.peakContext,
    background_id: id,
    transcript: transcriptPath(sessionId),
  };
  writeFileSync(transcript, `${JSON.stringify(json, null, 2)}\n`);
  return { timedOut, json, raw: turn.lastText };
}

function runClaude(call) {
  return call.options.print ? runPrint(call) : runBackground(call);
}

// "API Error: Connection lost mid-response" ended a turn on 6B's nights (#146, #149, #152). By the
// time the runner looked, the connection was back, so the cut was read as a finished turn: the
// gates ran on an unfinished ticket, said "No commit was made", and spent a fix round.
const CUT_PATTERN = /api error|connection (lost|error|reset|closed|refused)|server[_ ]error|ECONNRESET|socket hang up|fetch failed|stream (ended|closed)/i;
// An API error that will fail the same way again is not a cut: a prompt too long, a rejected
// request, a sign-in or billing problem. Those go to the gates at once (#194's review).
const PERMANENT_PATTERN = /\b4\d\d\b|too long|invalid[_ ]request|authenticat|unauthori[sz]ed|permission|forbidden|credit|billing/i;

/** Whether a turn ended because the API dropped it mid-response, as opposed to finishing or failing for good. */
function cutOff(result) {
  const text = String(result.json ? (result.json.result ?? "") : result.raw ?? "");
  const status = Number(result.json?.api_error_status);
  if (result.json && !result.json.is_error) return false;
  if (status >= 500) return true;
  return CUT_PATTERN.test(text) && !PERMANENT_PATTERN.test(text);
}
// A connection that keeps dropping is handed to the gates after this many resumes, as before.
const MAX_CUT_RESUMES = 3;

/**
 * One session call. A usage limit, a lost connection, or a turn the API cut
 * off mid-response is waited out and the same session resumed, so none is
 * mistaken for a ticket that failed, and none costs a fix round. The result
 * carries the session id in use: a background session is given its id by
 * Claude Code, and a `-p` one changes id only when it was cut off before it
 * ever started.
 *
 * `call.claude`, `call.online` and `call.sleep` stand in for the real session,
 * the connection check and the wait in tests (run.test.mjs).
 */
async function runSession(call) {
  const claude = call.claude ?? runClaude;
  const isOnline = call.online ?? online;
  const wait = call.sleep ?? sleep;
  const deadline = waitDeadline(call.options);
  let attempt = { ...call };
  let cutOffs = 0;
  for (;;) {
    const result = await claude(attempt);
    const sessionId = result.json?.session_id ?? attempt.sessionId;
    const done = (extra = {}) => ({ ...result, sessionId, cutOffs, ...extra });
    if (result.timedOut) return done();
    // An untrusted folder refuses every session: stop the run, not this ticket's fix rounds.
    if (UNTRUSTED.test(`${result.raw ?? ""} ${result.json?.result ?? ""}`)) return done({ gaveUp: TRUST_HELP });

    const limited =
      (result.json?.is_error && LIMIT_PATTERN.test(String(result.json.result ?? ""))) ||
      result.json?.api_error_status === 429 ||
      (!result.json && LIMIT_PATTERN.test(result.raw));
    const failed = !result.json || Boolean(result.json.is_error);
    const cut = !limited && cutOff(result) && cutOffs < MAX_CUT_RESUMES;
    const offline = failed && !limited && !cut && !(await isOnline());
    if (!limited && !offline && !cut) return done();

    if (cut) {
      cutOffs += 1;
      log(`The session's turn was cut off (${String(result.json?.result ?? result.raw ?? "").slice(0, 80)}). Resuming it (${cutOffs} of ${MAX_CUT_RESUMES}); this is not a fix round.`);
      if (!(await isOnline()) && !(await waitForInternet(deadline, "(the session was cut off)"))) {
        return done({ gaveUp: `The internet connection did not come back within ${call.options.waitHours} hours.` });
      }
      await wait(30_000);
    } else if (offline) {
      if (!(await waitForInternet(deadline, "(the session was cut off)"))) {
        return done({ gaveUp: `The internet connection did not come back within ${call.options.waitHours} hours.` });
      }
    } else {
      if (Date.now() > deadline) {
        return done({ gaveUp: `The usage limit did not lift within ${call.options.waitHours} hours.` });
      }
      log("Usage limit reached. Waiting 20 minutes, then resuming the same session.");
      await wait(20 * 60_000);
    }

    const started = attempt.resume || Boolean(result.json?.session_id);
    if (started) {
      const carryOn = "You were cut off (a usage limit, a lost internet connection, or the API dropping your turn mid-response). Continue the ticket from where you stopped, following the same instructions.";
      attempt = {
        ...call,
        sessionId,
        resume: true,
        // A fix round's instruction may never have reached the session, so it is repeated.
        prompt: call.resume ? `${carryOn}\n\nIn case it did not reach you, the last instruction was:\n\n${call.prompt}` : carryOn,
      };
    } else {
      attempt = { ...call, sessionId: randomUUID(), resume: false };
    }
  }
}

// -------------------------------------------------------------------- gates

const TRAILER = /co-authored-by:|claude-session:|generated with \[?claude|🤖 generated/i;

function specNumbers(options) {
  const numbers = new Set();
  const path = join(ROOT, ".claude", "spec-issues.json");
  if (existsSync(path)) for (const n of JSON.parse(readFileSync(path, "utf8")).specs ?? []) numbers.add(String(n));
  if (options.spec) numbers.add(String(options.spec));
  return numbers;
}

/** Each migration's file, by name, as newMigrations found it: what `destructive` reads, and what a park checks is gone. */
const migrationFiles = new Map();

/** The migrations the ticket added since `base` (phaseRun.migrations.added), by name. */
function newMigrations(base) {
  if (!config.migrations) return [];
  const added = git("diff", "--name-only", "--diff-filter=A", `${base}..HEAD`);
  const names = new Set();
  for (const file of added.split("\n").filter(Boolean)) {
    const match = file.match(config.migrations.added);
    if (!match) continue;
    names.add(match[1]);
    migrationFiles.set(match[1], file);
  }
  return [...names].sort();
}

/**
 * Applies `names` to the migration target and records in `applied` each one
 * that went in. The shell is a parameter, so a test can stand in for it.
 */
function applyMigrations(names, applied, { migrations, values, run = shell }) {
  const { apply, rollBack } = migrations;
  const result = run(fill(apply.run, values), fillEnv(apply.env, values));
  if (result.ok) {
    for (const name of names) applied.add(name);
    return { ok: true };
  }
  if (!rollBack) return { ok: false, output: result.output };
  // `rollBack` promises an `apply` that names each migration as it starts it
  // (config.mjs), so every one named before the last did apply; the last is
  // the one that failed.
  const started = names.filter((name) => result.output.includes(name));
  for (const name of started.slice(0, -1)) applied.add(name);
  // A failed row would make every later ticket's apply refuse, for a reason
  // that is not theirs.
  for (const name of names) {
    if (!applied.has(name)) run(fill(rollBack.run, { ...values, name }), fillEnv(rollBack.env, { ...values, name }));
  }
  return { ok: false, output: result.output };
}

/** What the report calls the migration target. */
function targetName() {
  return config?.migrations?.target.name ?? "the migration target";
}

const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;

/**
 * The browser check's screenshots in `rel` (a folder under `root`). One counts
 * only when it was saved after the ticket started AND after the last edit to
 * any source file the ticket changed (`sourceFiles`). Once, a session walked
 * the screens, then fixed what the code review found and amended, and the
 * screenshots from before the fixes passed the gate. Docs edits do not count.
 */
function screenshotsSince(root, rel, startedAt, changed, sourceFiles) {
  const dir = join(root, rel);
  const lastEdit = changed
    .filter((file) => sourceFiles.test(file))
    .map((file) => join(root, file))
    .filter((path) => existsSync(path))
    .reduce((newest, path) => Math.max(newest, statSync(path).mtimeMs), 0);
  const since = Math.max(startedAt, lastEdit);
  if (!existsSync(dir)) return { fresh: [], stale: 0, since };
  const shots = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((file) => IMAGE_FILE.test(file));
  const fresh = shots.filter((file) => statSync(join(dir, file)).mtimeMs >= since);
  return { fresh, stale: shots.length - fresh.length, since };
}

/**
 * The browser check's gate (phaseRun.browserCheck), or null when it passes.
 * The check is the session's own work, so its word is not enough: the
 * screenshots it was told to save must be there, and be from this build.
 */
function browserCheckProblem(ticket, changed, startedAt) {
  const check = config.browserCheck;
  if (!ticket.labels.includes("frontend") && !changed.some((file) => check.screenFiles.test(file))) return null;
  const dir = fill(check.screenshots, { N: ticket.number });
  const shots = screenshotsSince(ROOT, dir, startedAt, changed, check.sourceFiles);
  if (shots.fresh.length >= check.minimum) return null;
  return (
    `This ticket changes what a screen shows, and ${dir}/ holds ${shots.fresh.length} screenshot(s) saved after your last edit to a source file` +
    `${shots.stale ? ` (${shots.stale} older one(s) do not count: a source file changed after them, so they show code that is no longer there)` : ""}; ` +
    `the browser check saves at least ${check.minimum}. Do the browser check in section 5 of your first instructions again, on the code as it is now: ` +
    `${check.redo}, into ${dir}/, then stop the server. Fix what it finds and amend the commit. The screenshots themselves are not committed.`
  );
}

/**
 * The project's gates (phaseRun.gates), in order: the first failure as
 * `{ gate, output }`, or null. A gate whose `when` matches no changed file is
 * skipped. The shell and the side jobs are parameters, so a test can stand in
 * for them.
 */
async function projectGates(gates, { changed, values, browserCheck, run = shell, freePorts = freeTicketPorts, stopStray: stop = () => 0 }) {
  for (const gate of gates) {
    if (gate.builtin === BROWSER_CHECK) {
      const problem = browserCheck();
      if (problem) return { gate: "browser check", output: problem };
      continue;
    }
    if (gate.when && !changed.some((file) => gate.when.test(file))) continue;
    if (gate.freePorts) await freePorts();
    if (gate.alone) stop(`before the ${gate.label} gate`);
    const result = run(fill(gate.run, values), fillEnv(gate.env, values));
    if (!result.ok) return { gate: gate.label, output: result.output };
  }
  return null;
}

/** Each gate is checked by this script. The first failure is returned. */
async function runGates(ticket, base, options, run, startedAt) {
  const n = ticket.number;
  const fail = (gate, output) => ({ ok: false, gate, output });

  const commits = git("rev-list", `${base}..HEAD`).split("\n").filter(Boolean);
  if (commits.length === 0) {
    return fail("commit", `No commit was made for #${n}. Finish the ticket and commit it once, with "Closes #${n}" in the message.`);
  }
  if (commits.length > 1) {
    return fail(
      "commit",
      `#${n} has ${commits.length} commits; a ticket is exactly one. Fold them: \`git reset --soft ${base.slice(0, 9)}\`, then commit once.`,
    );
  }
  const message = git("log", "-1", "--format=%B");
  if (!new RegExp(`\\bcloses #${n}\\b`, "i").test(message)) {
    return fail("commit", `The commit message has no "Closes #${n}". Amend it.`);
  }
  if (TRAILER.test(message)) return fail("commit", "The commit message carries an attribution trailer. Amend it out.");
  for (const match of message.matchAll(/\b(clos(?:e|es|ed)|fix(?:es|ed)?|resolv(?:e|es|ed))\s*:?\s+#(\d+)/gi)) {
    if (specNumbers(options).has(match[2])) {
      return fail("commit", `"${match[0]}" would close spec issue #${match[2]}, which the owner closes by hand. Amend it out.`);
    }
  }
  const dirty = git("status", "--porcelain");
  if (dirty) return fail("clean tree", `Files were left uncommitted. Amend them into the ticket's commit, or delete them:\n${dirty}`);

  const added = git("diff", "--name-only", "--diff-filter=A", `${base}..HEAD`);
  if (!/^docs\/history\/implementation-log\/\d{3}-.+\.md$/m.test(added)) {
    return fail("docs", "The commit adds no docs/history/implementation-log/NNN-*.md entry. Every ticket gets one, in full.");
  }

  const changed = git("diff", "--name-only", `${base}..HEAD`).split("\n").filter(Boolean);
  const failed = await projectGates(config.gates, {
    changed,
    values: { base, N: n, qaUrl: qaUrl(config, lookup) },
    browserCheck: () => browserCheckProblem(ticket, changed, startedAt),
    stopStray: (when) => stopStray(`${when} for #${n}`),
  });
  if (failed) return fail(failed.gate, failed.output);

  const docs = exec("node", ["tools/doc-check.mjs", "--head"]);
  if (!docs.ok) return fail("doc-check", `${docs.stdout}\n${docs.stderr}`);

  // Last on purpose: nothing reaches the migration target until everything else is green.
  const migrations = newMigrations(base).filter((name) => !run.migrationsApplied.has(name));
  if (migrations.length > 0) {
    const target = targetName();
    log(`#${n}: applying ${migrations.join(", ")} to ${target}.`);
    const applied = applyMigrations(migrations, run.migrationsApplied, {
      migrations: config.migrations,
      values: { targetUrl: migrationTargetUrl, base },
    });
    if (!applied.ok) {
      const done = newMigrations(base).filter((name) => run.migrationsApplied.has(name));
      return fail(
        `migration on ${target}`,
        `${applied.output}\n\n` +
          (config.migrations.rollBack ? `The failed migration was marked rolled back on ${target}, so a corrected one can apply. ` : "") +
          `${target} may still hold part of its changes: make the corrected migration safe to run against that.` +
          (done.length ? `\nAlready applied to ${target}, never edit: ${done.join(", ")}. Add a new migration after them instead.` : ""),
      );
    }
  }
  return { ok: true };
}

// ------------------------------------------------------- finishing a ticket

function readVerdict(number) {
  const path = join(STATE, `verdict-${number}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Path prefixes or simple globs from the ticket's "## Areas" list. */
function ticketAreas(body) {
  const section = (body ?? "").replace(/\r\n/g, "\n").match(/^##\s+Areas\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  if (!section) return null;
  const areas = [...section[1].matchAll(/^\s*[-*]\s+`?([^`\n]+?)`?\s*$/gm)].map((m) => m[1].trim());
  return areas.length ? areas : null;
}

/**
 * Never "outside the ticket's areas": the workflow's own files. A project adds
 * its shared registries (the ones nearly every ticket touches, which would
 * otherwise teach the owner to ignore the ⚠ line) as phaseRun.alwaysInScope.
 */
const ALWAYS_IN_SCOPE = [/^docs\//, /^CLAUDE\.md$/, /^GLOSSARY\.md$/];

function outsideAreas(files, areas, alwaysInScope = []) {
  if (!areas) return [];
  const inScope = [...ALWAYS_IN_SCOPE, ...alwaysInScope];
  const patterns = areas.map((area) => {
    const escaped = area.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
    return new RegExp(`^${escaped}`);
  });
  return files.filter((file) => !inScope.some((p) => p.test(file)) && !patterns.some((p) => p.test(file)));
}

/** The migrations whose text matches the config's `destructive` pattern: they drop or rewrite data. */
function destructive(names) {
  const pattern = config.migrations?.destructive;
  if (!pattern) return [];
  return names.filter((name) => {
    const file = migrationFiles.get(name);
    return file && existsSync(join(ROOT, file)) && pattern.test(readFileSync(join(ROOT, file), "utf8"));
  });
}


// ------------------------------------------------- results that outlive a run
//
// Every ticket's result is written to .phase-run/<branch>/results.json the
// moment it is known, and the night's report file is rewritten after each one.
// Before this (#194), both lived in memory until a clean end: 6C's first night
// died at 05:20 mid-#168, and #166's and #167's report, with their assumptions
// to confirm, was never written. Each night's pull request body also listed
// only that night's tickets. Now the body lists every ticket built on the
// branch, and a night that died is carried into the next night's report.

function loadResults(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function resultsFile(run) {
  return join(run.dir, "results.json");
}

function saveResults(run) {
  writeFileSync(resultsFile(run), `${JSON.stringify(run.all, null, 2)}\n`);
}

/** Records one ticket's result: in this run's list, and on disk at once. */
function recordResult(run, result) {
  const stamped = { ...result, runId: run.runId, reported: false };
  run.results.push(stamped);
  run.all.push(stamped);
  saveResults(run);
  return stamped;
}

/** The pull request's body: every ticket built on the branch, whichever night built it. */
function pullRequestBody(all, options) {
  const latest = new Map();
  for (const result of all) if (result.status === "built") latest.set(result.number, result);
  return [
    `The phase run's branch for ${options.spec ? `spec #${options.spec}` : `ticket #${options.only}`}. One commit per ticket.`,
    "",
    "**Merge with a merge commit, never squash or rebase**: a devlog entry reads as closed once a commit message cites it, and a squash would drop those messages.",
    "",
    "Built on this branch:",
    ...[...latest.values()].map((r) => `- #${r.number} ${r.title} (\`${r.hash}\`)`),
    "",
  ].join("\n");
}

function ensurePullRequest(run, options) {
  const bodyFile = join(run.dir, "pr-body.md");
  // Only commits still on the branch: results.json outlives a branch deleted or rebuilt by hand.
  const onBranch = run.all.filter((r) => r.status !== "built" || gitTry("merge-base", "--is-ancestor", r.hash, "HEAD").ok);
  writeFileSync(bodyFile, pullRequestBody(onBranch, options));
  const existing = exec("gh", ["pr", "view", run.branch, "--json", "number,url", "-q", ".url"]);
  if (existing.ok && existing.stdout) {
    exec("gh", ["pr", "edit", run.branch, "--body-file", bodyFile]);
    return existing.stdout;
  }
  const title = options.spec ? `Phase run: ${run.branch} (spec #${options.spec})` : `Phase run: ${run.branch} (#${options.only})`;
  return gh("pr", "create", "--draft", "--base", "main", "--head", run.branch, "--title", title, "--body-file", bodyFile);
}

/** The ticket's screenshot folder, for the report, when the project has a browser check and the folder exists. */
function screenshotFolder(number) {
  if (!config.browserCheck) return null;
  const dir = fill(config.browserCheck.screenshots, { N: number });
  return existsSync(join(ROOT, dir)) ? `${dir}/` : null;
}

async function finishBuilt(ticket, base, options, run, session) {
  const hash = git("rev-parse", "--short", "HEAD");
  const stat = git("diff", "--shortstat", `${base}..HEAD`);
  const files = git("diff", "--name-only", `${base}..HEAD`).split("\n").filter(Boolean);
  const migrations = newMigrations(base);
  const verdict = readVerdict(ticket.number) ?? {};

  await waitForInternet(waitDeadline(options), `before pushing #${ticket.number}`); // a failed push is noted below
  const push = gitTry("push", "-u", "origin", run.branch);

  const result = {
    number: ticket.number,
    title: ticket.title,
    status: "built",
    hash,
    stat,
    outside: outsideAreas(files, ticketAreas(ticket.body), config.alwaysInScope),
    migrations,
    destructive: destructive(migrations),
    assumptions: verdict.assumptions ?? [],
    runByHand: verdict.runByHand ?? [],
    foundElsewhere: verdict.foundElsewhere ?? [],
    handedForward: verdict.handedForward ?? [],
    summary: verdict.summary ?? "",
    screenshots: screenshotFolder(ticket.number),
    notes: [],
    session,
  };
  if (!push.ok) result.notes.push(`The push failed: ${tail(push.stderr, 400)}`);
  recordResult(run, result);
  if (push.ok) run.pullRequest = ensurePullRequest(run, options);
  log(`#${ticket.number} built: ${hash} (${stat || "no diff"}).`);
}

async function park(ticket, base, kind, detail, run, session) {
  const n = ticket.number;
  let keptOn = null;
  if (git("status", "--porcelain")) {
    git("add", "-A");
    git("commit", "-m", `wip(parked): #${n} kept for the owner, not part of the phase`);
  }
  if (git("rev-parse", "HEAD") !== base) {
    keptOn = `${run.branch}-parked-${n}`;
    git("branch", "-f", keptOn, "HEAD");
    git("reset", "--hard", base);
  }
  await freeTicketPorts();

  const heading = kind === "question" ? "The phase run parked this ticket: it needs your decision." : "The phase run could not finish this ticket.";
  const body = [
    heading,
    "",
    detail,
    "",
    keptOn ? `The work so far is kept on the local branch \`${keptOn}\`. It is not on \`${run.branch}\`.` : "No work was kept.",
    kind === "question"
      ? `Answer here, then remove the \`${PARK_LABEL.question}\` label and add \`${READY_LABEL}\`. The next run picks it up.`
      : `Once it is sorted out, remove \`${PARK_LABEL.failure}\` and add \`${READY_LABEL}\` to let a run try again.`,
  ].join("\n");
  const bodyFile = join(run.dir, `park-${n}.md`);
  writeFileSync(bodyFile, body);
  const commented = exec("gh", ["issue", "comment", String(n), "--body-file", bodyFile]).ok;
  const labelled = exec("gh", ["issue", "edit", String(n), "--add-label", PARK_LABEL[kind], "--remove-label", READY_LABEL]).ok;
  // Set aside for this run either way; GitHub only knows if the two calls got through.
  ticket.labels = [...ticket.labels.filter((label) => label !== READY_LABEL), PARK_LABEL[kind]];

  // Applied to the target, but its file went with the reset: the target holds what the branch does not.
  const leftOnTarget = [...run.migrationsApplied].filter((name) => migrationFiles.has(name) && !existsSync(join(ROOT, migrationFiles.get(name))));
  recordResult(run, {
    number: n,
    title: ticket.title,
    status: kind === "question" ? "parked" : "failed",
    detail,
    keptOn,
    leftOnTarget,
    notPosted: !(commented && labelled),
    session,
  });
  log(`#${n} ${kind === "question" ? "parked (needs the owner)" : "failed"}${keptOn ? `, kept on ${keptOn}` : ""}.`);
}

function sessionFacts(result, previous) {
  const json = result.json ?? {};
  return {
    costUsd: json.total_cost_usd ?? previous?.costUsd ?? null,
    turns: (previous?.turns ?? 0) + (json.num_turns ?? 0),
    minutes: (previous?.minutes ?? 0) + Math.round((json.duration_ms ?? 0) / 60_000),
    denials: [...(previous?.denials ?? []), ...(json.permission_denials ?? []).map((d) => d.tool_input?.command ?? d.tool_name ?? "?")],
    calls: (previous?.calls ?? 0) + 1,
    // A background session reports no cost; these two stand in for it.
    outputTokens: (previous?.outputTokens ?? 0) + (json.output_tokens ?? 0),
    peakContext: Math.max(previous?.peakContext ?? 0, json.peak_context_tokens ?? 0),
    watch: json.background_id ?? previous?.watch ?? null,
  };
}

async function runTicket(ticket, options, run) {
  const n = ticket.number;
  const base = git("rev-parse", "HEAD");
  const startedAt = Date.now();
  let sessionId = randomUUID();
  const env = {
    ...sessionEnv(),
    PHASE_RUN: "1",
    PHASE_RUN_TICKET: String(n),
    PHASE_RUN_BASE: base,
    ...(options.spec ? { PHASE_RUN_SPEC: String(options.spec) } : {}),
  };
  rmSync(join(STATE, `verdict-${n}.json`), { force: true });
  rmSync(stopCheckMarker(n), { force: true });
  // What every call for this ticket shares. Its settings file (the run's
  // rules, the project's, the run's variables) is written for either kind of
  // session; a `-p` one also inherits the variables.
  const slug = ticket.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const session = {
    options,
    env,
    number: n,
    name: `ticket-${n}-${slug}`,
    settings: writeSessionSettings(run, n, env, { background: !options.print }),
  };
  const values = {
    N: n,
    TITLE: ticket.title,
    BRANCH: run.branch,
    PHASE: run.branch.replace(/^phase-/, ""), // phase-6g → 6g: the phase's own doc files are named so
    GOTCHAS_FILE: gotchasFile(run.branch),
    SPEC: options.spec ? `#${options.spec}` : "none (a one-off ticket)",
    BASE: base,
    FRONTEND: ticket.labels.includes("frontend") ? "yes" : "no",
  };
  Object.assign(values, promptValues(config, projectProse, values));

  log(`#${n} ${ticket.title}: starting${options.print ? ` (session ${sessionId})` : ""}.`);
  let call = await runSession({
    ...session,
    prompt: render(readFileSync(join(HERE, "ticket-prompt.md"), "utf8"), values),
    sessionId,
    resume: false,
    transcript: join(run.dir, `ticket-${n}-build.json`),
  });
  let facts = sessionFacts(call, null);

  for (let round = 0; ; round += 1) {
    sessionId = call.sessionId ?? sessionId;
    if (call.gaveUp) {
      await park(ticket, base, "failure", `${call.gaveUp} Nothing is wrong with the ticket itself; the run stopped here.`, run, facts);
      return "stop";
    }
    if (call.timedOut) {
      await park(ticket, base, "failure", `The session ran past the ${options.minutes}-minute cap and was stopped.`, run, facts);
      return "continue";
    }
    const verdict = readVerdict(n);
    if (verdict?.status === "parked") {
      await park(ticket, base, "question", verdict.question ?? "(The session parked the ticket without writing its question.)", run, facts);
      return "continue";
    }
    // The last gate may migrate a shared database, and a pass is followed by a push: both need the connection.
    if (!(await waitForInternet(waitDeadline(options), `before #${n}'s checks`))) {
      await park(
        ticket,
        base,
        "failure",
        `The internet connection did not come back within ${options.waitHours} hours, so the ticket's checks never ran. Nothing is known to be wrong with the ticket itself; the run stopped here.`,
        run,
        facts,
      );
      return "stop";
    }
    log(`#${n}: running the gates${round ? ` (after fix round ${round})` : ""}.`);
    const gates = await runGates(ticket, base, options, run, startedAt);
    if (gates.ok) {
      await freeTicketPorts();
      await finishBuilt(ticket, base, options, run, facts);
      return "continue";
    }
    if (round >= options.fixRounds) {
      await park(
        ticket,
        base,
        "failure",
        `The **${gates.gate}** check still failed after ${options.fixRounds} fix rounds. The end of its output:\n\n\`\`\`\n${tail(gates.output, 3000)}\n\`\`\``,
        run,
        facts,
      );
      return "continue";
    }
    log(`#${n}: ${gates.gate} failed. Fix round ${round + 1} of ${options.fixRounds}.`);
    call = await runSession({
      prompt: render(readFileSync(join(HERE, "fix-prompt.md"), "utf8"), {
        ...values,
        GATE: gates.gate,
        OUTPUT: tail(gates.output),
        ROUND: round + 1,
        ROUNDS: options.fixRounds,
      }),
      ...session,
      sessionId,
      resume: true,
      transcript: join(run.dir, `ticket-${n}-fix-${round + 1}.json`),
    });
    facts = sessionFacts(call, facts);
  }
}

// ------------------------------------------------------------------- report

/** The lines for one result that a person must act on: its assumptions, steps, findings and hand-offs. */
function actionLines(results) {
  const pick = (key) => results.flatMap((r) => (r[key] ?? []).map((line) => `#${r.number}: ${line}`));
  return {
    assumptions: pick("assumptions"),
    byHand: pick("runByHand"),
    elsewhere: pick("foundElsewhere"),
    handed: pick("handedForward"),
  };
}

/**
 * The morning report's doc health: the docs at 90% of their budget or over, named first, then the whole
 * table (`node tools/doc-check.mjs --report`) folded away. The finish ticket trims what is flagged.
 */
function docHealthSection(table) {
  const flagged = table.split("\n").filter((line) => /near the limit|over: trim/.test(line));
  const out = ["### Doc health", ""];
  if (flagged.length === 0) out.push("Every doc is under 90% of its budget.");
  else {
    out.push(`${flagged.length} doc(s) at 90% of their budget or over; the finish ticket trims them (or the owner raises a limit):`, "");
    for (const line of flagged) {
      const [file, lines, , limit, pct] = line.trim().split(/\s+/);
      out.push(`- \`${file}\` ${lines} / ${limit} lines (${pct})`);
    }
  }
  out.push("", "<details><summary>Every doc's size against its budget</summary>", "", "```text", table.trimEnd(), "```", "", "</details>", "");
  return out;
}

function report(run, options, remaining, { final = true } = {}) {
  const built = run.results.filter((r) => r.status === "built");
  const parked = run.results.filter((r) => r.status === "parked");
  const failed = run.results.filter((r) => r.status === "failed");
  const out = [];
  const thousands = (tokens) => `${Math.round(tokens / 1000)}K`;
  const money = (facts) =>
    facts?.costUsd != null
      ? ` · $${facts.costUsd.toFixed(2)} at list price`
      : facts?.outputTokens
        ? ` · ${thousands(facts.outputTokens)} tokens written, context up to ${thousands(facts.peakContext)}`
        : "";
  const effort = (facts) => (facts ? `${facts.minutes} min · ${facts.turns} turns · ${facts.calls} session call(s)${money(facts)}` : "");

  out.push(`## Phase run report: ${run.branch}`, "");
  out.push(`${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · built ${built.length} · parked ${parked.length} · failed ${failed.length}`, "");
  if (!final) out.push("🕒 **In progress.** This file is rewritten after each ticket; the run had not finished when it was saved. If no later version exists, the run stopped here.", "");
  if (run.stopped) out.push(`🚨 **The run stopped early.** ${run.stopped}`, "");

  // A ticket this run built again is reported once, under this run's own sections.
  const carried = (run.carried ?? []).filter((c) => !run.results.some((r) => r.number === c.number));
  if (carried.length) {
    out.push("### From an earlier run that stopped before writing its report", "");
    for (const r of carried) {
      const what = r.status === "built" ? `built \`${r.hash}\`` : r.status === "parked" ? "parked: it needs your decision" : "failed";
      out.push(`- **#${r.number} ${r.title}**: ${what}${r.keptOn ? `; work kept on \`${r.keptOn}\`` : ""}`);
      // A parked ticket's question, or a failure's output: the one thing the owner acts on.
      if (r.status !== "built" && r.detail) out.push(...String(r.detail).split("\n").map((line) => `  > ${line}`));
    }
    const lines = actionLines(carried);
    for (const [title, list] of [
      ["Its assumptions (confirm or reverse each)", lines.assumptions],
      ["Its steps to run by hand", lines.byHand],
      ["What it found in other tickets' code", lines.elsewhere],
      ["What it handed forward", lines.handed],
    ]) {
      if (list.length) out.push("", `**${title}**`, "", ...list.map((line) => `- ${line}`));
    }
    out.push("");
  }

  if (built.length) out.push("### Built", "");
  for (const r of built) {
    out.push(`**#${r.number} ${r.title}** · \`${r.hash}\``);
    if (r.summary) out.push(`- ${r.summary}`);
    out.push(`- Size: ${r.stat || "no diff"}`);
    if (r.outside.length) out.push(`- ⚠ Files outside the areas the ticket named: ${r.outside.map((f) => `\`${f}\``).join(", ")}`);
    if (r.migrations.length) out.push(`- Applied to ${targetName()}: ${r.migrations.join(", ")}`);
    if (r.destructive.length) out.push(`- 🚨 Destructive migration (it drops or rewrites data): ${r.destructive.join(", ")}`);
    if (r.screenshots) out.push(`- Screenshots: \`${r.screenshots}\``);
    if (r.session?.denials.length) out.push(`- Commands the session was refused (${r.session.denials.length}): ${r.session.denials.slice(0, 6).map((d) => `\`${String(d).slice(0, 60)}\``).join(", ")}`);
    for (const note of r.notes) out.push(`- ⚠ ${note}`);
    if (r.session?.watch) out.push(`- The whole session, to read back: \`claude attach ${r.session.watch}\``);
    out.push(`- Effort: ${effort(r.session)}`, "");
  }

  const lines = actionLines(built);
  for (const [title, list] of [
    ["Assumptions made (confirm or reverse each)", lines.assumptions],
    ["Run by hand", lines.byHand],
    ["Found in other tickets' code (for the finish, or a ticket of its own)", lines.elsewhere],
    ["Handed forward (owed by a later ticket: check it took it)", lines.handed],
  ]) {
    if (!list.length) continue;
    out.push(`### ${title}`, "");
    for (const line of list) out.push(`- ${line}`);
    out.push("");
  }

  const unposted = (r) =>
    r.notPosted
      ? `⚠ GitHub could not be reached, so this was not posted on the issue. The ticket still carries \`${READY_LABEL}\` there, and the next run will try it again from the start.`
      : "";

  if (parked.length) out.push("### Parked: your decision is needed", "");
  for (const r of parked) out.push(`**#${r.number} ${r.title}**`, "", r.detail, "", r.keptOn ? `Work kept on \`${r.keptOn}\`.` : "", unposted(r), "");

  if (failed.length) out.push("### Failed", "");
  for (const r of failed) {
    out.push(`**#${r.number} ${r.title}**`, "", r.detail, "", r.keptOn ? `Work kept on \`${r.keptOn}\`.` : "", unposted(r));
    if (r.leftOnTarget?.length) out.push(`🚨 ${targetName()} holds ${r.leftOnTarget.join(", ")} from this ticket, which is not on the phase branch.`);
    if (r.session?.watch) out.push(`The whole session, to read back: \`claude attach ${r.session.watch}\``);
    out.push(`Effort: ${effort(r.session)}`, "");
  }

  if (remaining.length) {
    out.push("### Not started", "");
    for (const line of remaining) out.push(`- ${line}`);
    out.push("");
  }

  if (run.docHealth) out.push(...docHealthSection(run.docHealth));

  out.push("### Next", "");
  out.push(run.pullRequest ? `- CI runs on the pull request (${run.pullRequest}); check it is green there.` : "- Nothing was pushed, so there is no pull request yet.");
  out.push(`- To hand-test: \`git checkout ${run.branch}\`. Leave the folder alone while a run is on.`);
  out.push("- Merge with a **merge commit** when the phase is done. Never squash or rebase.");
  return `${out.join("\n")}\n`;
}

// --------------------------------------------------------------------- main

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { branch, current, remote } = await preflight(options);
  // Only a dry run gets here without a remote, and its tickets are on GitHub.
  if (!remote) {
    console.log("\nNo tickets listed: they are read from GitHub, and this repo has no remote yet.\n");
    return;
  }

  const tickets = await loadTickets(options);
  const byNumber = new Map(tickets.map((t) => [t.number, t]));

  // --until #N: only tickets listed at or before #N are in this run.
  let inScope = tickets;
  if (options.until) {
    const at = tickets.findIndex((ticket) => ticket.number === options.until);
    if (at === -1) die(`--until #${options.until}: that is not one of spec #${options.spec}'s tickets.`);
    inScope = tickets.slice(0, at + 1);
  }
  const beyond = (ticket) => !inScope.includes(ticket);
  const AFTER_UNTIL = `after #${options.until}, where this run stops (--until)`;
  const limit = Number.isFinite(options.max) ? `up to ${options.max}` : "all";

  if (options.dryRun) {
    console.log(`\nDry run for ${branch}. Nothing was changed.\n`);
    for (const ticket of tickets) {
      const reason = beyond(ticket) && !isDone(ticket) ? AFTER_UNTIL : holdReason(ticket, byNumber);
      console.log(`  #${ticket.number}  ${reason ?? "READY"}  ·  ${ticket.title}`);
    }
    console.log(`\nA real run would build ${limit} of the READY tickets, in this order.\n`);
    return;
  }

  mkdirSync(STATE, { recursive: true });
  const lock = join(STATE, "lock");
  writeFileSync(lock, `pid ${process.pid}, started ${new Date().toISOString()}, branch ${branch}\n`);
  const release = () => rmSync(lock, { force: true });
  process.on("exit", release);
  // A background session outlives this script (it belongs to Claude Code's
  // background service), so a run that ends for any reason stops its own.
  process.on("exit", () => {
    if (!liveBackground) return;
    exec("claude", ["stop", liveBackground]);
    stopStray("by the session this run stopped");
  });
  process.on("SIGINT", () => process.exit(130));

  if (current !== branch) {
    if (gitTry("rev-parse", "--verify", "--quiet", branch).ok) git("checkout", branch);
    else {
      // A new phase branch starts from main as GitHub has it, or the pull
      // request would carry commits that were never pushed to main.
      gitTry("fetch", "origin", "main");
      if (git("rev-parse", "main") !== git("rev-parse", "origin/main")) {
        die("main and origin/main differ. Push (or pull) main first, then start the run.");
      }
      git("checkout", "-b", branch);
    }
  }

  const run = {
    branch,
    dir: join(STATE, branch),
    runId: new Date().toISOString(),
    results: [], // this run's
    all: [], // every run's on this branch, as results.json holds them
    carried: [], // an earlier run's that never reached a report
    migrationsApplied: new Set(),
    pullRequest: null,
  };
  mkdirSync(run.dir, { recursive: true });
  run.all = loadResults(resultsFile(run));
  run.carried = run.all.filter((result) => !result.reported);
  const reportFile = join(run.dir, `report-${run.runId.slice(0, 16).replace(/[:T]/g, "-")}.md`);
  mkdirSync(join(STATE, "tmp"), { recursive: true }); // where a session keeps its scratch files
  logFile = join(run.dir, "run.log");
  const appliedFile = join(run.dir, "migrations-applied.json");
  if (existsSync(appliedFile)) for (const name of JSON.parse(readFileSync(appliedFile, "utf8"))) run.migrationsApplied.add(name);

  log(
    `Run started on ${branch}: ${limit} ticket(s)${options.until ? `, stopping after #${options.until}` : ""}, ` +
      `${options.minutes} min each, ${options.fixRounds} fix rounds.`,
  );

  let outcome = "continue";
  while (outcome === "continue" && run.results.length < options.max) {
    const next = inScope.find((ticket) => holdReason(ticket, byNumber) === null);
    if (!next) break;
    if (!(await waitForInternet(waitDeadline(options), `before #${next.number}`))) {
      run.stopped = `The internet connection did not come back within ${options.waitHours} hours, so #${next.number} was never started.`;
      log(run.stopped);
      break;
    }
    try {
      outcome = await runTicket(next, options, run);
    } catch (error) {
      log(`#${next.number}: the runner itself hit an error and stopped: ${error.message}`);
      recordResult(run, { number: next.number, title: next.title, status: "failed", detail: `The runner stopped on an error of its own:\n\n\`\`\`\n${error.stack ?? error.message}\n\`\`\`\n\nThe branch was left as it was. Look before running again.`, keptOn: null, session: null });
      outcome = "stop";
    }
    writeFileSync(appliedFile, JSON.stringify([...run.migrationsApplied], null, 2));
    // Rewritten after every ticket, so a run that dies in the night still leaves its report.
    writeFileSync(reportFile, report(run, options, [], { final: false }));
  }

  const remaining = tickets
    .map((ticket) => ({ ticket, reason: holdReason(ticket, byNumber) }))
    .filter(({ reason }) => reason !== "done")
    .filter(({ ticket }) => !run.results.some((r) => r.number === ticket.number))
    .map(({ ticket, reason }) => `#${ticket.number} ${ticket.title}: ${beyond(ticket) ? AFTER_UNTIL : (reason ?? "ready, not reached this run")}`);

  const health = exec("node", ["tools/doc-check.mjs", "--report"]);
  run.docHealth = health.ok ? health.stdout : null;
  // A night that pushed nothing still reports on an earlier night's pull request.
  if (!run.pullRequest) {
    const existing = exec("gh", ["pr", "view", branch, "--json", "url", "-q", ".url"]);
    if (existing.ok && existing.stdout) run.pullRequest = existing.stdout;
  }
  const text = report(run, options, remaining);
  writeFileSync(reportFile, text);
  for (const result of run.all) result.reported = true;
  saveResults(run);
  if (run.pullRequest) exec("gh", ["pr", "comment", branch, "--body-file", reportFile]);
  log(`Run finished. Report: ${reportFile}${run.pullRequest ? ` · pull request: ${run.pullRequest}` : ""}`);
  console.log(`\n${text}`);
}

// Exported so these can be tested without starting a run.
export {
  QUIET_MS,
  SETTLE_MS,
  applyMigrations,
  fetchBlockers,
  gotchasFile,
  holdReason,
  loadResults,
  online,
  outsideAreas,
  projectGates,
  promptValues,
  pullRequestBody,
  render,
  readTurn,
  recordResult,
  report,
  runSession,
  screenshotsSince,
  sessionEnv,
  sessionSettings,
  stopCheckRunning,
  stopStray,
  turnOver,
  waitForInternet,
  writeSessionSettings,
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
