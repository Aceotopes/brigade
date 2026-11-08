// Trim (D16): night sessions start lighter. A per-machine list, `~/.claude/brigade/trim.json` (under
// CLAUDE_CONFIG_DIR when that is set), names the plugins and skills the owner's nights don't need,
// and the flags that drop the rest:
//
//   { "plugins": ["figma@claude-plugins-official"], "skills": ["frontend-design"], "flags": ["--strict-mcp-config", "--no-chrome"] }
//
// A missing file means no trim. The runner reads it at preflight, so a refused file stops the run
// before it starts, and only the runner reads it: attended sessions are never trimmed.
//
// A project never loses what it enables itself: a plugin its own `.claude/settings.json` enables, a
// skill in its `.claude/skills`, and whatever its `phaseRun.keep` names. Trim's entries go in each
// night ticket's settings file (`enabledPlugins: false`, `skillOverrides: "off"`), and the flags go
// on each session's first launch.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** No plugins and no skills: what a project with no settings, or no keep list, holds. */
const NOTHING = { plugins: [], skills: [] };

/** The only flags trim may add: each drops something a night doesn't need, and changes nothing else. */
export const TRIM_FLAGS = ["--strict-mcp-config", "--no-chrome"];

/** Where this machine's trim list lives. */
export function trimPath(env = process.env, home = homedir()) {
  return join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "brigade", "trim.json");
}

/** The machine's trim list, or null when there is no file (no trim). Throws on a file it refuses. */
export function readTrim(path) {
  if (!existsSync(path)) return null;
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path} is not JSON (${error.message}).`);
  }
  try {
    return parseTrim(data);
  } catch (error) {
    throw new Error(`${path}: ${error.message}`);
  }
}

/** `{ plugins, skills, flags }`, each a list of names; any of them may be left out. */
export function parseTrim(data) {
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("trim.json must be an object: { plugins, skills, flags }.");
  const allowed = ["plugins", "skills", "flags"];
  const unknown = Object.keys(data).filter((key) => key !== "note" && !allowed.includes(key));
  if (unknown.length) throw new Error(`unknown key(s) ${unknown.join(", ")}; allowed: ${allowed.join(", ")}.`);
  const names = (key) => {
    const value = data[key] ?? [];
    if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !name.trim())) throw new Error(`${key} must be a list of names.`);
    return [...new Set(value.map((name) => name.trim()))];
  };
  const plugins = names("plugins");
  for (const id of plugins) {
    if (!isPluginId(id)) throw new Error(`plugins: "${id}" is not a plugin id (name@marketplace, as \`claude plugin list\` prints it).`);
    if (/^brigade@/i.test(id)) throw new Error(`plugins: "${id}" is Brigade itself; switching it off would switch off the night's own hooks.`);
  }
  const skills = names("skills");
  for (const skill of skills) {
    if (/^brigade:/i.test(skill)) throw new Error(`skills: "${skill}" is one of Brigade's own; a night uses them.`);
  }
  const flags = names("flags");
  for (const flag of flags) {
    if (!TRIM_FLAGS.includes(flag)) throw new Error(`flags: "${flag}" is not a flag trim may add; allowed: ${TRIM_FLAGS.join(", ")}.`);
  }
  return { plugins, skills, flags };
}

/**
 * What the project enables itself: the plugins its `.claude/settings.json` turns on, and its own
 * skills. A missing file or folder is nothing enabled; a settings file that isn't JSON throws, never
 * reads as "nothing enabled", which would trim what the project needs.
 */
export function projectKeeps(root) {
  const path = join(root, ".claude", "settings.json");
  let enabled = {};
  if (existsSync(path)) {
    try {
      // A BOM is stripped: PowerShell 5.1 writes UTF-8 with one, and JSON.parse refuses it.
      enabled = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")).enabledPlugins ?? {};
    } catch (error) {
      throw new Error(`${path} is not JSON (${error.message}), so the plugins it enables can't be kept from trim.`);
    }
  }
  const plugins = Object.entries(enabled)
    .filter(([, on]) => on === true)
    .map(([id]) => id);
  const folder = join(root, ".claude", "skills");
  const isFolder = (name) => {
    try {
      return statSync(join(folder, name)).isDirectory();
    } catch {
      return false; // a dangling link is no skill, and never costs the others theirs
    }
  };
  const skills = existsSync(folder) ? readdirSync(folder).filter(isFolder) : [];
  return { plugins, skills };
}

/** Whether a plugin id names a plugin (`name@marketplace`, as `claude plugin list` prints it). */
export function isPluginId(id) {
  return /^[^@\s]+@[^@\s]+$/.test(id);
}

/**
 * Trim's entries for one ticket's settings: `{ enabledPlugins: {id: false}, skillOverrides: {name:
 * "off"} }`, each left out when empty. Nothing is written for what the project enables or keeps. A
 * skill named `<plugin>:<skill>` and its plugin go together: a kept plugin keeps its skills, and a
 * kept skill keeps its plugin (a skill whose plugin is off is gone too).
 */
export function trimEntries(trim, { project = NOTHING, keep = NOTHING } = {}) {
  if (!trim) return {};
  const keptSkills = new Set([...project.skills, ...keep.skills]);
  const pluginOf = (skill) => (skill.includes(":") ? skill.split(":")[0] : null);
  const keptBySkill = new Set([...keptSkills].map(pluginOf).filter(Boolean));
  const keptPlugins = new Set([...project.plugins, ...keep.plugins]);
  const keptPluginNames = new Set([...keptPlugins].map((id) => id.split("@")[0]));
  const plugins = trim.plugins.filter((id) => !keptPlugins.has(id) && !keptBySkill.has(id.split("@")[0]));
  const skills = trim.skills.filter((skill) => !keptSkills.has(skill) && !keptPluginNames.has(pluginOf(skill)));
  return {
    ...(plugins.length ? { enabledPlugins: Object.fromEntries(plugins.map((id) => [id, false])) } : {}),
    ...(skills.length ? { skillOverrides: Object.fromEntries(skills.map((skill) => [skill, "off"])) } : {}),
  };
}

/** A session's settings with trim's entries merged over its own. */
export function withTrim(settings, entries) {
  return {
    ...settings,
    ...(entries.enabledPlugins ? { enabledPlugins: { ...(settings.enabledPlugins ?? {}), ...entries.enabledPlugins } } : {}),
    ...(entries.skillOverrides ? { skillOverrides: { ...(settings.skillOverrides ?? {}), ...entries.skillOverrides } } : {}),
  };
}
