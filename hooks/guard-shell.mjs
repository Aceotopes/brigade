// PreToolUse hook for the Bash and PowerShell tools (.claude/settings.json).
// It enforces rules that used to rest on a session remembering CLAUDE.md.
// Exit 2 blocks the command and hands the message on stderr to the session.
//
// Always:
//   - no formatter run (`prettier --write`, `prisma format`): both rewrite whole files here
//   - no `--no-verify`
//   - no attribution trailer on a commit or a pull request
//   - no closing keyword on a spec issue (GitHub would close what the owner closes by hand)
//   - doc-check runs before `git commit`
// Inside a phase run (STJ_PHASE_RUN=1), also:
//   - no push at all: the runner is the only pusher
//   - no commit off a `phase-*` branch, no branch switching, no merge or rebase
//   - no closing an issue or opening a pull request by hand
//   - no migration against anything but a local database: the runner applies
//     each new migration to dev Neon after the ticket's checks pass
//   - no printing `.env` (cat, head, tail, grep and the like)
//
// Matching is on the command text, so it is a guard rail, not a sandbox. The
// runner's own gates (tools/phase-run/run.mjs) check the result again.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const IN_RUN = process.env.STJ_PHASE_RUN === "1";

function block(message) {
  process.stderr.write(`Blocked by .claude/hooks/guard-shell.mjs: ${message}\n`);
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
function specIssues() {
  const numbers = new Set();
  const path = join(ROOT, ".claude", "hooks", "spec-issues.json");
  if (existsSync(path)) {
    for (const n of JSON.parse(readFileSync(path, "utf8")).specs ?? []) numbers.add(String(n));
  }
  if (process.env.STJ_PHASE_SPEC) numbers.add(String(process.env.STJ_PHASE_SPEC));
  return numbers;
}

/**
 * The command split into simple commands, each with its leading wrappers
 * (env assignments, `pnpm exec`, `npx`, `cd x &&`) stripped. A separator
 * inside a quoted string splits wrongly, which only yields fragments that
 * start with prose and match nothing.
 */
function simpleCommands(command) {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((part) =>
      part
        .trim()
        .replace(/^(\w+=("[^"]*"|'[^']*'|\S*)\s+)+/, "")
        .replace(/^(pnpm\s+(exec|dlx)\s+|npx\s+(--yes\s+|-y\s+)?|pnpm\s+)/, "")
        // git's global options sit before the subcommand (`git -c x=y stash`, `git --no-pager push`);
        // dropped, so every rule below sees `git <subcommand>` (#194's review). `-C <dir>` is kept: the rules name it.
        .replace(/^git((?:\s+(?:-c\s+\S+|--no-pager|--paginate|-p|--no-optional-locks|--literal-pathspecs|--git-dir(?:=|\s+)\S+|--work-tree(?:=|\s+)\S+))+)(?=\s)/, "git"),
    )
    .filter(Boolean);
}

function currentBranch() {
  try {
    return execFileSync("git", ["branch", "--show-current"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** The text of a commit or PR message: the command itself, plus a `-F` file. */
function messageText(command) {
  let text = command;
  const file = command.match(/(?:\s-F|\s--file|\s--body-file)[=\s]+("([^"]+)"|'([^']+)'|(\S+))/);
  const path = file && (file[2] ?? file[3] ?? file[4]);
  if (path && path !== "-") {
    const abs = resolve(ROOT, path);
    if (existsSync(abs)) text += `\n${readFileSync(abs, "utf8")}`;
  }
  return text;
}

function main() {
  const input = readStdin();
  const command = input?.tool_input?.command;
  if (typeof command !== "string" || command.trim() === "") process.exit(0);

  const commands = simpleCommands(command);
  const starts = (pattern) => commands.some((c) => pattern.test(c));

  if (commands.some((c) => /^prettier\b/.test(c) && /\s(--write|-w)\b/.test(c))) {
    block("`prettier --write` rewrites whole files in this repo. Edit by hand and check `git diff --stat`.");
  }
  if (starts(/^prisma\s+format\b/)) {
    block("`prisma format` rewrites the whole schema file. Edit prisma/schema.prisma by hand.");
  }
  if (commands.some((c) => /^git\b/.test(c) && /\s--no-verify\b/.test(c))) {
    block("`--no-verify` skips the checks. Fix what the check found.");
  }

  const isCommit = starts(/^git\s+(-C\s+\S+\s+)?commit\b/);
  const isPrWrite = starts(/^gh\s+pr\s+(create|edit|comment)\b/);

  if (isCommit || isPrWrite) {
    const text = messageText(command);
    if (/co-authored-by:|claude-session:|generated with \[?claude|🤖 generated/i.test(text)) {
      block("no attribution trailer on any commit or pull request (CLAUDE.md, Working agreement).");
    }
    const specs = specIssues();
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
    if (starts(/^git\s+(-C\s+\S+\s+)?push\b/)) {
      block("a phase-run session never pushes. The runner pushes the branch once the ticket's checks pass.");
    }
    if (starts(/^git\s+(-C\s+\S+\s+)?(checkout|switch|merge|rebase|cherry-pick|branch\s+-[dDmM])\b/)) {
      block("a phase-run session stays on its phase branch: no branch switching, merge or rebase.");
    }
    if (starts(/^git\s+(-C\s+\S+\s+)?reset\s+--hard\b/) || starts(/^git\s+(-C\s+\S+\s+)?clean\b/)) {
      block("a phase-run session never discards work. If the ticket cannot be finished, write the verdict file and stop.");
    }
    // A stash hides work from the clean-tree check and from the ticket's commit; a restarted 6C
    // session found one and applied it (#194). Reading the list stays allowed.
    if (starts(/^git\s+(-C\s+\S+\s+)?stash\b(?!\s+(list|show)\b)/)) {
      block("a phase-run session never stashes: a stash hides work from the ticket's commit. Commit the work, or delete what is not wanted.");
    }
    // The allow list lets a session delete under .phase-run/tmp/ only; `..` would walk out of it.
    if (starts(/^(rm|remove-item|ri|del|erase)\b.*\.\.[\\/]/i)) {
      block("a phase-run session deletes only inside .phase-run/tmp/, never through `..`. Name the file directly.");
    }
    if (isCommit && !/^phase-/.test(currentBranch())) {
      block(`a phase-run session commits only on a phase-* branch (this is "${currentBranch()}").`);
    }
    if (starts(/^gh\s+issue\s+close\b/) || starts(/^gh\s+pr\s+(create|merge|close|ready)\b/)) {
      block("the runner opens the pull request, and issues close when the owner merges it. Do neither by hand.");
    }
    const migrates = commands.some(
      (c) => /^prisma\s+(migrate\s+(deploy|resolve|reset|dev)|db\s+(push|execute))\b/.test(c),
    );
    const local = /localhost|127\.0\.0\.1/.test(command);
    if ((migrates && !local) || /apply-pending-migrations/.test(command)) {
      block(
        "a phase-run session never migrates dev Neon. The test database and stj_cast take migrations on their own; " +
          "the runner applies a new migration to dev Neon after the ticket's checks pass.",
      );
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
      block("the doc-check baseline is not updated inside a phase run. Fix the line it names.");
    }
  }

  if (isCommit) {
    const args = ["tools/doc-check.mjs"];
    const amend = /\s--amend\b/.test(command);
    const fileMatch = command.match(/(?:\s-F|\s--file)[=\s]+("([^"]+)"|'([^']+)'|(\S+))/);
    const path = fileMatch && (fileMatch[2] ?? fileMatch[3] ?? fileMatch[4]);
    if (path && path !== "-" && existsSync(resolve(ROOT, path))) {
      args.push("--message-file", resolve(ROOT, path));
    } else if (/\s(-m|--message)[=\s]/.test(command)) {
      // An inline message: the command's own text holds it, heredoc and all.
      args.push("--message", command);
    }
    if (amend && args.length > 1) args.push("--amend");

    const check = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });
    if (check.status !== 0) {
      block(`doc-check failed, so the commit did not run.\n${(check.stderr || check.stdout || "").slice(0, 4000)}`);
    }
  }

  process.exit(0);
}

main();
