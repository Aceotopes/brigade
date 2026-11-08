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

// The receipt's unread paths are checked by both loaders alike: the hooks' (the Stop hook) and the
// runner's (stop-tests.mjs and preflight), which cannot share code across the plugin and the project.
const tests = (over = {}) => ({ label: "Tests", run: "npm test", receipt: true, ...over });
const checks = (...rows) => ({ version: 1, stopGate: { checks: rows } });

test("both loaders read the tests row's unread paths", () => {
  const data = checks({ label: "Lint", run: "npm run lint" }, tests({ unread: ["docs/**", "*.md"] }));
  assert.deepEqual(parseWorkflowConfig(data).checks.map((c) => c.unread), [[], ["docs/**", "*.md"]]);
  assert.deepEqual(parseRunConfig(data).stopChecks.map((c) => c.unread), [[], ["docs/**", "*.md"]]);
});

// 0.6.0 (#17, ADR 0004): each receipt row keeps its own receipt, so each keeps its own list and may
// carry a name, which names its receipt file.
test("both loaders read each receipt row's own name and unread list", () => {
  const data = checks(
    { name: "typecheck", label: "Typecheck", run: "npm run typecheck", receipt: true, unread: ["**/*.md"] },
    { label: "Format", run: "npm run fmt" },
    tests({ name: "tests", unread: ["docs/**", "*.md", "!docs/fixtures/**"] }),
  );
  for (const rows of [parseWorkflowConfig(data).checks, parseRunConfig(data).stopChecks]) {
    assert.deepEqual(
      rows.map((c) => [c.name, c.receipt, c.unread]),
      [["typecheck", true, ["**/*.md"]], [null, false, []], ["tests", true, ["docs/**", "*.md", "!docs/fixtures/**"]]],
    );
  }
});

test("both loaders refuse a bad or repeated name, and nameless receipt rows that would share a file with differing lists", () => {
  const cases = [
    [checks(tests({ name: 3 })), /checks\[0\]\.name must be/],
    [checks(tests({ name: "" })), /checks\[0\]\.name must be/],
    // It names a file: .phase-run/<name>-receipt-<ticket>.json.
    ...["Tests", "my tests", "../x", "-x", "a/b"].map((name) => [checks(tests({ name })), /checks\[0\]\.name .* lowercase/]),
    [checks(tests({ name: "test" })), /checks\[0\]\.name "test" is the one rows without a name share/],
    [checks(tests({ name: "unit" }), tests({ name: "unit", run: "npm run e2e" })), /checks\[1\]\.name "unit" is also stopGate\.checks\[0\]'s/],
    [checks({ name: "lint", label: "Lint", run: "x" }, tests({ name: "lint" })), /checks\[1\]\.name "lint" is also stopGate\.checks\[0\]'s/],
    [checks(tests({ unread: ["docs/**"] }), tests({ run: "npm run e2e" })), /checks\[1\]\.unread differs from stopGate\.checks\[0\]\.unread: receipt rows without a "name" share/],
  ];
  for (const [data, error] of cases) {
    assert.throws(() => parseWorkflowConfig(data), error, `hooks: ${JSON.stringify(data.stopGate)}`);
    assert.throws(() => parseRunConfig(data), error, `runner: ${JSON.stringify(data.stopGate)}`);
  }
  // Named rows, or a named row beside a nameless one, may differ.
  for (const data of [
    checks(tests({ name: "unit", unread: ["docs/**"] }), tests({ name: "e2e", run: "npm run e2e" })),
    checks(tests({ unread: ["docs/**"] }), tests({ name: "e2e", run: "npm run e2e", unread: ["**/*.md"] })),
    checks(tests({ unread: ["docs/**"] }), tests({ run: "npm run e2e", unread: ["docs/**"] })),
  ]) {
    assert.doesNotThrow(() => parseWorkflowConfig(data));
    assert.doesNotThrow(() => parseRunConfig(data));
  }
});

test("both loaders refuse a misplaced, malformed or catch-all unread list, naming the row", () => {
  const cases = [
    [checks({ label: "Lint", run: "x", unread: ["docs/**"] }), /checks\[0\]\.unread belongs on a row with "receipt": true/],
    [checks(tests({ unread: "docs/**" })), /checks\[0\]\.unread must be a list/],
    [checks(tests({ unread: ["docs/**", 3] })), /checks\[0\]\.unread\[1\] must be a glob/],
    [checks(tests({ unread: [" "] })), /checks\[0\]\.unread\[0\] must be a glob/],
    // A glob that names no folder or file could leave out every file, and the receipt would never go stale.
    ...["**", "**/*", "*/**", ".", "**/**", "**/*.*", "*"].map((glob) => [checks(tests({ unread: ["docs/**", glob] })), /checks\[0\]\.unread\[1\] .* every file/]),
    // Git refuses a path outside the repo, and `./` or `..` can climb back to its root.
    ...["/docs/**", "./**", "src/..", "../shared/**"].map((glob) => [checks(tests({ unread: [glob] })), /checks\[0\]\.unread\[0\] .* inside the repo/]),
    [checks(tests({ unread: [" docs/**"] })), /checks\[0\]\.unread\[0\] .* spaces around it/],
    // A leading `!` puts paths back; what follows it is held to the same rules.
    ...["!", "!**", "!*.*"].map((glob) => [checks(tests({ unread: ["docs/**", glob] })), /checks\[0\]\.unread\[1\] .* every file/]),
    ...["!/docs/**", "!../x/**"].map((glob) => [checks(tests({ unread: ["docs/**", glob] })), /checks\[0\]\.unread\[1\] .* inside the repo/]),
  ];
  for (const [data, error] of cases) {
    assert.throws(() => parseWorkflowConfig(data), error, `hooks: ${JSON.stringify(data.stopGate)}`);
    assert.throws(() => parseRunConfig(data), error, `runner: ${JSON.stringify(data.stopGate)}`);
  }
});

// The ledger section is read by both loaders: the hooks' (the attended hook's switch) and the
// runner's (the weekly view's first day).
const withLedger = (ledger) => ({ version: 1, ledger });

test("both loaders read the ledger section, defaulting to the attended hook on and weeks from Monday", () => {
  const cases = [
    [{ version: 1 }, { attended: true, weekStarts: "monday" }],
    [withLedger({}), { attended: true, weekStarts: "monday" }],
    [withLedger({ attended: false }), { attended: false, weekStarts: "monday" }],
    [withLedger({ weekStarts: "sunday", note: "the owner's weeks" }), { attended: true, weekStarts: "sunday" }],
  ];
  for (const [data, ledger] of cases) {
    assert.deepEqual(parseWorkflowConfig(data).ledger, ledger, `hooks: ${JSON.stringify(data)}`);
    assert.deepEqual(parseRunConfig(data).ledger, ledger, `runner: ${JSON.stringify(data)}`);
  }
});

test("both loaders refuse a malformed ledger section alike", () => {
  const cases = [
    [withLedger([]), /ledger must be an object/],
    [withLedger("on"), /ledger must be an object/],
    [withLedger({ weekStart: "monday" }), /: ledger has unknown key\(s\) weekStart; allowed: attended, weekStarts, note\.$/],
    [withLedger({ attended: "yes" }), /ledger\.attended must be true or false/],
    [withLedger({ weekStarts: "Monday" }), /ledger\.weekStarts must be a day in lowercase/],
    [withLedger({ weekStarts: "mon" }), /ledger\.weekStarts must be a day in lowercase/],
    [withLedger({ weekStarts: 1 }), /ledger\.weekStarts must be a day in lowercase/],
  ];
  for (const [data, error] of cases) {
    assert.throws(() => parseWorkflowConfig(data), error, `hooks: ${JSON.stringify(data.ledger)}`);
    assert.throws(() => parseRunConfig(data), error, `runner: ${JSON.stringify(data.ledger)}`);
  }
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
  const values = { N: 7, TITLE: "t", BRANCH: "phase-6h", PHASE: "6h", GOTCHAS_FILE: "docs/agents/gotchas/module-6/6h.md", SPEC: "#5", BASE: "abc", FRONTEND: "yes", GATE: "lint", OUTPUT: "x", ROUND: 1, ROUNDS: 3 };
  Object.assign(values, promptValues(stj, prose, values));
  const [ticket, fix] = ["ticket-prompt.md", "fix-prompt.md"].map((name) => render(readFileSync(join(PLUGIN, "template", "tools", "phase-run", name), "utf8"), values));
  for (const text of [ticket, fix]) assert.doesNotMatch(text, /\{\{\w+\}\}/);
  // Each of the old prompt's Steak To Juan instructions, as a session now reads it.
  for (const phrase of [
    "surface brief in `.impeccable/surfaces/`",
    // Its changed tests, now run through the receipt (0.4.0): the stop check skips them on code that passed.
    "`node tools/phase-run/stop-tests.mjs` (the tests)",
    "`node tools/phase-run/wait-url.mjs http://localhost:8400/`",
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
    "`docs/agents/gotchas/module-6/6h.md` (made from",
  ]) {
    assert.ok(ticket.includes(phrase), `the ticket prompt says: ${phrase}`);
  }
  assert.ok(fix.includes("committed walk under `scripts/walks/`"));
  assert.ok(fix.includes("QA on `stj_cast` only"));
  assert.match(fix, /already applied to\s+dev Neon/);
});
