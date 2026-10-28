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
import { ARCHIVE, STAMP, apply, autoModeLines, buildPlan, compareVersions, detect, dockerStatus, parseStackTable, plan, refresh, stackDisagreements, suggestPrototypeDir, update } from "../scripts/setup.mjs";
import { PLUGIN, repo, write } from "./helpers.mjs";

const read = (dir, rel) => readFileSync(join(dir, rel), "utf8");
const node = (dir, ...args) => spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8" });
const ANSWERS = { name: "Gym Desk", summary: "A desk app for a gym.", date: "2026-10-27" };

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
  write(dir, { ".claude/settings.json": `${JSON.stringify({ enabledPlugins: { "brigade@argee": true } }, null, 2)}\n` });
  assert.deepEqual(detect(dir).git.dirty, []);
  assert.equal(detect(dir).brigadeEnabled, true);
  write(dir, { ".claude/settings.json": `${JSON.stringify({ enabledPlugins: { "brigade@argee": true }, permissions: {} })}\n` });
  assert.equal(detect(dir).git.dirty.length, 1);
});

test("new mode on an empty repo: the whole workflow, clean on day one, staged and not committed", () => {
  const { dir, git } = repo("brigade-new-");
  write(dir, { ".claude/settings.json": `${JSON.stringify({ enabledPlugins: { "brigade@argee": true } }, null, 2)}\n` });
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
  assert.equal(git("status", "--porcelain", "--", ".claude/settings.json"), "?? .claude/settings.json");
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
  assert.deepEqual(refresh(dir).items, [], "right after setup there is nothing to do");
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
  const verified = cli("verify", dir);
  assert.equal(verified.status, 0, verified.stdout);
  assert.match(verified.stdout, /^ok +the phase runner's config$/m);
});

test("overwrite works on its own branch and archives the old docs, CLAUDE.md and settings instead of deleting them", () => {
  const { dir, git } = existing();
  write(dir, { ".claude/settings.json": `${JSON.stringify({ permissions: { allow: ["Bash(pnpm *)"] }, enabledPlugins: { "brigade@argee": true } }, null, 2)}\n` });
  git("add", "-A");
  git("commit", "-q", "-m", "settings");
  const result = apply(dir, runPlan(dir, { mode: "overwrite" }));
  assert.equal(result.docCheck.status, 0, result.docCheck.output);
  assert.equal(git("branch", "--show-current"), "adopt-workflow");
  assert.equal(read(dir, `${ARCHIVE}/docs/ROADMAP.md`), "# Roadmap\n\nPhase 2 is next.\n");
  assert.equal(read(dir, `${ARCHIVE}/CLAUDE.md`), "# Gym\n\nUse pnpm. Never push to main.\n");
  assert.ok(!existsSync(join(dir, "docs/ROADMAP.md")));
  assert.deepEqual(JSON.parse(read(dir, ".claude/settings.json")), { enabledPlugins: { "brigade@argee": true } });
  assert.match(read(dir, `${ARCHIVE}/.claude/settings.json`), /Bash\(pnpm \*\)/);
  assert.ok(!existsSync(join(dir, ".brigade-archive")));
  // git sees moves, not deletions:
  assert.match(git("status", "--porcelain"), /^R {2}docs\/ROADMAP\.md -> docs\/history\/pre-workflow\/docs\/ROADMAP\.md$/m);
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
  assert.equal(compareVersions("0.2.0", "0.2.0"), 0);
});
