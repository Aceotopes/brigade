// Every function a script calls is one it defines, imports, or the runtime provides. A rename that
// misses one call site leaves a name nothing defines; JavaScript says so only when that line runs,
// and some lines run only inside a live session (run.mjs's background session crashed a phase run on
// one, 2026-10-27). ESLint's no-undef would catch it too; Brigade takes no dependencies, so this
// reads the code itself: comments, strings and regexes are blanked first, `${…}` kept.
//
// Run: node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { PLUGIN } from "./helpers.mjs";

const SCANNED = ["hooks", "scripts", "template/tools"];

const KEYWORDS = new Set(
  "if for while switch catch function return typeof await new super import async yield void delete in of do else case throw".split(" "),
);

function files(rel) {
  if (statSync(join(PLUGIN, rel)).isFile()) return rel.endsWith(".mjs") ? [rel] : [];
  return readdirSync(join(PLUGIN, rel)).flatMap((name) => (name === "node_modules" ? [] : files(`${rel}/${name}`)));
}

/** The code with every comment, string, template text and regex literal blanked; `${…}` kept. */
function codeOnly(src) {
  let out = "";
  let i = 0;
  let depth = 0;
  const open = []; // the brace depth at each open `${`
  const regexCanStart = () => {
    const before = out.replace(/\s+$/, "");
    return before === "" || /[(,=:[!&|?{};+\-*%<>~^]$/.test(before) || /\b(return|typeof|case|of|in)$/.test(before);
  };
  // From a backtick, or the `}` that closed a `${`, to the template's end or its next `${`.
  const template = () => {
    i++;
    while (i < src.length) {
      if (src[i] === "\\") {
        i += 2;
      } else if (src[i] === "`") {
        i++;
        out += '""';
        return;
      } else if (src[i] === "$" && src[i + 1] === "{") {
        i += 2;
        out += '"" + (';
        open.push(depth++);
        return;
      } else {
        i++;
      }
    }
  };
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      out += " ";
    } else if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      i++;
      out += '""';
    } else if (c === "`") {
      template();
    } else if (c === "/" && regexCanStart()) {
      let inClass = false;
      for (i++; i < src.length; i++) {
        if (src[i] === "\\") i++;
        else if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) break;
      }
      i++;
      while (/[a-z]/i.test(src[i] ?? "")) i++;
      out += "/r/";
    } else if (c === "}" && open.at(-1) === depth - 1) {
      depth--;
      open.pop();
      out += ") + ";
      template();
    } else {
      if (c === "{") depth++;
      if (c === "}") depth--;
      out += c;
      i++;
    }
  }
  return out;
}

/** Names called as `name(` that nothing in the file binds or imports and the runtime lacks. */
export function unboundCalls(src) {
  const code = codeOnly(src);
  const imports = [...code.matchAll(/\bimport\s*\{([^}]*)\}/g)].map((match) => match[1]).join(",");
  const called = new Set([...code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]));
  return [...called].filter((name) => {
    if (KEYWORDS.has(name) || name in globalThis) return false;
    const e = name.replace(/\$/g, "\\$");
    const binds = new RegExp(
      [
        `\\bfunction\\*?\\s+${e}\\b`, // function name(
        `\\b(const|let|var|class)\\s+${e}\\b`, // const name =
        `[{,(]\\s*(\\.\\.\\.)?${e}\\s*[,})=]`, // a parameter, or a destructured name
        `:\\s*${e}\\s*[,}=]`, // { key: name } in a destructure
        `\\b${e}\\s*=>`, // name => …
        `\\bimport\\s+(\\*\\s+as\\s+)?${e}\\b`, // import name from, import * as name
      ].join("|"),
    );
    return !binds.test(code) && !new RegExp(`\\b${e}\\b`).test(imports);
  });
}

test("the scanner: a call to a name nothing defines is caught, and only that", () => {
  const src = [
    'import { join as joinPath, readFileSync } from "node:fs";',
    "function helper(when) { return when; }",
    "const arrow = (x) => x;",
    "function withParams({ run = helper, stopStray: stop = () => 0 }, ...rest) { run(); stop(); rest.map(String); }",
    "// renamed(x) in a comment does not count",
    'const text = "renamed(x) in a string" + `${helper(1)} and gone(2) in template text`;',
    "const re = /missing\\(/g;",
    "helper(); arrow(1); joinPath(); readFileSync(); setTimeout(); Number(1); renamed();",
  ].join("\n");
  assert.deepEqual(unboundCalls(src), ["renamed"]);
});

test("every script calls only names it defines, imports, or the runtime has", () => {
  const found = SCANNED.flatMap(files).flatMap((rel) => unboundCalls(readFileSync(join(PLUGIN, rel), "utf8")).map((name) => `${rel}: ${name}()`));
  assert.deepEqual(found, [], "A call to a name nothing defines: a missed rename? Define it, import it, or fix the call.");
});
