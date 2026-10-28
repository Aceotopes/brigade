// Where this project's docs live, read by the three doc tools:
//   tools/doc-check.mjs   the checks a commit must pass
//   tools/doc-index.mjs   the indexes nobody writes by hand
//   tools/doc-rotate.mjs  the end-of-phase move of the devlog into its archive
//
// The tools themselves know no project; every path they touch is named here.
// This is Brigade's starting copy: the layout the workflow itself uses (the
// paths the doc-sync skill names). A project adds its own docs to these lists
// (a DESIGN.md, a design/ folder, its code folders in PATH_ROOTS) and keeps
// every export: the tools import each one. A doc's own rules (its job, kind and
// budget) are not here: they sit in the doc's frontmatter, where a reader sees them.

/** The current phase's devlog: open entry on top. Rotated at each phase end. */
export const DEVLOG = "docs/history/devlog.md";
/** One frozen file per finished phase (or month, before the phase runs). */
export const DEVLOG_ARCHIVE = "docs/history/devlog";
/** The archive buckets so far, oldest first. doc-rotate appends to it. */
export const PHASES = "docs/history/devlog/phases.json";
/**
 * A phase's gotchas file, `{phase}` its name (branch phase-2b → 2b); the phase runner tells each
 * session this path. Flat by default. A project that groups its phases into modules names the
 * module's folder instead, e.g. "docs/agents/gotchas/module-2/{phase}.md": the gotchas index reads
 * every file under docs/agents/gotchas, at any depth.
 */
export const GOTCHAS_FILE = "docs/agents/gotchas/{phase}.md";
/**
 * The discovery docs: what the product is for, written before the first phase, one `NN-topic.md` each.
 * Records: never rewritten, so doc-check refuses a change below a doc's addendum block; a later fact is
 * a dated addendum at its top. Its README is the generated index.
 */
export const DISCOVERY_DIR = "docs/discovery";
/**
 * The design rung (a project with screens): each module's flow diagram, `<DESIGN_DIR>/flows/module-N.md`,
 * whose `**Approved:**` line records its prototype's approval, and its sample data,
 * `<SAMPLE_DATA_DIR>/module-N.json`, shared by the prototype, the QA seed and the tests.
 */
export const DESIGN_DIR = "design";
export const SAMPLE_DATA_DIR = "design/sample-data";
/**
 * Where the prototypes live, inside the app so they use the real shell: one folder per module under
 * it. Its top-level guard file carries `brigade:prototype-guard` and hides it from a production build;
 * doc-check refuses the folder without it. null until the project has one (setup asks).
 */
export const PROTOTYPE_DIR = null;

/**
 * Files and folders whose claims are read as current: one folder per question
 * a doc answers (status, guides, reference), the skill config in docs/agents,
 * and the hand-written heads of the history folders' indexes. The
 * missing-path and header checks cover all of them. The history records, the
 * ADRs, research and the handbook's chapters are left as written.
 */
export const LIVE_DOCS = [
  "CLAUDE.md",
  "GLOSSARY.md",
  "docs/README.md",
  "docs/status",
  "docs/guides",
  "docs/reference",
  "docs/agents",
  "docs/history/devlog/README.md",
  "docs/history/implementation-log/README.md",
  "docs/handbook/README.md",
  "tools/phase-run",
];

/** The stale-phrase check covers status-bearing docs only. */
export const STATUS_DOCS = /^(CLAUDE\.md|GLOSSARY\.md|docs\/(status|guides|reference|agents)\/.+)$/;

/**
 * The missing-path check: a path a live doc cites (`docs/guides/x.md`) must exist.
 * Only paths under these top-level folders, ending in one of these file types,
 * are read as paths; anything else in a doc is prose. Add the project's own
 * folders ("src", "test", ...) as its docs start citing them.
 */
export const PATH_ROOTS = ["docs", "design", "tools", ".github", ".claude"];
export const PATH_EXTENSIONS = ["md", "html", "tsx", "ts", "mjs", "sql", "yml", "json", "sh", "css"];

/**
 * Docs that must open with a frontmatter header (job, kind, budget): files, or
 * folders meaning every .md under them. Any doc that has a header is held to it.
 */
export const HEADER_REQUIRED = [
  "CLAUDE.md",
  "GLOSSARY.md",
  "docs", // every doc in docs/, so a new one cannot land without a job and a budget
];

/** Never asked for a header: another tool writes or reads these files as they are. */
export const HEADER_EXEMPT = [
  /^tools\/phase-run\//, // prompts the runner renders
  // Frozen records inside docs/: written once, never budgeted.
  /^docs\/research\//,
  new RegExp(`^${DISCOVERY_DIR}/(?!README\\.md$)`), // discovery docs, written as they came; the index has a header
  /^docs\/adr\/\d{4}-/, // an ADR's header holds its status, not a job
  /^docs\/history\/implementation-log\/\d/,
  /^docs\/_templates\/(?!README\.md$)/, // a template's header is a placeholder
  /^docs\/history\/pre-workflow\//, // what an adopted repo had before, archived by /setup-workflow
];

/**
 * The indexes tools/doc-index.mjs writes. Each lives between
 * `<!-- generated:start NAME -->` and `<!-- generated:end NAME -->` in its
 * target, so the hand-written text around it stays; a target without the
 * markers is left alone. `dir` is what the index lists.
 */
export const GENERATED = [
  { name: "implementation-log", target: "docs/history/implementation-log/README.md", dir: "docs/history/implementation-log" },
  { name: "devlog-archive", target: "docs/history/devlog/README.md", dir: "docs/history/devlog" },
  { name: "gotchas", target: "docs/agents/gotchas/README.md", dir: "docs/agents/gotchas" },
  { name: "handbook", target: "docs/handbook/README.md", dir: "docs/handbook" },
  { name: "doc-map", target: "docs/README.md", dir: "." },
  { name: "adr-index", target: "docs/adr/README.md", dir: "docs/adr" },
  { name: "discovery", target: `${DISCOVERY_DIR}/README.md`, dir: DISCOVERY_DIR },
  { name: "design", target: `${DESIGN_DIR}/README.md`, dir: `${DESIGN_DIR}/flows` },
  {
    name: "open-items",
    target: "docs/status/open-items.md",
    register: "docs/reference/domain-model.md",
    lists: [
      { files: ["docs/status/handoff.md"], heading: "Waiting on the owner" },
      { files: ["docs/guides/"], heading: "Things only you can settle" },
    ],
  },
];

/** The devlog's commit-type tags (the commit message's own prefix). */
export const DEVLOG_TYPES = ["feat", "fix", "docs", "chore", "refactor", "test", "style", "design", "ci", "infra", "research", "perf"];
/** Entries from this number on use `## #NNN · type · title` and carry no hash. A project that starts on the workflow starts at 1. */
export const DEVLOG_TAGGED_FROM = 1;
