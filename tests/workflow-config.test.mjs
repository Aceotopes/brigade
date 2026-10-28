// Tests for a project's .claude/workflow.json: the loader (hooks/workflow-config.mjs), the guard's
// block rules and the stop gate's checks. Steak To Juan's example rows stand in for a real project.
// Run: node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { parseWorkflowConfig } from "../hooks/workflow-config.mjs";
import { PLUGIN, repo, runHook, write } from "./helpers.mjs";

const STJ = readFileSync(join(PLUGIN, "examples", "steak-to-juan", "workflow.json"), "utf8");
const BLANK = readFileSync(join(PLUGIN, "template", ".claude", "workflow.json"), "utf8");

function project(config) {
  return repo("brigade-config-", config === undefined ? {} : { ".claude/workflow.json": config });
}

function guard(dir, command, env = {}) {
  return runHook("guard-shell.mjs", { tool_input: { command }, cwd: dir }, { CLAUDE_PROJECT_DIR: dir, ...env });
}

const RUN = { PHASE_RUN: "1" };

// ------------------------------------------------------------------- the loader

test("both shipped configs load: the blank template and Steak To Juan's example", () => {
  assert.deepEqual(parseWorkflowConfig(JSON.parse(BLANK)), { rules: [], checks: [], wrappers: ["pnpm exec", "pnpm dlx", "pnpm", "npx"] });
  const stj = parseWorkflowConfig(JSON.parse(STJ));
  assert.equal(stj.rules.length, 4);
  assert.deepEqual(stj.checks.map((c) => c.label), ["Typecheck", "Lint", "The tests your changes touch"]);
});

test("a config with a mistake names it: version, a typo'd key, a bad when, a bad pattern, both match kinds", () => {
  const rule = (extra) => ({ version: 1, guard: { block: [{ when: "always", command: "^x", message: "m", ...extra }] } });
  const cases = [
    [{ version: 2 }, /"version" must be 1/],
    [rule({ unles: "y" }), /unknown key\(s\) unles/],
    [rule({ when: "sometimes" }), /when must be one of always, phase-run/],
    [rule({ command: "(" }), /command is not a valid pattern/],
    [rule({ text: "x" }), /exactly one of "command" and "text"/],
    [rule({ message: "" }), /message is missing/],
    [{ version: 1, stopGate: { checks: [{ label: "Lint" }] } }, /checks\[0\]\.run is missing/],
    [{ version: 1, stack: { databse: "Postgres" } }, /stack has unknown key\(s\) databse/],
    [{ version: 1, stack: { database: "" } }, /stack\.database must be text \(leave an undecided part out\)/],
    [{ version: 1, stack: { other: "Stripe" } }, /stack\.other must be a list of texts/],
    [{ version: 1, guard: { wrappers: ["bunx", ""] } }, /guard\.wrappers must be a list of command prefixes/],
    [{ version: 1, roadmap: { url: "x" } }, /roadmap has unknown key\(s\) url/],
  ];
  for (const [data, error] of cases) assert.throws(() => parseWorkflowConfig(data), error);
});

test("the stack, the roadmap's link and the guard's wrappers load as written", () => {
  const data = {
    version: 1,
    guard: { block: [], wrappers: ["bunx", " bun x "] },
    stack: { language: "TypeScript", database: "Postgres on Supabase", other: ["Stripe", "Resend"] },
    roadmap: { artifact: "https://claude.ai/artifact/abc" },
  };
  assert.deepEqual(parseWorkflowConfig(data).wrappers, ["bunx", "bun x"]);
});

// -------------------------------------------------------------------- the guard

test("Steak To Juan's rows block what its hardcoded hook blocked", () => {
  const { dir } = project(STJ);
  assert.match(guard(dir, "pnpm exec prettier --write src/a.ts").stderr, /`prettier --write` rewrites whole files/);
  assert.equal(guard(dir, "pnpm exec prettier --check src/a.ts").status, 0);
  assert.match(guard(dir, "npx prisma format").stderr, /`prisma format` rewrites the whole schema/);
  // The migration rows hold inside a phase run only, and a local database is let through.
  assert.equal(guard(dir, "pnpm prisma migrate deploy").status, 0);
  assert.match(guard(dir, "pnpm prisma migrate deploy", RUN).stderr, /never migrates dev Neon/);
  assert.equal(guard(dir, 'DATABASE_URL="postgres://localhost:5432/t" pnpm prisma migrate deploy', RUN).status, 0);
  assert.match(guard(dir, "node scripts/apply-pending-migrations.mjs", RUN).stderr, /never migrates dev Neon/);
});

test("a block rule holds however the command is wrapped: the project's own wrappers are stripped first", () => {
  const rule = { when: "always", command: "^prisma\\s+format\\b", message: "`prisma format` rewrites the whole schema." };
  const config = (wrappers) => JSON.stringify({ version: 1, guard: { block: [rule], ...(wrappers ? { wrappers } : {}) } });
  const { dir: bun } = project(config(["bunx", "bun x", "bun run", "bun"]));
  for (const command of ["bunx prisma format", "bun x prisma format", "bunx --bun prisma format", "prisma format"]) {
    assert.match(guard(bun, command).stderr, /rewrites the whole schema/, command);
  }
  assert.equal(guard(bun, "bunx prisma validate").status, 0);
  const { dir: yarn } = project(config(["yarn dlx", "yarn exec", "yarn"]));
  assert.match(guard(yarn, "yarn prisma format").stderr, /rewrites the whole schema/);
  assert.match(guard(yarn, "yarn dlx prisma format").stderr, /rewrites the whole schema/);
  // No wrappers named: the ones the guard always knew.
  const { dir: plain } = project(config());
  assert.match(guard(plain, "pnpm exec prisma format").stderr, /rewrites the whole schema/);
  assert.match(guard(plain, "npx -y prisma format").stderr, /rewrites the whole schema/);
  assert.equal(guard(plain, "bunx prisma format").status, 0, "bunx is not a default wrapper");
});

test("the blank template and a missing file block nothing a project would add", () => {
  for (const config of [BLANK, undefined]) {
    const { dir } = project(config);
    assert.equal(guard(dir, "pnpm exec prettier --write src/a.ts").status, 0);
    assert.equal(guard(dir, "pnpm prisma migrate deploy", RUN).status, 0);
  }
});

test("a project's row passes a command aimed at another repo", () => {
  const { dir } = project(STJ);
  const other = repo("brigade-other-").dir;
  assert.equal(guard(dir, `cd "${other}" && npx prettier --write .`).status, 0);
  assert.match(guard(dir, `cd "${other}" && npx prettier --write .`, RUN).stderr, /rewrites whole files/);
});

test("a broken config refuses every shell command and says why", () => {
  const { dir } = project('{ "version": 1, "guard": { "block": [ ');
  const result = guard(dir, "ls");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /\.claude\/workflow\.json: .*JSON[\s\S]*until then no shell command runs/);
});

// --------------------------------------------------------------- the stop gate

const CHECKS = (checks) => JSON.stringify({ version: 1, stopGate: { checks } });
const SCRIPTS = {
  "ok.mjs": "process.exit(0);\n",
  "fail.mjs": 'console.log(`failing against ${process.argv[2]}`); process.exit(1);\n',
  "mark.mjs": 'import { writeFileSync } from "node:fs"; writeFileSync("marked", "");\n',
};

function stop(dir, env = {}) {
  return runHook("stop-gate.mjs", { cwd: dir }, { CLAUDE_PROJECT_DIR: dir, ...RUN, ...env });
}

test("the stop gate runs the project's checks in order, stops at the first failure, and fills in {base}", () => {
  const { dir, git } = project(
    CHECKS([
      { label: "Fine", run: "node ok.mjs" },
      { label: "Broken", run: "node fail.mjs {base}" },
      { label: "Never reached", run: "node mark.mjs" },
    ]),
  );
  write(dir, SCRIPTS); // also the ticket's "work": the tree is no longer clean
  const base = git("rev-parse", "HEAD");
  const result = stop(dir, { PHASE_RUN_BASE: base });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Broken failed \(`node fail\.mjs [0-9a-f]{40}`\)[\s\S]*failing against [0-9a-f]{40}/);
  assert.equal(existsSync(join(dir, "marked")), false);
});

test("the stop gate passes when every check passes, and has nothing to do with no checks", () => {
  const passing = project(CHECKS([{ label: "Fine", run: "node ok.mjs" }]));
  write(passing.dir, SCRIPTS);
  assert.equal(stop(passing.dir).status, 0);
  const blank = project(BLANK);
  write(blank.dir, { "changed.txt": "x\n" });
  assert.equal(stop(blank.dir).status, 0);
});

test("the stop gate reports a broken config as its failure", () => {
  const { dir } = project('{ "version": 1, "stopGate": { "checks": [{ "label": "Lint" }] } }');
  write(dir, { "changed.txt": "x\n" });
  const result = stop(dir);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /stop checks could not be read: .*checks\[0\]\.run is missing/);
});
