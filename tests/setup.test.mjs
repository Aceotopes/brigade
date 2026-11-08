// Tests for scripts/setup.mjs, the file work behind /setup-workflow and /update-workflow: each mode
// applied to a stand-in repo must leave a project that passes its own checks, and must never
// overwrite what the project already had.
// Run: node --test tests/*.test.mjs
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { parseWorkflowConfig } from "../hooks/workflow-config.mjs";
import { ARCHIVE, apply, autoModeLines, buildPlan, detect, dockerStatus, parseStackTable, plan, proposeWorkflow, refresh, stackDisagreements, suggestPrototypeDir, update } from "../scripts/setup.mjs";
import { MIGRATIONS } from "../scripts/migrations.mjs";
import { STAMP, compareVersions } from "../scripts/versions.mjs";
import { PLUGIN, repo, write } from "./helpers.mjs";

const read = (dir, rel) => readFileSync(join(dir, rel), "utf8");
const node = (dir, ...args) => spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8" });
const ANSWERS = { name: "Gym Desk", summary: "A desk app for a gym.", date: "2026-10-27" };
/** What setup writes for Brigade's catalog: its source, and auto-update on, so a release reaches the project by itself. */
const CATALOG = { aceotopes: { source: { source: "github", repo: "Aceotopes/brigade" }, autoUpdate: true } };

/** A repo the way an older project looks: a stack, loose docs with no headers, a CLAUDE.md. */
function existing() {
  const pkg = { name: "gym", private: true, scripts: { dev: "next dev", build: "next build", lint: "eslint", test: "vitest run" }, dependencies: { next: "16.0.0", react: "19.0.0" } };
  return repo("brigade-existing-", {
    "package.json": `${JSON.stringify(pkg, null, 2)}\n`,
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "tsconfig.json": "{}\n",
    ".gitignore": "node_modules/\n",
    "src/app/page.tsx": "export default function Page() { return null; }\n",
    "prisma/schema.prisma": 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
    "CLAUDE.md": "# Gym\n\nUse pnpm. Never push to main.\n",
    "docs/ROADMAP.md": "# Roadmap\n\nPhase 2 is next.\n",
    "docs/SESSION_HANDOFF.md": "# Handoff\n\nStopped at payments.\n",
    "docs/PROJECT_OVERVIEW.md": "# Overview\n\nThe client list lives in `src/gone.ts`.\n",
    "docs/adr/ADR-001.md": "# ADR-001: Prisma\n\nWe use Prisma.\n",
  });
}

function runPlan(dir, answers) {
  const p = plan(dir, { ...ANSWERS, ...answers });
  assert.deepEqual(p.problems, []);
  return p;
}

test("detect reads the stack, the docs and the git state, and tolerates the plugin install's own settings", () => {
  const { dir } = existing();
  const det = detect(dir);
  assert.equal(det.packageManager, "pnpm");
  assert.equal(det.typescript, true);
  assert.deepEqual(det.prisma, { provider: "postgresql" });
  assert.ok(det.frontend.includes("depends on next"));
  assert.deepEqual(det.topFolders, ["prisma", "src"]);
  assert.ok(det.docs.includes("docs/ROADMAP.md") && det.docs.includes("CLAUDE.md"));
  assert.equal(det.empty, false);
  assert.deepEqual(det.git.dirty, []);
  // What `claude plugin install --scope project` writes is not a dirty tree; anything else is.
  write(dir, { ".claude/settings.json": `${JSON.stringify({ enabledPlugins: { "brigade@aceotopes": true } }, null, 2)}\n` });
  assert.deepEqual(detect(dir).git.dirty, []);
  assert.equal(detect(dir).brigadeEnabled, true);
  write(dir, { ".claude/settings.json": `${JSON.stringify({ enabledPlugins: { "brigade@aceotopes": true }, permissions: {} })}\n` });
  assert.equal(detect(dir).git.dirty.length, 1);
});

test("new mode on an empty repo: the whole workflow, clean on day one, staged and not committed", () => {
  const { dir, git } = repo("brigade-new-");
  write(dir, { ".claude/settings.json": `${JSON.stringify({ enabledPlugins: { "brigade@aceotopes": true } }, null, 2)}\n` });
  const workflow = { ...JSON.parse(readFileSync(join(PLUGIN, "template/.claude/workflow.json"), "utf8")) };
  workflow.phaseRun = { gates: [{ label: "tests", run: "node --test" }] };
  const p = runPlan(dir, { mode: "new", workflow });
  const result = apply(dir, p);
  assert.equal(result.docCheck.status, 0, result.docCheck.output);
  assert.deepEqual(result.conflicts, []);
  assert.match(read(dir, "CLAUDE.md"), /^---\njob: [\s\S]*# Gym Desk\n\nA desk app for a gym\./);
  assert.match(read(dir, "CLAUDE.md"), /node --test tools\/doc-tools\.test\.mjs/); // no package.json: the raw commands
  assert.match(read(dir, ".gitignore"), /^\.phase-run\/$/m);
  assert.match(read(dir, "docs/history/devlog.md"), /## #1 · chore · adopt the workflow\n- 2026-10-27: .*\(new mode\)/);
  const stamp = JSON.parse(read(dir, STAMP));
  assert.equal(stamp.mode, "new");
  assert.ok(stamp.files["tools/phase-run/run.mjs"] && !stamp.files["tools/doc-config.mjs"]);
  // The config it wrote loads through the hooks' loader, and setup made no commit:
  assert.doesNotThrow(() => parseWorkflowConfig(JSON.parse(read(dir, ".claude/workflow.json"))));
  assert.equal(git("rev-list", "--count", "HEAD"), "1");
  assert.equal(git("status", "--porcelain", "--", ".claude/settings.json"), "A  .claude/settings.json");
  assert.match(git("diff", "--cached", "--name-only"), /tools\/phase-run\/run\.mjs/);
  git("commit", "-q", "-m", "chore: adopt the workflow — devlog #1");
  assert.equal(node(dir, "tools/doc-check.mjs", "--head").status, 0);
});

test("discovery first: a repo holding only discovery docs is still new, and setup lists them in its index", () => {
  const { dir } = repo("brigade-discovery-");
  const doc = "# Discovery: the gym desk\n\n**Rounds:** 2026-10-20, in Claude chat.\n\n## Goals\n\n1. Check members in.\n";
  write(dir, { "docs/discovery/01-gym-desk.md": doc });
  assert.equal(detect(dir).empty, true);
  write(dir, { "docs/notes.md": "# Notes\n" });
  assert.equal(detect(dir).empty, false, "any other doc makes it an existing repo");
  rmSync(join(dir, "docs/notes.md"));
  const result = apply(dir, runPlan(dir, { mode: "new" }));
  assert.equal(result.docCheck.status, 0, result.docCheck.output);
  assert.equal(read(dir, "docs/discovery/01-gym-desk.md"), doc, "setup never touches a discovery doc");
  assert.match(read(dir, "docs/discovery/README.md"), /- \[01\]\(01-gym-desk\.md\) · Discovery: the gym desk · 2026-10-20 · no addendum/);
});

test("the runner's own loader accepts the config setup proposes from a stack", async () => {
  const { dir: target } = existing();
  apply(target, runPlan(target, { mode: "merge" }));
  const { loadRunConfig } = await import(pathToFileURL(join(target, "tools/phase-run/config.mjs")).href);
  const { config, error } = loadRunConfig(target);
  assert.equal(error, null);
  assert.deepEqual(config.gates.map((g) => g.label), ["typecheck", "lint", "build", "tests"]);
  assert.equal(JSON.parse(read(target, ".claude/workflow.json")).stopGate.checks[0].run, "pnpm exec tsc --noEmit");
  // The tests row, and only it, carries the receipt that lets the stop check skip a passed run.
  assert.deepEqual(config.stopChecks.filter((c) => c.receipt).map((c) => c.label), ["Tests"]);
  // ...and the paths its tests never read, so a devlog written after the pass keeps the receipt (0.4.1).
  const written = JSON.parse(read(target, ".claude/workflow.json"));
  assert.deepEqual(written.stopGate.checks.find((c) => c.receipt), { label: "Tests", run: "pnpm test", receipt: true, unread: ["docs/**", "*.md"] });
  assert.deepEqual(parseWorkflowConfig(written).checks.find((c) => c.receipt).unread, ["docs/**", "*.md"], "the hooks' loader accepts it");
  assert.deepEqual(config.stopChecks.find((c) => c.receipt).unread, ["docs/**", "*.md"], "and the runner's");
});

test("detect lists the Node test files in a top-level test/ or tests/ folder, one glob per folder and extension", () => {
  assert.deepEqual(detect(repo("brigade-nodetests-none-").dir).nodeTests, [], "no test files: an empty list");
  const { dir } = repo("brigade-nodetests-", {
    "tests/a.test.mjs": "",
    "tests/b.test.mjs": "",
    "tests/sub/c.test.js": "", // nested: not counted
    "tests/helper.mjs": "", // not a test file
    "template/tools/x.test.mjs": "", // a test file elsewhere
    "src/y.test.cjs": "",
  });
  assert.deepEqual(detect(dir).nodeTests, ["tests/*.test.mjs"]);
  // Both folders, two extensions: each glob once, sorted.
  const both = repo("brigade-nodetests-both-", { "tests/a.test.mjs": "", "test/b.test.js": "", "test/c.test.js": "" }).dir;
  assert.deepEqual(detect(both).nodeTests, ["test/*.test.js", "tests/*.test.mjs"]);
  // .cjs counts too, and outside a git repository the walk finds the same files.
  const plain = mkdtempSync(join(tmpdir(), "brigade-nodetests-plain-"));
  write(plain, { "test/a.test.cjs": "", "test/notes.md": "" });
  assert.deepEqual(detect(plain).nodeTests, ["test/*.test.cjs"]);
});

test("a repo without package.json gets its Node tests proposed as the tests row, never a bare node --test", () => {
  const { dir } = repo("brigade-nodetests-propose-", { "tests/a.test.mjs": "", "test/b.test.js": "" });
  const det = detect(dir);
  assert.equal(det.packageJson, false);
  const config = proposeWorkflow(det);
  const run = "node --test test/*.test.js tests/*.test.mjs";
  assert.deepEqual(config.stopGate.checks, [{ label: "Tests", run, receipt: true, unread: ["docs/**", "*.md"] }]);
  assert.deepEqual(config.phaseRun.gates, [{ label: "tests", run, alone: true }]);
  for (const row of [...config.stopGate.checks, ...config.phaseRun.gates]) assert.notEqual(row.run.trim(), "node --test");
  assert.doesNotThrow(() => parseWorkflowConfig(config), "the hooks' loader accepts it");
  // No Node tests and no package.json: still nothing proposed.
  const none = proposeWorkflow(detect(repo("brigade-nodetests-empty-").dir));
  assert.deepEqual([none.stopGate.checks, none.phaseRun.gates], [[], []]);
});

test("a repo with package.json is proposed what its scripts give, whatever Node tests it has", () => {
  const { dir } = existing();
  write(dir, { "tests/a.test.mjs": "" });
  const det = detect(dir);
  assert.deepEqual(det.nodeTests, ["tests/*.test.mjs"]);
  assert.deepEqual(proposeWorkflow(det), proposeWorkflow({ ...det, nodeTests: [] }));
  assert.equal(proposeWorkflow(det).stopGate.checks.find((c) => c.receipt).run, "pnpm test");
  // A package.json with no test script is not given the Node tests either.
  const bare = repo("brigade-nodetests-noscript-", { "package.json": '{ "name": "x" }\n', "tests/a.test.mjs": "" }).dir;
  assert.equal(proposeWorkflow(detect(bare)).phaseRun.gates.length, 0);
});

test("the prototype folder is a route group where the framework has them, and unknown otherwise", () => {
  const has = (...dirs) => (d) => dirs.includes(d);
  assert.equal(suggestPrototypeDir({ next: "16" }, has("src/app")), "src/app/(prototype)");
  assert.equal(suggestPrototypeDir({ next: "16" }, has("app")), "app/(prototype)");
  assert.equal(suggestPrototypeDir({ next: "16" }, has("pages")), null, "the pages router: the skill asks");
  assert.equal(suggestPrototypeDir({ "@sveltejs/kit": "2" }, has()), "src/routes/(prototype)");
  assert.equal(suggestPrototypeDir({ nuxt: "3" }, has()), "pages/prototype");
  assert.equal(suggestPrototypeDir({ react: "19", vite: "6" }, has()), "src/prototype");
  assert.equal(suggestPrototypeDir({}, has()), null, "no framework yet: the skill asks");
});

test("a project with screens gets the design review's prompt file, which the runner can splice; one without does not", async () => {
  const { dir: front } = existing();
  const p = runPlan(front, { mode: "merge" });
  assert.ok(p.actions.some((a) => a.op === "add" && a.path === "docs/agents/phase-run-prompt.md"));
  apply(front, p);
  assert.equal(JSON.parse(read(front, ".claude/workflow.json")).phaseRun.prompt, "docs/agents/phase-run-prompt.md");
  const { loadRunConfig } = await import(pathToFileURL(join(front, "tools/phase-run/config.mjs")).href);
  assert.equal(loadRunConfig(front).error, null);
  const headings = [...read(front, "docs/agents/phase-run-prompt.md").matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  assert.deepEqual(headings, ["Read", "Review"]);
  assert.ok(headings.every((h) => ["Read", "Build", "Browser check", "Review", "Fix"].includes(h)), "the runner refuses any other section");
  assert.match(read(front, "docs/agents/phase-run-prompt.md"), /impeccable-finish-reviewer[\s\S]*otherwise a general subagent/);
  // A project that names its own prompt file keeps it.
  const built = (dir, answers) => buildPlan(dir, detect(dir), { ...ANSWERS, ...answers });
  const ownDir = existing().dir;
  const own = built(ownDir, { mode: "merge", workflow: { version: 1, guard: { block: [] }, stopGate: { checks: [] }, phaseRun: { gates: [], prompt: "docs/agents/ours.md" } } });
  assert.equal(JSON.parse(own.actions.find((a) => a.path === ".claude/workflow.json").text).phaseRun.prompt, "docs/agents/ours.md");
  const { dir: back } = repo("brigade-backend-");
  const none = built(back, { mode: "new" });
  assert.ok(!none.actions.some((a) => a.path === "docs/agents/phase-run-prompt.md"));
  assert.equal(JSON.parse(none.actions.find((a) => a.path === ".claude/workflow.json").text).phaseRun.prompt, undefined);
});

test("merge keeps every file the project had, accepts its docs as they stand, and reports same-job docs", () => {
  const { dir, git } = existing();
  const before = Object.fromEntries(["docs/ROADMAP.md", "docs/SESSION_HANDOFF.md", "docs/PROJECT_OVERVIEW.md", "docs/adr/ADR-001.md", "src/app/page.tsx"].map((f) => [f, read(dir, f)]));
  const p = runPlan(dir, { mode: "merge" });
  assert.deepEqual(p.actions.filter((a) => a.op === "append").map((a) => a.path).sort(), [".gitignore", "CLAUDE.md", "package.json"]);
  assert.deepEqual(p.sameJob.map((s) => s.theirs).sort(), ["docs/ROADMAP.md", "docs/SESSION_HANDOFF.md", "docs/adr/"]);
  const result = apply(dir, p);
  assert.equal(result.docCheck.status, 0, result.docCheck.output);
  for (const [file, text] of Object.entries(before)) assert.equal(read(dir, file), text, file);
  assert.match(read(dir, "CLAUDE.md"), /^---\n[\s\S]*Use pnpm\. Never push to main\.\n\n## Commands\n\n- `pnpm dev`: the dev server\n- `pnpm exec tsc --noEmit`[\s\S]*`pnpm build`: build[\s\S]*`pnpm test:docs`[\s\S]*## Working agreement/);
  const baseline = JSON.parse(read(dir, "tools/doc-check-baseline.json"));
  assert.ok(baseline.headers.includes("docs/ROADMAP.md") && baseline.headers.includes("docs/adr/ADR-001.md"));
  assert.deepEqual(baseline.missing["docs/PROJECT_OVERVIEW.md"], ["src/gone.ts"]);
  assert.match(read(dir, "tools/doc-config.mjs"), /PATH_ROOTS = \["docs", "design", "tools", "\.github", "\.claude", "prisma", "src"\]/);
  assert.match(read(dir, "tools/doc-config.mjs"), /^export const PROTOTYPE_DIR = "src\/app\/\(prototype\)";/m, "a Next app router: a route group");
  assert.match(JSON.parse(read(dir, "package.json")).scripts["test:docs"], /doc-tools\.test\.mjs/);
  assert.equal(git("branch", "--show-current"), "main");
  // A doc written after the merge still needs its header:
  write(dir, { "docs/new.md": "# New\n" });
  assert.match(node(dir, "tools/doc-check.mjs").stderr, /docs\/new\.md: has no header/);
});

test("CI runs the project's own checks: checks.yml installs the stack and runs the stop gate's checks", () => {
  const { dir } = existing();
  apply(dir, runPlan(dir, { mode: "merge" }));
  const yml = read(dir, ".github/workflows/checks.yml");
  assert.match(yml, /- uses: pnpm\/action-setup@v4\n {8}with:\n {10}version: 10\n/); // no "packageManager" pin in package.json
  assert.match(yml, /run: pnpm install --frozen-lockfile\n/);
  assert.match(yml, /run: pnpm exec prisma generate\n {8}env:\n {10}DATABASE_URL: /);
  assert.match(yml, /- name: Typecheck\n {8}run: pnpm exec tsc --noEmit\n[\s\S]*- name: Tests\n {8}run: pnpm test\n/);
  assert.ok(existsSync(join(dir, ".github/workflows/doc-check.yml")), "the docs' own workflow is still there");
  // No package manager: no install; a command YAML would misread is quoted; a {base} check is left to the run.
  const { dir: bare } = repo("brigade-bare-");
  const workflow = JSON.parse(readFileSync(join(PLUGIN, "template/.claude/workflow.json"), "utf8"));
  workflow.stopGate.checks = [{ label: "Tests", run: 'node --test "test/**/*.test.mjs"' }, { label: "Changed", run: "node --test --changed {base}" }];
  apply(bare, runPlan(bare, { mode: "new", workflow }));
  const plain = read(bare, ".github/workflows/checks.yml");
  assert.doesNotMatch(plain, /Install|action-setup|\{base\}/);
  assert.match(plain, /run: "node --test \\"test\/\*\*\/\*\.test\.mjs\\""\n/);
  // Nothing to run: no file.
  const { dir: none } = repo("brigade-none-");
  apply(none, runPlan(none, { mode: "new" }));
  assert.ok(!existsSync(join(none, ".github/workflows/checks.yml")));
});

test("a CLAUDE.md one folder down: merge points the new CLAUDE.md at it, overwrite names its archived copy", () => {
  const nested = () => {
    const made = existing();
    made.git("mv", "CLAUDE.md", "docs/CLAUDE.md");
    made.git("commit", "-q", "-m", "rules live in docs/");
    return made;
  };
  const { dir } = nested();
  assert.deepEqual(detect(dir).nestedAgentFiles, ["docs/CLAUDE.md"]);
  const merged = apply(dir, runPlan(dir, { mode: "merge" }));
  assert.equal(merged.docCheck.status, 0, merged.docCheck.output);
  assert.match(read(dir, "CLAUDE.md"), /\n- \*\*Read `docs\/CLAUDE\.md` before any work\*\*/);
  assert.equal(read(dir, "docs/CLAUDE.md"), "# Gym\n\nUse pnpm. Never push to main.\n");
  const { dir: over } = nested();
  const p = runPlan(over, { mode: "overwrite" });
  assert.deepEqual(p.oldRules, [`${ARCHIVE}/docs/CLAUDE.md`]);
  const result = apply(over, p);
  assert.deepEqual(result.oldRules, [`${ARCHIVE}/docs/CLAUDE.md`]);
  assert.match(read(over, result.oldRules[0]), /Never push to main/);
  assert.doesNotMatch(read(over, "CLAUDE.md"), /Read `docs\/CLAUDE\.md`/, "its archived copy is read once, not pointed at");
});

test("a glossary under its old name, CONTEXT.md: merge reports it beside GLOSSARY.md, overwrite archives it for carrying over", () => {
  const withOld = () => {
    const made = existing();
    write(made.dir, { "CONTEXT.md": "# Gym\n\n**Member**:\nA person with a paid plan.\n" });
    made.git("add", "-A");
    made.git("commit", "-q", "-m", "a glossary");
    return made;
  };
  const { dir } = withOld();
  assert.ok(detect(dir).agentFiles.includes("CONTEXT.md"));
  const merged = runPlan(dir, { mode: "merge" });
  assert.ok(merged.sameJob.some((s) => s.theirs === "CONTEXT.md" && s.ours.startsWith("GLOSSARY.md")), JSON.stringify(merged.sameJob));
  assert.deepEqual(merged.oldGlossary, []);
  assert.deepEqual(merged.oldRules, [], "a glossary is not a rules file");
  const { dir: over } = withOld();
  const p = runPlan(over, { mode: "overwrite" });
  assert.deepEqual(p.oldGlossary, [`${ARCHIVE}/CONTEXT.md`]);
  assert.ok(!p.oldRules.some((f) => f.endsWith("CONTEXT.md")));
  const result = apply(over, p);
  assert.deepEqual(result.oldGlossary, [`${ARCHIVE}/CONTEXT.md`]);
  assert.match(read(over, result.oldGlossary[0]), /A person with a paid plan/);
  assert.ok(!existsSync(join(over, "CONTEXT.md")));
});

/** A discovery doc with the template's stack table: pnpm, a hosted Postgres, a Docker test database, storage undecided. */
const DISCOVERY = [
  "# Discovery: the gym desk",
  "",
  "**Rounds:** 2026-10-20.",
  "",
  "## Requirements and stack",
  "",
  "| Part | Choice | Why |",
  "|---|---|---|",
  "| Language | TypeScript | |",
  "| Framework | Next.js | |",
  "| Package manager | pnpm | the owner's habit |",
  "| Database | Postgres on Supabase | |",
  "| Migrations | <e.g. Prisma> | |",
  "| Test database | Docker Postgres | |",
  "| Storage | undecided | |",
  "| Other services | Stripe, Resend | |",
  "",
  "## Candidate modules",
  "",
].join("\n");

test("the stack table reads by its Part names; an undecided, empty or placeholder cell is left out", () => {
  assert.deepEqual(parseStackTable(DISCOVERY), {
    language: "TypeScript",
    framework: "Next.js",
    packageManager: "pnpm",
    database: "Postgres on Supabase",
    testDatabase: "Docker Postgres",
    other: ["Stripe", "Resend"],
  });
  assert.equal(parseStackTable("# A doc\n\n## Goals\n"), null, "no table");
});

test("discovery first: setup records the declared stack, the wrappers for its package manager, and the Stack block", () => {
  const { dir } = repo("brigade-stack-");
  write(dir, { "docs/discovery/01-gym-desk.md": DISCOVERY });
  const det = detect(dir);
  assert.equal(det.discoveryStack.from, "docs/discovery/01-gym-desk.md");
  const result = apply(dir, runPlan(dir, { mode: "new" }));
  assert.equal(result.docCheck.status, 0, result.docCheck.output);
  const config = JSON.parse(read(dir, ".claude/workflow.json"));
  assert.deepEqual(config.stack, parseStackTable(DISCOVERY));
  assert.deepEqual(config.guard.wrappers, ["pnpm exec", "pnpm dlx", "pnpm", "npx"], "no lockfile yet: the package manager the table names");
  const claude = read(dir, "CLAUDE.md");
  assert.match(claude, /- \*\*Database:\*\* Postgres on Supabase/);
  assert.match(claude, /- \*\*Storage:\*\* undecided/);
  assert.match(claude, /- \*\*Other services:\*\* Stripe, Resend/);
});

test("where the discovery doc and the files name different parts, detect lists each for the owner", () => {
  const { dir, git } = existing();
  write(dir, { "docs/discovery/01-gym.md": DISCOVERY.replace("| Package manager | pnpm |", "| Package manager | bun |") });
  git("add", "-A");
  git("commit", "-q", "-m", "discovery");
  const det = detect(dir);
  assert.deepEqual(det.stackDisagreements, [{ key: "packageManager", declared: "bun", found: "pnpm" }]);
  assert.equal(det.stackFromFiles.database, "Postgres");
  assert.deepEqual(stackDisagreements({ database: "Postgres on Supabase" }, { database: "Postgres" }), [], "a more specific name agrees");
});

test("a refresh adds what the stack suggests, removes or changes only what the owner accepts, and records a new stack", () => {
  const { dir } = existing();
  apply(dir, runPlan(dir, { mode: "merge" }));
  // Right after setup there is nothing to do but 0.6.0's offers, which setup's rows don't carry yet (#22 writes them).
  assert.deepEqual(refresh(dir).items.filter((i) => i.op !== "offer"), [], "right after setup there is nothing to do");
  const path = join(dir, ".claude/workflow.json");
  const config = JSON.parse(read(dir, ".claude/workflow.json"));
  delete config.guard.wrappers;
  config.phaseRun.gates.push({ label: "e2e", run: "pnpm e2e" });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  const seen = refresh(dir);
  assert.deepEqual(seen.items.filter((i) => i.op === "add").map((i) => i.id), ["guard.wrappers+pnpm exec", "guard.wrappers+pnpm dlx", "guard.wrappers+pnpm", "guard.wrappers+npx"]);
  assert.deepEqual(seen.items.filter((i) => i.op === "remove").map((i) => i.id), ["phaseRun.gates-pnpm e2e"]);
  refresh(dir, { apply: true });
  let now = JSON.parse(read(dir, ".claude/workflow.json"));
  assert.deepEqual(now.guard.wrappers, ["pnpm exec", "pnpm dlx", "pnpm", "npx"]);
  assert.ok(now.phaseRun.gates.some((g) => g.run === "pnpm e2e"), "a hand-written gate is never dropped silently");
  refresh(dir, { apply: true, accept: ["phaseRun.gates-pnpm e2e"] });
  now = JSON.parse(read(dir, ".claude/workflow.json"));
  assert.ok(!now.phaseRun.gates.some((g) => g.run === "pnpm e2e"));
  const result = refresh(dir, { stack: { ...now.stack, storage: "Cloudflare R2" }, apply: true });
  assert.deepEqual(result.applied, ["stack"]);
  assert.equal(JSON.parse(read(dir, ".claude/workflow.json")).stack.storage, "Cloudflare R2");
  assert.match(read(dir, "CLAUDE.md"), /- \*\*Storage:\*\* Cloudflare R2/, "the Stack block follows");
});

test("a refresh looks inside the tests row: a missing receipt or unread list is added, a project's own list never touched", () => {
  const { dir } = existing();
  apply(dir, runPlan(dir, { mode: "merge" }));
  const path = join(dir, ".claude/workflow.json");
  const testsRow = () => JSON.parse(read(dir, ".claude/workflow.json")).stopGate.checks.find((c) => c.run === "pnpm test");
  const edit = (change) => {
    const config = JSON.parse(read(dir, ".claude/workflow.json"));
    change(config.stopGate.checks.find((c) => c.run === "pnpm test"));
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  };
  const adds = () => refresh(dir).items.filter((i) => i.op === "add").map((i) => i.id);

  // A 0.4.0 project: the receipt, no list.
  edit((row) => delete row.unread);
  assert.deepEqual(adds(), ["stopGate.checks.unread+pnpm test"]);
  refresh(dir, { apply: true });
  assert.deepEqual(testsRow(), { label: "Tests", run: "pnpm test", receipt: true, unread: ["docs/**", "*.md"] });

  // An older project still: neither.
  edit((row) => {
    delete row.receipt;
    delete row.unread;
  });
  assert.deepEqual(adds(), ["stopGate.checks.receipt+pnpm test", "stopGate.checks.unread+pnpm test"]);
  const applied = refresh(dir, { apply: true });
  assert.deepEqual(applied.applied, ["stopGate.checks.receipt+pnpm test", "stopGate.checks.unread+pnpm test"]);
  assert.deepEqual(testsRow(), { label: "Tests", run: "pnpm test", receipt: true, unread: ["docs/**", "*.md"] });

  // The project's own list is its own: never offered for change or removal.
  edit((row) => (row.unread = ["docs/**", "notes/**"]));
  assert.deepEqual(refresh(dir).items.filter((i) => i.op !== "offer"), []);
  assert.ok(!refresh(dir).items.some((i) => i.id === "stopGate.checks.offer+pnpm test" && /"unread"/.test(i.summary)), "an offer never touches the tests row's list");
});

test("a refresh never trips on a tests row the owner also chose to remove", () => {
  const { dir } = existing();
  apply(dir, runPlan(dir, { mode: "merge" }));
  const path = join(dir, ".claude/workflow.json");
  const config = JSON.parse(read(dir, ".claude/workflow.json"));
  const own = config.stopGate.checks.find((c) => c.receipt);
  own.run = "pnpm vitest run";
  delete own.unread;
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  const ids = refresh(dir).items.map((i) => i.id);
  assert.ok(ids.includes("stopGate.checks-pnpm vitest run") && ids.includes("stopGate.checks.unread+pnpm vitest run"), ids.join(", "));
  refresh(dir, { apply: true, accept: ["stopGate.checks-pnpm vitest run"] });
  const rows = JSON.parse(read(dir, ".claude/workflow.json")).stopGate.checks.filter((c) => c.receipt);
  assert.deepEqual(rows, [{ label: "Tests", run: "pnpm test", receipt: true, unread: ["docs/**", "*.md"] }]);
});

/** The rows 0.5.2's setup wrote for `existing()`'s stack, as literals, so a later setup can't change what these tests start from. */
const ROWS_052 = {
  checks: [
    { label: "Typecheck", run: "pnpm exec tsc --noEmit" },
    { label: "Lint", run: "pnpm lint" },
    { label: "Tests", run: "pnpm test", receipt: true, unread: ["docs/**", "*.md"] },
  ],
  gates: [
    { label: "typecheck", run: "pnpm exec tsc --noEmit" },
    { label: "lint", run: "pnpm lint" },
    { label: "build", run: "pnpm build" },
    { label: "tests", run: "pnpm test", alone: true },
  ],
};
const OFFERS_052 = ["stopGate.checks.offer+pnpm exec tsc --noEmit", "stopGate.checks.offer+pnpm lint", "stopGate.checks.offer+pnpm test", "phaseRun.gates.offer+pnpm test"];

/** `existing()` set up and committed, its config holding `rows` (0.5.2's by default). */
function project052(rows = ROWS_052, change = () => {}) {
  const { dir, git } = existing();
  apply(dir, runPlan(dir, { mode: "merge" }));
  const config = JSON.parse(read(dir, ".claude/workflow.json"));
  config.stopGate.checks = structuredClone(rows.checks);
  config.phaseRun.gates = structuredClone(rows.gates);
  change(config);
  writeFileSync(join(dir, ".claude/workflow.json"), `${JSON.stringify(config, null, 2)}\n`);
  git("add", "-A");
  git("commit", "-q", "-m", "chore: adopt the workflow — devlog #1");
  return { dir, git, config: () => JSON.parse(read(dir, ".claude/workflow.json")) };
}

/** Both loaders on the project's file: the hooks' and its own runner's. */
async function bothLoaders(dir) {
  const { loadRunConfig } = await import(pathToFileURL(join(dir, "tools/phase-run/config.mjs")).href);
  assert.doesNotThrow(() => parseWorkflowConfig(JSON.parse(read(dir, ".claude/workflow.json"))), "the hooks' loader");
  const { error } = loadRunConfig(dir);
  assert.ok(!error, `the runner's loader: ${error}`);
}

test("update lists refresh's 0.6.0 offers as their own group; one accepted, one declined, and a 0.5.2 file loads unchanged", async () => {
  const { dir, config } = project052();
  const before = read(dir, ".claude/workflow.json");
  assert.deepEqual(MIGRATIONS, [], "0.6.0 runs no migration: a 0.5.x file stays valid");
  await bothLoaders(dir);

  const report = update(dir);
  assert.deepEqual(report.offers.map((o) => o.id), OFFERS_052);
  assert.match(report.offers[1].summary, /Lint gets "name": "lint", "receipt": true, "unread": \["\*\*\/\*\.md"\]/);
  assert.match(report.offers[3].summary, /tests gets "unreadOf": "tests".*names the Tests check "tests"/);
  update(dir, { apply: true });
  assert.equal(read(dir, ".claude/workflow.json"), before, "update never writes the config");
  refresh(dir, { apply: true });
  assert.equal(read(dir, ".claude/workflow.json"), before, "nothing is written without a yes");

  // Lint accepted, Typecheck declined.
  const result = refresh(dir, { apply: true, onlyAccepted: true, accept: ["stopGate.checks.offer+pnpm lint"] });
  assert.deepEqual(result.applied, ["stopGate.checks.offer+pnpm lint"]);
  assert.deepEqual(config().stopGate.checks, [
    ROWS_052.checks[0],
    { label: "Lint", run: "pnpm lint", name: "lint", receipt: true, unread: ["**/*.md"] },
    ROWS_052.checks[2],
  ]);
  assert.deepEqual(config().phaseRun.gates, ROWS_052.gates);
  await bothLoaders(dir);
  assert.deepEqual(update(dir).offers.map((o) => o.id), OFFERS_052.filter((id) => id !== "stopGate.checks.offer+pnpm lint"), "a declined offer is asked again next time");

  // The suite gate accepted without the tests row's own offer: it names the row it points at, and both loaders take it.
  refresh(dir, { apply: true, onlyAccepted: true, accept: ["phaseRun.gates.offer+pnpm test"] });
  assert.deepEqual(config().stopGate.checks[2], { ...ROWS_052.checks[2], name: "tests" });
  assert.deepEqual(config().phaseRun.gates[3], { label: "tests", run: "pnpm test", alone: true, unreadOf: "tests" });
  await bothLoaders(dir);
  assert.deepEqual(update(dir).offers.map((o) => o.id), ["stopGate.checks.offer+pnpm exec tsc --noEmit"]);
});

test("only the accepted offers are written, never refresh's own additions along with them", () => {
  const { dir, config } = project052(ROWS_052, (c) => delete c.guard.wrappers);
  assert.ok(refresh(dir).items.some((i) => i.op === "add"), "refresh has additions of its own");
  refresh(dir, { apply: true, onlyAccepted: true, accept: ["stopGate.checks.offer+pnpm exec tsc --noEmit"] });
  assert.equal(config().guard.wrappers, undefined);
  assert.deepEqual(config().stopGate.checks[0], { label: "Typecheck", run: "pnpm exec tsc --noEmit", name: "typecheck", receipt: true, unread: ["**/*.md"] });
});

test("offers go only to rows the stack suggests, never take a name in use, and leave a whole row alone", async () => {
  // A hand-written row gets no offer; a name in use is never offered again; the tests row's own name is what the gate points at.
  const rows = {
    checks: [
      { label: "Typecheck", run: "pnpm exec tsc --noEmit", name: "typecheck", receipt: true, unread: ["**/*.md"] },
      { label: "Styles", run: "pnpm lint:css", name: "lint" },
      { label: "Lint", run: "pnpm lint" },
      { label: "Tests", run: "pnpm test", name: "unit", receipt: true, unread: ["docs/**"] },
      { label: "E2E", run: "pnpm e2e" },
    ],
    gates: [...ROWS_052.gates, { label: "e2e", run: "pnpm e2e" }],
  };
  const { dir, config } = project052(rows);
  await bothLoaders(dir);
  const offers = update(dir).offers;
  assert.deepEqual(offers.map((o) => o.id), ["phaseRun.gates.offer+pnpm test"]);
  assert.match(offers[0].summary, /"unreadOf": "unit"/);
  assert.doesNotMatch(offers[0].summary, /names the/, "the row already has its name");
  refresh(dir, { apply: true, onlyAccepted: true, accept: offers.map((o) => o.id) });
  assert.deepEqual(config().stopGate.checks, rows.checks);
  assert.equal(config().phaseRun.gates[3].unreadOf, "unit");
  await bothLoaders(dir);
  assert.deepEqual(update(dir).offers, []);
});

test("a list is offered only with the receipt it belongs to, never beside 0.4.1's own add, and a broken config never stops update", async () => {
  // Lint says no receipt; Typecheck has one but no list, which 0.4.1's add already gives it.
  const { dir, config } = project052(ROWS_052, (c) => {
    c.stopGate.checks[0] = { ...c.stopGate.checks[0], receipt: true };
    c.stopGate.checks[1] = { ...c.stopGate.checks[1], receipt: false };
  });
  const items = refresh(dir).items;
  const offer = (run) => items.find((i) => i.id === `stopGate.checks.offer+${run}`);
  assert.match(offer("pnpm lint").summary, /^stopGate\.checks: Lint gets "name": "lint", so its receipt/);
  assert.match(offer("pnpm exec tsc --noEmit").summary, /^stopGate\.checks: Typecheck gets "name": "typecheck", so its receipt/);
  assert.ok(items.some((i) => i.id === "stopGate.checks.unread+pnpm exec tsc --noEmit"), "the list stays 0.4.1's add");
  refresh(dir, { apply: true, onlyAccepted: true, accept: [offer("pnpm lint").id, offer("pnpm exec tsc --noEmit").id] });
  assert.deepEqual(config().stopGate.checks[1], { label: "Lint", run: "pnpm lint", receipt: false, name: "lint" });
  await bothLoaders(dir);

  writeFileSync(join(dir, ".claude/workflow.json"), "{ not json\n");
  const report = update(dir);
  assert.deepEqual(report.offers, []);
  assert.match(report.notes.join("\n"), /offers could not be read/);
});

test("a tests row added back shares the nameless rows' list, never a named row's", () => {
  // Typecheck took its offer (a named list of its own); the tests row has lost its list.
  const { dir, config } = project052(ROWS_052, (c) => {
    c.stopGate.checks[0] = { ...c.stopGate.checks[0], name: "typecheck", receipt: true, unread: ["**/*.md"] };
    delete c.stopGate.checks[2].unread;
  });
  refresh(dir, { apply: true });
  assert.deepEqual(config().stopGate.checks[2].unread, ["docs/**", "*.md"]);
});

test("propose writes no tool-specific rows: its config for a package.json project is pinned", () => {
  // Names, receipts beyond the tests row, `after`, `when`, `{cache}` and tampering are checklist items (D17, ADR 0001).
  const config = proposeWorkflow(detect(existing().dir));
  assert.deepEqual(Object.keys(config), ["version", "note", "guard", "stopGate", "phaseRun", "stack"]);
  assert.deepEqual(config.guard, { block: [], wrappers: ["pnpm exec", "pnpm dlx", "pnpm", "npx"] });
  assert.deepEqual(config.stopGate, {
    checks: [
      { label: "Typecheck", run: "pnpm exec tsc --noEmit" },
      { label: "Lint", run: "pnpm lint" },
      { label: "Tests", run: "pnpm test", receipt: true, unread: ["docs/**", "*.md"] },
    ],
  });
  assert.deepEqual(config.phaseRun, {
    gates: [
      { label: "typecheck", run: "pnpm exec tsc --noEmit" },
      { label: "lint", run: "pnpm lint" },
      { label: "build", run: "pnpm build" },
      { label: "tests", run: "pnpm test", alone: true },
    ],
    permissions: { allow: ["Bash(pnpm *)", "PowerShell(pnpm *)"] },
  });
});

test("a named row whose command gained a flag is still its row: nothing added back, no removal, its offers reach it; a nameless one matches by its run", async () => {
  const rows = {
    checks: [
      { label: "Typecheck", run: "pnpm exec tsc --noEmit --incremental", name: "typecheck" },
      { label: "Lint", run: "pnpm lint --cache" },
      { label: "Tests", run: "pnpm test -- --changed {base}", name: "tests", receipt: true, unread: ["docs/**", "*.md"] },
    ],
    gates: [
      { label: "typecheck", run: "pnpm exec tsc --noEmit" },
      { label: "lint", run: "pnpm lint --cache --cache-location {cache}/eslintcache" },
      { label: "build", run: "pnpm build" },
      { label: "tests", run: "pnpm test -- --changed {base}", alone: true },
    ],
  };
  const { dir, config } = project052(rows);
  await bothLoaders(dir);
  const items = refresh(dir).items;
  const ids = (op) => items.filter((i) => i.op === op).map((i) => i.id);
  // The nameless Lint row is matched by its exact run alone, as in 0.5.x: the plain row is offered back.
  assert.deepEqual(ids("add"), ["stopGate.checks+pnpm lint"]);
  assert.deepEqual(ids("remove"), ["stopGate.checks-pnpm lint --cache"]);
  // A gate is matched by its label, which is the name `after` points at.
  const offers = ["stopGate.checks.offer+pnpm exec tsc --noEmit --incremental", "phaseRun.gates.offer+pnpm test -- --changed {base}"];
  assert.deepEqual(ids("offer"), offers);
  const summary = (id) => items.find((i) => i.id === id).summary;
  assert.match(summary(offers[0]), /Typecheck gets "receipt": true, "unread": \["\*\*\/\*\.md"\]/);
  assert.match(summary(offers[1]), /tests gets "unreadOf": "tests"/);
  assert.doesNotMatch(summary(offers[1]), /names the/, "the tests row already has its name");
  assert.deepEqual(update(dir).offers.map((o) => o.id), offers, "update offers the same");

  refresh(dir, { apply: true, onlyAccepted: true, accept: offers });
  assert.deepEqual(config().stopGate.checks[0], { ...rows.checks[0], receipt: true, unread: ["**/*.md"] });
  assert.deepEqual(config().stopGate.checks.slice(1), rows.checks.slice(1));
  assert.deepEqual(config().phaseRun.gates[3], { ...rows.gates[3], unreadOf: "tests" });
  await bothLoaders(dir);
  assert.deepEqual(update(dir).offers, []);
});

test("a name never hides a stack change: a row whose command is no longer the suggested one, flags or not, is a stranger", () => {
  // Named rows from 0.5.2's stack, then the project moves from pnpm to npm: refresh adds npm's and offers pnpm's for removal.
  const { dir } = project052(ROWS_052, (c) => {
    c.stopGate.checks[1] = { ...c.stopGate.checks[1], name: "lint" };
    c.stopGate.checks[2] = { ...c.stopGate.checks[2], name: "unit", run: "pnpm test -- --changed {base}" };
  });
  rmSync(join(dir, "pnpm-lock.yaml"));
  write(dir, { "package-lock.json": "{}\n" });
  const items = refresh(dir).items;
  const ids = (op) => items.filter((i) => i.op === op).map((i) => i.id);
  for (const id of ["stopGate.checks+npm run lint", "stopGate.checks+npm run test", "phaseRun.gates+npm run lint", "phaseRun.gates+npm run test"]) assert.ok(ids("add").includes(id), id);
  for (const id of ["stopGate.checks-pnpm lint", "stopGate.checks-pnpm test -- --changed {base}", "phaseRun.gates-pnpm lint", "phaseRun.gates-pnpm test"]) assert.ok(ids("remove").includes(id), id);
});

test("any name will do: a tests row named unit whose command gained {base} is still the tests row, and the one the scan reads", () => {
  const { dir } = project052(ROWS_052, (c) => {
    c.stopGate.checks[2] = { ...c.stopGate.checks[2], name: "unit", run: "pnpm test -- --changed {base}" };
    c.phaseRun.tampering = { testFiles: ["tests/**/*.test.mjs"] };
  });
  write(dir, { "tests/b.test.mjs": 'readFileSync("docs/guide.md");\n' });
  const { items, warnings } = refresh(dir);
  assert.ok(!items.some((i) => /pnpm test/.test(i.id) && (i.op === "add" || i.op === "remove")), items.map((i) => i.id).join(", "));
  assert.ok(items.some((i) => i.id === "phaseRun.gates.offer+pnpm test" && /"unreadOf": "unit"/.test(i.summary)), "the suite gate points at it");
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0], /^tests\/b\.test\.mjs:1 names "docs\/guide\.md", on the Tests check's/);
});

/** The one line the scan prints for a project that names no test files. */
const NO_TEST_FILES = "set phaseRun.tampering.testFiles to check your unread list";
const TEST_FILES = { testFiles: ["tests/**/*.test.mjs"] };

test("the unread list's honesty: no tampering section, one line and nothing scanned", () => {
  const { dir } = project052();
  write(dir, { "tests/b.test.mjs": 'readFileSync("docs/guide.md");\n' });
  assert.deepEqual(refresh(dir).warnings, [NO_TEST_FILES]);
  // A section that lists no test files is the same: nothing to scan.
  const empty = project052(ROWS_052, (c) => (c.phaseRun.tampering = { guarded: [".claude/workflow.json"] }));
  assert.deepEqual(refresh(empty.dir).warnings, [NO_TEST_FILES]);
});

test("the unread list's honesty: a clean repo warns of nothing, whatever a non-test file or another check's list says", async () => {
  const { dir } = project052(ROWS_052, (c) => {
    c.stopGate.checks[0] = { ...c.stopGate.checks[0], name: "typecheck", receipt: true, unread: ["**/*.md"] };
    c.phaseRun.tampering = TEST_FILES;
  });
  write(dir, {
    "tests/a.test.mjs": [
      'import { x } from "../src/x.mjs";',
      'const page = "src/app/page.tsx";',
      'const notes = "src/notes.md";', // on the named Typecheck's list, never the tests row's
      'const lists = ["docs/**", "*.md"];', // globs, not paths
      'const url = "https://example.com/docs/a.md";',
      "const made = `${dir}/docs/x.md`;",
    ].join("\n"),
    "scripts/c.mjs": 'const doc = "docs/guide.md";\n', // not a test file
  });
  await bothLoaders(dir);
  assert.deepEqual(refresh(dir).warnings, []);
});

test("the unread list's honesty: each path a test file names on the tests row's list is a warning, and refresh still goes ahead", () => {
  const { dir, config } = project052(ROWS_052, (c) => {
    c.phaseRun.tampering = TEST_FILES;
    delete c.guard.wrappers;
  });
  write(dir, { "tests/sub/b.test.mjs": 'const text = readFileSync("docs/guide.md", "utf8");\nconst top = join(here, "../../README.md");\n' });
  const warnings = refresh(dir).warnings;
  assert.equal(warnings.length, 2, warnings.join("\n"));
  assert.match(warnings[0], /^tests\/sub\/b\.test\.mjs:1 names "docs\/guide\.md", on the Tests check's unread list/);
  assert.match(warnings[1], /^tests\/sub\/b\.test\.mjs:2 names "README\.md"/, "a ./ or ../ path is read from the test's folder");
  const applied = refresh(dir, { apply: true });
  assert.deepEqual(applied.warnings, warnings);
  assert.deepEqual(config().guard.wrappers, ["pnpm exec", "pnpm dlx", "pnpm", "npx"], "a warning never stops the refresh");
});

test("an older CLAUDE.md without the Stack section is offered it, and gets it only on a yes", () => {
  const { dir } = existing();
  apply(dir, runPlan(dir, { mode: "merge" }));
  const claude = join(dir, "CLAUDE.md");
  writeFileSync(claude, read(dir, "CLAUDE.md").replace(/## Stack[\s\S]*?<!-- generated:end stack -->\n/, ""));
  const offered = refresh(dir).items.find((i) => i.id === "CLAUDE.md:stack");
  assert.equal(offered.op, "change");
  refresh(dir, { apply: true });
  assert.doesNotMatch(read(dir, "CLAUDE.md"), /## Stack/);
  refresh(dir, { apply: true, accept: ["CLAUDE.md:stack"] });
  assert.match(read(dir, "CLAUDE.md"), /## Stack[\s\S]*- \*\*Framework:\*\* Next\.js[\s\S]*<!-- generated:end stack -->/);
});

test("the Docker check says whether Docker is installed and running, and never installs it", () => {
  const fake = (results) => (cmd, args) => results[args[0]];
  assert.deepEqual(dockerStatus(fake({ "--version": { error: new Error("ENOENT") } })).installed, false);
  const stopped = dockerStatus(fake({ "--version": { status: 0, stdout: "Docker version 27.3.1\n" }, info: { status: 1, stdout: "" } }));
  assert.deepEqual([stopped.installed, stopped.running, stopped.version], [true, false, "Docker version 27.3.1"]);
  const up = dockerStatus(fake({ "--version": { status: 0, stdout: "x" }, info: { status: 0, stdout: "27.3.1\n" } }));
  assert.deepEqual([up.running, up.version], [true, "27.3.1"]);
  assert.match(up.help, /^https:\/\/docs\.docker\.com\//);
});

test("the command line: plan previews the changed files, apply writes, verify passes every check", () => {
  const { dir } = existing();
  const scratch = mkdtempSync(join(tmpdir(), "brigade-cli-"));
  const cli = (...args) => spawnSync(process.execPath, [join(PLUGIN, "scripts/setup.mjs"), ...args], { encoding: "utf8" });
  writeFileSync(join(scratch, "answers.json"), JSON.stringify({ ...ANSWERS, mode: "merge" }));
  const planned = cli("plan", dir, "--answers", join(scratch, "answers.json"), "--out", join(scratch, "plan.json"), "--preview", join(scratch, "preview"));
  assert.equal(planned.status, 0, planned.stderr);
  assert.match(planned.stdout, /Changed \(shown as a diff before writing\) \(3\):/);
  assert.match(readFileSync(join(scratch, "preview/CLAUDE.md"), "utf8"), /Never push to main\.\n\n## Commands\n/);
  assert.equal(cli("apply", dir, "--plan", join(scratch, "plan.json")).status, 0);
  // A test file naming a path on the tests row's unread list: verify warns of it, and still passes.
  const config = JSON.parse(read(dir, ".claude/workflow.json"));
  config.phaseRun.tampering = { testFiles: ["tests/**/*.test.mjs"] };
  writeFileSync(join(dir, ".claude/workflow.json"), `${JSON.stringify(config, null, 2)}\n`);
  write(dir, { "tests/b.test.mjs": 'readFileSync("docs/guide.md");\n' });
  const verified = cli("verify", dir);
  assert.equal(verified.status, 0, verified.stdout);
  assert.match(verified.stdout, /^ok +the phase runner's config$/m);
  assert.match(verified.stdout, /^warn +the tests' unread list\ntests\/b\.test\.mjs:1 names "docs\/guide\.md"/m);
});

test("overwrite works on its own branch and archives the old docs, CLAUDE.md and settings instead of deleting them", () => {
  const { dir, git } = existing();
  write(dir, { ".claude/settings.json": `${JSON.stringify({ permissions: { allow: ["Bash(pnpm *)"] }, enabledPlugins: { "brigade@aceotopes": true } }, null, 2)}\n` });
  git("add", "-A");
  git("commit", "-q", "-m", "settings");
  const result = apply(dir, runPlan(dir, { mode: "overwrite" }));
  assert.equal(result.docCheck.status, 0, result.docCheck.output);
  assert.equal(git("branch", "--show-current"), "adopt-workflow");
  assert.equal(read(dir, `${ARCHIVE}/docs/ROADMAP.md`), "# Roadmap\n\nPhase 2 is next.\n");
  assert.equal(read(dir, `${ARCHIVE}/CLAUDE.md`), "# Gym\n\nUse pnpm. Never push to main.\n");
  assert.ok(!existsSync(join(dir, "docs/ROADMAP.md")));
  assert.deepEqual(JSON.parse(read(dir, ".claude/settings.json")), { enabledPlugins: { "brigade@aceotopes": true }, extraKnownMarketplaces: CATALOG });
  assert.match(read(dir, `${ARCHIVE}/.claude/settings.json`), /Bash\(pnpm \*\)/);
  assert.ok(!existsSync(join(dir, ".brigade-archive")));
  // git sees moves, not deletions:
  assert.match(git("status", "--porcelain"), /^R {2}docs\/ROADMAP\.md -> docs\/history\/pre-workflow\/docs\/ROADMAP\.md$/m);
});

test("setup turns on auto-update for Brigade's catalog, adding the entry when the install left none", () => {
  const { dir, git } = repo("brigade-auto-");
  apply(dir, runPlan(dir, { mode: "new" }));
  assert.deepEqual(JSON.parse(read(dir, ".claude/settings.json")), { extraKnownMarketplaces: CATALOG });
  assert.match(git("diff", "--cached", "--name-only"), /^\.claude\/settings\.json$/m);
});

test("setup adds only autoUpdate to an install's own catalog entry, and keeps every other key as it was", () => {
  const { dir, git } = existing();
  const mine = {
    permissions: { allow: ["Bash(pnpm *)"] },
    enabledPlugins: { "brigade@aceotopes": true },
    extraKnownMarketplaces: { aceotopes: { source: { source: "github", repo: "someone/fork" } }, other: { source: { source: "github", repo: "x/y" } } },
  };
  write(dir, { ".claude/settings.json": `${JSON.stringify(mine, null, 2)}\n` });
  git("add", "-A");
  git("commit", "-q", "-m", "settings");
  apply(dir, runPlan(dir, { mode: "merge" }));
  const after = JSON.parse(read(dir, ".claude/settings.json"));
  assert.deepEqual(after.extraKnownMarketplaces.aceotopes, { source: { source: "github", repo: "someone/fork" }, autoUpdate: true });
  assert.deepEqual({ ...after, extraKnownMarketplaces: { ...after.extraKnownMarketplaces, aceotopes: mine.extraKnownMarketplaces.aceotopes } }, mine);
});

test("a settings file a rewrite would reformat is left alone, and the setting is listed to add by hand", () => {
  const { dir, git } = existing();
  const text = `${JSON.stringify({ permissions: { allow: ["Bash(pnpm *)"] } })}\n`;
  write(dir, { ".claude/settings.json": text });
  git("add", "-A");
  git("commit", "-q", "-m", "settings");
  const result = apply(dir, runPlan(dir, { mode: "merge" }));
  assert.equal(read(dir, ".claude/settings.json"), text);
  assert.ok(result.manual.some((line) => line.startsWith(".claude/settings.json: ") && /autoUpdate/.test(line)), result.manual.join("\n"));
});

test("a CRLF settings file keeps its line endings when the setting is added", () => {
  const { dir, git } = existing();
  git("config", "core.autocrlf", "false");
  write(dir, { ".claude/settings.json": `${JSON.stringify({ permissions: { allow: ["Bash(pnpm *)"] } }, null, 2)}\n`.replace(/\n/g, "\r\n") });
  git("add", "-A");
  git("commit", "-q", "-m", "settings");
  apply(dir, runPlan(dir, { mode: "merge" }));
  const text = read(dir, ".claude/settings.json");
  assert.equal(text.split("\r\n").length, text.split("\n").length, "every line still ends in CRLF");
  assert.equal(JSON.parse(text).extraKnownMarketplaces.aceotopes.autoUpdate, true);
});

test("a dirty tree, a second setup, the wrong mode and a stale plan are each refused", () => {
  const { dir } = existing();
  write(dir, { "src/app/page.tsx": "changed\n" });
  assert.match(plan(dir, { ...ANSWERS, mode: "merge" }).problems.join("\n"), /working tree has changes[\s\S]*src\/app\/page\.tsx/);
  assert.match(plan(dir, { ...ANSWERS, mode: "new" }).problems.join("\n"), /New mode is for an empty repo/);
  const { dir: clean } = existing();
  const p = runPlan(clean, { mode: "merge" });
  write(clean, { "docs/ROADMAP.md": "# Roadmap, changed after the plan\n" });
  assert.throws(() => apply(clean, p), /working tree has changes/);
  const { dir: other, git } = existing();
  const q = runPlan(other, { mode: "merge" });
  write(other, { "docs/LATER.md": "# Added later\n" });
  git("add", "-A");
  git("commit", "-q", "-m", "later");
  assert.throws(() => apply(other, q), /changed since this plan was made/);
  apply(other, runPlan(other, { mode: "merge" }));
  assert.match(plan(other, { ...ANSWERS, mode: "merge" }).problems.join("\n"), /already set up/);
});

/** A copy of the plugin, so a test can change its template and version. */
function pluginCopy() {
  const dir = mkdtempSync(join(tmpdir(), "brigade-plugin-"));
  for (const part of ["template", "scaffold", ".claude-plugin", "CHANGELOG.md"]) cpSync(join(PLUGIN, part), join(dir, part), { recursive: true });
  return dir;
}

test("update replaces what the project left alone, never what it edited, never its config, and runs a migration once", () => {
  const plugin = pluginCopy();
  const { dir, git } = repo("brigade-update-");
  apply(dir, plan(dir, { ...ANSWERS, mode: "new" }, plugin), plugin);
  git("add", "-A");
  git("commit", "-q", "-m", "chore: adopt the workflow — devlog #1");
  // The plugin moves on: a changed guide, a new file, a new version with its changelog.
  const manifest = JSON.parse(readFileSync(join(plugin, ".claude-plugin/plugin.json"), "utf8"));
  const from = manifest.version;
  writeFileSync(join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({ ...manifest, version: "9.0.0" }));
  writeFileSync(join(plugin, "CHANGELOG.md"), `# Changelog\n\n## 9.0.0 — 2027-01-01\n- The guide got better.\n\n${readFileSync(join(plugin, "CHANGELOG.md"), "utf8").replace(/^# Changelog\n+/, "")}`);
  writeFileSync(join(plugin, "template/docs/guides/phase-run.md"), `${read(dir, "docs/guides/phase-run.md")}\nA new line.\n`);
  writeFileSync(join(plugin, "template/tools/new-tool.mjs"), "export {};\n");
  writeFileSync(join(plugin, "template/docs/agents/workflow.md"), `${read(dir, "docs/agents/workflow.md")}\nUpstream too.\n`);
  // A starting file changed upstream: the project owns its copy, so it is only listed.
  const roadmap = read(dir, "docs/status/roadmap.md");
  writeFileSync(join(plugin, "scaffold/docs/status/roadmap.md"), `${readFileSync(join(plugin, "scaffold/docs/status/roadmap.md"), "utf8")}\nA better starting line.\n`);
  // The project edited one template file and its config:
  write(dir, { "docs/agents/workflow.md": `${read(dir, "docs/agents/workflow.md")}\nMy own line.\n` });
  const config = `${read(dir, ".claude/workflow.json").trimEnd()}\n`;
  let ran = 0;
  const migrations = [{ version: "9.0.0", describe: "a fake format change", run: () => (ran++, []) }];
  const report = update(dir, { plugin, migrations, date: "2027-01-02" });
  assert.equal(report.from, from);
  assert.equal(report.changelog[0].version, "9.0.0");
  const byPath = Object.fromEntries(report.changes.map((c) => [c.path, c.op]));
  assert.deepEqual(byPath, { "docs/guides/phase-run.md": "replace", "docs/agents/workflow.md": "conflict", "tools/new-tool.mjs": "add", "docs/status/roadmap.md": "review" });
  assert.deepEqual(report.notes, []);
  assert.equal(ran, 0, "a report alone changes nothing");
  update(dir, { plugin, migrations, apply: true, date: "2027-01-02" });
  assert.equal(ran, 1);
  assert.match(read(dir, "docs/guides/phase-run.md"), /A new line\.\n$/);
  assert.match(read(dir, "docs/agents/workflow.md"), /My own line\.\n$/);
  assert.equal(read(dir, ".claude/workflow.json"), config);
  assert.equal(JSON.parse(read(dir, STAMP)).version, "9.0.0");
  assert.equal(read(dir, "docs/status/roadmap.md"), roadmap, "a scaffold file is never written by update");
  assert.ok(!update(dir, { plugin }).changes.some((c) => c.op === "review"), "a reviewed scaffold change is listed once");
  update(dir, { plugin, migrations, apply: true });
  assert.equal(ran, 1, "a migration runs once");
  // A stamp from before 0.2.2 has no scaffold hashes: it says so, and the next update records them.
  const stamp = JSON.parse(read(dir, STAMP));
  delete stamp.scaffold;
  writeFileSync(join(dir, STAMP), `${JSON.stringify(stamp, null, 2)}\n`);
  assert.match(update(dir, { plugin }).notes.join(""), /predates 0\.2\.2/);
  update(dir, { plugin, apply: true });
  assert.ok(JSON.parse(read(dir, STAMP)).scaffold["CLAUDE.md"]);
});

test("update offers auto-update to a project set up without it, and writes it only on a yes", () => {
  const { dir, git } = repo("brigade-update-auto-");
  apply(dir, plan(dir, { ...ANSWERS, mode: "new" }));
  // A project set up before 0.5.0: its settings carry only the install's keys.
  const before = `${JSON.stringify({ enabledPlugins: { "brigade@aceotopes": true } }, null, 2)}\n`;
  write(dir, { ".claude/settings.json": before });
  git("add", "-A");
  git("commit", "-q", "-m", "chore: adopt the workflow — devlog #1");
  const offer = update(dir).changes.filter((c) => c.path === ".claude/settings.json");
  assert.equal(offer.length, 1);
  assert.equal(offer[0].op, "setting");
  update(dir, { apply: true });
  assert.equal(read(dir, ".claude/settings.json"), before, "without a yes the setting is not written");
  update(dir, { apply: true, autoUpdate: true });
  assert.deepEqual(JSON.parse(read(dir, ".claude/settings.json")), { enabledPlugins: { "brigade@aceotopes": true }, extraKnownMarketplaces: CATALOG });
  assert.match(git("diff", "--cached", "--name-only"), /^\.claude\/settings\.json$/m);
  assert.ok(!update(dir).changes.some((c) => c.path === ".claude/settings.json"), "once on, it is not offered again");
});

const STJ_LINES = [
  "$defaults",
  "### Per-project additions — each line below applies ONLY when the session's working directory is that project; in any other project, rely on the defaults above",
  "**Project D:\\HGP\\Example — what it is**: someone else's project",
  "**Project D:\\HGP\\Example — routine work**: pnpm under D:\\HGP\\Example\\",
];

test("autoMode lines go after the other projects', replace their own earlier lines, and leave the rest byte for byte", () => {
  const settings = `${JSON.stringify({ model: "x", autoMode: { environment: STJ_LINES } }, null, 2)}\n`;
  const mine = ["**Project D:\\HGP\\Gym — what it is**: a gym desk app", "**Project D:\\HGP\\Gym — routine work**: pnpm under D:\\HGP\\Gym\\"];
  const first = autoModeLines(settings, mine);
  assert.equal(first.writable, true);
  assert.deepEqual(JSON.parse(first.text).autoMode.environment, [...STJ_LINES, ...mine]);
  assert.deepEqual(first.removed, []);
  // Run again with a changed line: replaced in place, nothing duplicated, the others untouched.
  const again = autoModeLines(first.text, ["**Project D:\\HGP\\Gym — what it is**: a gym desk app, v2"]);
  assert.deepEqual(JSON.parse(again.text).autoMode.environment, [...STJ_LINES, "**Project D:\\HGP\\Gym — what it is**: a gym desk app, v2"]);
  assert.equal(again.text.split(STJ_LINES[2].replaceAll("\\", "\\\\")).length, 2);
  // No autoMode yet: $defaults and the header come first.
  assert.deepEqual(JSON.parse(autoModeLines("{}\n", mine).text).autoMode.environment.slice(0, 2), STJ_LINES.slice(0, 2));
  // A file a rewrite would reformat is not writable:
  assert.equal(autoModeLines('{"model":"x"}\n', mine).writable, false);
  assert.throws(() => autoModeLines(settings, ["no project here"]), /must start/);
});

test("versions compare by number, not as text", () => {
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
  assert.equal(compareVersions("0.4.9", "0.4.10"), -1);
  assert.equal(compareVersions("0.2.0", "0.2.0"), 0);
});
