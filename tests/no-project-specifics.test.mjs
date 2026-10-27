// The generic half of Brigade (skills/, hooks/, template/) names no one project. A project's own
// rules live in its config (.claude/workflow.json, tools/doc-config.mjs, docs/agents/doc-sync-rows.md);
// examples/steak-to-juan/ holds the project this was lifted from.
//
// BANNED names one project's systems, not its domain words: its name, repo, database, vendors,
// hosting, module numbering and published pages. PENDING is the files a piece of work still has
// to make generic: empty since README step 7 finished (2026-10-27). A file goes on it only while
// it is being made generic, and leaves it the moment it is clean (the second test fails until it
// does), so the list only shrinks.
//
// Run: node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { PLUGIN } from "./helpers.mjs";

const SCANNED = ["skills", "hooks", "template"];

const BANNED = [
  { term: /steak ?to ?juan/i, why: "the project's name" },
  { term: /aceotopes/i, why: "its GitHub owner" },
  { term: /\bstj_/i, why: "its database and env prefix" },
  { term: /loyverse/i, why: "its point-of-sale vendor" },
  { term: /\bneon\b/i, why: "its database host" },
  { term: /gcash/i, why: "its payment vendor" },
  { term: /module[ -]6/i, why: "its module numbering" },
  { term: /3P5zZTpoYRVwN26dWXJ7Yg/, why: "its Build Roadmap Artifact" },
];

const PENDING = [];

function files(rel) {
  if (statSync(join(PLUGIN, rel)).isFile()) return [rel];
  return readdirSync(join(PLUGIN, rel)).flatMap((name) => (name === "node_modules" ? [] : files(`${rel}/${name}`)));
}

function hits(rel) {
  const text = readFileSync(join(PLUGIN, rel), "utf8");
  return BANNED.filter(({ term }) => term.test(text)).map(({ term, why }) => `${rel}: ${term} (${why})`);
}

const ALL = SCANNED.flatMap(files);

test("no file outside the pending list names one project", () => {
  assert.deepEqual(ALL.filter((rel) => !PENDING.includes(rel)).flatMap(hits), []);
});

test("every pending file still needs its step 7 work: a clean one leaves the list", () => {
  for (const rel of PENDING) {
    assert.ok(ALL.includes(rel), `${rel} is pending but no longer exists: take it off the list`);
    assert.notDeepEqual(hits(rel), [], `${rel} is clean now: take it off PENDING`);
  }
});
