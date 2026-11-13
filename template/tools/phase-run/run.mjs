// The phase runner: builds a phase's tickets one after another with nobody
// watching, each in its own fresh Claude Code session, on a `phase-*` branch.
//
//   node tools/phase-run/run.mjs --spec <N> --branch phase-6b [--max 4]
//   node tools/phase-run/run.mjs --only <ticket> --branch phase-trial
//   node tools/phase-run/run.mjs --spec <N> --dry-run
//   node tools/phase-run/run.mjs --spec <N> --branch phase-6b --lane 2
//
// With --lane, the tickets are built in that lane's own git worktree (phaseRun.lanes, lane.mjs),
// with its ports, QA database, test prefix and env, and a passing ticket's commit stays on the
// lane's branch, then lands on the phase branch under the landing lock (landing.mjs, landing-lock.mjs):
// replayed onto the newest tip, re-gated there, and fast-forwarded, or parked. Its results and logs
// go in the primary checkout's `.phase-run/<branch>/lane-<id>/` (ADR 0007).
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
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { BROWSER_CHECK, HOTSPOT_TOKEN, fill, fillEnv, laneQaUrl, loadRunConfig, sessionEnv as pinnedEnv, targetFingerprint, targetUrl } from "./config.mjs";
import { afterPass, ignoredImports, ignoredImportsProblem, joinBranch, laneLockPath, lanePortProblems, laneRoots, laneRow, laneValues, liveLanes, mayFinishCopy, prepareWorktree, resetWorktree, setupWorktree, writeLaneLock } from "./lane.mjs";
import { builtOn, claimNext, clearParked, laneChoice, releaseClaim, takeClaim, takesTicket } from "./claim.mjs";
import { keepParked, land } from "./landing.mjs";
import { dropUnlanded, handBack, keepUnlanded, restartSteps, underLandingLock, unlandedCommits, unlandedRef } from "./landing-lock.mjs";
import { takeFingerprint } from "./fingerprint.mjs";
import { branchResults, findingText, findingsPath, laneState, onBranch, readFindings, recordFindings } from "./findings.mjs";
import { Screen, notify, ticketMinutes } from "./display.mjs";
import { brigadeCatalog, readInstalledBrigade, versionStop, withAutoUpdateOff } from "./brigade.mjs";
import { LEDGER_PATH, appendRow, ledgerRow, stampVersion } from "./ledger.mjs";
import { hookTime, loadPrices, sessionCost, stepKind, stepRules, ticketMetrics, withLanding } from "./metrics.mjs";
import { finishSnapshot, takeSnapshot } from "./snapshot.mjs";
import { DEFAULT_RULES as DEFAULT_SIZE, measureTicket as ticketSize } from "./ticket-size.mjs";
import { PATCH_ARGS, tamperingVerdict } from "./tampering.mjs";
import { projectKeeps, readTrim, trimEntries, trimPath, withTrim } from "./trim.mjs";
import { LANE_DIR, scratchFor } from "./numbering.mjs";
import { unreadMatcher } from "./unread.mjs";
import { repoFiles, testNamedPaths, withListedCode } from "./unread-scan.mjs";
import * as docConfig from "../doc-config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The primary checkout: the run's state (its lock, results, logs, runner copy) lives here (ADR 0007). */
const ROOT = resolve(HERE, "..", "..");
const STATE = join(ROOT, ".phase-run");
const WINDOWS = process.platform === "win32";
/**
 * The session's root: where its git, its shell, its gates and its files (verdicts, receipts, the
 * stop check's log, scratch) are. A lane's worktree (`--lane`, ADR 0007), else ROOT, so a run
 * without --lane reads every path as before. Set by main() once the worktree is ready.
 */
let work = ROOT;
/** The `.phase-run/` folder of the session's root. */
const sessionState = () => join(work, ".phase-run");
/** The gates' `{cache}`: emptied before each gate run, so no tool trusts a cache a session wrote (D14). Each lane has its own. */
const gateCache = () => join(sessionState(), "gate-cache").replaceAll("\\", "/");
/** The lane's row (`--lane <id>`, config.mjs parseLane), or null: a one-lane run. Set by preflight. */
let lane = null;
/** How often the gates' parallel group is looked at: a failure stops the rest on the next look. */
const GATE_TICK_MS = 250;

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
    lane: null, // --lane <id>: build in that lane's worktree (lane.mjs), keeping each pass unlanded
  };
  const numeric = { "--spec": "spec", "--only": "only", "--until": "until", "--max": "max", "--fix-rounds": "fixRounds", "--minutes": "minutes", "--wait-hours": "waitHours" };
  const text = { "--branch": "branch", "--permission-mode": "permissionMode", "--model": "model", "--lane": "lane" };
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
// The terminal (display.mjs) and what it shows: set by main(), null in tests.
let screen = null;
let progress = null;
let liveFile = null;

function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

/**
 * One line of the run's story: always to run.log, plain. On a terminal a
 * `routine` line (a ticket starting, a heartbeat, the gates, a ticket built)
 * shows only through the table and its live row; anywhere else every line
 * prints as before.
 */
function log(message, { routine = false } = {}) {
  const line = `[${stamp()}] ${message}`;
  if (logFile) appendFileSync(logFile, `${line}\n`);
  if (screen?.tty) {
    if (!routine) screen.note(line);
  } else console.log(line);
}

/** Redraws the live row and saves what status.mjs reads (live.json). */
function showProgress() {
  if (!progress) return;
  screen?.update(progress);
  if (liveFile) writeFileSync(liveFile, `${JSON.stringify(progress)}\n`);
}

/** The ticket being built, as the live row shows it. */
function setCurrent(changes) {
  if (progress?.current) Object.assign(progress.current, changes);
}

function die(message) {
  console.error(`\nphase-run: ${message}\n`);
  process.exit(1);
}

/** Runs a program directly (no shell). Returns status and trimmed output. */
function exec(command, args, extra = {}) {
  const result = spawnSync(command, args, {
    cwd: work,
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
function shell(commandLine, env = {}, cwd = work) {
  const result = spawnSync(commandLine, {
    cwd,
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

/** A file's text at a commit, or null when it isn't there (or can't be read): the tampering gate's reader. */
function atCommit(rev, path) {
  const result = gitTry("show", `${rev}:${path}`);
  return result.ok ? result.stdout : null;
}

/**
 * The listed-code rule's reader for gatePlan (#39): the paths the run's test files
 * (phaseRun.tampering.testFiles) name, read from `tree`, the checkout the gates run in: runGates
 * refuses a dirty tree before it plans, and the re-gate checks out the landed commit, so its files
 * are the commit's. No tampering section, no test files: no rule, and nothing (git included) is read.
 */
function testNamedIn(tree) {
  return () => {
    const testFiles = config.tampering?.testFiles ?? [];
    if (testFiles.length === 0) return [];
    return testNamedPaths({ testFiles, files: repoFiles(tree), read: (file) => readFileSync(join(tree, file), "utf8") });
  };
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
  return pinnedEnv(config, lookup, lane);
}

/** The QA database's address this run's sessions and gates use: the lane's, in a lane (D4). */
function runQaUrl() {
  return laneQaUrl(config, lane, lookup);
}

/** The ports this run owns: a lane's row's, else phaseRun.ports (the other lane may hold those). */
function runPorts() {
  return lane ? lane.ports : config.ports;
}

/** A port the project names, freed after every ticket: a ticket's QA server must not block the next one. */
async function freeTicketPorts() {
  for (const { port } of runPorts().filter((p) => p.freeAfterEachTicket)) await freePort(port);
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

/**
 * Starts one gate's command through the shell, as `shell` runs one, but without waiting:
 * `done` resolves to `{ ok, output }` once it has exited, and `stop()` kills its whole process tree
 * and waits for it. Off Windows the job leads its own process group, so the kill reaches what the
 * shell started; on Windows `taskkill /T` walks the tree. A job's own group no longer hears the
 * terminal's Ctrl-C, so every job still open is killed when the runner exits.
 */
function startJob(commandLine, env = {}) {
  const child = spawn(commandLine, { cwd: work, shell: true, env: { ...process.env, ...env }, detached: !WINDOWS, windowsHide: true });
  let stdout = "";
  let stderr = "";
  let closed = false;
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  // Until `close`, something may still hold the job's output open: a shell that exited can leave
  // a child behind it, so the kill is decided on "closed", never on "exited" (Windows aside, where
  // a gone pid's tree can't be walked).
  const kill = () => {
    if (closed) return;
    if (WINDOWS) {
      if (child.exitCode === null && child.signalCode === null) exec("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      return;
    }
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // the whole group is gone already
    }
  };
  openJobs.add(kill);
  if (!jobsKilledOnExit) {
    jobsKilledOnExit = true;
    process.on("exit", () => {
      for (const open of openJobs) open();
    });
  }
  const done = new Promise((resolve) => {
    child.on("error", (error) => {
      if (child.pid === undefined) {
        closed = true; // it never started, so no `close` follows
        openJobs.delete(kill);
      }
      resolve({ ok: false, output: error.message });
    });
    child.on("close", (code) => {
      closed = true;
      openJobs.delete(kill);
      resolve({ ok: code === 0, output: `${stdout}\n${stderr}`.replace(/\r\n/g, "\n").trim() });
    });
  });
  const stop = async () => {
    kill();
    await done;
  };
  return { done, stop };
}

/** Each gate job not yet closed, by its kill: the runner's exit kills them all. */
const openJobs = new Set();
let jobsKilledOnExit = false;

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
 * Where "built" is read (claim.mjs builtOn): HEAD, the checked-out phase branch, in a one-lane run,
 * as before; the phase branch itself in a lane, whose HEAD is its own branch of unlanded passes.
 */
let builtRef = "HEAD";

/**
 * Issues stay open until the pull request merges, so on a phase branch
 * "done" is: closed, or a commit on this branch carries `Closes #N`.
 */
function builtOnBranch(number) {
  return builtOn(gitTry, builtRef, number);
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
    const done = known ? isDone(known) : blockerDone(blocker);
    if (!done) return `waiting on #${blocker.number}`;
  }
  return null;
}

/** A blocker outside the run's tickets, as `{ number, state }`: closed, or built on the branch. */
function blockerDone(blocker) {
  return blocker.state === "closed" || builtOnBranch(blocker.number);
}

/**
 * The next ticket to build, or none. A one-lane run takes the first ready ticket in order, as
 * before. A lane takes the first of its frontier under a claim both lanes share (claim.mjs, #34):
 * ready, a ticket its row takes, and claimed by no live lane. With none, it waits while another
 * live lane may still land a ticket one of its own waits on, and stops when none can.
 */
async function nextTicket(inScope, byNumber, run) {
  if (!lane) return inScope.find((ticket) => holdReason(ticket, byNumber) === null);
  // The other lanes of this branch still running, as their rows: what each may still take.
  const others = () => {
    const live = liveLanes(STATE).filter((other) => other.branch === run.branch && other.lane !== String(lane.id));
    return config.lanes.rows.filter((row) => live.some((other) => other.lane === String(row.id)));
  };
  let said = "";
  const { ticket } = await claimNext({
    dir: run.claims,
    lane: lane.id,
    sleep,
    // A ticket a lane parked tonight is held here too: this lane read its labels at its own start (#37).
    choose: (claims, idle, parked = []) =>
      laneChoice({
        tickets: inScope,
        byNumber,
        hold: (ticket) => (parked.includes(ticket.number) ? "parked tonight, in a lane" : holdReason(ticket, byNumber)),
        done: blockerDone,
        takes: lane.takes,
        claims,
        self: lane.id,
        others: others(),
        idle,
      }),
    onWait: (waitOn) => {
      const line = waitOn.map((w) => (w.claimed ? `lane ${w.lane}'s #${w.ticket}` : `#${w.ticket}, which lane ${w.lane} may take`)).join(", ");
      if (line !== said) log(`Lane ${lane.id}: nothing it takes is ready; waiting on ${line}.`);
      said = line;
    },
  });
  if (ticket === null) log(`Lane ${lane.id}: nothing it takes is ready, and no other live lane can unblock one.`, { routine: true });
  return ticket === null ? undefined : inScope.find((candidate) => candidate.number === ticket);
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
  if (options.lane !== null) {
    try {
      lane = laneRow(config, options.lane);
      runQaUrl(); // a url with no place for the lane's database is refused here, not at the first ticket
    } catch (error) {
      die(`Not ready to run: ${error.message}`);
    }
  }

  const current = git("branch", "--show-current");
  let branch = options.branch;
  if (!branch && current.startsWith("phase-")) branch = current;
  // A lane started without --branch on a detached checkout (another lane is landing) joins the
  // branch a live lane's lock names (D13).
  if (!branch && lane && current === "") {
    try {
      branch = joinBranch(STATE);
    } catch (error) {
      problems.push(error.message);
    }
    if (branch) console.log(`Joining ${branch}, the branch a live lane runs on.`);
  }
  if (!branch) problems.push("No phase branch named. Add --branch phase-<name> (for example --branch phase-6b).");
  else if (!/^phase-[a-z0-9][a-z0-9-]*$/.test(branch)) problems.push(`"${branch}" must look like phase-6b.`);
  // A lane builds in its own worktree and never checks a branch out here, so the primary may be anywhere.
  else if (!lane && current !== branch && current !== "main") {
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
    const result = shell(fill(row.run, { qaUrl: runQaUrl() }));
    if (!result.ok) problems.push(`${row.label} failed (\`${row.run}\`).${row.hint ? ` ${row.hint}` : ""}\n${tail(result.output, 600)}`);
  }

  // A lane checks its own row's ports: the other lane may be holding phaseRun.ports.
  if (lane) problems.push(...(await lanePortProblems(lane, listening)));
  else {
    for (const { port, what } of config.ports) {
      if (await listening(port)) problems.push(`Something is listening on :${port} (${what}). Stop it before a run.`);
    }
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

  // This machine's trim list (trim.mjs, D16), read live, never snapshotted: a refused file stops the run here.
  let trim = null;
  try {
    trim = readTrim(trimPath());
    if (trim) projectKeeps(ROOT); // what the project enables must be readable, or trim could switch it off
  } catch (error) {
    problems.push(`The trim list is refused: ${error.message}`);
  }

  const lock = join(STATE, "lock");
  if (existsSync(lock)) {
    problems.push(`A run is already going (or one crashed): ${readFileSync(lock, "utf8").trim()}. If none is running, delete .phase-run/lock.`);
  }
  if (lane && existsSync(laneLockPath(STATE, lane.id))) {
    const mine = laneLockPath(STATE, lane.id);
    problems.push(`Lane ${lane.id} is already going (or it crashed): ${readFileSync(mine, "utf8").trim()}. If it is not running, delete ${relative(ROOT, mine).replaceAll("\\", "/")}.`);
  }
  if (lane && branch && !gitTry("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).ok) {
    problems.push(`${branch} does not exist yet: a lane cuts its branch from it. Start the phase branch first (a run without --lane makes it from main), then start the lane.`);
  }

  if (problems.length > 0) {
    // A dry run still lists the tickets, so the owner sees both at once.
    if (!options.dryRun) die(`Not ready to run:\n\n- ${problems.join("\n- ")}`);
    console.log(`\nA real run would refuse to start:\n\n- ${problems.join("\n- ")}`);
  }
  return { branch: branch ?? "(no branch named)", current, remote, trim };
}

// ------------------------------------------------------------------ session

/** The phase's gotchas file: doc-config's GOTCHAS_FILE, or the flat default when the project's copy predates it. */
function gotchasFile(branch) {
  return fill(docConfig.GOTCHAS_FILE ?? "docs/agents/gotchas/{phase}.md", { phase: branch.replace(/^phase-/, "") });
}

/**
 * What the prompt says an edit after the pass does, by the receipt rows' unread lists: one list when
 * they share it, else each list with the checks that keep it (0.6.0's named rows keep their own).
 */
function unreadNote(stopChecks) {
  const receipts = stopChecks.filter((c) => c.receipt);
  const lists = new Map();
  for (const check of receipts) {
    const key = JSON.stringify(check.unread ?? []);
    lists.set(key, [...(lists.get(key) ?? []), check.label]);
  }
  const globs = (key) => JSON.parse(key).map((glob) => `\`${glob}\``).join(", ");
  if (lists.size === 1) {
    const [key] = lists.keys();
    return key === "[]" ? "docs included" : `except to ${globs(key)}, which ${receipts.length === 1 ? "the tests" : "they"} never read`;
  }
  const parts = [...lists].map(([key, labels]) => `${key === "[]" ? "nothing" : globs(key)} for ${labels.join(" and ")}`);
  return `except to ${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}, which they never read`;
}

/** The stop checks as the prompt lists them: stop-tests.mjs once for every receipt row, the rest as their commands. */
function stopCheckLine(stopChecks, stopTests, base) {
  const receipts = stopChecks.filter((c) => c.receipt);
  const which = receipts.length === 1 ? "the tests" : receipts.map((c) => c.label).join(", ");
  return stopChecks
    .filter((c) => !c.receipt || c === receipts[0])
    .map((c) => (c.receipt ? `${stopTests} (${which})` : `\`${c.run.replaceAll("{base}", base)}\``))
    .join(", ");
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
  // The session's own check command is the run's copy's (ticket.RUNNER, from the repo's root), so
  // its receipt is made by the code the stop hook judges with (ADR 0005). Live with no copy.
  const stopTests = `\`node ${ticket.RUNNER ? `${ticket.RUNNER}/` : ""}tools/phase-run/stop-tests.mjs\``;
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
    // The tests (a `receipt` row) are run through stop-tests.mjs, so their pass leaves the receipt the stop check reads.
    // It runs every receipt row, so it is named once, where the first one stands.
    STOP_CHECKS: project.stopChecks.length ? stopCheckLine(project.stopChecks, stopTests, base) : "nothing, as this project names no stop checks",
    RECEIPT: project.stopChecks.some((c) => c.receipt)
      ? ` Run the tests through ${stopTests}, never by hand: it prints a short summary (the failures and the totals), and on a pass records a receipt, so a second run on the same code (or the stop check) skips them. Any edit since makes them run again, ` +
        unreadNote(project.stopChecks) +
        ": so write your docs and logs first, and run the tests last."
      : "",
    MIGRATIONS: target
      ? `never apply a migration to ${target} yourself; the runner applies it after your checks pass`
      : "this project's runner applies none, so never apply one to a shared database",
    SHELL_ENV: pinned.length
      ? `**Your shell points at local data, on purpose.** ${pinned.join(", ")} ${pinned.length === 1 ? "is" : "are"} already set for this run, and \`--env-file=.env\` or a script's own \`.env\` loader changes none of them. Work on ${project.qa ? `\`${project.qa.name}\`` : "local data"}; never point anything at ${target ?? "a shared database"}, and never open or print \`.env\`.`
      : "**Never open or print `.env`**: it can hold live credentials.",
    BROWSER_GATE: check
      ? `The runner checks this itself: a ticket labelled \`frontend\`, or one that changes a screen's file, does not pass without at least ${check.minimum} screenshots saved to \`${fill(check.screenshots, { N })}/\` **after your last edit to a source file**. A fix you make after the walk (the code review's, a fix round's) means walking again.`
      : "The runner has no screenshot gate for this project; say in the implementation log what you checked.",
    LANE_NUMBERS: ticket.LANE ? laneNumbers(ticket.LANE, laneToken(project.hotspots), ticket.GOTCHAS_FILE) : "",
  };
}

/**
 * The token a lane writes: `phaseRun.hotspots.token`, else HOTSPOT_TOKEN. doc-check accepts only
 * doc-config's NUMBER_TOKEN, so a token the two disagree on is refused before a lane is told to write it.
 */
function laneToken(hotspots, docToken = docConfig.NUMBER_TOKEN ?? HOTSPOT_TOKEN) {
  const token = hotspots?.token ?? HOTSPOT_TOKEN;
  if (token !== docToken) {
    throw new Error(`phaseRun.hotspots.token is "${token}", but tools/doc-config.mjs's NUMBER_TOKEN is "${docToken}", the only token doc-check accepts. Make them the same.`);
  }
  return token;
}

/**
 * A lane session's numbering paragraph (ADR 0006): it writes the token itself where a number goes,
 * and its gotchas block to the scratch file numbering.mjs folds in. Empty for a one-lane run, whose
 * prompt is then today's, byte for byte.
 */
function laneNumbers(lane, token, gotchasFile) {
  return (
    `\n\n**You are lane \`${lane}\`: write \`${token}\` where a number goes, literally.** Another lane builds beside you, ` +
    `so neither takes the next number; the runner fills them in when your commit lands on the phase branch. Above, ` +
    `\`${token}\` stood for "your number"; here it is the text you write: the devlog heading \`## #${token} · <type> · <title>\`, ` +
    `the log's file name \`${token}-<slug>.md\`, its title \`# #${token} — …\` and its Devlog line's \`#${token}\`, ` +
    `the devlog entry's \`implementation log ${token}\`, and \`devlog #${token}\` in the commit message. Your gotchas block goes in \`${scratchFor(gotchasFile)}\`, ` +
    `not in \`${gotchasFile}\`: it is added to that file when your commit lands. If \`${gotchasFile}\` does not exist yet, make it from the template with no block of yours ` +
    `(its header and opening only), in this commit: the other lane may make it too, and Landing keeps whichever lands first. ` +
    `doc-check, in a lane, judges the file with your block folded in. doc-check accepts \`${token}\` only in a lane.`
  );
}

/** A `-p` call's arguments. Each call is a process of its own, so trim's flags go on a resume too. */
function printArgs({ sessionId, resume, options, settings, flags = [] }) {
  return [
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
    ...flags,
  ];
}

/**
 * A background session's arguments. Trim's flags go on the first launch only: a resume takes no
 * flag at all (point 5 below: any flag starts a copy), and the session keeps its launch flags, as
 * it keeps its `--settings`.
 */
function backgroundArgs({ sessionId, resume, name, options, settings, ask, flags = [] }) {
  if (resume) return ["--bg", "--resume", sessionId, ask];
  return ["--bg", "--name", name, "--permission-mode", "dontAsk", "--settings", settings, ...(options.model ? ["--model", options.model] : []), ...flags, ask];
}

// "You've hit your session limit · resets 3:30pm" is the wording past transcripts on this machine hold.
const LIMIT_PATTERN = /usage limit|rate.?limit|limit reached|hit your (\w+ )?limit|out of (extra )?usage|resets? (at|in)\b|overloaded/i;

/** A hidden `claude -p` session (`--print`): nothing to watch, one summary at the end. */
function runPrint({ prompt, sessionId, resume, options, env, settings, transcript, flags }) {
  const args = printArgs({ sessionId, resume, options, settings, flags });
  return new Promise((done) => {
    const child = spawn("claude", args, { cwd: work, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
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
const LOOK_MS = 60_000;
// Not working, no stop check running, yet no end of turn written: how long before that is taken as the end.
const QUIET_MS = 3 * 60_000;
// The Stop hook's own time limit (`"timeout": 1800` in .claude/settings.json). A marker older than that is a dead check's.
const STOP_CHECK_MAX_MS = 30 * 60_000;
// Point 7: how long a turn must stay ended, its verdict written, before a session still listed as working is taken as done.
const SETTLE_MS = 2 * 60_000;

/** Whether the ticket's verdict file was written at or after `since` (ms): this turn's, not an earlier round's. */
function verdictWrittenSince(number, since) {
  try {
    return statSync(join(sessionState(), `verdict-${number}.json`)).mtimeMs >= since;
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
  return join(sessionState(), `stop-check-${number}.json`);
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
    const modules = `${work}\\node_modules\\`.toLowerCase().replace(/'/g, "''"); // a lane's own install: never the other lane's
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
      .filter((line) => line.includes(`${work}/node_modules/`) && pattern.test(line))
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
 * for a person or move the work somewhere else. `catalog` (brigade.mjs brigadeCatalog, read at run
 * start) switches Brigade's auto-update off for the session, keeping its catalog entry's `source`.
 */
function sessionSettings(base, project, { branch, env, background, prompt, catalog = null, runFolder = null }) {
  const allow = [...(base.permissions?.allow ?? []), ...project.allow];
  // A lane's session runs in its worktree, so `./` names the worktree; the run's folder with the
  // shared runner copy sits in the primary checkout, denied by its absolute path (`//`, the POSIX
  // form Claude Code matches a Windows path in: D:\a becomes /d/a).
  const absolute = runFolder ? `/${resolve(runFolder).replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)}` : null;
  return withAutoUpdateOff({
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
        ...(absolute ? [`Edit(${absolute}/**)`] : []),
        "AskUserQuestion",
        "EnterPlanMode",
        "EnterWorktree",
      ],
    },
    env: { ...(base.env ?? {}), ...env },
    ...(background ? { worktree: { ...(base.worktree ?? {}), bgIsolation: "none" } } : {}),
  }, catalog);
}

/**
 * A file of the runner's that a session's rules come from (its base settings, its prompts): the run's
 * frozen copy's (ADR 0005), so a shell write to the live tools/phase-run/ mid-night changes nothing
 * for later tickets. With no copy yet (a dry run), the runner's own.
 */
function runnerFile(runner, name) {
  return runner ? join(runner, "tools", "phase-run", name) : join(HERE, name);
}

/**
 * doc-check as the runner runs it (D10): the run's copy's, with its imports and its baseline,
 * pointed at the repo it checks (`root`, doc-lib.mjs `checkedRoot`), so a change to the live doc
 * tools mid-night changes no later ticket's verdict. With no copy yet (a dry run), the live one, as
 * before. `env` is the environment it runs in, this process's unless a test gives another.
 */
function docCheck(runner, root, args, env = process.env) {
  if (!runner) return exec("node", [join("tools", "doc-check.mjs"), ...args], { cwd: root, env });
  return exec("node", [join(runner, "tools", "doc-check.mjs"), ...args], { cwd: root, env: { ...env, PHASE_RUN_RUNNER: runner, PHASE_RUN_ROOT: root } });
}

function writeSessionSettings(run, number, env, { background = true } = {}) {
  const base = JSON.parse(readFileSync(runnerFile(run.runner, "settings.json"), "utf8"));
  const settings = sessionSettings(base, config.permissions, { branch: run.branch, env, background, prompt: config.prompt, catalog: run.catalog, runFolder: lane ? join(STATE, run.branch) : null });
  const path = join(run.dir, `settings-${number}.json`);
  // What the session's own project enables: a lane session loads its worktree's settings (#28's probe, answer 5).
  writeFileSync(path, `${JSON.stringify(trimmedSettings(settings, run.trim, work, config.keep), null, 2)}\n`);
  return path;
}

/**
 * A night ticket's settings with trim's entries (trim.mjs, D16), minus what the project enables or
 * keeps. A project settings file that can't be read (preflight refused it, so a session broke it
 * since) trims nothing that ticket: never what the project may need.
 */
function trimmedSettings(settings, trim, root, keep) {
  if (!trim) return settings;
  let project;
  try {
    project = projectKeeps(root);
  } catch (error) {
    log(`Trim skipped for this ticket: ${error.message}`);
    return settings;
  }
  return withTrim(settings, trimEntries(trim, { project, keep }));
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
        turn.lastStep = `${block.name} ${what.replace(work, "").replace(/^[\\/]/, "")}`.slice(0, 90);
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
async function runBackground({ prompt, sessionId, resume, options, settings, name, transcript, number, flags }) {
  // The prompt is the session's file, in its own root (a lane's worktree), where it may read it;
  // the transcript beside it in the run's folder is run state (ADR 0007). One lane: the same path.
  const promptFile = join(sessionState(), relative(STATE, transcript)).replace(/\.json$/, ".prompt.md");
  mkdirSync(dirname(promptFile), { recursive: true });
  writeFileSync(promptFile, prompt);
  const ask = `Read the file ${relative(work, promptFile).replace(/\\/g, "/")} and follow it exactly. It is your whole task for this turn.`;

  let id = null;
  let fromLine = 0;
  if (resume) {
    id = sessionId.slice(0, 8);
    stopBackground(id);
    fromLine = transcriptLines(sessionId).length;
    const woke = exec("claude", backgroundArgs({ sessionId, resume, ask }));
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
    const started = exec("claude", backgroundArgs({ name, options, settings, ask, flags }));
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
  log(`#${number}: session ${id} is working. Watch it: claude attach ${id}   (or: claude agents)`, { routine: true });
  setCurrent({ attach: id, stage: "reading" });
  showProgress();

  const startedAt = Date.now();
  const deadline = startedAt + options.minutes * 60_000;
  const rules = stepRules(config);
  // "Bash node tools/x.mjs" → the plain word for that step.
  const stageOf = (lastStep) => {
    const [tool = "", ...rest] = lastStep.split(" ");
    return lastStep ? stepKind(tool, rest.join(" "), rules) : "reading";
  };
  let timedOut = false;
  let lastBeat = startedAt;
  let lastLook = startedAt;
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
    // The live row's step count and stage word, every minute; run.log's heartbeat, every five.
    if (stopCheck) setCurrent({ stage: "stop hook" });
    else if (Date.now() - lastLook >= LOOK_MS) {
      lastLook = Date.now();
      const sofar = readTurn(sessionId, fromLine);
      setCurrent({ steps: sofar.steps, stage: stageOf(sofar.lastStep) });
    }
    showProgress();
    if (Date.now() - lastBeat >= BEAT_MS) {
      lastBeat = Date.now();
      const sofar = readTurn(sessionId, fromLine);
      const stage = stopCheck ? "stop hook" : stageOf(sofar.lastStep);
      log(`#${number}: ${Math.round((lastBeat - startedAt) / 60_000)} min in, ${sofar.steps} steps, ${stage}. Last: ${sofar.lastStep || "(nothing yet)"}`, { routine: true });
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
    // An untrusted folder refuses every session: stop the run, not this ticket's fix rounds. Only a call
    // that never reached a session (no result, Claude Code's own error) counts: a session's own words
    // may quote the phrase (from a log it read) without anything being wrong.
    if (!result.json && UNTRUSTED.test(result.raw ?? "")) return done({ gaveUp: TRUST_HELP });

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
  const path = join(work, ".claude", "spec-issues.json");
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
 * The browser check's gate (phaseRun.browserCheck, `check`) on the tree at `root`:
 * `{ problem, fingerprint }`. The check is the session's own work, so its word is
 * not enough: the screenshots it was told to save must be there, and be from this
 * build. A pass records the fingerprint of what it judged (fingerprint.mjs, D12);
 * a ticket the check does not apply to, or a failed check, has none.
 */
function browserCheckVerdict({ check, ticket, changed, startedAt, root }) {
  if (!check) return { problem: null, fingerprint: null };
  if (!ticket.labels.includes("frontend") && !changed.some((file) => check.screenFiles.test(file))) return { problem: null, fingerprint: null };
  const dir = fill(check.screenshots, { N: ticket.number });
  const shots = screenshotsSince(root, dir, startedAt, changed, check.sourceFiles);
  if (shots.fresh.length >= check.minimum) {
    // readdirSync names a subfolder's file with the platform's separator; the fingerprint keeps `/`.
    const counted = shots.fresh.map((file) => `${dir.replace(/\/+$/, "")}/${file.split(sep).join("/")}`);
    return { problem: null, fingerprint: takeFingerprint({ root, changed, sourceFiles: check.sourceFiles, shots: counted }) };
  }
  return { problem: browserCheckProblem(check, dir, shots), fingerprint: null };
}

/** What a failed browser check tells the session. */
function browserCheckProblem(check, dir, shots) {
  return (
    `This ticket changes what a screen shows, and ${dir}/ holds ${shots.fresh.length} screenshot(s) saved after your last edit to a source file` +
    `${shots.stale ? ` (${shots.stale} older one(s) do not count: a source file changed after them, so they show code that is no longer there)` : ""}; ` +
    `the browser check saves at least ${check.minimum}. Do the browser check in section 5 of your first instructions again, on the code as it is now: ` +
    `${check.redo}, into ${dir}/, then stop the server. Fix what it finds and amend the commit. The screenshots themselves are not committed.`
  );
}

/**
 * Every path a `git diff --name-status -M -z` names, once each, in its order. A rename or a copy
 * (`R087`, `C075`) names two paths, and both count: a doc moved into the source is a source change.
 */
function diffPaths(nameStatus) {
  const fields = nameStatus.split("\0");
  const paths = [];
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i].trim();
    if (!status) continue;
    const count = /^[RC]/.test(status) ? 2 : 1;
    paths.push(...fields.slice(i + 1, i + 1 + count));
    i += count;
  }
  return [...new Set(paths.filter(Boolean))];
}

/**
 * Which of the project's gates run on this ticket, which skip, and the tampering verdict: the one
 * decision function. `diff` is `git diff --name-status -M -z <base>..HEAD`.
 * A gate skips on `when` when no changed path matches it, and on `unreadOf` (the suite skip, D13)
 * when the diff is non-empty and every path is on that stop check's `unread` list, through the
 * one matcher (unread.mjs). An empty diff never takes the suite skip. Under the listed-code rule
 * (0.7.0 D11) the list first gets back each path a test names, from `testNamed()` (unread-scan.mjs's
 * `testNamedPaths`, read only when a skip is in reach), so a changed file a test names runs the gate;
 * a `testNamed` that throws refuses the skip. Without one there is no rule.
 * `tampering` (D15, tampering.mjs) is null when the run has no tampering section; its rules are read
 * at `base` through `readAt(rev, path)`, from the `patch` (PATCH_ARGS), the ticket `body` as fetched
 * at run start and the commit `message`.
 */
function gatePlan({ base, diff, config: { gates, stopChecks = [], tampering = null }, patch = "", readAt = null, body = "", message = "", testNamed = () => [] }) {
  const paths = diffPaths(diff);
  const unread = new Map(stopChecks.filter((check) => check.name).map((check) => [check.name, check.unread]));
  let scan; // `{ named }`, read once and only for a diff wholly on some list; `named` is null when it failed
  const testNamedOnce = () => (scan ??= (() => {
    try {
      return { named: testNamed() };
    } catch {
      return { named: null }; // the scan failed: no skip on a list it could not check
    }
  })());
  const onListOf = (name) => {
    const list = unread.get(name) ?? [];
    if (!paths.every(unreadMatcher(list))) return false;
    const { named } = testNamedOnce();
    // Every changed path is on the list, so each named one among them is listed code: put it back.
    return named !== null && paths.every(unreadMatcher(withListedCode(list, named)));
  };
  const skipOf = (gate) => {
    if (gate.builtin) return null;
    if (gate.when && !paths.some((path) => gate.when.test(path))) return "when";
    if (gate.unreadOf && paths.length > 0 && onListOf(gate.unreadOf)) return "unreadOf";
    return null;
  };
  return {
    base,
    paths,
    gates: gates.map((gate) => ({ gate, skip: skipOf(gate) })),
    tampering: tamperingVerdict({ base, rules: tampering, paths, patch, readAt, body, message }),
  };
}

/** Why a gate skipped, by `gatePlan`'s skip: one line each, so a new skip can't borrow another's words. */
const SKIP_REASONS = {
  when: () => "no changed file matches its `when`",
  unreadOf: (gate) => `every changed file is on the ${gate.unreadOf} check's unread list (the suite skip)`,
};

/**
 * Runs `gates` side by side (D12): every one without a pending `after` starts at once, and an
 * `after` gate starts once its gate passed (a gate not in this group, a skipped one, holds nobody
 * up). Finished jobs are collected each tick; on a failure, every failure of that tick is reported,
 * the jobs still running are killed and waited for, and the ones not started never start.
 */
async function gateGroup(gates, { values, start, tickMs, laneEnv = {} }) {
  const labels = new Set(gates.map((gate) => gate.label));
  const passed = new Set();
  const running = new Map();
  let waiting = [...gates];
  const startReady = () => {
    const ready = (gate) => !gate.after || !labels.has(gate.after) || passed.has(gate.after);
    for (const gate of waiting.filter(ready)) {
      // A lane's variables over the gate's own env: a lane's suite names its own test databases.
      const entry = { job: start(fill(gate.run, values), { ...fillEnv(gate.env, values), ...laneEnv }), result: null };
      entry.job.done.then((result) => (entry.result = result));
      running.set(gate, entry);
    }
    waiting = waiting.filter((gate) => !ready(gate));
  };
  startReady();
  while (running.size > 0) {
    await sleep(tickMs);
    const failures = [];
    for (const [gate, entry] of running) {
      if (!entry.result) continue;
      running.delete(gate);
      if (entry.result.ok) passed.add(gate.label);
      else failures.push({ gate: gate.label, output: entry.result.output });
    }
    if (failures.length > 0) {
      await Promise.all([...running.values()].map((entry) => entry.job.stop()));
      if (failures.length === 1) return failures[0];
      return {
        gate: failures.map((failure) => failure.gate).join(", "),
        output: failures.map((failure) => `── ${failure.gate} ──\n${tail(failure.output, 3000)}`).join("\n\n"),
      };
    }
    startReady();
  }
  // The loaders rule this out (gateOrder); a gate left unstarted must still never read as a pass.
  if (waiting.length > 0) {
    return { gate: waiting.map((gate) => gate.label).join(", "), output: `Never started: each waits on an \`after\` that never passed (${waiting.map((gate) => `${gate.label} after ${gate.after}`).join(", ")}).` };
  }
  return null;
}

/**
 * The project's gates (phaseRun.gates), as `gatePlan` decided them: the tampering verdict first (D12),
 * then the parallel group, then each `alone` gate by itself (strays stopped first), then the browser
 * check, wherever the config places it. The first failure is returned as `{ gate, output }`, or null.
 * `{cache}` is emptied before any gate starts. `laneEnv` is a lane's variables (laneVariables), none
 * without a lane. The job starter and the side jobs are parameters, so a test can stand in for them.
 */
async function projectGates(plan, { values, browserCheck, start = startJob, tickMs = GATE_TICK_MS, freePorts = freeTicketPorts, stopStray: stop = () => 0, laneEnv = {} }) {
  if (plan.tampering && !plan.tampering.ok) return { gate: "tampering", output: plan.tampering.output };
  if (values.cache) {
    rmSync(values.cache, { recursive: true, force: true });
    mkdirSync(values.cache, { recursive: true });
  }
  const live = plan.gates.filter(({ gate, skip }) => !gate.builtin && !skip).map(({ gate }) => gate);
  const group = live.filter((gate) => !gate.alone);
  if (group.some((gate) => gate.freePorts)) await freePorts();
  const failed = await gateGroup(group, { values, start, tickMs, laneEnv });
  if (failed) return failed;
  for (const gate of live.filter((g) => g.alone)) {
    if (gate.freePorts) await freePorts();
    stop(`before the ${gate.label} gate`);
    const alone = await gateGroup([gate], { values, start, tickMs, laneEnv });
    if (alone) return alone;
  }
  if (plan.gates.some(({ gate }) => gate.builtin === BROWSER_CHECK)) {
    const problem = browserCheck();
    if (problem) return { gate: "browser check", output: problem };
  }
  return null;
}

/**
 * Whether a commit's added files (`git diff --name-only --diff-filter=A`) hold an implementation
 * log: `NNN-<slug>.md` with a number, or in a lane (`token` set) the number token, which Landing
 * numbers (ADR 0006).
 */
function implementationLogAdded(added, token = null) {
  const number = token ? `(?:\\d{3}|${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})` : "\\d{3}";
  return new RegExp(`^docs/history/implementation-log/${number}-.+\\.md$`, "m").test(added);
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
  if (!implementationLogAdded(added, lane ? laneToken(config.hotspots) : null)) {
    return fail("docs", "The commit adds no docs/history/implementation-log/NNN-*.md entry. Every ticket gets one, in full.");
  }

  // One rename-aware diff decides every gate's skip and feeds the browser check, so they agree. The
  // tampering verdict reads its rules at the base, never from the tree the ticket could edit.
  const plan = gatePlan({
    base,
    diff: git("diff", "--name-status", "-M", "-z", `${base}..HEAD`),
    config,
    ...(config.tampering ? { patch: git(...PATCH_ARGS, `${base}..HEAD`), readAt: atCommit, body: ticket.body ?? "", message } : {}),
    testNamed: testNamedIn(work),
  });
  const changed = plan.paths;
  for (const { gate, skip } of plan.gates.filter((g) => g.skip)) {
    log(`#${n}: the ${gate.label} gate is skipped: ${SKIP_REASONS[skip](gate)}.`, { routine: true });
  }
  if (plan.tampering?.overridden.length) log(`#${n}: the tampering gate let ${plan.tampering.overridden.join(", ")} through, by the ticket's test override.`);
  if (plan.tampering?.refusedNote) {
    // Kept for the result (recordResult), whichever round or gate ends the ticket.
    run.tamperingNotes ??= new Map();
    run.tamperingNotes.set(n, plan.tampering.refusedNote);
  }
  // A browser-check pass's fingerprint, for the ticket's result (finishBuilt) and Landing (#36).
  let fingerprint = null;
  const failed = await projectGates(plan, {
    values: { base, N: n, qaUrl: runQaUrl(), cache: gateCache() },
    laneEnv: laneVariables(lane ? laneValues(lane, config) : null),
    browserCheck: () => {
      const verdict = browserCheckVerdict({ check: config.browserCheck, ticket, changed, startedAt, root: work });
      fingerprint = verdict.fingerprint;
      return verdict.problem;
    },
    stopStray: (when) => stopStray(`${when} for #${n}`),
  });
  if (failed) return fail(failed.gate, failed.output);

  // In a lane, doc-check accepts the number token only with PHASE_RUN_LANE set (ADR 0006).
  const docs = docCheck(run.runner, work, ["--head"], lane ? { ...process.env, PHASE_RUN_LANE: String(lane.id) } : process.env);
  if (!docs.ok) return fail("doc-check", `${docs.stdout}\n${docs.stderr}`);

  // A lane's migration waits for Landing's re-gate, never its own pass (ADR 0008).
  if (!afterPass(lane).migrate) {
    const waiting = newMigrations(base);
    if (waiting.length) log(`#${n}: ${waiting.join(", ")} not applied: in a lane, Landing applies it as the re-gate's last step.`);
    return { ok: true, fingerprint };
  }
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
  return { ok: true, fingerprint };
}

// ------------------------------------------------------- finishing a ticket

function readVerdict(number) {
  const path = join(sessionState(), `verdict-${number}.json`);
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
const ALWAYS_IN_SCOPE = [/^docs\//, /^CLAUDE\.md$/, /^GLOSSARY\.md$/, new RegExp(`^${LANE_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`)]; // a lane's own-file scratch (numbering.mjs), always (D13)

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
    return file && existsSync(join(work, file)) && pattern.test(readFileSync(join(work, file), "utf8"));
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

/** Written whole and renamed into place: the other lane reads this file (findings.mjs branchResults), and a half-written one would read as no results (#38). */
function saveResults(run) {
  const part = `${resultsFile(run)}.${process.pid}.part`;
  writeFileSync(part, `${JSON.stringify(run.all, null, 2)}\n`);
  renameSync(part, resultsFile(run));
}

/**
 * Records one ticket's result: its night row in the ledger, then the result in this run's list
 * and on disk at once. Every way a ticket ends comes through here: built, parked, failed, and the
 * runner's own error.
 */
function recordResult(run, result, at = Date.now()) {
  // A lane's result names its night (the shared runner copy's run), so every lane's report reads the same night (#38).
  const stamped = { ...withTamperingNote(run, result), runId: run.runId, ...(run.night ? { night: run.night } : {}), reported: false };
  recordNight(run, stamped, at);
  recordFound(run, stamped, at);
  run.results.push(stamped);
  run.all.push(stamped);
  saveResults(run);
  return stamped;
}

/**
 * A result with the tampering gate's refusal of a commit-message reason, if any round of this ticket
 * had one: a built ticket's notes, or a parked or failed ticket's detail (the report renders no notes
 * for those). Kept even when a later round passed, since the session tried to excuse itself.
 */
function withTamperingNote(run, result) {
  const note = run.tamperingNotes?.get(result.number);
  if (!note) return result;
  if (result.status === "built") return { ...result, notes: [...(result.notes ?? []), note] };
  return { ...result, detail: `${result.detail ?? ""}\n\n${note}` };
}

/**
 * The ticket's night row (ledger.mjs): its session priced whole from the transcript, so a crash
 * is priced as well as a measured result. A run keeps a ledger only when main() gave it a file.
 * A row that cannot be written marks the result "ledger: not written" and never stops the run.
 */
function recordNight(run, result, at) {
  if (!run.ledgerFile) return;
  try {
    const live = run.ticketSession?.number === result.number ? run.ticketSession : null;
    if (!live) throw new Error("no session was started for this ticket");
    // `transcript` is set only by tests; the runner finds the session's own file.
    const transcript = live.transcript ?? transcriptPath(live.sessionId);
    // No transcript: the session never ran (or its file is elsewhere). A $0 row would count a session that cost nothing.
    if (!transcript || !existsSync(transcript)) throw new Error(`no transcript was found for session ${live.sessionId}`);
    const cost = sessionCost(transcript, run.prices ?? loadPrices());
    appendRow(run.ledgerFile, ledgerRow({ at, sessionId: live.sessionId, transcript, kind: "night", ticket: result.number, branch: run.branch, brigade: run.brigade ?? null, cost }));
  } catch (error) {
    result.ledger = "not written";
    result.ledgerError = String(error?.message ?? error);
  }
}

/**
 * The result's findings (`foundElsewhere`) in the phase branch's one record (findings.mjs, D14): the
 * branch folder in the primary checkout, which a lane shares (`run.claims`) and a run without lanes
 * is (`run.dir`). A record that cannot be written leaves a note and never stops the run.
 */
function recordFound(run, result, at) {
  if (!result.foundElsewhere?.length) return;
  try {
    recordFindings({ dir: run.claims ?? run.dir, ticket: result.number, lane: result.lane ?? null, night: run.night ?? null, items: result.foundElsewhere, at });
  } catch (error) {
    (result.notes ??= []).push(`The findings record could not be written (${error.message}): this ticket's findings are only in its result.`);
  }
}

/** The report's line for a result whose night row was lost, or nothing. */
const ledgerNote = (r) => (r.ledger === "not written" ? [`⚠ ledger: not written (${r.ledgerError ?? "no reason recorded"}). This ticket's cost is missing from .phase-run/ledger.jsonl.`] : []);

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
    ...[...latest.values()].map((r) => `- #${r.number} ${r.title} (\`${r.hash}\`)${r.lane != null ? ` · lane ${r.lane}` : ""}`),
    "",
  ].join("\n");
}

function ensurePullRequest(run, options) {
  const bodyFile = join(run.dir, "pr-body.md");
  // A lane's body reads every lane's landed results (findings.mjs), checked against the phase branch: its own HEAD is its worktree's.
  const all = lane ? onBranch(branchResults(run.claims)) : run.all;
  const tip = lane ? `refs/heads/${run.branch}` : "HEAD";
  // Only commits still on the branch: results.json outlives a branch deleted or rebuilt by hand.
  const listed = all.filter((r) => r.status !== "built" || gitTry("merge-base", "--is-ancestor", r.hash, tip).ok);
  writeFileSync(bodyFile, pullRequestBody(listed, options));
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
  return existsSync(join(work, dir)) ? `${dir}/` : null;
}

async function finishBuilt(ticket, base, options, run, session, fingerprint = null) {
  const hash = git("rev-parse", "--short", "HEAD");
  const stat = git("diff", "--shortstat", `${base}..HEAD`);
  const files = git("diff", "--name-only", `${base}..HEAD`).split("\n").filter(Boolean);
  const migrations = newMigrations(base);
  const verdict = readVerdict(ticket.number) ?? {};

  // A lane's pass stays on its own branch, unpushed, for Landing (ADR 0008): the phase branch never moves here.
  const pushing = afterPass(lane).push;
  if (pushing) await waitForInternet(waitDeadline(options), `before pushing #${ticket.number}`); // a failed push is noted below
  const push = pushing ? gitTry("push", "-u", "origin", run.branch) : null;

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
    // What a browser-check pass judged (fingerprint.mjs), for Landing (#36); no key without one.
    ...(fingerprint ? { fingerprint } : {}),
    notes: [],
    session,
    // Unlanded: the commit is on the lane's branch, and Landing puts it on the phase branch (landPass).
    ...(lane ? { lane: String(lane.id), laneBranch: run.laneBranch, commit: git("rev-parse", "HEAD"), landed: false } : {}),
  };
  if (push && !push.ok) result.notes.push(`The push failed: ${tail(push.stderr, 400)}`);
  const stamped = recordResult(run, result);
  if (push?.ok) run.pullRequest = ensurePullRequest(run, options);
  log(`#${ticket.number} built: ${hash} (${stat || "no diff"})${lane ? `, kept on ${run.laneBranch} for Landing` : ""}.`, { routine: true });
  // A lane lands its pass at once (#37). The result is on disk first, unlanded, so a lane that dies
  // mid-landing leaves exactly what its restart lands (landUnlanded).
  const outcome = lane ? await landPass(ticket, stamped, stamped.commit, run, options) : "continue";
  ticketFinished(stamped);
  return outcome;
}

// ------------------------------------------------------------ landing (a lane)

/**
 * A lane's pass put on the phase branch (#37, D13, ADR 0008): Landing (landing.mjs) under the
 * landing lock (landing-lock.mjs), with the run's real gates as its re-gate. `result` is the pass's
 * recorded result, changed in place and saved: landed (its new hash, its numbers, the push), or
 * parked on `<branch>-parked-<N>` and posted as a park. Either way the lane's worktree is put back on
 * the phase branch's tip and its claim released. A lock that is never freed leaves the pass unlanded
 * on the lane's branch, for its restart, and stops the lane. Returns "continue" or "stop".
 */
async function landPass(ticket, result, commit, run, options) {
  const n = ticket.number;
  result.notes ??= [];
  setCurrent({ stage: "landing" });
  showProgress();
  await waitForInternet(waitDeadline(options), `before landing #${n}`); // the push needs it; a failed push is noted below
  log(`#${n}: landing on ${run.branch}.`, { routine: true });
  const appliedBefore = new Set(run.migrationsApplied); // a park after the migration leaves it on the target
  let landing;
  // The ticket's time takes its landing too (metrics.mjs withLanding): the lock's wait, then the landing.
  const askedAt = Date.now();
  let heldAt = null;
  try {
    const held = await underLandingLock(
      { dir: run.claims, root: ROOT, branch: run.branch, lane: lane.id, onWait: (holder) => log(`#${n}: waiting for ${holder?.lane ? `lane ${holder.lane}'s` : "another"} landing to finish.`) },
      () => {
        heldAt = Date.now();
        return land({
          repo: ROOT,
          branch: run.branch,
          ticket: n,
          commit,
          hotspots: config.hotspots,
          phase: run.branch.replace(/^phase-/, ""),
          rebuild: (dir) => rebuildGenerated(dir),
          regate: (dir, at) => regateLanded(ticket, at, run),
          fingerprint: result.fingerprint ?? null,
          shotsRoot: work,
          // The check is a session's walk of the screens: the runner can't redo it on the new tip.
          browserCheck: () => `The runner can't walk the screens itself, so the check was not run again on ${run.branch}'s tip: build #${n} again from there.`,
          migration: config.migrations ? { added: config.migrations.added, apply: (dir, names) => migrateLanded(names, run) } : null,
          remote: "origin",
        });
      },
    );
    landing = held.value;
    result.notes.push(...held.notes);
  } catch (error) {
    landing = { status: "unlanded", detail: error.message };
  }
  const endedAt = Date.now();
  if (result.session?.metrics) {
    result.session.metrics = withLanding(result.session.metrics, { waitedMs: (heldAt ?? endedAt) - askedAt, landingMs: heldAt === null ? 0 : endedAt - heldAt });
  }
  if (landing.cleanup) result.notes.push(landing.cleanup);

  if (landing.status === "unlanded") {
    result.notes.push(`Not landed: ${landing.detail} The pass stays on ${run.laneBranch}; the lane's next start lands it first.`);
    saveResults(run);
    run.stopped = `#${n} could not be landed: ${landing.detail}`;
    log(run.stopped);
    return "stop";
  }
  if (landing.status === "landed") {
    Object.assign(result, { landed: true, laneHash: result.hash, hash: landing.commit.slice(0, 7), commit: landing.commit, numbers: landing.numbers, pushed: landing.pushed });
    if (landing.browserCheck?.verdict === "carry") result.notes.push(landing.browserCheck.note);
    if (!landing.pushed) result.notes.push(`Landed, but the push failed: ${tail(landing.pushOutput ?? "", 400)}`);
    saveResults(run);
    if (landing.pushed) run.pullRequest = ensurePullRequest(run, options);
    log(`#${n} landed on ${run.branch}: ${result.hash}, devlog #${landing.numbers.devlog}${landing.pushed ? ", pushed" : ""}.`, { routine: true });
  } else {
    const attempt = landing.attempt ? `\n\nThe numbered commit it tried was ${landing.attempt.slice(0, 9)} (on no branch).` : "";
    const detail = `Landing parked #${n} at its ${landing.step} step, with ${run.branch} unmoved.\n\n${landing.detail}${attempt}`;
    const leftOnTarget = [...run.migrationsApplied].filter((name) => !appliedBefore.has(name));
    Object.assign(result, { status: "failed", landed: false, detail, keptOn: landing.keptOn, leftOnTarget, landing: { step: landing.step, attempt: landing.attempt ?? null, branchMoved: landing.branchMoved } });
    result.notPosted = postPark(ticket, "failure", detail, landing.keptOn, run);
    saveResults(run);
    log(`#${n} parked at Landing (${landing.step})${landing.keptOn ? `, kept on ${landing.keptOn}` : ""}.`);
    // Kept on no parked branch: the lane's branch is its only home, so it is not reset, and the lane stops.
    if (!landing.keptOn) {
      run.stopped = `#${n} parked at Landing, and its pass could not be kept on a parked branch: it stays on ${run.laneBranch}, which was left as it is.`;
      log(run.stopped);
      return "stop";
    }
  }
  // The pass is on the branch, or kept parked: the lane starts its next ticket from the new tip.
  let outcome = "continue";
  try {
    resetWorktree({ tree: work, ownBranch: run.laneBranch, tip: git("rev-parse", `refs/heads/${run.branch}`) });
  } catch (error) {
    run.stopped = `After #${n}'s landing, the lane's worktree could not be put back on ${run.branch}'s tip: ${error.message}`;
    log(run.stopped);
    outcome = "stop";
  }
  try {
    releaseClaim({ dir: run.claims, ticket: n, lane: lane.id, parked: landing.status !== "landed" });
  } catch (error) {
    log(`#${n}'s claim could not be released (it lapses when this lane exits): ${error.message}`);
  }
  return outcome;
}

/**
 * Landing's re-gate (ADR 0008): the run's real gates on the landed commit, run in the lane's own
 * worktree, which holds its install (Landing's scratch tree has only tracked files). The worktree is
 * checked out at `head`, detached; landPass puts it back on the lane's branch. The real gates, the
 * tampering verdict included (ADR 0008); only the browser check is left to Landing, which judges it
 * by its fingerprint. Null on a pass, else `{ gate, output }`.
 */
async function regateLanded(ticket, { base, head }, run) {
  const n = ticket.number;
  const moved = gitTry("checkout", "-q", "--detach", head);
  if (!moved.ok) return { gate: "re-gate", output: `The lane's worktree could not be checked out at the landed commit:\n${moved.stderr}` };
  // The tampering verdict reads its rules at the tip it lands on, never from the landed tree.
  const plan = gatePlan({
    base,
    diff: git("diff", "--name-status", "-M", "-z", `${base}..${head}`),
    config,
    ...(config.tampering ? { patch: git(...PATCH_ARGS, `${base}..${head}`), readAt: atCommit, body: ticket.body ?? "", message: git("log", "-1", "--format=%B", head) } : {}),
    testNamed: testNamedIn(work),
  });
  const failed = await projectGates(plan, {
    values: { base, N: n, qaUrl: runQaUrl(), cache: gateCache() },
    laneEnv: laneVariables(lane ? laneValues(lane, config) : null),
    browserCheck: () => null,
    stopStray: (when) => stopStray(`${when} for #${n}'s landing`),
  });
  if (failed) return failed;
  const docs = docCheck(run.runner, work, ["--head"]);
  return docs.ok ? null : { gate: "doc-check", output: `${docs.stdout}\n${docs.stderr}` };
}

/** Landing's migration, the re-gate's last step: the landed commit's new migrations, applied from the lane's worktree at it. */
function migrateLanded(names, run) {
  const pending = names.filter((name) => !run.migrationsApplied.has(name));
  if (pending.length === 0) return null;
  log(`Applying ${pending.join(", ")} to ${targetName()}, the landing's last gate.`);
  const applied = applyMigrations(pending, run.migrationsApplied, { migrations: config.migrations, values: { targetUrl: migrationTargetUrl, base: git("rev-parse", "HEAD^") } });
  return applied.ok ? null : { gate: `migration on ${targetName()}`, output: applied.output };
}

/**
 * Landing's rebuild of the generated rows, on the numbered tree: the doc indexes, as a session writes
 * them (`node tools/doc-index.mjs`). No hotspot row names a command of its own.
 */
function rebuildGenerated(dir) {
  if (!existsSync(join(dir, "tools", "doc-index.mjs"))) return { gate: "rebuild", output: "The landed tree has no tools/doc-index.mjs to rebuild its generated files with." };
  const built = exec("node", [join("tools", "doc-index.mjs")], { cwd: dir });
  return built.ok ? null : { gate: "rebuild", output: `${built.stdout}\n${built.stderr}` };
}

/**
 * A restarted lane's unlanded passes, landed before it claims new work (D13): the commits its branch
 * held, kept past the worktree's reset (keepUnlanded), oldest first, each given its action by
 * landing-lock.mjs `restartSteps`. A recorded pass is landed as any pass is, under a claim taken
 * first: while this lane was down its claim lapsed, and the other lane may be building it again. One
 * never recorded as a pass is kept on a parked branch, never landed; one the last start landed or
 * parked but died before recording has its result finished. The keep is dropped only once every
 * commit is on the phase branch or a parked branch. "continue" or "stop".
 */
async function landUnlanded(byNumber, run, options) {
  const self = String(lane.id);
  const found = unlandedCommits({ root: ROOT, branch: run.branch, laneBranch: run.laneBranch });
  let kept = true; // every commit is somewhere other than the keep
  const keep = (commit, n, why) => {
    const parked = keepParked(ROOT, run.branch, n ?? "unknown", commit);
    if (!parked.keptOn) kept = false;
    log(`${commit.slice(0, 7)}${n ? ` (#${n})` : ""} ${why}, so it was not landed${parked.keptOn ? `; it is kept on ${parked.keptOn}` : `, and could not be kept on a parked branch (${parked.output}); it stays on ${unlandedRef(run.laneBranch)}`}.`);
    return parked.keptOn;
  };
  for (const { commit, ticket: n, action, result, keptOn } of restartSteps({ found, results: run.all, lane: self })) {
    const ticket = byNumber.get(n) ?? { number: n, title: result?.title ?? `#${n}`, labels: [], body: "" };
    if (action === "skip") continue;
    if (action === "keep") {
      keep(commit, n, `was on ${run.laneBranch} with no recorded pass`);
      continue;
    }
    if (action === "record-landed") {
      const landedAs = gitTry("log", "-1", "--format=%H", "-i", "-E", `--grep=Closes #${n}([^0-9]|$)`, run.branch).stdout;
      Object.assign(result, { landed: true, laneHash: result.hash, hash: landedAs.slice(0, 7), commit: landedAs });
      (result.notes ??= []).push("Landed by the lane's last start, which stopped before it recorded the landing (its numbers and push are not known).");
      saveResults(run);
      continue;
    }
    if (action === "record-parked") {
      const detail = `Landing parked #${n} on the lane's last start, which stopped before it posted the park. ${run.branch} is unmoved; the pass is kept as it passed.`;
      Object.assign(result, { status: "failed", landed: false, detail, keptOn, leftOnTarget: [] });
      result.notPosted = postPark(ticket, "failure", detail, keptOn, run);
      saveResults(run);
      continue;
    }
    // "land": claimed first, unless the other lane holds the ticket now.
    const claim = takeClaim({ dir: run.claims, lane: self, choose: (claims) => (claims.some((c) => c.ticket === n && c.lane !== self) ? null : n) });
    if (claim.ticket === null) {
      const other = claim.claims.find((c) => c.ticket === n)?.lane;
      const on = keep(commit, n, `is being built again by lane ${other}, which claimed it while this lane was down`);
      Object.assign(result, { status: "failed", landed: false, keptOn: on, detail: `Lane ${other} claimed and built #${n} again while lane ${self} was down, so this lane's pass was not landed${on ? `; it is kept on ${on}` : ""}.` });
      saveResults(run);
      continue;
    }
    log(`#${n}: a pass the lane's last start never landed (${commit.slice(0, 7)}); landing it before any new ticket.`);
    if ((await landPass(ticket, result, commit, run, options)) === "stop") return "stop";
  }
  if (kept) dropUnlanded({ root: ROOT, laneBranch: run.laneBranch });
  return "continue";
}

/** A ticket is over: its row goes into the table, the live row moves on, and a failure or a park says so on the desktop. */
function ticketFinished(result) {
  if (progress) {
    progress.done += 1;
    progress.current = null;
    progress.finished.push(ticketMinutes(result) ?? progress.avgMinutes);
    progress.avgMinutes = Math.round(progress.finished.reduce((a, b) => a + b, 0) / progress.finished.length);
  }
  screen?.ticketDone(result);
  showProgress();
  if (result.status !== "built") notify(`#${result.number} ${result.status}`, `${result.title}${result.status === "parked" ? ": it needs your answer." : ": read the report."}`);
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
  const notPosted = postPark(ticket, kind, detail, keptOn, run);
  // The claim goes, and the park is listed: the other lane read this ticket's labels at its own start (#37).
  if (lane) {
    try {
      releaseClaim({ dir: run.claims, ticket: n, lane: lane.id, parked: true });
    } catch (error) {
      log(`#${n}'s claim could not be released (it lapses when this lane exits): ${error.message}`);
    }
  }

  // Applied to the target, but its file went with the reset: the target holds what the branch does not.
  const leftOnTarget = [...run.migrationsApplied].filter((name) => migrationFiles.has(name) && !existsSync(join(work, migrationFiles.get(name))));
  const stamped = recordResult(run, {
    number: n,
    title: ticket.title,
    status: kind === "question" ? "parked" : "failed",
    detail,
    keptOn,
    leftOnTarget,
    notPosted,
    session,
  });
  log(`#${n} ${kind === "question" ? "parked (needs the owner)" : "failed"}${keptOn ? `, kept on ${keptOn}` : ""}.`, { routine: true });
  ticketFinished(stamped);
}

/**
 * A park told on GitHub: the issue's comment and its label (`kind`, "question" or "failure"), and the
 * ticket set aside for this run. Returns true when either call did not get through (`notPosted`).
 */
function postPark(ticket, kind, detail, keptOn, run) {
  const n = ticket.number;
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
  return !(commented && labelled);
}

/**
 * A ticket's cost, time split and size (metrics.mjs, ticket-size.mjs), for
 * its result. A measure that cannot be taken is left out: it never stops the run.
 */
function measureTicketRun(ticket, startedAt, sessionId, gatesMs) {
  try {
    const metrics = ticketMetrics({
      transcript: transcriptPath(sessionId),
      startedAt,
      endedAt: Date.now(),
      gatesMs,
      hookMs: hookTime(join(sessionState(), "stop-check-log.jsonl"), ticket.number, startedAt),
      prices: loadPrices(),
      rules: stepRules(config),
    });
    const size = Object.fromEntries(ticketSize(ticket.body ?? "", config.ticketSize ?? DEFAULT_SIZE).map((m) => [m.key, m.value]));
    return { ...metrics, size };
  } catch (error) {
    return { error: String(error.message ?? error) };
  }
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

/**
 * The run's variables in one ticket's session. PHASE_RUN_RUNNER points the plugin's hooks at the
 * run's frozen copy of the runner and its config (snapshot.mjs, ADR 0005); PHASE_RUN_ROOT points
 * the copy's own scripts (stop-tests.mjs) back at the repo they check.
 */
function runVariables({ ticket, base, spec, runner, root, lane = null }) {
  return {
    PHASE_RUN: "1",
    PHASE_RUN_TICKET: String(ticket),
    PHASE_RUN_BASE: base,
    ...(spec ? { PHASE_RUN_SPEC: String(spec) } : {}),
    PHASE_RUN_RUNNER: runner,
    PHASE_RUN_ROOT: root,
    ...laneVariables(lane),
  };
}

/**
 * A lane's own variables (0.7.0, D2, D4), from lane.mjs laneValues: its row's env, then
 * PHASE_RUN_LANE (doc-check then accepts the number token, ADR 0006) and the QA port, QA database
 * and test prefix the project's tools read. Empty without a lane. The session gets them
 * (runVariables), and so does every gate the runner runs for the lane, Landing's re-gate included
 * (projectGates). Every lane names every value another lane names (config.mjs parseLanes), so none
 * is left to what a lane inherits. A row's env never names a PHASE_RUN_* variable (the loader).
 */
function laneVariables(lane) {
  if (!lane) return {};
  return {
    ...(lane.env ?? {}),
    PHASE_RUN_LANE: lane.id,
    ...(lane.qaPort ? { PHASE_RUN_QA_PORT: lane.qaPort } : {}),
    ...(lane.qaDatabase ? { PHASE_RUN_QA_DATABASE: lane.qaDatabase } : {}),
    ...(lane.testDbPrefix ? { PHASE_RUN_TEST_DB_PREFIX: lane.testDbPrefix } : {}),
  };
}

async function runTicket(ticket, options, run) {
  const n = ticket.number;
  const base = git("rev-parse", "HEAD");
  const startedAt = Date.now();
  let sessionId = randomUUID();
  // The session the ticket's night row prices, however the ticket ends (recordNight).
  run.ticketSession = { number: n, sessionId };
  // The session's root is the lane's worktree (ADR 0007): its hooks, receipts and stop check judge its own tree.
  const env = { ...sessionEnv(), ...runVariables({ ticket: n, base, spec: options.spec, runner: run.runner, root: work, lane: lane ? laneValues(lane, config) : null }) };
  rmSync(join(sessionState(), `verdict-${n}.json`), { force: true });
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
    flags: run.trim?.flags ?? [], // trim's launch flags (trim.mjs, D16)
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
    RUNNER: relative(work, run.runner).replaceAll("\\", "/"), // the copy, as the session's shell names it (from a lane's worktree, a ../ path)
    ...(lane ? { LANE: String(lane.id) } : {}), // the numbering paragraph (promptValues LANE_NUMBERS)
  };
  Object.assign(values, promptValues(config, projectProse, values));

  log(`#${n} ${ticket.title}: starting${options.print ? ` (session ${sessionId})` : ""}.`, { routine: true });
  if (progress) progress.current = { number: n, title: ticket.title, startedAt, steps: 0, stage: "starting", attach: null };
  showProgress();
  // Its cost and where its time went, kept with its result (metrics.mjs).
  let gatesMs = 0;
  const measured = (facts) => ({ ...facts, metrics: measureTicketRun(ticket, startedAt, sessionId, gatesMs) });
  let call = await runSession({
    ...session,
    prompt: render(readFileSync(runnerFile(run.runner, "ticket-prompt.md"), "utf8"), values),
    sessionId,
    resume: false,
    transcript: join(run.dir, `ticket-${n}-build.json`),
  });
  let facts = sessionFacts(call, null);

  for (let round = 0; ; round += 1) {
    sessionId = call.sessionId ?? sessionId;
    run.ticketSession.sessionId = sessionId;
    if (call.gaveUp) {
      await park(ticket, base, "failure", `${call.gaveUp} Nothing is wrong with the ticket itself; the run stopped here.`, run, measured(facts));
      return "stop";
    }
    if (call.timedOut) {
      await park(ticket, base, "failure", `The session ran past the ${options.minutes}-minute cap and was stopped.`, run, measured(facts));
      return "continue";
    }
    const verdict = readVerdict(n);
    if (verdict?.status === "parked") {
      await park(ticket, base, "question", verdict.question ?? "(The session parked the ticket without writing its question.)", run, measured(facts));
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
        measured(facts),
      );
      return "stop";
    }
    log(`#${n}: running the gates${round ? ` (after fix round ${round})` : ""}.`, { routine: true });
    setCurrent({ stage: "gates" });
    showProgress();
    const gatesFrom = Date.now();
    const gates = await runGates(ticket, base, options, run, startedAt);
    gatesMs += Date.now() - gatesFrom;
    if (gates.ok) {
      await freeTicketPorts();
      return await finishBuilt(ticket, base, options, run, measured(facts), gates.fingerprint);
    }
    if (round >= options.fixRounds) {
      await park(
        ticket,
        base,
        "failure",
        `The **${gates.gate}** check still failed after ${options.fixRounds} fix rounds. The end of its output:\n\n\`\`\`\n${tail(gates.output, 3000)}\n\`\`\``,
        run,
        measured(facts),
      );
      return "continue";
    }
    log(`#${n}: ${gates.gate} failed. Fix round ${round + 1} of ${options.fixRounds}.`);
    setCurrent({ stage: `fix round ${round + 1}`, steps: 0 });
    showProgress();
    call = await runSession({
      prompt: render(readFileSync(runnerFile(run.runner, "fix-prompt.md"), "utf8"), {
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
  // A lane's result says which lane built it (#38); a `foundElsewhere` item may be `{ finding, outcome }` (findings.mjs).
  const pick = (key) => results.flatMap((r) => (r[key] ?? []).map((line) => `#${r.number}${r.lane != null ? ` (lane ${r.lane})` : ""}: ${findingText(line)}`));
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

/**
 * The report's scoreboard: each ticket's minutes (Claude is the remainder
 * after everything measured), its cost at API rates (prices.json), its peak
 * context and its size. Size beside cost is what the size budget
 * (phaseRun.ticketSize) is retuned from.
 */
function scoreboardSection(results, { lanes = false } = {}) {
  const out = ["### Scoreboard", ""];
  // With lanes, a Lane column, and each result as where it stands (landed, unlanded, parked at Landing).
  out.push(`| # |${lanes ? " Lane |" : ""} Ticket | Result | Min | Claude | Tests | Checks | Browser | Slept | Reviews | Hook | Gates | Cost | Peak | Criteria | Areas | Words |`);
  out.push(`|---|${lanes ? "---|" : ""}---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|`);
  const cell = (value) => (value == null ? "—" : String(value));
  for (const r of results) {
    const m = r.session?.metrics ?? {};
    const t = m.minutes ?? {};
    const fixes = Math.max(0, (r.session?.calls ?? 1) - 1);
    const status = lanes ? laneState(r) : r.status;
    const result = r.status === "built" ? `${status}${fixes ? `, ${fixes} fix` : ""}` : status;
    out.push(
      `| ${r.number} |${lanes ? ` ${cell(r.lane)} |` : ""} ${r.title.replace(/\|/g, "/").slice(0, 48)} | ${result} | ${cell(ticketMinutes(r))} | ${cell(t.claude)} | ${cell(t.tests)} | ${cell(t.checks)} | ${cell(t.browser)} | ${cell(t.waiting)} | ${cell(t.reviewing)} | ${cell(t.hook)} | ${cell(t.gates)} | ${m.costUsd == null ? "—" : `$${m.costUsd.toFixed(2)}`} | ${m.peakContext ? `${Math.round(m.peakContext / 1000)}K` : "—"} | ${cell(m.size?.criteria)} | ${cell(m.size?.areas)} | ${cell(m.size?.words)} |`,
    );
  }
  const costs = results.map((r) => r.session?.metrics?.costUsd).filter((c) => c != null);
  const minutes = results.reduce((sum, r) => sum + (ticketMinutes(r) ?? 0), 0);
  out.push("", `${results.length} ticket(s), ${minutes} min${costs.length ? `, $${costs.reduce((a, b) => a + b, 0).toFixed(2)} at API rates (a usage gauge: a subscription plan is not billed per token)` : ""}. "Claude" is what is left after every measured wait: mostly the model thinking and writing.`, "");
  return out;
}

/**
 * A lane's night across every lane (#38, D14): the results every lane recorded under this night (the
 * shared runner copy's run), read from the branch folder, and the night's findings from its record.
 * Null for a run without lanes, whose report reads its own results only.
 */
function nightOf(run) {
  if (!run.night) return null;
  const results = branchResults(run.claims).filter((r) => r.night === run.night);
  let findings = [];
  let problem = null;
  try {
    findings = readFindings(run.claims).filter((row) => row.night === run.night);
  } catch (error) {
    problem = error.message;
  }
  const lanes = [...new Set(results.map((r) => r.lane))].sort();
  return { results, findings, problem, lanes };
}

function report(run, options, remaining, { final = true } = {}) {
  const night = nightOf(run);
  const results = night ? night.results : run.results;
  const atLanding = (r) => night && laneState(r) === "parked at Landing";
  const built = results.filter((r) => r.status === "built");
  const parked = results.filter((r) => r.status === "parked" || atLanding(r));
  const failed = results.filter((r) => r.status === "failed" && !atLanding(r));
  const laneOf = (r) => (night && r.lane != null ? ` · lane ${r.lane}` : "");
  const out = [];
  const thousands = (tokens) => `${Math.round(tokens / 1000)}K`;
  const money = (facts) =>
    facts?.metrics?.costUsd != null
      ? ` · $${facts.metrics.costUsd.toFixed(2)} at API rates, context up to ${thousands(facts.metrics.peakContext)}`
      : facts?.costUsd != null
        ? ` · $${facts.costUsd.toFixed(2)} at list price`
        : facts?.outputTokens
          ? ` · ${thousands(facts.outputTokens)} tokens written, context up to ${thousands(facts.peakContext)}`
          : "";
  const effort = (facts) => (facts ? `${facts.minutes} min · ${facts.turns} turns · ${facts.calls} session call(s)${money(facts)}` : "");

  out.push(`## Phase run report: ${run.branch}`, "");
  // The Brigade version whose hooks judged every ticket (brigade.mjs, D14).
  const version = run.brigade ? ` · Brigade ${run.brigade}` : "";
  const count = (state) => results.filter((r) => laneState(r) === state).length;
  const counts = night
    ? `lanes ${night.lanes.join(", ") || "none yet"} · landed ${count("landed")} · unlanded ${count("unlanded")} · parked ${parked.length} · failed ${failed.length}`
    : `built ${built.length} · parked ${parked.length} · failed ${failed.length}`;
  out.push(`${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC${version} · ${counts}`, "");
  // Only the last lane out writes the night's whole report; an earlier lane's says who is still building.
  for (const other of run.othersLive ?? []) out.push(`🕒 Lane ${other} is still running: its report, written when the last lane stops, is the night's whole report.`, "");
  if (run.brigade && run.stamp && run.stamp !== run.brigade) {
    out.push(`This project's runner is stamped ${run.stamp}; Brigade ${run.brigade} judged the run. \`/update-workflow\` brings the runner to the plugin's version.`, "");
  }
  if (run.catalog && !run.catalog.catalog) out.push(`⚠ Brigade's auto-update was not switched off for this run: ${run.catalog.why}`, "");
  if (!final) out.push("🕒 **In progress.** This file is rewritten after each ticket; the run had not finished when it was saved. If no later version exists, the run stopped here.", "");
  if (run.stopped) out.push(`🚨 **The run stopped early.** ${run.stopped}`, "");
  if (results.length) out.push(...scoreboardSection(results, { lanes: Boolean(night) }));

  // A ticket this run built again is reported once, under this run's own sections; with lanes, a
  // restart's earlier results of the same night are tonight's, never carried.
  const carried = (run.carried ?? []).filter((c) => !results.some((r) => r.number === c.number) && !(night && c.night === run.night));
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

  const builtLines = (r) => {
    if (r.summary) out.push(`- ${r.summary}`);
    out.push(`- Size: ${r.stat || "no diff"}`);
    if (r.outside.length) out.push(`- ⚠ Files outside the areas the ticket named: ${r.outside.map((f) => `\`${f}\``).join(", ")}`);
    if (r.migrations.length) out.push(`- Applied to ${targetName()}: ${r.migrations.join(", ")}`);
    if (r.destructive.length) out.push(`- 🚨 Destructive migration (it drops or rewrites data): ${r.destructive.join(", ")}`);
    if (r.screenshots) out.push(`- Screenshots: \`${r.screenshots}\``);
    if (r.session?.denials.length) out.push(`- Commands the session was refused (${r.session.denials.length}): ${r.session.denials.slice(0, 6).map((d) => `\`${String(d).slice(0, 60)}\``).join(", ")}`);
    for (const note of r.notes) out.push(`- ⚠ ${note}`);
    for (const note of ledgerNote(r)) out.push(`- ${note}`);
    if (r.session?.watch) out.push(`- The whole session, to read back: \`claude attach ${r.session.watch}\``);
    out.push(`- Effort: ${effort(r.session)}`, "");
  };
  if (night) {
    // A lane's pass is landed (on the branch) or unlanded (still on its lane's branch, for its restart).
    const landed = built.filter((r) => laneState(r) === "landed");
    const unlanded = built.filter((r) => laneState(r) === "unlanded");
    if (landed.length) out.push("### Landed", "");
    for (const r of landed) {
      out.push(`**#${r.number} ${r.title}**${laneOf(r)} · \`${r.hash}\``);
      builtLines(r);
    }
    if (unlanded.length) out.push("### Unlanded: passed, not on the branch yet", "");
    for (const r of unlanded) {
      out.push(`**#${r.number} ${r.title}**${laneOf(r)} · \`${r.hash}\`${r.laneBranch ? ` on \`${r.laneBranch}\`` : ""}`);
      builtLines(r);
    }
  } else {
    if (built.length) out.push("### Built", "");
    for (const r of built) {
      out.push(`**#${r.number} ${r.title}** · \`${r.hash}\``);
      builtLines(r);
    }
  }

  const lines = actionLines(built);
  for (const [title, list] of [
    ["Assumptions made (confirm or reverse each)", lines.assumptions],
    ["Run by hand", lines.byHand],
    // With lanes, the findings section below lists these from the record, with their outcomes.
    ["Found in other tickets' code (for the finish, or a ticket of its own)", night ? [] : lines.elsewhere],
    ["Handed forward (owed by a later ticket: check it took it)", lines.handed],
  ]) {
    if (!list.length) continue;
    out.push(`### ${title}`, "");
    for (const line of list) out.push(`- ${line}`);
    out.push("");
  }

  if (night && (night.findings.length || night.problem)) {
    out.push("### Findings", "", `What the night's sessions found in other tickets' code, from the record (\`${relative(ROOT, findingsPath(run.claims)).replaceAll("\\", "/")}\`). Give each open one its outcome: fixed, ticketed, taken or dropped.`, "");
    if (night.problem) out.push(`⚠ The findings record can't be read: ${night.problem}`, "");
    for (const row of night.findings) out.push(`- #${row.ticket}${row.lane != null ? ` (lane ${row.lane})` : ""}: ${row.finding} · ${row.outcome ?? "**open**"}`);
    if (night.findings.length) out.push("");
  }

  const unposted = (r) =>
    r.notPosted
      ? `⚠ GitHub could not be reached, so this was not posted on the issue. The ticket still carries \`${READY_LABEL}\` there, and the next run will try it again from the start.`
      : "";

  if (parked.length) out.push("### Parked: your decision is needed", "");
  for (const r of parked) out.push(`**#${r.number} ${r.title}**${laneOf(r)}`, "", r.detail, "", r.keptOn ? `Work kept on \`${r.keptOn}\`.` : "", unposted(r), ...ledgerNote(r), "");

  if (failed.length) out.push("### Failed", "");
  for (const r of failed) {
    out.push(`**#${r.number} ${r.title}**${laneOf(r)}`, "", r.detail, "", r.keptOn ? `Work kept on \`${r.keptOn}\`.` : "", unposted(r), ...ledgerNote(r));
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
  const { branch, current, remote, trim } = await preflight(options);
  // A lane reads "built" off the phase branch: its own HEAD holds passes not landed yet (#34).
  if (lane) builtRef = branch;
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

  // The Brigade version whose hooks judge the night (brigade.mjs, ADR 0005): read once here, before
  // the lock and the branch are touched, and again before each ticket. With none installed for this
  // repo, no ticket would run under Brigade's hooks.
  let installed;
  try {
    installed = readInstalledBrigade(ROOT, exec);
  } catch (error) {
    die(`Brigade's installed version can't be read, so the run can't hold to one version: ${error.message}`);
  }
  if (!installed) die(`Brigade is not installed for this repo: \`claude plugin list --json\` lists no brigade@… install for ${ROOT}, and none at user scope. Install it, then start the run again.`);

  mkdirSync(STATE, { recursive: true });
  // A lane's lock sits under .phase-run/ itself, so a lane started on a detached checkout finds its branch (lane.mjs joinBranch).
  const lock = lane ? laneLockPath(STATE, lane.id) : join(STATE, "lock");
  if (lane) writeLaneLock(STATE, { id: lane.id, pid: process.pid, branch, at: Date.now() });
  else writeFileSync(lock, `pid ${process.pid}, started ${new Date().toISOString()}, branch ${branch}\n`);
  const release = () => rmSync(lock, { force: true });
  process.on("exit", release);
  // The hand-back (D13): the last lane out, its own lock gone first, leaves the primary checkout on
  // the phase branch's tip, however it exits. While another lane runs, the checkout is left alone.
  if (lane) {
    process.on("exit", () => {
      const back = handBack({ root: ROOT, state: STATE, branch, lane: lane.id });
      log(`Hand-back: ${back.why}`, { routine: back.handedBack });
    });
  }
  process.on("exit", () => screen?.clearLive()); // a run stopped mid-ticket leaves no half-drawn live row
  // A background session outlives this script (it belongs to Claude Code's
  // background service), so a run that ends for any reason stops its own.
  process.on("exit", () => {
    if (!liveBackground) return;
    exec("claude", ["stop", liveBackground]);
    stopStray("by the session this run stopped");
  });
  process.on("SIGINT", () => process.exit(130));

  // A lane never checks a branch out in the primary checkout: it builds in its own worktree (below).
  const roots = lane ? laneRoots({ root: ROOT, branch, lane }) : null;
  if (!lane && current !== branch) {
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
    // Two roots (ADR 0007): a lane's results and logs are its own folder in the primary checkout.
    dir: roots ? roots.runDir : join(STATE, branch),
    laneBranch: roots?.branch ?? null, // where a lane's passing commits stay, unlanded
    claims: roots ? roots.copyDir : null, // the branch's folder in the primary checkout, whose claim file both lanes share (claim.mjs)
    runId: new Date().toISOString(),
    results: [], // this run's
    all: [], // every run's on this branch, as results.json holds them
    carried: [], // an earlier run's that never reached a report
    migrationsApplied: new Set(),
    pullRequest: null,
    ledgerFile: join(ROOT, LEDGER_PATH), // one night row per ticket (recordNight)
    brigade: installed, // the installed Brigade version that judges the night: in the manifest, the report and every night row
    stamp: stampVersion(ROOT), // the project's runner stamp, shown in the report when it differs
    catalog: brigadeCatalog(ROOT), // Brigade's catalog entry, for each ticket's auto-update override (or why there is none)
    ticketSession: null,
    runner: null, // the run's frozen copy of the runner and its config (takeSnapshot, below)
    trim, // this machine's trim list (trim.mjs, D16), or null: no trim
  };
  mkdirSync(run.dir, { recursive: true });
  run.all = loadResults(resultsFile(run));
  run.carried = run.all.filter((result) => !result.reported);
  const reportFile = join(run.dir, `report-${run.runId.slice(0, 16).replace(/[:T]/g, "-")}.md`);
  logFile = join(run.dir, "run.log");
  // One frozen copy of the runner and its config judges the whole run (snapshot.mjs, ADR 0005):
  // a restart after a crash reuses it, and is refused when the live runner's code changed since.
  // Both lanes share the branch's one copy: the first to start takes it, the second reuses it. A
  // lane's live runner is the phase branch's tip, as its worktree holds it, never whatever the
  // primary checkout has out (main, or detached by a landing).
  let made = null;
  if (lane) {
    try {
      // A lane with no other lane live starts a new night: the last night's parks are cleared.
      if (mayFinishCopy(STATE, { id: lane.id, branch })) clearParked(run.claims);
      // A restart's unlanded passes are kept on a hidden ref, so the reset to the tip loses none (#37).
      const { kept } = keepUnlanded({ root: ROOT, branch, laneBranch: roots.branch });
      made = prepareWorktree({ root: ROOT, tree: roots.tree, branch, ownBranch: roots.branch, kept });
    } catch (error) {
      die(`Lane ${lane.id} can't start: ${error.message}`);
    }
  }
  try {
    const snapshot = takeSnapshot({ root: roots ? roots.tree : ROOT, runDir: roots ? roots.copyDir : run.dir, runId: run.runId, commit: made ? made.tip : git("rev-parse", "HEAD"), at: Date.now(), brigade: run.brigade });
    run.runner = snapshot.dir;
    // A lane's night is the shared copy's run (ADR 0005): both lanes, and a restart, stamp the same one (#38).
    if (lane) run.night = snapshot.manifest.runId;
    log(snapshot.reused ? `Restarted on the runner copy taken ${snapshot.manifest.takenAt} (run ${snapshot.manifest.runId}).` : `Runner copy taken at ${snapshot.manifest.commit.slice(0, 7)}.`, { routine: true });
  } catch (error) {
    die(error.message);
  }
  // The runner's own gates and the prompt's checks come from the copy too, as the hooks' do: on a
  // restart the live config may have changed since the copy was taken.
  const frozen = loadRunConfig(run.runner);
  if (frozen.error) die(`The run's copy of the config cannot be read (${run.runner}): ${frozen.error}`);
  config = frozen.config;
  // The lane's worktree, now at the phase branch's tip, set up by the copy's rules (D8). Every
  // refusal names what to fix. From here on the session's root is the worktree.
  if (lane) {
    try {
      const live = lane;
      lane = laneRow(config, live.id); // the copy's row judges the night
      if (resolve(ROOT, lane.worktree) !== roots.tree) {
        throw new Error(`the run's copy names its worktree ${lane.worktree}, and the live config ${live.worktree}. A restart keeps the copy's rules: put the row back, or delete the copy to start fresh.`);
      }
      runQaUrl();
      const setup = config.lanes.worktreeSetup;
      const problem = ignoredImportsProblem(ignoredImports(roots.tree, [...setup.copy, ...setup.leaves]));
      if (problem) throw new Error(problem);
      setupWorktree({ root: ROOT, tree: roots.tree, setup, shell: (command, cwd) => shell(command, {}, cwd) });
      log(`Lane ${lane.id}: ${made.reused ? "reused" : "made"} ${roots.tree} on ${roots.branch}, at ${made.tip.slice(0, 7)}.`);
    } catch (error) {
      die(`Lane ${lane.id} can't start: ${error.message}`);
    }
    work = roots.tree;
  }
  mkdirSync(join(sessionState(), "tmp"), { recursive: true }); // where a session keeps its scratch files
  liveFile = join(run.dir, "live.json");
  const appliedFile = join(run.dir, "migrations-applied.json");
  if (existsSync(appliedFile)) for (const name of JSON.parse(readFileSync(appliedFile, "utf8"))) run.migrationsApplied.add(name);

  // "6 of 10": the tickets this run can reach (ready now, or waiting only on
  // another ticket), up to --max. The time per ticket starts at the branch's
  // own average, then follows this run's.
  const reachable = inScope.filter((ticket) => {
    const reason = holdReason(ticket, byNumber);
    if (lane && !takesTicket(lane.takes, ticket)) return false; // a lane counts only what its row takes
    return reason === null || reason.startsWith("waiting on #");
  });
  const earlier = run.all.map(ticketMinutes).filter((minutes) => minutes != null);
  screen = new Screen();
  progress = {
    label: `${branch.replace(/^phase-/, "").toUpperCase()} phase run`,
    done: 0,
    total: Math.min(options.max, reachable.length),
    startedAt: Date.now(),
    avgMinutes: earlier.length ? Math.round(earlier.reduce((a, b) => a + b, 0) / earlier.length) : 80,
    finished: [],
    current: null,
  };
  screen.begin(progress);

  log(
    `Run started on ${branch}${lane ? ` as lane ${lane.id}, in ${work}` : ""}: ${limit} ticket(s)${options.until ? `, stopping after #${options.until}` : ""}, ` +
      `${options.minutes} min each, ${options.fixRounds} fix rounds, Brigade ${run.brigade}.`,
    { routine: true },
  );
  if (!run.catalog.catalog) log(`Brigade's auto-update is not switched off for this run: ${run.catalog.why}`);
  showProgress();

  let outcome = "continue";
  // A restarted lane lands its own unlanded passes before it claims new work (D13).
  if (lane) {
    try {
      outcome = await landUnlanded(byNumber, run, options);
    } catch (error) {
      run.stopped = `The lane's unlanded passes could not be landed: ${error.message}`;
      log(run.stopped);
      outcome = "stop";
    }
    writeFileSync(appliedFile, JSON.stringify([...run.migrationsApplied], null, 2)); // a landing may have migrated
  }
  while (outcome === "continue" && run.results.length < options.max) {
    let next;
    try {
      next = await nextTicket(inScope, byNumber, run);
    } catch (error) {
      // A lane's claim file or its lock refused (claim.mjs): the run still reaches its report.
      run.stopped = `No ticket could be claimed: ${error.message}`;
      log(run.stopped);
      break;
    }
    if (!next) break;
    if (!(await waitForInternet(waitDeadline(options), `before #${next.number}`))) {
      run.stopped = `The internet connection did not come back within ${options.waitHours} hours, so #${next.number} was never started.`;
      log(run.stopped);
      break;
    }
    // An attended session elsewhere may have updated Brigade: the next ticket would be judged by other hooks.
    const changed = versionStop(run.brigade, () => readInstalledBrigade(ROOT, exec));
    if (changed) {
      run.stopped = `${changed} #${next.number} was never started.`;
      log(run.stopped);
      break;
    }
    try {
      outcome = await runTicket(next, options, run);
    } catch (error) {
      log(`#${next.number}: the runner itself hit an error and stopped: ${error.message}`);
      ticketFinished(recordResult(run, { number: next.number, title: next.title, status: "failed", detail: `The runner stopped on an error of its own:\n\n\`\`\`\n${error.stack ?? error.message}\n\`\`\`\n\nThe branch was left as it was. Look before running again.`, keptOn: null, session: null }));
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

  const health = docCheck(run.runner, work, ["--report"]);
  run.docHealth = health.ok ? health.stdout : null;
  // A night that pushed nothing still reports on an earlier night's pull request.
  if (!run.pullRequest) {
    const existing = exec("gh", ["pr", "view", branch, "--json", "url", "-q", ".url"]);
    if (existing.ok && existing.stdout) run.pullRequest = existing.stdout;
  }
  // A lane's report reads every lane's night (#38). Only the last lane out posts it: an earlier
  // lane's is the night so far, and says which lanes still run. Its own lock goes first, so of two
  // lanes reaching here together the second sees the first gone; at worst both post, never neither.
  if (lane) release();
  if (lane) run.othersLive = liveLanes(STATE).filter((lock) => lock.branch === branch && String(lock.lane) !== String(lane.id)).map((lock) => String(lock.lane));
  const lastOut = !lane || run.othersLive.length === 0;
  const text = report(run, options, remaining);
  writeFileSync(reportFile, text);
  for (const result of run.all) result.reported = true;
  saveResults(run);
  // The run reached its report: the next one takes a fresh copy. Both lanes share it, so only the last lane out marks it.
  if (lastOut) finishSnapshot(run.runner);
  if (run.pullRequest && lastOut) exec("gh", ["pr", "comment", branch, "--body-file", reportFile]);
  log(`Run finished. Report: ${reportFile}${run.pullRequest ? ` · pull request: ${run.pullRequest}` : ""}`);
  rmSync(liveFile, { force: true });
  const counts = ["built", "parked", "failed"].map((status) => `${status} ${run.results.filter((r) => r.status === status).length}`).join(" · ");
  notify(`${progress.label} finished`, `${counts}. The report is in ${relative(ROOT, reportFile)}.`);
  if (screen.tty) screen.end(run.results);
  else console.log(`\n${text}`);
}

// Exported so these can be tested without starting a run.
export {
  QUIET_MS,
  SETTLE_MS,
  applyMigrations,
  backgroundArgs,
  browserCheckVerdict,
  docCheck,
  fetchBlockers,
  gatePlan,
  gotchasFile,
  holdReason,
  implementationLogAdded,
  loadResults,
  online,
  outsideAreas,
  printArgs,
  projectGates,
  promptValues,
  pullRequestBody,
  render,
  readTurn,
  recordResult,
  report,
  runSession,
  runVariables,
  laneVariables,
  runnerFile,
  screenshotsSince,
  sessionEnv,
  sessionSettings,
  startJob,
  stopCheckRunning,
  stopStray,
  trimmedSettings,
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
