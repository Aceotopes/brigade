// The file work behind /setup-workflow and /update-workflow. The skills do the talking (which mode,
// is this stack right, may I write this); this script does what must be the same every time, and is
// tested (tests/setup.test.mjs).
//
//   node scripts/setup.mjs detect <dir>                          what is there: git, stack, docs, a stamp
//   node scripts/setup.mjs propose <dir>                         the .claude/workflow.json its stack suggests
//   node scripts/setup.mjs plan <dir> --answers <f> --out <f> [--preview <d>]
//                                                                what setup would do, summed up; --preview writes the
//                                                                proposed text of each changed or conflicting file under <d>
//   node scripts/setup.mjs apply <dir> --plan <f>                do it, if the repo is still as planned
//   node scripts/setup.mjs verify <dir>                          doc-check, the template's tests, both config loaders
//   node scripts/setup.mjs update <dir> [--apply] [--remove]     re-copy template/ into a set-up project
//   node scripts/setup.mjs refresh <dir> [--stack <f>] [--apply] [--accept <id,id>]
//                                                                bring the config in line with the stack (--stack: the new
//                                                                one); --apply writes the additions and the accepted ids
//   node scripts/setup.mjs docker                                is Docker installed, and running
//   node scripts/setup.mjs automode --settings <f> --lines <f> [--apply]   the project's autoMode lines
//   node scripts/setup.mjs labels                                the GitHub labels the workflow reads
//
// Three kinds of file reach a project:
//   template/  the plugin keeps owning them; update re-copies them; a project never edits one.
//   scaffold/  written once, then the project's own (CLAUDE.md, the devlog, the roadmap…).
//   config     the project's settings (CONFIG_FILES), written from its stack; update never touches them.
// The stamp (.claude/workflow-version.json) records the plugin version, the mode, and a hash of every
// template file as copied, so update can tell a file the project edited from one it left alone.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MIGRATIONS } from "./migrations.mjs";

export const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..");
export const STAMP = ".claude/workflow-version.json";
export const ARCHIVE = "docs/history/pre-workflow";
export const BRANCH = "adopt-workflow";
/** The project's own settings: written once from its stack, never re-copied. */
export const CONFIG_FILES = [".claude/workflow.json", ".claude/spec-issues.json", "tools/doc-config.mjs", "tools/doc-check-baseline.json", ".github/workflows/checks.yml"];
/** Settings keys a project-scope plugin install writes: a change to only these is not a dirty tree. */
const INSTALL_KEYS = ["enabledPlugins", "extraKnownMarketplaces"];
/** What the runner and /ticket-check read (tools/phase-run/run.mjs: READY_LABEL, PARK_LABEL; the browser check). */
export const LABELS = [
  { name: "run-ready", color: "0e8a16", description: "/ticket-check found no open question: a phase run may build it" },
  { name: "needs-info", color: "d876e3", description: "A phase run parked it on a question for the owner" },
  { name: "ready-for-human", color: "b60205", description: "A phase run parked it after its gates failed" },
  { name: "frontend", color: "1d76db", description: "Changes a screen: the browser check and design review apply" },
];
const FRONTEND_DEPS = ["react", "next", "vue", "nuxt", "svelte", "@sveltejs/kit", "solid-js", "astro", "@angular/core"];
const FRONTEND_DIRS = ["app", "pages", "src/app", "src/pages", "src/components", "components"];
/** The phase-run prompt file a project with screens starts with (its default design review); `phaseRun.prompt` names it. */
const PROMPT_FILE = "docs/agents/phase-run-prompt.md";
/** Scaffold files written only for a project with screens. */
const FRONTEND_ONLY = [PROMPT_FILE];

/**
 * Where a framework keeps routes, so the prototype folder sits inside the app and uses the real shell:
 * a route group where the framework has them. null when the framework is unknown or not chosen yet:
 * the skill asks.
 */
export function suggestPrototypeDir(deps, exists) {
  if (deps.next) {
    if (exists("src/app")) return "src/app/(prototype)";
    if (exists("app")) return "app/(prototype)";
    return null; // the pages router, or no routes yet
  }
  if (deps["@sveltejs/kit"]) return "src/routes/(prototype)";
  if (deps.nuxt) return "pages/prototype";
  if (deps.react) return "src/prototype";
  return null;
}
/** Top-level folders that are build output, never cited by a doc. */
const NOT_CODE = ["node_modules", "dist", "build", "out", "coverage", "target", "vendor", "docs", "tools"];
/** Existing docs that look like they do a job the workflow has a fixed home for (reported in merge mode, never moved). */
const SAME_JOB = [
  [/(^|\/)[^/]*road-?map[^/]*\.md$/i, "docs/status/roadmap.md"],
  [/(^|\/)[^/]*hand-?off[^/]*\.md$/i, "docs/status/handoff.md"],
  [/(^|\/)(devlog|changelog)[^/]*\.md$/i, "docs/history/devlog.md"],
  [/^docs\/(logs?|journal)\/[^/]+\.md$/i, "docs/history/implementation-log/"],
  [/(^|\/)(adrs?|decisions)\/(?!\d{4}-)[^/]+\.md$/i, "docs/adr/ (named NNNN-<slug>.md)"],
  [/^CONTEXT\.md$/, "GLOSSARY.md, the workflow's name for the glossary since 0.3.0: rename it when you like"],
];
/** The glossary's name, then the name it had before 0.3.0. */
const GLOSSARY_NAMES = ["GLOSSARY.md", "CONTEXT.md"];

const lf = (text) => text.replace(/\r\n/g, "\n");
export const hash = (text) => createHash("sha256").update(lf(text)).digest("hex").slice(0, 16);
const readText = (path) => readFileSync(path, "utf8");
const unique = (items) => [...new Set(items)];

/** Every file under `root`, as posix paths relative to it. */
function walk(root, rel = "", out = []) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs).sort()) {
    if (name === ".git" || name === "node_modules") continue;
    const child = rel ? `${rel}/${name}` : name;
    if (statSync(join(root, child)).isDirectory()) walk(root, child, out);
    else out.push(child);
  }
  return out;
}

export const templateFiles = (plugin = PLUGIN) => walk(join(plugin, "template")).filter((f) => !CONFIG_FILES.includes(f));
export const scaffoldFiles = (plugin = PLUGIN) => walk(join(plugin, "scaffold"));
/** A hash of each scaffold file as the plugin has it, placeholders and all. */
const scaffoldHashes = (plugin) => Object.fromEntries(scaffoldFiles(plugin).map((path) => [path, hash(readText(join(plugin, "scaffold", path)))]));
export const pluginVersion = (plugin = PLUGIN) => JSON.parse(readText(join(plugin, ".claude-plugin", "plugin.json"))).version;

/** `{{KEY}}` filled from `values`; a key with no value is an error, so nothing ships half-filled. */
export function render(text, values) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (marker, key) => {
    if (values[key] === undefined) throw new Error(`No value for ${marker}.`);
    return values[key];
  });
}

/** -1, 0 or 1, for versions like 0.2.0. */
export function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// ------------------------------------------------------------------ detect

function gitIn(dir) {
  return (...args) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : null;
  };
}

/** True when `.claude/settings.json` differs from HEAD only in what a plugin install writes. */
function installOnlyChange(dir, git) {
  const path = join(dir, ".claude", "settings.json");
  if (!existsSync(path)) return false;
  const strip = (data) => Object.fromEntries(Object.entries(data ?? {}).filter(([key]) => !INSTALL_KEYS.includes(key)));
  try {
    const now = strip(JSON.parse(readText(path)));
    const before = git("show", "HEAD:.claude/settings.json");
    return JSON.stringify(now) === JSON.stringify(before === null ? {} : strip(JSON.parse(before)));
  } catch {
    return false;
  }
}

/** What is in `dir`: everything the plan reads. No writes, no network. */
export function detect(dir) {
  const git = gitIn(dir);
  const isRepo = git("rev-parse", "--git-dir") !== null;
  const status = isRepo ? (git("status", "--porcelain", "--untracked-files=all") ?? "") : "";
  const changes = status.split("\n").filter(Boolean);
  const tolerated = isRepo && installOnlyChange(dir, git);
  const dirty = changes.filter((line) => !(tolerated && line.slice(3) === ".claude/settings.json"));
  const files = isRepo
    ? (git("ls-files", "--cached", "--others", "--exclude-standard") ?? "").split("\n").filter(Boolean)
    : walk(dir);
  // Discovery docs come before setup (docs/agents/workflow.md), so a repo holding only them is still new.
  const meaningful = files.filter(
    (f) => !/^(README(\.md)?|LICENSE(\..+)?|\.gitignore|\.gitattributes|\.claude\/settings\.json)$/i.test(f) && !/^docs\/discovery\/[^/]+\.md$/.test(f),
  );

  const json = (rel) => {
    try {
      return JSON.parse(readText(join(dir, rel)));
    } catch {
      return null;
    }
  };
  const pkg = json("package.json");
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const lockfiles = [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lockb", "bun"], ["bun.lock", "bun"], ["package-lock.json", "npm"]];
  const lockfile = lockfiles.find(([file]) => existsSync(join(dir, file)))?.[0] ?? null;
  const packageManager = lockfiles.find(([file]) => file === lockfile)?.[1] ?? (pkg ? "npm" : null);
  const schema = existsSync(join(dir, "prisma", "schema.prisma")) ? readText(join(dir, "prisma", "schema.prisma")) : null;
  const frontend = [
    ...FRONTEND_DEPS.filter((d) => deps[d]).map((d) => `depends on ${d}`),
    ...FRONTEND_DIRS.filter((d) => existsSync(join(dir, d)) && statSync(join(dir, d)).isDirectory()).map((d) => `has ${d}/`),
  ];
  const docs = files.filter((f) => f.endsWith(".md") && (/^docs\//.test(f) || !f.includes("/")));
  const topFolders = unique(files.filter((f) => f.includes("/")).map((f) => f.split("/")[0])).filter(
    (name) => !name.startsWith(".") && !NOT_CODE.includes(name),
  );
  const settings = json(".claude/settings.json");
  const typescript = existsSync(join(dir, "tsconfig.json")) || Boolean(deps.typescript);
  const provider = schema?.match(/datasource\s+\w+\s*\{[^}]*provider\s*=\s*"([^"]+)"/)?.[1] ?? null;
  const framework = FRAMEWORKS.find(([dep]) => deps[dep])?.[1];
  // What the files show, in the stack's own words; the discovery doc's table says what was chosen.
  const stackFromFiles = {
    ...(pkg ? { language: typescript ? "TypeScript" : "JavaScript" } : {}),
    ...(framework ? { framework } : {}),
    ...(packageManager ? { packageManager } : {}),
    ...(provider ? { database: DATABASES[provider] ?? provider } : {}),
    ...(schema ? { migrations: "Prisma" } : deps["drizzle-kit"] ? { migrations: "Drizzle" } : {}),
  };
  const declared = discoveryStack(dir, files);
  return {
    dir,
    name: basename(dir),
    git: {
      repo: isRepo,
      head: isRepo ? git("rev-parse", "--verify", "-q", "HEAD") : null,
      branch: isRepo ? git("branch", "--show-current") : null,
      remote: isRepo ? git("remote", "get-url", "origin") : null,
      dirty,
      installOnly: tolerated,
    },
    empty: meaningful.length === 0,
    stamp: json(STAMP),
    packageManager,
    lockfile,
    // package.json's own "packageManager" pin: CI's pnpm setup reads it, and refuses a second version.
    packageManagerPin: pkg?.packageManager ?? null,
    packageJson: pkg !== null,
    scripts: pkg?.scripts ?? {},
    typescript,
    prisma: schema ? { provider: provider ?? "unknown" } : null,
    frontend,
    // The newest discovery doc's "Requirements and stack" table, what the files show, and where they differ.
    discoveryStack: declared,
    stackFromFiles,
    stackDisagreements: stackDisagreements(declared?.stack, stackFromFiles),
    prototypeDir: suggestPrototypeDir(deps, (d) => existsSync(join(dir, d))),
    docs,
    agentFiles: ["CLAUDE.md", "AGENTS.md", ...GLOSSARY_NAMES].filter((f) => existsSync(join(dir, f))),
    // One folder down (a docs/CLAUDE.md): a project's rules, which Claude reads only on demand.
    nestedAgentFiles: files.filter((f) => /^[^./][^/]*\/(CLAUDE|AGENTS)\.md$/.test(f)),
    topFolders,
    brigadeEnabled: Object.entries(settings?.enabledPlugins ?? {}).some(([id, on]) => on && id.startsWith("brigade@")),
  };
}

// ------------------------------------------------------------------ the config a stack suggests

const RUN = { pnpm: (s) => `pnpm ${s}`, npm: (s) => `npm run ${s}`, yarn: (s) => `yarn ${s}`, bun: (s) => `bun run ${s}` };
const EXEC = { pnpm: "pnpm exec", npm: "npx", yarn: "yarn", bun: "bunx" };
const PLACEHOLDER_TEST = /no test specified/;

/** The checks the stack already has: a typecheck, a lint, the tests and a build, as commands. */
export function stackChecks(det) {
  const pm = det.packageManager;
  if (!pm) return [];
  const has = (name) => typeof det.scripts[name] === "string" && !PLACEHOLDER_TEST.test(det.scripts[name]);
  const out = [];
  if (has("typecheck")) out.push({ key: "typecheck", label: "Typecheck", run: RUN[pm]("typecheck") });
  else if (det.typescript) out.push({ key: "typecheck", label: "Typecheck", run: `${EXEC[pm]} tsc --noEmit` });
  if (has("lint")) out.push({ key: "lint", label: "Lint", run: RUN[pm]("lint") });
  if (has("build")) out.push({ key: "build", label: "Build", run: RUN[pm]("build") });
  if (has("test")) out.push({ key: "test", label: "Tests", run: RUN[pm]("test") });
  return out;
}

/**
 * `.claude/workflow.json` as the stack suggests it: the template's blank copy with the checks filled in,
 * the stack recorded, and the guard's wrappers for the package manager. `stack` replaces the one detect
 * proposes (the discovery doc's table over what the files show): a refresh passes the config's own.
 */
export function proposeWorkflow(det, plugin = PLUGIN, { stack } = {}) {
  const config = JSON.parse(readText(join(plugin, "template", ".claude", "workflow.json")));
  const checks = stackChecks(det);
  config.stopGate.checks = checks.filter((c) => c.key !== "build").map(({ label, run }) => ({ label, run }));
  config.phaseRun.gates = checks.map(({ key, label, run }) => ({ label: label.toLowerCase(), run, ...(key === "test" ? { alone: true } : {}) }));
  const chosen = orderStack(stack ?? { ...(det.stackFromFiles ?? {}), ...(det.discoveryStack?.stack ?? {}) });
  if (Object.keys(chosen).length) config.stack = chosen;
  const pm = det.packageManager ?? packageManagerIn(chosen.packageManager);
  if (pm) {
    config.guard.wrappers = WRAPPERS[pm];
    const tools = pm === "npm" ? ["npm", "npx"] : [pm];
    config.phaseRun.permissions = { allow: tools.flatMap((t) => [`Bash(${t} *)`, `PowerShell(${t} *)`]) };
  }
  return config;
}

// ------------------------------------------------------------------ the stack

/** The discovery template's "Requirements and stack" rows, by their Part name, and the `stack` key each fills. */
const STACK_ROWS = {
  language: "language",
  framework: "framework",
  "package manager": "packageManager",
  database: "database",
  migrations: "migrations",
  "test database": "testDatabase",
  storage: "storage",
  "other services": "other",
};
const STACK_ORDER = Object.values(STACK_ROWS);
/** What the guard strips before a block rule is tested (`guard.wrappers`), per package manager. */
const WRAPPERS = {
  pnpm: ["pnpm exec", "pnpm dlx", "pnpm", "npx"],
  npm: ["npm exec", "npx"],
  yarn: ["yarn dlx", "yarn exec", "yarn"],
  bun: ["bunx", "bun x", "bun run", "bun"],
};
/** The framework a dependency means, the most specific first (Next.js before React). */
const FRAMEWORKS = [
  ["next", "Next.js"],
  ["nuxt", "Nuxt"],
  ["@sveltejs/kit", "SvelteKit"],
  ["astro", "Astro"],
  ["@angular/core", "Angular"],
  ["solid-js", "Solid"],
  ["vue", "Vue"],
  ["svelte", "Svelte"],
  ["react", "React"],
];
/** A Prisma datasource provider, in the stack's words. */
const DATABASES = { postgresql: "Postgres", mysql: "MySQL", sqlite: "SQLite", sqlserver: "SQL Server", mongodb: "MongoDB", cockroachdb: "CockroachDB" };

const orderStack = (stack) => Object.fromEntries(STACK_ORDER.filter((key) => stack[key] !== undefined).map((key) => [key, stack[key]]));
const packageManagerIn = (text) => text?.toLowerCase().match(/\b(pnpm|npm|yarn|bun)\b/)?.[1] ?? null;

/**
 * A discovery doc's "Requirements and stack" table as a `stack`: the decided rows only. A cell left
 * empty, "undecided" or still a `<placeholder>` is left out, and Other services is split on commas.
 * null when the doc has no such table.
 */
export function parseStackTable(text) {
  const lines = lf(text).split("\n");
  const start = lines.findIndex((line) => /^## Requirements and stack\b/.test(line));
  if (start === -1) return null;
  const stack = {};
  let found = false;
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break;
    const cells = line.match(/^\|(.*)\|\s*$/)?.[1].split("|").map((cell) => cell.trim());
    const key = cells && STACK_ROWS[cells[0].replace(/\*/g, "").toLowerCase()];
    if (!key) continue;
    found = true;
    const choice = (cells[1] ?? "").replace(/<[^>]*>/g, "").trim();
    if (!choice || /^undecided\b/i.test(choice)) continue;
    stack[key] = key === "other" ? choice.split(",").map((s) => s.trim()).filter(Boolean) : choice;
  }
  return found ? stack : null;
}

/** The newest discovery doc that has a stack table: `{ from, stack }`, or null. */
function discoveryStack(dir, files) {
  const docs = files
    .filter((f) => /^docs\/discovery\/[^/]+\.md$/.test(f) && posix.basename(f) !== "README.md")
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  for (const from of docs) {
    const stack = parseStackTable(readText(join(dir, from)));
    if (stack) return { from, stack };
  }
  return null;
}

/** The parts where the discovery doc and the files name different things ("Postgres on Supabase" agrees with "Postgres"). */
export function stackDisagreements(declared = {}, found = {}) {
  const agree = (a, b) => a.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(a.toLowerCase());
  return STACK_ORDER.filter((key) => key !== "other" && declared[key] && found[key] && !agree(declared[key], found[key])).map((key) => ({
    key,
    declared: declared[key],
    found: found[key],
  }));
}

/** Whether Docker is installed and running, for a stack whose test database runs in it. Nothing is installed. */
export function dockerStatus(run = spawnSync) {
  const help = "https://docs.docker.com/get-started/get-docker/";
  const version = run("docker", ["--version"], { encoding: "utf8" });
  if (version.error || version.status !== 0) return { installed: false, running: false, version: null, help };
  const info = run("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" });
  const running = !info.error && info.status === 0;
  return { installed: true, running, version: String(running ? info.stdout : version.stdout).trim(), help };
}

/** The template's doc-config.mjs, pointed at the project's code folders and (merge) its existing docs. */
export function docConfigText({ pathRoots = [], liveDocs = [], prototypeDir = null }, plugin = PLUGIN) {
  let text = readText(join(plugin, "template", "tools", "doc-config.mjs"));
  if (prototypeDir) text = text.replace(/^export const PROTOTYPE_DIR = null;(?=\r?$)/m, `export const PROTOTYPE_DIR = ${JSON.stringify(prototypeDir)};`);
  const rootsLine = /^export const PATH_ROOTS = (\[.*\]);$/m;
  const roots = unique([...JSON.parse(text.match(rootsLine)[1]), ...pathRoots]);
  text = text.replace(rootsLine, `export const PATH_ROOTS = ${JSON.stringify(roots).replaceAll('","', '", "')};`);
  if (liveDocs.length) {
    const added = liveDocs.map((doc) => `  ${JSON.stringify(doc)}, // the project's own, from before the workflow`).join("\n");
    text = text.replace(/(export const LIVE_DOCS = \[\r?\n[\s\S]*?)(\r?\n\];)/, (all, body, end) => `${body}\n${added}${end}`);
  }
  return text;
}

/** The commands `CLAUDE.md` lists, as markdown bullets: the dev server, every check, then the workflow's own. */
function commandLines(det, workflow) {
  const pm = det.packageJson ? det.packageManager : null;
  const lines = pm && det.scripts.dev ? [`- \`${RUN[pm]("dev")}\`: the dev server`] : [];
  const checks = [...workflow.stopGate.checks, ...(workflow.phaseRun?.gates ?? []).filter((g) => g.run)];
  const seen = new Set();
  for (const check of checks) {
    if (check.run.includes("{") || seen.has(check.run)) continue;
    seen.add(check.run);
    lines.push(`- \`${check.run}\`: ${check.label.toLowerCase()}`);
  }
  lines.push(
    `- \`${pm ? RUN[pm]("test:docs") : "node --test tools/doc-tools.test.mjs"}\`: the doc tools' own tests`,
    `- \`${pm ? RUN[pm]("test:runner") : "node --test tools/phase-run/run.test.mjs"}\`: the phase runner's own tests`,
    "- `node tools/doc-check.mjs`: the docs' checks (a hook runs it before every commit)",
  );
  return lines.join("\n");
}

const INSTALL = {
  pnpm: (det) => (det.lockfile ? "pnpm install --frozen-lockfile" : "pnpm install"),
  npm: (det) => (det.lockfile ? "npm ci" : "npm install"),
  yarn: (det) => (det.lockfile ? "yarn install --frozen-lockfile" : "yarn install"),
  bun: (det) => (det.lockfile ? "bun install --frozen-lockfile" : "bun install"),
};
/** A YAML scalar: plain when nothing in it means something to YAML, else JSON-quoted (valid YAML). */
const yaml = (text) => (/^[\w./-][^:#"'{}[\],&*?|<>=!%@`]*$/.test(text) && !/\s$/.test(text) ? text : JSON.stringify(text));

/**
 * `.github/workflows/checks.yml`: the stop gate's checks on every push and pull request, so a green
 * pull request means the project's own tests ran, not only the docs'. Null when there is nothing
 * to run. A check that needs the run's base commit ({base}) is left to the phase run.
 */
export function checksWorkflowText(det, workflow) {
  const checks = workflow.stopGate.checks.filter((c) => !c.run.includes("{"));
  if (!checks.length) return null;
  const pm = det.packageJson ? det.packageManager : null;
  const steps = ["      - uses: actions/checkout@v4"];
  if (pm === "pnpm") steps.push("", "      - uses: pnpm/action-setup@v4", ...(det.packageManagerPin ? [] : ["        with:", "          version: 10"]));
  if (pm === "bun") steps.push("", "      - uses: oven-sh/setup-bun@v2");
  steps.push("", "      - uses: actions/setup-node@v4", "        with:", '          node-version: "22"');
  if (pm) steps.push("", "      - name: Install", `        run: ${yaml(INSTALL[pm](det))}`);
  if (pm && det.prisma) {
    // The generated client is not committed; generating it reads the schema, never a database.
    steps.push("", "      - name: Generate the Prisma client", `        run: ${yaml(`${EXEC[pm]} prisma generate`)}`, "        env:", "          DATABASE_URL: postgresql://ci:ci@localhost:5432/ci");
  }
  for (const check of checks) steps.push("", `      - name: ${yaml(check.label)}`, `        run: ${yaml(check.run)}`);
  return [
    "name: Checks",
    "",
    "# This project's own checks, the stop gate's in .claude/workflow.json, on every push and pull",
    "# request: a green pull request means they passed too, not only the docs' checks (doc-check.yml).",
    "# Written once by /setup-workflow; the project owns it and /update-workflow never touches it, so",
    "# change it here when the checks change.",
    "on:",
    "  push: {}",
    "  pull_request: {}",
    "  workflow_dispatch: {}",
    "",
    "permissions:",
    "  contents: read",
    "",
    "jobs:",
    "  checks:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 15",
    "    steps:",
    ...steps,
    "",
  ].join("\n");
}

/** Where an old rules file is once setup is done: archived (overwrite, inside docs/ or at the top), or where it was. */
function rulesFileAfter(mode, path) {
  const archived = mode === "overwrite" && (!path.includes("/") || path.startsWith("docs/"));
  return archived ? `${ARCHIVE}/${path}` : path;
}

// ------------------------------------------------------------------ plan

/**
 * Every action setup would take, in order, each with the text it would write. `answers`:
 *   mode      "new" | "overwrite" | "merge"
 *   name, summary, date   for the scaffold (date defaults to today)
 *   workflow  the owner's `.claude/workflow.json` (defaults to proposeWorkflow)
 *   pathRoots, liveDocs   for doc-config.mjs (default: the code folders; in merge, the top-level docs)
 *   frontend  the project has screens (default: detect found a frontend): the design rung's prompt file
 *   prototypeDir  doc-config's PROTOTYPE_DIR (default: suggested from the framework; null for none yet)
 */
export function buildPlan(dir, det, answers, plugin = PLUGIN) {
  const mode = answers.mode;
  if (!["new", "overwrite", "merge"].includes(mode)) throw new Error(`mode must be new, overwrite or merge (it is ${JSON.stringify(mode)}).`);
  const problems = [];
  if (det.stamp) problems.push(`This project is already set up (${STAMP}, version ${det.stamp.version}). Use /update-workflow.`);
  if (mode === "new" && !det.empty) problems.push("New mode is for an empty repo; this one has files. Use overwrite or merge.");
  if (mode !== "new" && !det.git.repo) problems.push("Not a git repository: overwrite and merge need git, to show and undo what they change.");
  if (mode !== "new" && det.git.dirty.length) problems.push(`The working tree has changes; commit or put them away first:\n${det.git.dirty.join("\n")}`);
  if (mode !== "new" && !det.git.head) problems.push("The repo has no commits yet; use new mode.");

  const frontend = answers.frontend ?? det.frontend.length > 0;
  let workflow = answers.workflow ?? proposeWorkflow(det, plugin);
  // A project with screens gets the design review's prompt file, unless it already names its own.
  if (frontend && !workflow.phaseRun?.prompt) workflow = { ...workflow, phaseRun: { ...workflow.phaseRun, prompt: PROMPT_FILE } };
  const date = answers.date ?? new Date().toISOString().slice(0, 10);
  const values = {
    NAME: answers.name ?? det.name,
    SUMMARY: answers.summary ?? "What this project is, in one paragraph: who uses it, and for what.",
    DATE: date,
    MODE: `${mode} mode`,
    COMMANDS: commandLines(det, workflow),
  };
  const docConfig = {
    pathRoots: answers.pathRoots ?? det.topFolders,
    liveDocs: answers.liveDocs ?? (mode === "merge" ? det.docs.filter((d) => /^docs\/[^/]+\.md$/.test(d)) : []),
    prototypeDir: answers.prototypeDir !== undefined ? answers.prototypeDir : (det.prototypeDir ?? null),
  };

  // Every file setup writes, before it looks at what is there.
  const wanted = [
    ...templateFiles(plugin).map((path) => ({ path, kind: "template", text: readText(join(plugin, "template", path)) })),
    ...scaffoldFiles(plugin)
      .filter((path) => frontend || !FRONTEND_ONLY.includes(path))
      .map((path) => ({ path, kind: "scaffold", text: render(readText(join(plugin, "scaffold", path)), values) })),
    { path: ".claude/workflow.json", kind: "config", text: `${JSON.stringify(workflow, null, 2)}\n` },
    { path: ".claude/spec-issues.json", kind: "config", text: readText(join(plugin, "template", ".claude", "spec-issues.json")) },
    { path: "tools/doc-config.mjs", kind: "config", text: docConfigText(docConfig, plugin) },
    { path: "tools/doc-check-baseline.json", kind: "config", text: readText(join(plugin, "template", "tools", "doc-check-baseline.json")) },
  ];
  const checksYml = checksWorkflowText(det, workflow);
  if (checksYml) wanted.push({ path: ".github/workflows/checks.yml", kind: "config", text: checksYml });
  const exists = (path) => existsSync(join(dir, path));

  // The project's own rules files. Overwrite archives the top-level ones and those in docs/, and the
  // skill reads each from there (oldRules); one left in place gets a line in the new CLAUDE.md, as
  // Claude reads a nested CLAUDE.md only when it works in that folder.
  const rulesFiles = [...det.agentFiles.filter((f) => !GLOSSARY_NAMES.includes(f)), ...(det.nestedAgentFiles ?? [])];
  const oldRules = mode === "overwrite" ? rulesFiles.map((f) => rulesFileAfter(mode, f)).filter((f) => f.startsWith(`${ARCHIVE}/`)) : [];
  // An old glossary is archived too, and the skill offers its terms for GLOSSARY.md.
  const oldGlossary = mode === "overwrite" ? det.agentFiles.filter((f) => GLOSSARY_NAMES.includes(f)).map((f) => `${ARCHIVE}/${f}`) : [];
  const pointers = (det.nestedAgentFiles ?? [])
    .filter((f) => rulesFileAfter(mode, f) === f)
    .map((f) => `- **Read \`${f}\` before any work**: the project's own context and rules, from before the workflow. Where it and this file differ, ask.`);
  const claude = wanted.find((w) => w.path === "CLAUDE.md");
  if (pointers.length && (!exists("CLAUDE.md") || mode === "overwrite")) claude.text = `${claude.text.replace(/\n*$/, "\n\n")}${pointers.join("\n")}\n`;
  const actions = [];

  // Overwrite: the old docs, agent files and any file in the way move into the archive first.
  const archived = new Set();
  if (mode === "overwrite") {
    const inTheWay = wanted.map((w) => w.path).filter((p) => exists(p) && !p.startsWith("docs/"));
    const settings = join(dir, ".claude", "settings.json");
    const oldSettings = existsSync(settings) ? JSON.parse(readText(settings)) : null;
    const settingsHasMore = oldSettings && Object.keys(oldSettings).some((key) => !INSTALL_KEYS.includes(key));
    const moves = unique([
      ...(exists("docs") ? ["docs"] : []),
      ...det.agentFiles,
      ...inTheWay,
      ...(settingsHasMore ? [".claude/settings.json"] : []),
    ]);
    for (const from of moves) {
      actions.push({ op: "archive", path: from, to: `${ARCHIVE}/${from}` });
      archived.add(from);
    }
    if (settingsHasMore) {
      const kept = Object.fromEntries(INSTALL_KEYS.filter((key) => oldSettings[key]).map((key) => [key, oldSettings[key]]));
      actions.push({ op: "add", path: ".claude/settings.json", kind: "config", text: `${JSON.stringify(kept, null, 2)}\n`, note: "only the plugin keys carried over" });
    }
  }
  const gone = (path) => archived.has(path) || (archived.has("docs") && path.startsWith("docs/"));

  for (const item of wanted) {
    if (!exists(item.path) || gone(item.path)) {
      actions.push({ op: "add", ...item });
      continue;
    }
    const current = readText(join(dir, item.path));
    if (lf(current) === lf(item.text)) {
      actions.push({ op: "same", path: item.path, kind: item.kind });
    } else if (item.path === "CLAUDE.md") {
      actions.push({ op: "append", path: item.path, kind: item.kind, text: claudeMerge(current, item.text) });
    } else {
      actions.push({ op: "conflict", path: item.path, kind: item.kind, text: item.text, note: "exists and differs: left as it is" });
    }
  }

  // .phase-run/ is the runner's state; its clean-tree gate trips on it unless git ignores it.
  const ignore = exists(".gitignore") && !gone(".gitignore") ? readText(join(dir, ".gitignore")) : null;
  if (ignore === null) actions.push({ op: "add", path: ".gitignore", kind: "scaffold", text: ".phase-run/\n" });
  else if (!/^\/?\.phase-run\/?\s*$/m.test(ignore)) {
    actions.push({ op: "append", path: ".gitignore", kind: "scaffold", text: `${ignore}${ignore.endsWith("\n") || !ignore ? "" : "\n"}.phase-run/\n` });
  }

  // package.json gets test:docs and test:runner, but only when it can be edited without reformatting it.
  if (det.packageJson && !gone("package.json")) {
    const text = readText(join(dir, "package.json"));
    const data = JSON.parse(text);
    const want = { "test:docs": "node --test tools/doc-tools.test.mjs", "test:runner": "node --test tools/phase-run/run.test.mjs" };
    const missing = Object.entries(want).filter(([key]) => !data.scripts?.[key]);
    if (missing.length) {
      const indent = text.match(/^\{\r?\n([ \t]+)"/)?.[1] ?? "  ";
      const roundTrips = lf(text).replace(/\n?$/, "\n") === `${JSON.stringify(data, null, indent)}\n`;
      if (roundTrips) {
        data.scripts = { ...(data.scripts ?? {}), ...Object.fromEntries(missing) };
        actions.push({ op: "append", path: "package.json", kind: "scaffold", text: `${JSON.stringify(data, null, indent)}\n`, note: "adds test:docs and test:runner" });
      } else {
        actions.push({ op: "manual", path: "package.json", note: `add to "scripts" by hand (rewriting it would reformat the file): ${missing.map(([k, v]) => `"${k}": "${v}"`).join(", ")}` });
      }
    }
  }

  const sameJob = mode === "merge" ? sameJobPairs(det.docs) : [];
  return { mode, head: det.git.head, problems, answers: { ...answers, date }, actions, sameJob, oldRules, oldGlossary };
}

/** The workflow's CLAUDE.md sections (its commands on) after the project's own text, and a header on top if it had none. */
export function claudeMerge(current, scaffold) {
  const sections = lf(scaffold).slice(lf(scaffold).indexOf("## Commands"));
  const body = `${lf(current).replace(/\n*$/, "\n")}\n${sections}`;
  if (/^---\n/.test(lf(current))) return body;
  const lines = body.split("\n").length;
  const budget = Math.ceil((lines + 40) / 10) * 10;
  return `---\njob: What every session on this repo must know first, its rules, and where everything else lives.\nkind: living\nmax-lines: ${budget}\n---\n${body}`;
}

/** Existing docs that look like they do a job the workflow keeps elsewhere, one row per pair. */
export function sameJobPairs(docs) {
  const ours = new Set([...scaffoldFiles(), ...templateFiles()]);
  const pairs = new Map();
  for (const doc of docs) {
    if (ours.has(doc)) continue;
    const match = SAME_JOB.find(([pattern]) => pattern.test(doc));
    if (!match) continue;
    const where = match[1].endsWith("/") || match[1].includes("(") ? `${posix.dirname(doc)}/` : doc;
    pairs.set(`${where}→${match[1]}`, { theirs: where, ours: match[1] });
  }
  return [...pairs.values()];
}

/** The plan as saved and shown: each action without its text, with a hash of it instead. */
export function plan(dir, answers, plugin = PLUGIN) {
  const built = buildPlan(dir, detect(dir), answers, plugin);
  return { ...built, actions: built.actions.map(({ text, ...rest }) => (text === undefined ? rest : { ...rest, hash: hash(text) })) };
}

// ------------------------------------------------------------------ apply

/** Carries out a saved plan, if the repo is still as it was planned against. */
export function apply(dir, saved, plugin = PLUGIN) {
  const det = detect(dir);
  const fresh = buildPlan(dir, det, saved.answers, plugin);
  if (fresh.problems.length) throw new Error(fresh.problems.join("\n"));
  const strip = (actions) => actions.map(({ text, ...rest }) => (text === undefined ? rest : { ...rest, hash: hash(text) }));
  if (fresh.head !== saved.head || JSON.stringify(strip(fresh.actions)) !== JSON.stringify(saved.actions)) {
    throw new Error("The repo changed since this plan was made. Run plan again and review it.");
  }
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  if (!det.git.repo) git("init", "-q");
  if (fresh.mode === "overwrite") git("switch", "-q", "-c", BRANCH);

  const touched = [];
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
    touched.push(path);
  };
  // Archive in two moves: docs/ cannot be moved into its own docs/history/pre-workflow/.
  const archives = fresh.actions.filter((a) => a.op === "archive");
  const holding = ".brigade-archive";
  for (const a of archives) {
    mkdirSync(dirname(join(dir, holding, a.path)), { recursive: true });
    renameSync(join(dir, a.path), join(dir, holding, a.path));
  }
  for (const a of archives) {
    mkdirSync(dirname(join(dir, a.to)), { recursive: true });
    renameSync(join(dir, holding, a.path), join(dir, a.to));
    touched.push(a.path, a.to);
  }
  rmSync(join(dir, holding), { recursive: true, force: true });

  for (const a of fresh.actions) if (a.op === "add" || a.op === "append") write(a.path, a.text);

  const node = (...args) => spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8" });
  node("tools/doc-index.mjs");
  if (fresh.mode === "merge") node("tools/doc-check.mjs", "--adopt");
  touched.push("docs", "tools/doc-check-baseline.json");

  // The stamp: a template file is hashed only if setup wrote it, so update never replaces one it did not.
  const files = {};
  for (const a of fresh.actions) if (a.kind === "template" && (a.op === "add" || a.op === "same")) files[a.path] = hash(readText(join(dir, a.path)));
  // The plugin's starting copy of each scaffold file, as it was: update reports one that changes since.
  const scaffold = scaffoldHashes(plugin);
  const stamp = { plugin: "brigade", version: pluginVersion(plugin), mode: fresh.mode, adopted: fresh.answers.date, updated: fresh.answers.date, files, scaffold };
  write(STAMP, `${JSON.stringify(stamp, null, 2)}\n`);

  const present = unique(touched).filter((p) => existsSync(join(dir, p)) || git("ls-files", "--", p).trim());
  git("add", "-A", "--", ...present);
  const check = node("tools/doc-check.mjs");
  return {
    branch: fresh.mode === "overwrite" ? BRANCH : det.git.branch,
    written: fresh.actions.filter((a) => a.op === "add" || a.op === "append").map((a) => a.path),
    archived: archives.map((a) => `${a.path} → ${a.to}`),
    conflicts: fresh.actions.filter((a) => a.op === "conflict").map((a) => a.path),
    manual: fresh.actions.filter((a) => a.op === "manual").map((a) => `${a.path}: ${a.note}`),
    sameJob: fresh.sameJob,
    oldRules: fresh.oldRules,
    oldGlossary: fresh.oldGlossary,
    docCheck: { status: check.status, output: `${check.stdout}${check.stderr}`.trim() },
  };
}

// ------------------------------------------------------------------ refresh

/** The scaffold CLAUDE.md's Stack section: its heading, its line, and the generated markers. */
function stackSection(plugin) {
  const lines = lf(readText(join(plugin, "scaffold", "CLAUDE.md"))).split("\n");
  const start = lines.findIndex((line) => line === "## Stack");
  const end = lines.findIndex((line, i) => i > start && /^## /.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n").trim();
}

/**
 * Brings a set-up project's config in line with its stack: the config's own `stack`, or `stack` given,
 * the owner's answer to "what changed?". Each item is one of:
 *   set     the stack itself, as the owner gave it
 *   add     something the stack suggests that is missing; --apply writes it
 *   change, remove   written only when its id is in `accept`: a hand-written row is never dropped silently
 * It covers the stack, the guard's wrappers, the stop gate's checks, the runner's gates and allow
 * rules, the design rung's prompt file, PROTOTYPE_DIR, CLAUDE.md's Stack section and checks.yml.
 */
export function refresh(dir, { stack, apply = false, accept = [] } = {}, plugin = PLUGIN) {
  const det = detect(dir);
  if (!det.stamp) throw new Error(`No ${STAMP}: this project was not set up by /setup-workflow. Run that first.`);
  const current = JSON.parse(readText(join(dir, ".claude", "workflow.json")));
  const chosen = orderStack(stack ?? current.stack ?? {});
  const proposed = proposeWorkflow(det, plugin, { stack: chosen });
  const items = [];
  const item = (id, op, summary, edit) => items.push({ id, op, summary, edit });

  if (JSON.stringify(orderStack(current.stack ?? {})) !== JSON.stringify(chosen)) {
    item("stack", "set", `stack: ${JSON.stringify(chosen)}`, (config) => {
      if (Object.keys(chosen).length) config.stack = chosen;
      else delete config.stack;
    });
  }

  // The lists the stack suggests rows for: a missing one is added; one it would not suggest is offered for removal.
  const same = (row) => row;
  const lists = [
    { section: "guard.wrappers", get: (c) => c.guard?.wrappers ?? [], put: (c, v) => (c.guard = { ...(c.guard ?? {}), wrappers: v }), key: same, show: same },
    {
      section: "stopGate.checks",
      get: (c) => c.stopGate?.checks ?? [],
      put: (c, v) => (c.stopGate = { ...(c.stopGate ?? {}), checks: v }),
      key: (r) => r.run,
      show: (r) => `${r.label}: ${r.run}`,
    },
    {
      section: "phaseRun.gates",
      get: (c) => c.phaseRun?.gates ?? [],
      put: (c, v) => (c.phaseRun = { ...(c.phaseRun ?? {}), gates: v }),
      key: (r) => r.run ?? r.builtin,
      show: (r) => `${r.label}: ${r.run}`,
    },
    {
      section: "phaseRun.permissions.allow",
      get: (c) => c.phaseRun?.permissions?.allow ?? [],
      put: (c, v) => (c.phaseRun = { ...(c.phaseRun ?? {}), permissions: { ...(c.phaseRun?.permissions ?? {}), allow: v } }),
      key: same,
      show: same,
    },
  ];
  for (const list of lists) {
    const have = list.get(current);
    const want = list.get(proposed);
    const haveKeys = new Set(have.map(list.key));
    const wantKeys = new Set(want.map(list.key));
    for (const row of want.filter((r) => !haveKeys.has(list.key(r)))) {
      item(`${list.section}+${list.key(row)}`, "add", `${list.section}: add ${list.show(row)}`, (config) => list.put(config, [...list.get(config), row]));
    }
    for (const row of have.filter((r) => !r.builtin && !wantKeys.has(list.key(r)))) {
      item(`${list.section}-${list.key(row)}`, "remove", `${list.section}: ${list.show(row)} is not one the stack suggests (kept unless accepted)`, (config) =>
        list.put(config, list.get(config).filter((r) => list.key(r) !== list.key(row))),
      );
    }
  }

  // The design rung, once the project has screens: its prompt file and the prototype folder.
  if (det.frontend.length && !current.phaseRun?.prompt) {
    item("phaseRun.prompt", "add", `phaseRun.prompt: ${PROMPT_FILE}, the design review's prompt`, (config) => {
      config.phaseRun = { ...(config.phaseRun ?? {}), prompt: PROMPT_FILE };
    });
    if (!existsSync(join(dir, PROMPT_FILE))) {
      item(PROMPT_FILE, "add", `${PROMPT_FILE}: the design review's prompt file`, (config, files) => files.set(PROMPT_FILE, readText(join(plugin, "scaffold", PROMPT_FILE))));
    }
  }
  const docConfigPath = "tools/doc-config.mjs";
  const docConfig = existsSync(join(dir, docConfigPath)) ? readText(join(dir, docConfigPath)) : "";
  const prototypeLine = /^export const PROTOTYPE_DIR = (null|"[^"\n]*");(?=\r?$)/m;
  const prototypeNow = docConfig.match(prototypeLine);
  if (prototypeNow && det.prototypeDir && JSON.parse(prototypeNow[1]) !== det.prototypeDir) {
    const was = JSON.parse(prototypeNow[1]);
    item("PROTOTYPE_DIR", was === null ? "add" : "change", `${docConfigPath}: PROTOTYPE_DIR ${JSON.stringify(was)} → ${JSON.stringify(det.prototypeDir)}`, (config, files) =>
      files.set(docConfigPath, (files.get(docConfigPath) ?? docConfig).replace(prototypeLine, `export const PROTOTYPE_DIR = ${JSON.stringify(det.prototypeDir)};`)),
    );
  }
  // An older CLAUDE.md has no Stack section: CLAUDE.md is the project's, so it is offered, not added.
  if (existsSync(join(dir, "CLAUDE.md")) && !/<!-- generated:start stack\b/.test(readText(join(dir, "CLAUDE.md")))) {
    item("CLAUDE.md:stack", "change", "CLAUDE.md: add the Stack section, generated from the stack", (config, files) =>
      files.set("CLAUDE.md", `${readText(join(dir, "CLAUDE.md")).replace(/\n*$/, "\n\n")}${stackSection(plugin)}\n`),
    );
  }

  // What the selected items make, then checks.yml from the checks as they will be.
  const selected = (it) => it.op === "set" || it.op === "add" || accept.includes(it.id);
  const build = () => {
    const config = structuredClone(current);
    const files = new Map();
    for (const it of items.filter(selected)) it.edit(config, files);
    return { config, files };
  };
  const ciPath = ".github/workflows/checks.yml";
  const ci = checksWorkflowText(det, build().config);
  const ciNow = existsSync(join(dir, ciPath)) ? readText(join(dir, ciPath)) : null;
  if (ci && lf(ci) !== lf(ciNow ?? "")) {
    item(ciPath, ciNow === null ? "add" : "change", `${ciPath}: ${ciNow === null ? "written" : "rewritten"} from the checks`, (config, files) => files.set(ciPath, ci));
  }

  const report = { stack: chosen, items: items.map(({ id, op, summary }) => ({ id, op, summary })), applied: [], written: [] };
  if (!apply) return report;
  const { config, files } = build();
  if (JSON.stringify(config) !== JSON.stringify(current)) files.set(".claude/workflow.json", `${JSON.stringify(config, null, 2)}\n`);
  for (const [path, text] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  // The Stack section and the other indexes follow the config.
  if (existsSync(join(dir, "tools", "doc-index.mjs"))) spawnSync(process.execPath, ["tools/doc-index.mjs"], { cwd: dir, encoding: "utf8" });
  const written = [...files.keys()];
  if (written.length) execFileSync("git", ["add", "--", ...written, ...(existsSync(join(dir, "CLAUDE.md")) ? ["CLAUDE.md"] : [])], { cwd: dir });
  return { ...report, applied: items.filter(selected).map((it) => it.id), written };
}

// ------------------------------------------------------------------ update

/** The CHANGELOG.md sections after `from`, up to and including `to`. */
export function changesSince(from, to, plugin = PLUGIN) {
  const path = join(plugin, "CHANGELOG.md");
  if (!existsSync(path)) return [];
  const out = [];
  let current = null;
  for (const line of lf(readText(path)).split("\n")) {
    const heading = line.match(/^## (\d+\.\d+\.\d+)\b/);
    if (heading) {
      const v = heading[1];
      current = compareVersions(v, from) > 0 && compareVersions(v, to) <= 0 ? { version: v, lines: [line] } : null;
      if (current) out.push(current);
    } else if (current) current.lines.push(line);
  }
  return out.map((s) => ({ version: s.version, text: s.lines.join("\n").trim() }));
}

/**
 * Re-copies the template into a set-up project. Per template file:
 *   the project's copy is as stamped → replaced by the plugin's (if it changed)
 *   the project edited it            → a conflict: never overwritten
 *   new in the plugin                → added
 *   gone from the plugin             → listed; removed only with `remove`, and only if unedited
 * Config and scaffold files are never touched, except by a version's migration. A scaffold file the
 * plugin changed since the stamp is listed for review (op "review"), and only listed.
 */
export function update(dir, { apply: doApply = false, remove = false, plugin = PLUGIN, migrations = MIGRATIONS, date } = {}) {
  const stampPath = join(dir, STAMP);
  if (!existsSync(stampPath)) throw new Error(`No ${STAMP}: this project was not set up by /setup-workflow. Run that first.`);
  const stamp = JSON.parse(readText(stampPath));
  const to = pluginVersion(plugin);
  const changes = [];
  for (const path of templateFiles(plugin)) {
    const upstream = readText(join(plugin, "template", path));
    const local = join(dir, path);
    if (!existsSync(local)) {
      changes.push(stamp.files[path] ? { op: "conflict", path, note: "the project deleted it" } : { op: "add", path, text: upstream });
      continue;
    }
    const mine = hash(readText(local));
    if (mine === hash(upstream)) changes.push({ op: "same", path });
    else if (stamp.files[path] === mine) changes.push({ op: "replace", path, text: upstream });
    else changes.push({ op: "conflict", path, note: stamp.files[path] ? "edited in the project" : "not written by setup" });
  }
  const current = new Set(templateFiles(plugin));
  for (const path of Object.keys(stamp.files)) {
    if (current.has(path) || !existsSync(join(dir, path))) continue;
    const edited = hash(readText(join(dir, path))) !== stamp.files[path];
    changes.push({ op: remove && !edited ? "remove" : "gone", path, note: edited ? "edited in the project: kept" : "no longer in the plugin" });
  }
  // Scaffold files are the project's own once written, so a change upstream is only reported, never
  // written: the owner compares their copy with the plugin's and carries over what they want.
  const scaffoldNow = scaffoldHashes(plugin);
  const notes = [];
  if (!stamp.scaffold) {
    notes.push("This project's stamp predates 0.2.2, so changes to the plugin's starting files (scaffold/) before now are not listed; from this update on they are.");
  } else {
    for (const [path, now] of Object.entries(scaffoldNow)) {
      if (stamp.scaffold[path] === now) continue;
      const note = stamp.scaffold[path] ? "the plugin's starting copy changed; yours is the project's own: compare, carry over by hand" : "a new starting file in the plugin: add it by hand if you want it";
      changes.push({ op: "review", path, note });
    }
  }
  const pending = migrations.filter((m) => compareVersions(m.version, stamp.version) > 0 && compareVersions(m.version, to) <= 0);
  const report = {
    from: stamp.version,
    to,
    changelog: changesSince(stamp.version, to, plugin),
    changes: changes.filter((c) => c.op !== "same").map(({ text, ...rest }) => rest),
    migrations: pending.map((m) => `${m.version}: ${m.describe}`),
    notes,
  };
  if (!doApply) return report;

  const touched = [];
  for (const c of changes) {
    if (c.op === "add" || c.op === "replace") {
      mkdirSync(dirname(join(dir, c.path)), { recursive: true });
      writeFileSync(join(dir, c.path), c.text);
      touched.push(c.path);
    } else if (c.op === "remove") {
      execFileSync("git", ["rm", "-q", "--", c.path], { cwd: dir });
    }
  }
  for (const m of pending) touched.push(...(m.run(dir) ?? []));
  const files = { ...stamp.files };
  for (const c of changes) {
    if (c.op === "add" || c.op === "replace" || c.op === "same") files[c.path] = hash(readText(join(dir, c.path)));
    if (c.op === "remove") delete files[c.path];
  }
  const next = { ...stamp, version: to, updated: date ?? new Date().toISOString().slice(0, 10), files, scaffold: scaffoldNow };
  writeFileSync(stampPath, `${JSON.stringify(next, null, 2)}\n`);
  touched.push(STAMP);
  spawnSync("git", ["add", "-A", "--", ...unique(touched)], { cwd: dir });
  return report;
}

// ------------------------------------------------------------------ autoMode

/**
 * The project's lines in `autoMode.environment` of a user settings file. Each line reads
 * `**Project <path> — <topic>**: …`; earlier lines for the same path are replaced, other projects'
 * lines are left exactly as they are. Written only if the file round-trips through JSON.stringify
 * unchanged, so the rest of the file is never reformatted; otherwise `writable` is false and the
 * lines are for pasting by hand.
 */
export function autoModeLines(settingsText, lines) {
  const path = lines[0]?.match(/^\*\*Project (.+?) — /)?.[1];
  if (!path) throw new Error('Each line must start "**Project <path> — <topic>**:".');
  if (!lines.every((line) => line.startsWith(`**Project ${path} — `))) throw new Error(`Every line must name the same project (${path}).`);
  const text = lf(settingsText);
  const data = JSON.parse(text);
  const writable = text.replace(/\n?$/, "\n") === `${JSON.stringify(data, null, 2)}\n`;
  const before = data.autoMode?.environment ?? [];
  const env = before.filter((line) => !line.startsWith(`**Project ${path} — `));
  if (!env.includes("$defaults")) env.unshift("$defaults");
  let at = env.findLastIndex((line) => line.startsWith("**Project "));
  if (at === -1) {
    at = env.findIndex((line) => line.startsWith("### Per-project"));
    if (at === -1) {
      at = env.indexOf("$defaults") + 1;
      env.splice(at, 0, "### Per-project additions — each line below applies ONLY when the session's working directory is that project; in any other project, rely on the defaults above");
    }
  }
  env.splice(at + 1, 0, ...lines);
  const after = { ...data, autoMode: { ...(data.autoMode ?? {}), environment: env } };
  return {
    writable,
    changed: JSON.stringify(before) !== JSON.stringify(env),
    removed: before.filter((line) => !env.includes(line)),
    added: env.filter((line) => !before.includes(line)),
    text: `${JSON.stringify(after, null, 2)}\n`,
  };
}

// ------------------------------------------------------------------ the command line

function summarize(p) {
  const count = (op) => p.actions.filter((a) => a.op === op);
  const out = [`Mode: ${p.mode}`];
  if (p.problems.length) out.push("", "Cannot go ahead:", ...p.problems.map((x) => `  - ${x}`));
  for (const [op, label] of [["archive", "Moved into the archive"], ["add", "Written"], ["append", "Changed (shown as a diff before writing)"], ["conflict", "Left alone: exists and differs"], ["manual", "By hand"], ["same", "Already identical"]]) {
    const items = count(op);
    if (!items.length) continue;
    out.push("", `${label} (${items.length}):`);
    for (const a of items) out.push(`  ${a.path}${a.to ? ` → ${a.to}` : ""}${a.note ? `  (${a.note})` : ""}`);
  }
  if (p.sameJob.length) out.push("", "Docs of yours that look like they do a job the workflow keeps elsewhere (nothing moved):", ...p.sameJob.map((s) => `  ${s.theirs}  ~  ${s.ours}`));
  if (p.oldRules.length) out.push("", "The project's old rules, to carry into CLAUDE.md after apply (read from):", ...p.oldRules.map((f) => `  ${f}`));
  if (p.oldGlossary?.length) out.push("", "The project's old glossary, its terms to carry into GLOSSARY.md after apply (read from):", ...p.oldGlossary.map((f) => `  ${f}`));
  return out.join("\n");
}

/** The checks a set-up project must pass: doc-check, the template's two test suites, and its config through both loaders. */
export async function verify(dir) {
  const node = (...args) => spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8" });
  const results = [];
  const run = (label, ...args) => {
    const r = node(...args);
    results.push({ label, ok: r.status === 0, output: r.status === 0 ? "" : `${r.stdout}${r.stderr}`.trim().slice(-2000) });
  };
  run("doc-check", "tools/doc-check.mjs");
  run("the doc tools' tests", "--test", "tools/doc-tools.test.mjs");
  run("the phase runner's tests", "--test", "tools/phase-run/run.test.mjs");
  const { loadWorkflowConfig } = await import(pathToFileURL(join(PLUGIN, "hooks", "workflow-config.mjs")).href);
  const hooks = loadWorkflowConfig(dir);
  results.push({ label: "the hooks' config", ok: !hooks.error, output: hooks.error ?? "" });
  const { loadRunConfig } = await import(pathToFileURL(join(dir, "tools", "phase-run", "config.mjs")).href);
  const runner = loadRunConfig(dir);
  results.push({ label: "the phase runner's config", ok: !runner.error, output: runner.error ?? "" });
  return results;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const value = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : null);
  const target = rest[0];
  const print = (data) => console.log(JSON.stringify(data, null, 2));
  try {
    if (command === "detect") print(detect(target));
    else if (command === "propose") print(proposeWorkflow(detect(target)));
    else if (command === "verify") {
      const results = await verify(target);
      for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.label}${r.output ? `\n${r.output}` : ""}`);
      if (results.some((r) => !r.ok)) process.exitCode = 1;
    } else if (command === "plan") {
      const p = plan(target, JSON.parse(readText(value("--answers"))));
      if (value("--out")) {
        mkdirSync(dirname(value("--out")), { recursive: true });
        writeFileSync(value("--out"), `${JSON.stringify(p, null, 2)}\n`);
      }
      // The proposed text of each file setup would change or leaves in conflict, for a real diff.
      if (value("--preview")) {
        for (const a of buildPlan(target, detect(target), p.answers).actions) {
          if (a.op !== "append" && a.op !== "conflict") continue;
          mkdirSync(dirname(join(value("--preview"), a.path)), { recursive: true });
          writeFileSync(join(value("--preview"), a.path), a.text);
        }
      }
      console.log(summarize(p));
      if (p.problems.length) process.exitCode = 1;
    } else if (command === "apply") print(apply(target, JSON.parse(readText(value("--plan")))));
    else if (command === "update") print(update(target, { apply: rest.includes("--apply"), remove: rest.includes("--remove") }));
    else if (command === "automode") {
      const settings = value("--settings");
      const result = autoModeLines(readText(settings), JSON.parse(readText(value("--lines"))));
      if (rest.includes("--apply")) {
        if (!result.writable) throw new Error(`${settings} would be reformatted by a rewrite; paste the lines by hand.`);
        writeFileSync(settings, result.text);
      }
      print({ writable: result.writable, changed: result.changed, removed: result.removed, added: result.added, written: rest.includes("--apply") });
    } else if (command === "labels") print(LABELS);
    else if (command === "refresh") {
      const stack = value("--stack") ? JSON.parse(readText(value("--stack"))) : undefined;
      const accept = value("--accept") ? value("--accept").split(",").map((id) => id.trim()) : [];
      print(refresh(target, { stack, apply: rest.includes("--apply"), accept }));
    } else if (command === "docker") print(dockerStatus());
    else throw new Error("Usage: setup.mjs detect|propose|plan|apply|verify|update|refresh|docker|automode|labels (see the top of this file).");
  } catch (error) {
    console.error(`setup: ${error.message}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
