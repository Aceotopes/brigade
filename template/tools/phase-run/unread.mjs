// The unread-paths matcher: which paths a stop check's `unread` list leaves out of its receipt's key
// (receipt.mjs). One matcher, in JS, so everything that reads a list judges a path alike (ADR 0004).
// It has no imports and reads no receipt, so the runner may use it: no gate may read a receipt.
//
// A list is globs on repo paths, from the root, with `/` between folders:
//   `*` and `?` stay inside one folder (`*.md` is the root's .md files only), a `[...]` class too;
//   `**/` crosses folders (`**/*.md` is every .md file), and a trailing `/**` is everything under a
//   folder, as is a plain folder name (`docs` or `docs/`), as git's pathspecs had it;
//   a leading `!` puts the paths it matches back, and the last glob that matches a path wins.
// Until 0.6.0 git's `:(glob)` pathspecs did this, so a list written for them keeps its meaning.

/** A test of one path (`docs/a.md`) against a list: true when the list leaves it out. */
export function unreadMatcher(list = []) {
  const rules = (list ?? []).map((entry) => ({ back: entry.startsWith("!"), matches: globTest(entry.replace(/^!/, "")) }));
  return (path) => {
    let unread = false;
    for (const rule of rules) if (rule.matches(path)) unread = !rule.back;
    return unread;
  };
}

/** One glob's test. Whatever its wildcards, it also names itself as written: a file, or a folder and all under it. */
function globTest(glob) {
  const folder = glob.endsWith("/") ? glob : `${glob}/`;
  const named = (path) => path === glob || path.startsWith(folder);
  if (!/[*?[\\]/.test(glob)) return named;
  const pattern = new RegExp(`^${globSource(glob)}$`, "u");
  return (path) => named(path) || pattern.test(path);
}

/** The glob as a regex body, by git's wildmatch rules with a path's slashes kept whole. */
function globSource(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      let j = i;
      while (glob[j + 1] === "*") j++;
      const double = j > i;
      const before = i === 0 || glob[i - 1] === "/";
      const after = j + 1 === glob.length || glob[j + 1] === "/";
      i = j;
      if (!double || !before || !after) out += "[^/]*"; // `*`, or `**` inside a name, which is a `*`
      else if (i + 1 === glob.length) out += ".*"; // a trailing `**`: everything under the folder before it
      else {
        out += "(?:.*/)?"; // `**/`: no folders, or any number
        i++; // its slash is in the group
      }
    } else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const found = charClass(glob, i);
      if (!found) out += "\\[";
      else {
        out += found.source;
        i = found.end;
      }
    } else if (c === "\\" && i + 1 < glob.length) out += escape(glob[++i]);
    else out += escape(c);
  }
  return out;
}

/** wildmatch's named classes, `[[:upper:]]` and the like, as regex ranges. */
const NAMED_CLASSES = {
  alnum: "a-zA-Z0-9", alpha: "a-zA-Z", blank: " \\t", cntrl: "\\x00-\\x1f\\x7f", digit: "0-9", graph: "!-~",
  lower: "a-z", print: " -~", punct: "!-\\/:-@\\[-`{-~", space: "\\s", upper: "A-Z", xdigit: "0-9a-fA-F",
};

/**
 * The `[...]` class starting at `start`: its regex (never matching `/`) and the index of its `]`, or
 * null when it never closes (the `[` is then literal). A `]` first in it is a member, and
 * `[:name:]` inside it is a named class; an unknown name matches nothing, as in git.
 */
function charClass(glob, start) {
  let j = start + 1;
  const negated = glob[j] === "!" || glob[j] === "^";
  if (negated) j++;
  let body = "";
  let first = true;
  for (; j < glob.length; j++, first = false) {
    const c = glob[j];
    if (c === "]" && !first) {
      const source = body === null ? "(?!)" : negated ? `[^/${body}]` : `(?!/)[${body}]`;
      return { source, end: j };
    }
    const named = c === "[" && glob[j + 1] === ":" ? glob.slice(j).match(/^\[:([a-z]+):\]/) : null;
    if (named) {
      body = body === null || !(named[1] in NAMED_CLASSES) ? null : body + NAMED_CLASSES[named[1]];
      j += named[0].length - 1;
    } else if (c === "\\" && j + 1 < glob.length) {
      j++;
      if (body !== null) body += /[\\\]^[-]/.test(glob[j]) ? `\\${glob[j]}` : glob[j]; // an escaped `-` is a member, not a range
    } else if (body !== null) body += /[\\\]^[]/.test(c) ? `\\${c}` : c;
  }
  return null;
}

function escape(c) {
  return c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
