// What the hook tests share: a throwaway git repository to stand in for a project, and a way to
// run a hook the way Claude Code does (JSON on stdin, CLAUDE_PROJECT_DIR in the environment).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
 * run from inside a phase run sees an attended session unless it sets them itself.
 */
export function runHook(name, input, env = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PHASE_RUN/.test(key)));
  const result = spawnSync(process.execPath, [join(PLUGIN, "hooks", name)], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...clean, ...env },
  });
  return { status: result.status, stderr: result.stderr };
}
