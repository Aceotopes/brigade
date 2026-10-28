// Every relative link in Brigade's own docs (README.md, GLOSSARY.md, docs/ at any depth) points at a file that exists, so a
// section moved between them cannot leave a dead link behind.
//
// Run: node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { PLUGIN } from "./helpers.mjs";

/** Every .md under a folder of the plugin, at any depth. */
function markdown(rel) {
  return readdirSync(join(PLUGIN, rel)).flatMap((name) => {
    const path = `${rel}/${name}`;
    if (statSync(join(PLUGIN, path)).isDirectory()) return markdown(path);
    return name.endsWith(".md") ? [path] : [];
  });
}

const DOCS = ["README.md", "GLOSSARY.md", ...markdown("docs")];

/** The relative link targets in a Markdown file, code blocks and spans left out. */
function links(text) {
  const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  return [...prose.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1])
    .filter((target) => !/^(https?:|mailto:|#)/.test(target))
    .map((target) => decodeURIComponent(target.split("#")[0]));
}

test("every relative link in the plugin's docs resolves", () => {
  const dead = DOCS.flatMap((rel) =>
    links(readFileSync(join(PLUGIN, rel), "utf8"))
      .filter((target) => !existsSync(join(PLUGIN, dirname(rel), target)))
      .map((target) => `${rel} → ${target}`),
  );
  assert.deepEqual(dead, []);
});
