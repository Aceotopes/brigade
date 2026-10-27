// Where this project's docs live, read by the three doc tools:
//   tools/doc-check.mjs   the checks a commit must pass
//   tools/doc-index.mjs   the indexes nobody writes by hand
//   tools/doc-rotate.mjs  the end-of-phase move of the devlog into its archive
//
// The tools themselves know nothing about Steak To Juan; every path they
// touch is named here. A doc's own rules (its job, kind and budget) are not
// here either: they sit in the doc's frontmatter, where a reader sees them.

/** The current phase's devlog: open entry on top. Rotated at each phase end. */
export const DEVLOG = "docs/history/devlog.md";
/** One frozen file per finished phase (or month, before the phase runs). */
export const DEVLOG_ARCHIVE = "docs/history/devlog";
/** The archive buckets so far, oldest first. doc-rotate appends to it. */
export const PHASES = "docs/history/devlog/phases.json";

/**
 * Files and folders whose claims are read as current: one folder per question
 * a doc answers (status, guides, reference), the skill config in docs/agents,
 * and the hand-written heads of the history folders' indexes. The
 * missing-path and header checks cover all of them. The history records, the
 * ADRs, research, the discovery rounds and the handbook's chapters are left as
 * written.
 */
export const LIVE_DOCS = [
  "CLAUDE.md",
  "CONTEXT.md",
  "DESIGN.md",
  "PRODUCT.md",
  "docs/README.md",
  "docs/status",
  "docs/guides",
  "docs/reference",
  "docs/agents",
  "docs/history/devlog/README.md",
  "docs/history/implementation-log/README.md",
  "docs/handbook/README.md",
  "design",
  ".claude/skills/doc-sync",
  ".claude/skills/ticket-check",
  ".impeccable/surfaces",
  "tools/phase-run",
];

/**
 * The stale-phrase check covers status-bearing docs only. A design file or
 * DESIGN.md says "still open" about a drawer, not about a decision.
 */
export const STATUS_DOCS = /^(CLAUDE\.md|CONTEXT\.md|docs\/(status|guides|reference|agents)\/.+)$/;

/**
 * Docs that must open with a frontmatter header (job, kind, budget): files, or
 * folders meaning every .md under them. Any doc that has a header is held to it.
 */
export const HEADER_REQUIRED = [
  "CLAUDE.md",
  "CONTEXT.md",
  "docs", // every doc in docs/, so a new one cannot land without a job and a budget
];

/** Never asked for a header: another tool writes or reads these files as they are. */
export const HEADER_EXEMPT = [
  /^PRODUCT\.md$/, // Impeccable reads it by its own schema marker
  /^DESIGN\.md$/, // Impeccable's documenter owns its format
  /^AGENTS\.md$/, // `next dev` rewrites it
  /^\.impeccable\//,
  /^design\//, // prototypes and flow diagrams, deleted once built
  /^\.claude\/skills\//, // skill files carry the skill loader's own frontmatter
  /^tools\/phase-run\//, // prompts the runner renders
  // Frozen records inside docs/: written once, never budgeted.
  /^docs\/claude-discovery-rounds\//,
  /^docs\/research\//,
  /^docs\/adr\/\d{4}-/, // an ADR's header holds its status, not a job
  /^docs\/history\/implementation-log\/\d/,
  /^docs\/history\/workflow-upgrade-plan\.md$/,
  /^docs\/_templates\/(?!README\.md$)/, // a template's header is a placeholder
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
/** Entries from this number on use `## #NNN · type · title` and carry no hash. */
export const DEVLOG_TAGGED_FROM = 339;
