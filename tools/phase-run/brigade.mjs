// One run, one Brigade version (ADR 0005, D8, D14). The plugin's hooks judge every ticket, so the
// installed plugin version is part of what judges the night, beside the runner copy.
// - At run start the runner reads that version (`claude plugin list --json`, the probe's item d)
//   and records it in the snapshot manifest, the morning report and the ledger rows.
// - Each night ticket's settings switch Brigade's auto-update off, so an update waits for the
//   owner's next fresh session.
// - Before each ticket the version is read again. A change (an attended session elsewhere ran an
//   update) stops the run cleanly, and no later ticket starts.
//
// Only run.mjs imports this file, and it imports only node builtins.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The plugin's name: an install's id is `brigade@<catalog>`. */
const BRIGADE_ID = /^brigade@(.+)$/i;

/**
 * Brigade's catalog as the project declares it: the part after `@` in its own `enabledPlugins`
 * entry for `brigade` (never a literal, since the runner can't see the plugin's folder), with that
 * catalog's `extraKnownMarketplaces` entry. `{ catalog: null, why }` when there is nothing to
 * override: no settings file, no Brigade entry, no catalog entry, or a file that isn't JSON.
 */
export function brigadeCatalog(root) {
  const path = join(root, ".claude", "settings.json");
  if (!existsSync(path)) return { catalog: null, why: "the project has no .claude/settings.json, so it names no catalog for Brigade." };
  let settings;
  try {
    // A BOM is stripped: PowerShell 5.1 writes UTF-8 with one, and JSON.parse refuses it.
    const text = readFileSync(path, "utf8");
    settings = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    return { catalog: null, why: `.claude/settings.json is not JSON (${error.message}).` };
  }
  // An entry that is on wins over one that is off, should a project list two.
  const ids = Object.entries(settings?.enabledPlugins ?? {})
    .filter(([id]) => BRIGADE_ID.test(id))
    .sort(([, a], [, b]) => Number(b === true) - Number(a === true));
  if (!ids.length) return { catalog: null, why: "the project's .claude/settings.json has no brigade@… entry in enabledPlugins." };
  const catalog = ids[0][0].match(BRIGADE_ID)[1];
  const entry = settings.extraKnownMarketplaces?.[catalog];
  // Written without its `source`, the entry would be a catalog with nowhere to come from.
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { catalog: null, why: `the project's .claude/settings.json has no extraKnownMarketplaces entry for "${catalog}" to carry the override.` };
  }
  return { catalog, entry };
}

/**
 * A night ticket's settings with Brigade's auto-update off: the project's catalog entry, every other
 * key kept (`source` above all, since a `--settings` entry stands in for the project's), and
 * `autoUpdate: false`. Settings come back as they went in when there is no catalog.
 */
export function withAutoUpdateOff(settings, catalog) {
  if (!catalog?.catalog) return settings;
  return {
    ...settings,
    extraKnownMarketplaces: {
      ...(settings.extraKnownMarketplaces ?? {}),
      [catalog.catalog]: { ...catalog.entry, autoUpdate: false },
    },
  };
}

/** The rows of `claude plugin list --json`: a list, or a list under `plugins`. Throws, quoting the output, on any other shape. */
export function parsePluginList(stdout) {
  const quoted = JSON.stringify(String(stdout).slice(0, 200));
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`\`claude plugin list --json\` printed something that isn't JSON: ${quoted}`);
  }
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.plugins) ? parsed.plugins : null;
  if (!rows) throw new Error(`\`claude plugin list --json\` printed JSON of a shape the runner can't read: ${quoted}`);
  return rows;
}

/**
 * The Brigade version installed for the repo at `root`, from `claude plugin list --json`'s rows
 * (`{id, version, scope, projectPath, projectEnabled}`, every project's installs listed): the
 * `brigade@…` row whose `projectPath` is the repo, else a `scope: "user"` row, else null. Paths
 * compare with either slash and no trailing one, case-blind on Windows.
 */
export function installedBrigade(rows, root, { platform = process.platform } = {}) {
  const key = (path) => {
    const plain = String(path).replace(/\\/g, "/").replace(/\/+$/, "");
    return platform === "win32" ? plain.toLowerCase() : plain;
  };
  const brigade = rows.filter((row) => typeof row?.id === "string" && BRIGADE_ID.test(row.id) && typeof row.version === "string" && row.version);
  const project = brigade.find((row) => typeof row.projectPath === "string" && key(row.projectPath) === key(root));
  const user = brigade.find((row) => row.scope === "user");
  return (project ?? user)?.version ?? null;
}

/** Reads the installed version through `exec` (the runner's: `{ ok, stdout, stderr }`). Throws when the command fails or prints what it can't read. */
export function readInstalledBrigade(root, exec) {
  const result = exec("claude", ["plugin", "list", "--json"]);
  if (!result.ok) throw new Error(`\`claude plugin list --json\` failed: ${JSON.stringify(String(result.stderr || result.stdout).slice(0, 200))}`);
  return installedBrigade(parsePluginList(result.stdout), root);
}

/**
 * Why the run must stop before its next ticket, or null to go on. `read` returns the version
 * installed now. A version that can't be read stops the run too: it can't prove the next ticket's
 * hooks are the ones the run started with.
 */
export function versionStop(started, read) {
  let now;
  try {
    now = read();
  } catch (error) {
    return `Brigade's installed version could not be read (${error.message}), so the run can't tell whether it changed. Rerun.`;
  }
  if (now === started) return null;
  return `Brigade updated mid-run (${started} → ${now ?? "not installed"}), rerun.`;
}
