// PreToolUse hook for the Bash and PowerShell tools (the plugin's hooks.json).
// It enforces rules that used to rest on a session remembering CLAUDE.md.
// Exit 2 blocks the command and hands the message on stderr to the session.
//
// The project is CLAUDE_PROJECT_DIR. Each simple command is aimed at a folder
// (the session's cwd, moved by a `cd` before it or git's `-C`). A rule of the
// project's own (doc-check, spec issues, the formatter and migration rules)
// passes a command aimed at another repo; the owner's rules (no `--no-verify`,
// no attribution trailer) hold everywhere. Inside a phase run every rule holds
// for every command: an unattended session has no business elsewhere.
//
// Always:
//   - the project's own block rules, from its .claude/workflow.json
//     (hooks/workflow-config.mjs: a formatter that rewrites whole files, a migration rule)
//   - no `--no-verify`
//   - no attribution trailer on a commit or a pull request
//   - no closing keyword on a spec issue (GitHub would close what the owner closes by hand)
//   - doc-check runs before `git commit`
// Inside a phase run (PHASE_RUN=1), also:
//   - no push at all: the runner is the only pusher
//   - no commit off a `phase-*` branch, no branch switching, no merge or rebase
//   - no closing an issue or opening a pull request by hand
//   - the project's `"when": "phase-run"` block rules
//   - no printing `.env` (cat, head, tail, grep and the like)
//
// Matching is on the command text, so it is a guard rail, not a sandbox. The
// runner's own gates (tools/phase-run/run.mjs) check the result again.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { judgeRoot, loadJudgeGuard } from "./workflow-config.mjs";

const IN_RUN = process.env.PHASE_RUN === "1";
/** One shell word: double-quoted, single-quoted, or bare. */
const WORD = String.raw`("[^"]*"|'[^']*'|\S+)`;

function block(message) {
  process.stderr.write(`Blocked by Brigade's guard-shell hook: ${message}\n`);
  process.exit(2);
}

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

/** Spec issues are closed by the owner's hand, never by a commit keyword. */
function specIssues(root) {
  const numbers = new Set();
  const path = join(root, ".claude", "spec-issues.json");
  if (existsSync(path)) {
    for (const n of JSON.parse(readFileSync(path, "utf8")).specs ?? []) numbers.add(String(n));
  }
  if (process.env.PHASE_RUN_SPEC) numbers.add(String(process.env.PHASE_RUN_SPEC));
  return numbers;
}

/** True when the run's copy at `dir` says it took a doc-check (snapshot.mjs's manifest, 0.7.0). */
function copyTookDocCheck(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).docCheck === true;
  } catch {
    return false;
  }
}

/** A path as a shell wrote it, made absolute: quotes off, `~` expanded, Git Bash's `/d/x` read as `d:/x`. */
function toPath(word, from) {
  let path = word.replace(/^(["'])(.*)\1$/, "$2");
  if (path === "~" || /^~[\\/]/.test(path)) path = join(homedir(), path.slice(1));
  if (process.platform === "win32") path = path.replace(/^\/([a-z])(\/|$)/i, "$1:/");
  return resolve(from, path);
}

/**
 * A folder the shell computes (`$PWD`, `%CD%`, `` `pwd` ``) cannot be resolved here. Such a `cd` or
 * `-C` leaves the folder where it was, so the project's rules still apply: guessing "elsewhere"
 * would let a command through unchecked.
 */
const COMPUTED = /[$`]|%[^%\s]+%/;

/** True when `dir` is `root` or under it (path.relative compares without case on Windows). */
function inside(root, dir) {
  const rel = relative(root, dir);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const CHANGE_DIR = new RegExp(String.raw`^(?:cd|chdir|set-location|sl|pushd)(?:\s+-(?:Literal)?Path)?\s+${WORD}\s*$`, "i");
// git's global options sit before the subcommand (`git -c x=y stash`, `git --no-pager push`);
// dropped, so every rule below sees `git <subcommand>` (#194's review). `-C <dir>` moves the command's folder.
const GIT_GLOBAL = new RegExp(
  String.raw`^\s+(?:-C\s+${WORD}|-c\s+\S+|--no-pager|--paginate|-p|--no-optional-locks|--literal-pathspecs|--git-dir(?:=|\s+)\S+|--work-tree(?:=|\s+)\S+)(?=\s|$)`,
);

/**
 * The project's wrappers (`guard.wrappers`: `pnpm exec`, `bunx`, `yarn dlx`…) as one pattern, the longest
 * first so `pnpm exec` wins over `pnpm`, each taking the flags right after it (`npx -y`).
 */
function wrapperPattern(wrappers) {
  const alternatives = [...wrappers]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.trim().split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(String.raw`\s+`));
  return new RegExp(String.raw`^(?:${alternatives.join("|")})\s+(?:--?[A-Za-z][\w-]*\s+)*`);
}

/**
 * The command split into simple commands, each with its leading wrappers
 * (env assignments, then one of the project's `guard.wrappers`) stripped, and the folder it is aimed
 * at: a `cd` (or Set-Location, pushd) moves every command after it, git's
 * `-C <dir>` its own. A separator inside a quoted string splits wrongly, which
 * only yields fragments that start with prose and match nothing.
 */
function simpleCommands(command, cwd, wrappers) {
  const strip = wrapperPattern(wrappers);
  let dir = cwd;
  const out = [];
  for (const part of command.split(/&&|\|\||[;|\n]/)) {
    let text = part
      .trim()
      .replace(/^(\w+=("[^"]*"|'[^']*'|\S*)\s+)+/, "")
      .replace(strip, "");
    if (!text) continue;
    const cd = text.match(CHANGE_DIR);
    if (cd && !COMPUTED.test(cd[1])) dir = toPath(cd[1], dir);
    let target = dir;
    if (/^git\s/.test(text)) {
      let rest = text.slice(3);
      for (let option = rest.match(GIT_GLOBAL); option; option = rest.match(GIT_GLOBAL)) {
        if (option[1] && !COMPUTED.test(option[1])) target = toPath(option[1], target);
        rest = rest.slice(option[0].length);
      }
      text = `git${rest}`;
    }
    out.push({ text, dir: target });
  }
  return out;
}

function currentBranch(root) {
  try {
    return execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** A `-F` / `--file` / `--body-file` path in the command, if any, read from `dir`. */
function messageFile(command, dir, flags = String.raw`\s-F|\s--file|\s--body-file`) {
  const file = command.match(new RegExp(String.raw`(?:${flags})[=\s]+${WORD}`));
  if (!file || file[1] === "-") return null;
  const abs = toPath(file[1], dir);
  return existsSync(abs) ? abs : null;
}

/** The text of a commit or PR message: the command itself, plus a `-F` file. */
function messageText(command, dir) {
  const file = messageFile(command, dir);
  return file ? `${command}\n${readFileSync(file, "utf8")}` : command;
}

function main() {
  const input = readStdin();
  const command = input?.tool_input?.command;
  if (typeof command !== "string" || command.trim() === "") process.exit(0);

  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const root = resolve(process.env.CLAUDE_PROJECT_DIR || cwd);
  // A broken guard section is refused outright: a rule that silently stopped applying is worse. A
  // fault elsewhere in the file (a key from a newer Brigade) is not the guard's to judge, so the
  // shell keeps working and the session-start notice names it. Inside a run the rules are its frozen
  // copy's (PHASE_RUN_RUNNER, ADR 0005): a rule written mid-night judges the next run, not this one.
  const config = loadJudgeGuard(root);
  if (config.error) {
    const fix = process.env.PHASE_RUN_RUNNER ? "Write the verdict file and stop" : "Fix the file (the Edit tool still works)";
    block(`${config.error}\n${fix}; until then no shell command runs.`);
  }
  const all = simpleCommands(command, cwd, config.wrappers);
  // The project's rules hold for the commands aimed at it; inside a phase run, for every command.
  const mine = IN_RUN ? all : all.filter((c) => inside(root, c.dir));
  const find = (list, pattern) => list.find((c) => pattern.test(c.text));
  const starts = (pattern) => Boolean(find(mine, pattern));
  const commands = mine.map((c) => c.text);
  for (const rule of config.rules) {
    if (rule.when === "phase-run" && !IN_RUN) continue;
    const hit = rule.command
      ? mine.some((c) => rule.command.test(c.text) && (!rule.with || rule.with.test(c.text)))
      : mine.length > 0 && rule.text.test(command);
    if (hit && !rule.unless?.test(command)) block(rule.message);
  }

  if (all.some((c) => /^git\b/.test(c.text) && /\s--no-verify\b/.test(c.text))) {
    block("`--no-verify` skips the checks. Fix what the check found.");
  }

  const COMMIT = /^git\s+commit\b/;
  const PR_WRITE = /^gh\s+pr\s+(create|edit|comment)\b/;
  const message = find(all, COMMIT) ?? find(all, PR_WRITE);
  const isCommit = starts(COMMIT);

  if (message) {
    const text = messageText(command, message.dir);
    if (/co-authored-by:|claude-session:|generated with \[?claude|🤖 generated/i.test(text)) {
      block("no attribution trailer on any commit or pull request (CLAUDE.md, Working agreement).");
    }
    const specs = isCommit || starts(PR_WRITE) ? specIssues(root) : new Set();
    for (const match of text.matchAll(/\b(clos(?:e|es|ed)|fix(?:es|ed)?|resolv(?:e|es|ed))\s*:?\s+#(\d+)/gi)) {
      if (specs.has(match[2])) {
        block(
          `"${match[1]} #${match[2]}" would close a spec issue, which the owner closes by hand. ` +
            `Write "Part of #${match[2]}" or cite the number without a keyword.`,
        );
      }
    }
  }

  if (IN_RUN) {
    if (starts(/^git\s+push\b/)) {
      block("a phase-run session never pushes. The runner pushes the branch once the ticket's checks pass.");
    }
    if (starts(/^git\s+(checkout|switch|merge|rebase|cherry-pick|branch\s+-[dDmM])\b/)) {
      block("a phase-run session stays on its phase branch: no branch switching, merge or rebase.");
    }
    if (starts(/^git\s+reset\s+--hard\b/) || starts(/^git\s+clean\b/)) {
      block("a phase-run session never discards work. If the ticket cannot be finished, write the verdict file and stop.");
    }
    // A stash hides work from the clean-tree check and from the ticket's commit; a restarted 6C
    // session found one and applied it (#194). Reading the list stays allowed.
    if (starts(/^git\s+stash\b(?!\s+(list|show)\b)/)) {
      block("a phase-run session never stashes: a stash hides work from the ticket's commit. Commit the work, or delete what is not wanted.");
    }
    // The allow list lets a session delete under .phase-run/tmp/ only; `..` would walk out of it.
    if (starts(/^(rm|remove-item|ri|del|erase)\b.*\.\.[\\/]/i)) {
      block("a phase-run session deletes only inside .phase-run/tmp/, never through `..`. Name the file directly.");
    }
    if (isCommit && !/^phase-/.test(currentBranch(root))) {
      block(`a phase-run session commits only on a phase-* branch (this is "${currentBranch(root)}").`);
    }
    if (starts(/^gh\s+issue\s+close\b/) || starts(/^gh\s+pr\s+(create|merge|close|ready)\b/)) {
      block("the runner opens the pull request, and issues close when the owner merges it. Do neither by hand.");
    }
    // `.env` holds live credentials. The runner pins the two that matter in a
    // session's environment (run.mjs, sessionEnv); this stops the file being
    // printed into the transcript. `.env.example` holds none and stays readable.
    const printsDotEnv = commands.some(
      (c) =>
        /^(cat|head|tail|more|less|type|sed|awk|grep|rg|get-content|gc)\b/i.test(c) &&
        /(^|[\s"'=/\\])\.env(?!\.example)(?![\w-])/.test(c),
    );
    if (printsDotEnv) {
      block("a phase-run session never reads `.env`: it holds live credentials. `.env.example` lists the names.");
    }
    if (/doc-check\.mjs\b.*--update-baseline/.test(command)) {
      block("the doc-check baseline is not updated inside a phase run: the night's docs are judged by the baseline the run's copy took at run start (ADR 0005). Fix the line it names.");
    }
  }

  // A project without the doc tools has nothing to check; its commits are not blocked for it.
  // Inside a run the doc-check is the run's copy's (D10), as the runner's gate is, pointed at the
  // project; a copy taken by an older runner holds none, and the live one checks, as before. A copy
  // whose manifest says it took one, and has lost it, blocks: the live one must not judge instead.
  const copied = process.env.PHASE_RUN_RUNNER ? join(judgeRoot(root), "tools", "doc-check.mjs") : null;
  if (isCommit && copied && !existsSync(copied) && copyTookDocCheck(judgeRoot(root))) {
    block(`the phase run's runner copy (${judgeRoot(root)}) has lost its tools/doc-check.mjs. Write the verdict file and stop; the owner deletes the copy to start a fresh run.`);
  }
  const docCheck = copied && existsSync(copied) ? copied : join(root, "tools", "doc-check.mjs");
  if (isCommit && existsSync(docCheck)) {
    const args = [docCheck];
    const amend = /\s--amend\b/.test(command);
    const file = messageFile(command, find(mine, COMMIT).dir, String.raw`\s-F|\s--file`);
    if (file) {
      args.push("--message-file", file);
    } else if (/\s(-m|--message)[=\s]/.test(command)) {
      // An inline message: the command's own text holds it, heredoc and all.
      args.push("--message", command);
    }
    if (amend && args.length > 1) args.push("--amend");

    const env = docCheck === copied ? { ...process.env, PHASE_RUN_ROOT: root } : process.env;
    const check = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", env });
    if (check.status !== 0) {
      block(`doc-check failed, so the commit did not run.\n${(check.stderr || check.stdout || "").slice(0, 4000)}`);
    }
  }

  process.exit(0);
}

main();
