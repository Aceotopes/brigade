// The browser check's fingerprint (0.7.0 D12, ADR 0008): what a passing browser check judged,
// one sha256 per file. A pass records a hash of each source file the ticket changed (the files the
// check's own `sourceFiles` names, never a fixed `src/`) and of each screenshot it counted. Landing
// (#36) compares it with the tree after its rebase: if every one of those files is unchanged, the
// browser check's pass carries over; if any changed, or a counted screenshot is gone, it checks again.
//
// The hash is of the file's bytes in the working tree, not its git blob: the screenshots are never
// committed, and a source file's checkout bytes are what the walk ran. So a comparison must read a
// tree checked out the same way (the same line-ending settings) as the one that passed.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The sha256 of the file at `path`, or null when there is no file there (nothing, or a folder such as a submodule). */
function hashOf(path) {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}

/**
 * The fingerprint of a pass: `{ sources, screenshots }`, each a map of a repo-relative path (with
 * `/`) under `root` to its hash. `sources` holds each of `changed` that `sourceFiles` matches, a
 * file the ticket deleted as null; `screenshots` holds each counted screenshot (`shots`, paths
 * relative to `root`).
 */
export function takeFingerprint({ root, changed, sourceFiles, shots }) {
  const sources = {};
  for (const file of changed.filter((path) => sourceFiles.test(path))) sources[file] = hashOf(join(root, file));
  const screenshots = {};
  for (const file of shots) screenshots[file] = hashOf(join(root, file));
  return { sources, screenshots };
}

/**
 * Whether the browser check's pass carries to the tree at `root`: `{ verdict: "carry" }` when every
 * file the fingerprint holds hashes the same, else `{ verdict: "re-check", file, why }` for the first
 * that does not, sources before screenshots. `why` is "gone" for a file that was there and is not
 * now, else "changed" (a deleted source file that is back counts as changed).
 */
export function compareFingerprint(fingerprint, root) {
  for (const files of [fingerprint.sources, fingerprint.screenshots]) {
    for (const [file, hash] of Object.entries(files)) {
      const now = hashOf(join(root, file));
      if (now === hash) continue;
      return { verdict: "re-check", file, why: now === null ? "gone" : "changed" };
    }
  }
  return { verdict: "carry" };
}
