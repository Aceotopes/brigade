// Brigade's version and a project's stamp: read by setup's update and by the out-of-step notice
// (hooks/version-check.mjs). Kept apart from setup.mjs so the notice, which runs at every launch,
// loads only this.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where a set-up project records the Brigade version its copied files came from. */
export const STAMP = ".claude/workflow-version.json";

const manifest = (plugin, file) => JSON.parse(readFileSync(join(plugin, ".claude-plugin", file), "utf8"));

export const pluginVersion = (plugin = PLUGIN) => manifest(plugin, "plugin.json").version;

/**
 * The ID Claude Code knows the plugin by, `<plugin>@<catalog>`, from the manifests: the catalog's name
 * lives there only. An installed copy has marketplace.json too, because the catalog's source is the
 * repo's own root ("./").
 */
export const pluginId = (plugin = PLUGIN) => `${manifest(plugin, "plugin.json").name}@${manifest(plugin, "marketplace.json").name}`;

/** -1, 0 or 1, for versions like 0.2.0. */
export function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}
