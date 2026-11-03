// SessionStart hook (the plugin's hooks.json, matcher "startup"): the out-of-step notice. At a new
// session it compares the installed Brigade with the project's stamp. When they differ, the owner
// sees one line naming the fix, and Claude gets the same fact with a note not to act on it unasked.
// It only ever suggests: /update-workflow and /setup-workflow stay the owner's to type.
//
// It never stands in a session's way: any error, even a module that fails to load, means no output
// and exit 0. So the one import that could fail is loaded inside the try.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// A phase run's sessions are unattended: nobody would read the line, and the run goes on as before.
if (process.env.PHASE_RUN === "1") process.exit(0);

/** A version this can compare; anything else (a missing or hand-edited one) means say nothing. */
const VERSION_SHAPE = /^\d+(\.\d+)*$/;

/** The owner's line, or null when there is nothing to say. */
function notice({ STAMP, compareVersions, pluginId, pluginVersion }) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8")) ?? {};
  } catch {
    input = {};
  }
  // The project, not this file's folder: inside a plugin that is the plugin's cache.
  const root = resolve(process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === "string" && input.cwd) || process.cwd());
  const stampPath = join(root, STAMP);
  if (!existsSync(stampPath)) return "Brigade is on here, but this repo isn't set up yet. Type /setup-workflow.";
  const installed = pluginVersion();
  const projectVersion = JSON.parse(readFileSync(stampPath, "utf8")).version;
  if (![installed, projectVersion].every((v) => typeof v === "string" && VERSION_SHAPE.test(v))) return null;
  const order = compareVersions(installed, projectVersion);
  if (order > 0) {
    return `Brigade ${installed} is installed, but this project's files are from ${projectVersion}. Type /update-workflow to see what changed.`;
  }
  if (order < 0) {
    return `This project is on Brigade ${projectVersion}, but this machine has ${installed}. Run \`claude plugin update ${pluginId()}\`, then /reload-plugins.`;
  }
  return null;
}

try {
  const line = notice(await import("../scripts/versions.mjs"));
  if (line) {
    const context = `Brigade notice, shown to the owner at the start of this session: ${line} Do not act on it unless the owner asks; \`/update-workflow\` and \`/setup-workflow\` are the owner's to type.`;
    process.stdout.write(`${JSON.stringify({ systemMessage: line, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } })}\n`);
  }
} catch {
  // A version notice is never worth a failed session start.
}
process.exit(0);
