// Every relative link in Brigade's own docs (README.md, docs/) points at a file that exists, so a
// section moved between them cannot leave a dead link behind.
//
// Run: node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { PLUGIN } from "./helpers.mjs";

const DOCS = ["README.md", ...readdirSync(join(PLUGIN, "docs")).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`)];

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
