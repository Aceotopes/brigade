// The phase runner's config (the `phaseRun` section of .claude/workflow.json) as shipped: the blank
// template and Steak To Juan's example must load through both loaders, the hooks' and the
// runner's, and the example must hold exactly what run.mjs hardcoded at 905e2d8.
// Run: node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { parseWorkflowConfig } from "../hooks/workflow-config.mjs";
import { parseRunConfig, qaUrl, sessionEnv, targetUrl } from "../template/tools/phase-run/config.mjs";
import { promptValues, render } from "../template/tools/phase-run/run.mjs";
import { PLUGIN } from "./helpers.mjs";

const read = (rel) => JSON.parse(readFileSync(join(PLUGIN, rel), "utf8"));
const STJ = read("examples/steak-to-juan/workflow.json");
const BLANK = read("template/.claude/workflow.json");

test("both shipped configs load through the hooks' loader and the runner's", () => {
  for (const data of [STJ, BLANK]) {
    assert.doesNotThrow(() => parseWorkflowConfig(data));
    assert.doesNotThrow(() => parseRunConfig(data));
  }
  const blank = parseRunConfig(BLANK);
  assert.deepEqual([blank.gates, blank.qa, blank.migrations, blank.browserCheck], [[], null, null, null]);
});

test("Steak To Juan's example holds exactly what run.mjs hardcoded", () => {
  const stj = parseRunConfig(STJ);
  const lookup = (name) => ({ NEON_TEST_DATABASE_URL: "postgresql://u:p@localhost:5432/stj_test", NEON_DATABASE_URL: "postgresql://u:p@ep-cool-1-pooler.ap.aws.neon.tech/db" })[name];
  assert.deepEqual(
    stj.gates.map((g) => g.label ?? g.builtin),
    ["typecheck", "lint", "build (next build)", "browser-check", "tests (full suite)"],
  );
  assert.deepEqual(stj.gates.map((g) => g.run ?? null), ["pnpm typecheck", "pnpm lint", "pnpm exec next build", null, "pnpm test"]);
  // The patterns, against the regex literals run.mjs held (compared by source, so an escape lost on the way in shows).
  assert.equal(stj.gates[2].when.source, /^(src\/|public\/|package\.json$|pnpm-lock\.yaml$|next\.config\.|tsconfig)/.source);
  assert.equal(stj.browserCheck.screenFiles.source, /^src\/(components\/|app\/.*\.(tsx|css)$)/.source);
  assert.equal(stj.migrations.added.source, /^prisma\/migrations\/([^/]+)\/migration\.sql$/.source);
  assert.equal(
    stj.migrations.destructive.source,
    /\bDROP\s+(TABLE|COLUMN|TYPE|INDEX|CONSTRAINT)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i.source,
  );
  assert.deepEqual(
    stj.alwaysInScope.map((p) => p.source),
    [/^test\//, /^DESIGN\.md$/, /^\.impeccable\//, /^src\/components\/shell\/(nav-config\.ts|icons\.tsx)$/, /^src\/lib\/notifications\.ts$/, /^src\/app\/globals\.css$/, /^scripts\/walks\//].map((p) => p.source),
  );
  // The values a session and a migration get, as castDatabaseUrl(), sessionEnv() and applyToDevNeon() made them.
  assert.equal(qaUrl(stj, lookup), "postgresql://postgres:postgres@127.0.0.1:5432/stj_cast");
  assert.deepEqual(sessionEnv(stj, lookup), {
    NEON_DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/stj_cast",
    LOYVERSE_ACCESS_TOKEN: "phase-run-sessions-get-no-loyverse-token",
  });
  assert.equal(targetUrl(stj, lookup), "postgresql://u:p@ep-cool-1.ap.aws.neon.tech/db");
  assert.deepEqual(stj.ports.map((p) => [p.port, p.freeAfterEachTicket]), [[8400, true], [3000, false]]);
  assert.equal(stj.strayProcess.source, "vitest");
  assert.equal(stj.stopChecks.length, 3);
});

test("Steak To Juan's prompt, rendered from the example, still says everything its old prompt did", () => {
  const stj = parseRunConfig(STJ);
  const prose = readFileSync(join(PLUGIN, "examples", "steak-to-juan", "phase-run-prompt.md"), "utf8");
  const values = { N: 7, TITLE: "t", BRANCH: "phase-6h", PHASE: "6h", SPEC: "#5", BASE: "abc", FRONTEND: "yes", GATE: "lint", OUTPUT: "x", ROUND: 1, ROUNDS: 3 };
  Object.assign(values, promptValues(stj, prose, values));
  const [ticket, fix] = ["ticket-prompt.md", "fix-prompt.md"].map((name) => render(readFileSync(join(PLUGIN, "template", "tools", "phase-run", name), "utf8"), values));
  for (const text of [ticket, fix]) assert.doesNotMatch(text, /\{\{\w+\}\}/);
  // Each of the old prompt's Steak To Juan instructions, as a session now reads it.
  for (const phrase of [
    "surface brief in `.impeccable/surfaces/`",
    "`pnpm exec vitest run --changed abc --passWithNoTests`",
    "**Do not run the full suite (`pnpm test`)**",
    "`impeccable craft <the ticket's screen>",
    "a hand-built actor sets `payrollRestricted`",
    "new migration folder under `prisma/migrations/`",
    "never apply a migration to dev Neon yourself",
    "`NEON_DATABASE_URL`, `LOYVERSE_ACCESS_TOKEN` are already set for this run",
    "`LOYVERSE_ACCESS_TOKEN` is a placeholder",
    "On the local `stj_cast` database only, never dev Neon:",
    "`node --env-file=.env --import tsx scripts/qa-cast.ts --serve`",
    "**Save the walk as `scripts/walks/7-<short-slug>.mjs` and commit it with the ticket.**",
    "Save screenshots at 390 and 1280 to `.impeccable/review-7/`.",
    "Nothing may be left listening on `:8400`.",
    "at least 2 screenshots saved to `.impeccable/review-7/`",
    "The runner also runs `next build` on any change under `src/`.",
    "Start one `impeccable-finish-reviewer` agent.",
  ]) {
    assert.ok(ticket.includes(phrase), `the ticket prompt says: ${phrase}`);
  }
  assert.ok(fix.includes("committed walk under `scripts/walks/`"));
  assert.ok(fix.includes("QA on `stj_cast` only"));
  assert.match(fix, /already applied to\s+dev Neon/);
});
