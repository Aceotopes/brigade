// What the hook tests share: a throwaway git repository to stand in for a project, and a way to
// run a hook the way Claude Code does (JSON on stdin, CLAUDE_PROJECT_DIR in the environment).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// A suite run from inside a phase run (the stop check, a gate) sees an attended session: a test
// that wants the runner's variables sets them itself. Without this, doc-check spawned "attended"
// inherits PHASE_RUN and refuses what only a phase run refuses (#9).
for (const key of Object.keys(process.env)) if (/^PHASE_RUN/.test(key)) delete process.env[key];

export const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A git repository with one commit. `files` maps a repo path to its text. */
export function repo(prefix = "brigade-project-", files = {}) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  write(dir, { "README.md": "# Test\n", ...files });
  git("add", "-A");
  git("commit", "-q", "-m", "start");
  return { dir, git };
}

export function write(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
}

/** A doc-check that always fails, so a test can tell whether the hook ran it. */
export const FAILING_DOC_CHECK = { "tools/doc-check.mjs": 'console.error("doc-check stub ran"); process.exit(1);\n' };

/**
 * Runs `hooks/<name>` with `input` on stdin. The phase-run variables are cleared first, so a test
 * run from inside a phase run sees an attended session unless it sets them itself. `plugin` is the
 * plugin folder to run it from: this repo, or a test's altered copy of it.
 */
export function runHook(name, input, env = {}, { plugin = PLUGIN } = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PHASE_RUN/.test(key)));
  const result = spawnSync(process.execPath, [join(plugin, "hooks", name)], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...clean, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
