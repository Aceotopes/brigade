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

// 0.6.0 (#19, D12, D13): a gate's `after` names another gate's label, and its `unreadOf` a stop
// check's `name`. The hooks skip `phaseRun`, except to refuse these two names alike: a name that
// names nothing must fail loudly wherever the file is read, never be quietly ignored.
const withGates = (gates, ...rows) => ({ version: 1, stopGate: { checks: rows }, phaseRun: { gates } });
const named = tests({ name: "tests", unread: ["docs/**"] });

test("both loaders refuse an after or unreadOf that names nothing, with the same words", () => {
  const cases = [
    [withGates([{ label: "build", run: "b" }, { label: "typecheck", run: "t", after: "biuld" }]), /phaseRun\.gates\[1\]\.after "biuld" names no gate: it must be another gate's label \(build, typecheck\)\./],
    [withGates([{ label: "suite", run: "s", unreadOf: "tset" }], named), /phaseRun\.gates\[0\]\.unreadOf "tset" names no stop check: it must be a stopGate\.checks row's "name" \(tests\)\./],
    // A row without a name has no list a gate can point at.
    [withGates([{ label: "suite", run: "s", unreadOf: "tests" }], tests({ unread: ["docs/**"] })), /phaseRun\.gates\[0\]\.unreadOf "tests" names no stop check: .*\(no row has one\)\./],
  ];
  for (const [data, error] of cases) {
    const messages = [() => parseWorkflowConfig(data), () => parseRunConfig(data)].map((load) => {
      try {
        load();
      } catch (thrown) {
        return thrown.message;
      }
      return "(loaded)";
    });
    assert.match(messages[0], error, "hooks");
    assert.equal(messages[1], messages[0], "the runner's words are the hooks'");
  }
  const good = withGates([{ label: "build", run: "b" }, { label: "typecheck", run: "t", after: "build" }, { label: "suite", run: "s", unreadOf: "tests", alone: true }], named);
  assert.doesNotThrow(() => parseWorkflowConfig(good));
  assert.deepEqual(parseRunConfig(good).gates.map((g) => [g.label, g.after, g.unreadOf]), [["build", null, null], ["typecheck", "build", null], ["suite", null, "tests"]]);
  // Any other shape in phaseRun stays the runner's to refuse: the hooks never break a shell over it.
  for (const gates of ["lint", [null, 3, { label: 4, after: 5 }], [{ label: "a", run: "a", after: ["b"] }]]) {
    assert.doesNotThrow(() => parseWorkflowConfig(withGates(gates)), JSON.stringify(gates));
    assert.throws(() => parseRunConfig(withGates(gates)), undefined, JSON.stringify(gates));
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

// 0.6.0 (#21, D16): `phaseRun.keep` names the user plugins and skills a project's nights keep from
// the machine's trim list. The hooks pass over it (it judges nothing); the runner checks its shape.
test("both loaders accept phaseRun.keep; the runner refuses a malformed one", () => {
  const keep = { plugins: ["notion@official"], skills: ["dataviz"], note: "our docs need these" };
  assert.doesNotThrow(() => parseWorkflowConfig({ version: 1, phaseRun: { keep } }));
  assert.deepEqual(parseRunConfig({ version: 1, phaseRun: { keep } }).keep, { plugins: ["notion@official"], skills: ["dataviz"] });
  assert.deepEqual(parseRunConfig({ version: 1 }).keep, { plugins: [], skills: [] });
  for (const [bad, error] of [
    [{ flags: ["--no-chrome"] }, /phaseRun\.keep has unknown key\(s\) flags/],
    [{ skills: "dataviz" }, /phaseRun\.keep\.skills must be a list/],
    [{ plugins: [""] }, /phaseRun\.keep\.plugins\[0\] is missing/],
    [{ plugins: ["figma"] }, /phaseRun\.keep\.plugins: "figma" is not a plugin id/],
  ]) {
    assert.throws(() => parseRunConfig({ version: 1, phaseRun: { keep: bad } }), error, JSON.stringify(bad));
  }
  for (const bad of [null, []]) {
    assert.throws(() => parseRunConfig({ version: 1, phaseRun: { keep: bad } }), /phaseRun\.keep must be an object/, JSON.stringify(bad));
  }
});

// 0.6.0 (#20, D15): `phaseRun.tampering` is checked in full by both loaders, with the same words: a
// broken rule must stop the night wherever the file is read, never be quietly skipped. This is the
// one part of phaseRun the hooks refuse on any shape.
const withTampering = (tampering) => ({ version: 1, phaseRun: { tampering } });
const TAMPERING = {
  testFiles: ["**/*.test.mjs"],
  markers: [{ name: "skip", pattern: "\\.skip\\(" }, { name: "only", pattern: "\\.only\\(", note: "node:test's focus" }],
  assertions: { pattern: "\\bassert\\.", maxNetRemoved: 0 },
  guarded: [".claude/workflow.json", "package.json"],
  guardedScripts: [{ file: "package.json", script: "test" }],
  override: { heading: "Tests removed or weakened" },
};

test("both loaders accept the tampering section; no section means no tampering gate", () => {
  assert.doesNotThrow(() => parseWorkflowConfig(withTampering(TAMPERING)));
  const rules = parseRunConfig(withTampering(TAMPERING)).tampering;
  assert.deepEqual(rules.markers.map((m) => [m.name, m.pattern.source]), [["skip", "\\.skip\\("], ["only", "\\.only\\("]]);
  assert.deepEqual([rules.assertions.maxNetRemoved, rules.guarded, rules.guardedScripts, rules.override], [0, TAMPERING.guarded, TAMPERING.guardedScripts, TAMPERING.override]);
  assert.equal(parseRunConfig({ version: 1 }).tampering, null);
  assert.equal(parseRunConfig({ version: 1, phaseRun: {} }).tampering, null);
  // Only guarded files: no test files needed.
  assert.deepEqual(parseRunConfig(withTampering({ guarded: ["vitest.config.ts"] })).tampering.testFiles, []);
});

test("both loaders refuse a bad tampering section, a bad regex among it, with the same words", () => {
  const cases = [
    [{ ...TAMPERING, markers: [{ name: "skip", pattern: "(" }] }, /^phaseRun\.tampering\.markers\[0\]\.pattern is not a valid pattern: /],
    [{ ...TAMPERING, assertions: { pattern: "[", maxNetRemoved: 0 } }, /^phaseRun\.tampering\.assertions\.pattern is not a valid pattern: /],
    [{ ...TAMPERING, assertions: { pattern: "assert", maxNetRemoved: -1 } }, /assertions\.maxNetRemoved must be a whole number, 0 or more \(it is -1\)\./],
    [{ ...TAMPERING, assertions: { pattern: "assert" } }, /assertions\.maxNetRemoved must be a whole number/],
    [{ ...TAMPERING, markers: [{ pattern: "x" }] }, /^phaseRun\.tampering\.markers\[0\]\.name is missing\.$/],
    [{ ...TAMPERING, markers: [{ name: "skip", regex: "x" }] }, /markers\[0\] has unknown key\(s\) regex; allowed: name, pattern\./],
    [{ ...TAMPERING, guardedScript: [] }, /^phaseRun\.tampering has unknown key\(s\) guardedScript; allowed: testFiles, markers, assertions, guarded, guardedScripts, override\.$/],
    [{ ...TAMPERING, guardedScripts: [{ file: "package.json" }] }, /guardedScripts\[0\]\.script is missing\./],
    [{ ...TAMPERING, guarded: "package.json" }, /^phaseRun\.tampering\.guarded must be a list\.$/],
    [{ ...TAMPERING, testFiles: [" **/*.test.mjs"] }, /testFiles\[0\] must be a path from the repo's root, such as "\*\*\/\*\.test\.mjs"\./],
    // As git prints a path, from the root: these would match nothing, a rule quietly off.
    [{ ...TAMPERING, guarded: ["./vitest.config.ts"] }, /guarded\[0\] must be a path from the repo's root/],
    [{ ...TAMPERING, guarded: ["../shared/vitest.config.ts"] }, /guarded\[0\] must be a path from the repo's root/],
    [{ ...TAMPERING, guardedScripts: [{ file: "./package.json", script: "test" }] }, /guardedScripts\[0\]\.file must be a path from the repo's root, such as "package\.json"\./],
    [{ ...TAMPERING, testFiles: [] }, /testFiles is empty, so its markers and assertions would match no file/],
    [{ ...TAMPERING, override: { heading: " " } }, /override\.heading is missing\./],
    [[], /^phaseRun\.tampering must be an object\.$/],
  ];
  for (const [tampering, error] of cases) {
    const messages = [() => parseWorkflowConfig(withTampering(tampering)), () => parseRunConfig(withTampering(tampering))].map((load) => {
      try {
        load();
      } catch (thrown) {
        return thrown.message;
      }
      return "(loaded)";
    });
    assert.match(messages[0], error, `hooks: ${JSON.stringify(tampering)}`);
    assert.equal(messages[1], messages[0], "the runner's words are the hooks'");
  }
});

test("the two loaders' tamperingRules are one text, word for word", () => {
  const body = (file) => {
    const text = readFileSync(join(PLUGIN, file), "utf8").replace(/\r\n/g, "\n");
    const start = text.indexOf("function tamperingRules(");
    assert.notEqual(start, -1, file);
    return text.slice(start, text.indexOf("\n}\n", start));
  };
  assert.equal(body("template/tools/phase-run/config.mjs"), body("hooks/workflow-config.mjs"));
});

// 0.7.0 (#29, D3–D6): two lanes are config, `phaseRun.lanes` and `phaseRun.hotspots`, and a port row
// may carry a `name`. Only the runner's loader checks them; the hooks' loader passes over them, as no
// hook reads lane config (owner, 2026-11-09). No `lanes` section is today's run.
const LANES = {
  rows: [
    // Lane 1 names every lane value lane 2 names (the source's later fix): its test prefix and its env key.
    { id: 1, takes: "any", worktree: "../shop-lanes/lane-1", ports: [{ port: 4100, what: "the QA server", name: "qa" }], testDbPrefix: "lane1_", env: { CACHE_DB: "1" } },
    {
      id: 2,
      takes: "walk",
      worktree: "../shop-lanes/lane-2",
      qa: "shop_qa_2",
      ports: [{ port: 4200, what: "the QA server", name: "qa", freeAfterEachTicket: true }, { port: 4201, what: "the dev server" }],
      testDbPrefix: "lane2_",
      env: { CACHE_DB: "2", note: "the cache's database index" },
    },
  ],
  claims: {},
  worktreeSetup: { copy: [".env", ".claude/settings.local.json"], commands: ["npm ci"], leaves: ["node_modules/.bin/tsc"] },
  landing: { note: "its keys come with Landing" },
};
const HOTSPOTS = {
  token: "NNN",
  rows: [
    { path: "docs/history/devlog.md", kind: "log" },
    { path: "docs/history/implementation-log/*.md", kind: "log" },
    { path: "docs/README.md", kind: "generated" },
    { path: "docs/agents/gotchas/*.md", kind: "own-file" },
  ],
};
const QA = { name: "shop_qa", url: "postgresql://localhost:5432/shop_qa" };
const withLanes = (lanes, extra = {}) => ({ version: 1, phaseRun: { qa: QA, lanes, ...extra } });
// The message alone, so a pattern can say the field comes first (assert.throws matches "Error: …").
const refusal = (load) => {
  try {
    load();
  } catch (thrown) {
    return thrown.message;
  }
  return "(loaded)";
};

test("the runner's loader reads a two-lane config and its hotspots as written", () => {
  const config = parseRunConfig(withLanes(LANES, { hotspots: HOTSPOTS }));
  // Lane 1 leaves qa out: its QA database is phaseRun.qa's, with no value made up for its row.
  assert.deepEqual(
    config.lanes.rows.map((r) => [r.id, r.takes, r.worktree, r.qa, r.testDbPrefix]),
    [["1", "any", "../shop-lanes/lane-1", null, "lane1_"], ["2", "walk", "../shop-lanes/lane-2", "shop_qa_2", "lane2_"]],
  );
  assert.deepEqual(config.lanes.rows[1].ports, [
    { port: 4200, what: "the QA server", freeAfterEachTicket: true, name: "qa" },
    { port: 4201, what: "the dev server", freeAfterEachTicket: false, name: null },
  ]);
  assert.deepEqual([config.lanes.rows[0].env, config.lanes.rows[1].env], [{ CACHE_DB: "1" }, { CACHE_DB: "2" }]);
  assert.deepEqual(config.lanes.worktreeSetup, LANES.worktreeSetup);
  assert.deepEqual([config.lanes.claims, config.lanes.landing], [{}, {}]);
  assert.deepEqual(config.hotspots, HOTSPOTS);
  // Every part but the rows may be left out.
  const bare = parseRunConfig(withLanes({ rows: LANES.rows })).lanes;
  assert.deepEqual([bare.claims, bare.worktreeSetup, bare.landing], [{}, { copy: [], commands: [], leaves: [] }, {}]);
  assert.deepEqual(parseRunConfig({ version: 1, phaseRun: { hotspots: { rows: [] } } }).hotspots, { token: null, rows: [] });
  // A lane value no lane names is left out of every row: a project without test databases names none.
  const none = ({ testDbPrefix: _p, env: _e, ...row }) => row;
  const bareRows = parseRunConfig(withLanes({ rows: LANES.rows.map(none) })).lanes.rows;
  assert.deepEqual(bareRows.map((r) => [r.testDbPrefix, r.env]), [[null, {}], [null, {}]]);
  // A port row's name, in phaseRun.ports' own rows too.
  assert.deepEqual(parseRunConfig({ version: 1, phaseRun: { ports: [{ port: 4100, what: "the QA server", name: "qa" }] } }).ports, [
    { port: 4100, what: "the QA server", freeAfterEachTicket: false, name: "qa" },
  ]);
});

test("a config with no lanes section loads as before: no lanes, no hotspots, no port names", () => {
  for (const data of [{ version: 1 }, { version: 1, phaseRun: {} }, BLANK, STJ]) {
    const config = parseRunConfig(data);
    assert.deepEqual([config.lanes, config.hotspots], [null, null], JSON.stringify(data).slice(0, 60));
    assert.ok(config.ports.every((p) => p.name === null));
  }
});

test("the hooks' loader passes over lanes, hotspots and a port's name, which no hook reads", () => {
  const data = withLanes(LANES, { hotspots: HOTSPOTS, ports: [{ port: 4100, what: "the QA server", name: "qa" }] });
  assert.deepEqual(parseWorkflowConfig(data), parseWorkflowConfig({ version: 1 }));
  // Even a lane table the runner refuses: preflight catches it, and the hooks keep working.
  const refused = withLanes({ rows: [...LANES.rows, LANES.rows[1]], lock: true }, { hotspots: { rows: [{ path: "x", kind: "merge" }] } });
  assert.throws(() => parseRunConfig(refused));
  assert.doesNotThrow(() => parseWorkflowConfig(refused));
});

test("the runner's loader refuses a bad lane table, naming the field", () => {
  const [one, two] = LANES.rows;
  const withoutKey = (row, key) => Object.fromEntries(Object.entries(row).filter(([name]) => name !== key));
  const { qa: _qa, ...twoWithoutQa } = two;
  const third = { id: 3, takes: "docs", worktree: "../shop-lanes/lane-3", qa: "shop_qa_3", ports: [{ port: 4300, what: "the QA server", name: "qa" }] };
  const rows = (...list) => ({ rows: list });
  const cases = [
    // Two lanes at most (D5).
    [rows(one, two, third), /^phaseRun\.lanes\.rows has 3 rows, and at most 2 lanes run: take out rows\[2\]\.$/],
    // At most one row takes any ticket (D6), and the message names the upgrade that would lift it.
    [rows(one, { ...two, takes: "any" }), /^phaseRun\.lanes\.rows\[1\]\.takes is "any", as phaseRun\.lanes\.rows\[0\]\.takes is: .*Areas don't overlap.* out of scope/],
    // Each lane its own QA database: lane 1's row qa, or phaseRun.qa's own when lane 1's row has none.
    [rows(one, { ...two, qa: "shop_qa" }), /^phaseRun\.lanes\.rows\[1\]\.qa "shop_qa" is also phaseRun\.lanes\.rows\[0\]'s QA database \(phaseRun\.qa\.name, as it has no "qa"\): each lane needs its own\.$/],
    [rows({ ...one, qa: "shop_main" }, { ...two, qa: "shop_main" }), /^phaseRun\.lanes\.rows\[1\]\.qa "shop_main" is also phaseRun\.lanes\.rows\[0\]'s QA database \(phaseRun\.lanes\.rows\[0\]\.qa\)/],
    [rows(one, twoWithoutQa), /^phaseRun\.lanes\.rows\[1\] has no "qa", so its QA database is phaseRun\.qa\.name "shop_qa", which is also phaseRun\.lanes\.rows\[0\]'s/],
    // A qa database and no port named qa: its browser check would reach another lane's server.
    [rows(one, { ...two, ports: [{ port: 4200, what: "the QA server" }] }), /^phaseRun\.lanes\.rows\[1\]\.qa is set, but phaseRun\.lanes\.rows\[1\]\.ports has no port named "qa"/],
    // Every lane names every lane value another lane names (the source's later fix), or a lane that names
    // none has nothing to replace whatever it inherits: lane 1 ran on lane 2's test databases there.
    [rows(withoutKey(one, "testDbPrefix"), two), /^phaseRun\.lanes\.rows\[0\] has no testDbPrefix, but phaseRun\.lanes\.rows\[1\] sets one: every lane names its own test prefix once any lane does/],
    [rows({ ...one, ports: [] }, two), /^phaseRun\.lanes\.rows\[0\] has no port named "qa", but phaseRun\.lanes\.rows\[1\] has one: every lane names its own QA port once any lane does/],
    [rows({ ...one, env: {} }, two), /^phaseRun\.lanes\.rows\[0\]\.env has no CACHE_DB, but phaseRun\.lanes\.rows\[1\]\.env sets it: every lane names each env key any lane sets/],
    // testDbPrefix: never empty, never unsafe.
    [rows(one, { ...two, testDbPrefix: "" }), /^phaseRun\.lanes\.rows\[1\]\.testDbPrefix is set but empty: leave it out/],
    ...["lane-2", "Lane2_", "2lane", "lane 2", "lane%", 2].map((testDbPrefix) => [rows(one, { ...two, testDbPrefix }), /^phaseRun\.lanes\.rows\[1\]\.testDbPrefix .* is unsafe: /]),
    // Each lane its own prefix: one that starts the other's would match its databases too.
    ...[["lane2_", "lane2_"], ["lane", "lane2_"], ["lane2_", "lane"]].map(([a, b]) => [
      rows({ ...one, testDbPrefix: a }, { ...two, testDbPrefix: b }),
      /^phaseRun\.lanes\.rows\[1\]\.testDbPrefix "\w+" overlaps phaseRun\.lanes\.rows\[0\]\.testDbPrefix "\w+": one starts the other/,
    ]),
    // An unknown key in any new section or row.
    [{ ...LANES, lock: {} }, /^phaseRun\.lanes has unknown key\(s\) lock; allowed: rows, claims, worktreeSetup, landing\.$/],
    [rows(one, { ...two, database: "x" }), /^phaseRun\.lanes\.rows\[1\] has unknown key\(s\) database; allowed: id, takes, worktree, qa, ports, testDbPrefix, env\.$/],
    [rows(one, { ...two, ports: [{ port: 4200, what: "the QA server", label: "qa" }] }), /^phaseRun\.lanes\.rows\[1\]\.ports\[0\] has unknown key\(s\) label; allowed: port, what, freeAfterEachTicket, name\.$/],
    [{ ...LANES, worktreeSetup: { install: ["npm ci"] } }, /^phaseRun\.lanes\.worktreeSetup has unknown key\(s\) install; allowed: copy, commands, leaves\.$/],
    [{ ...LANES, claims: { file: "claims.json" } }, /^phaseRun\.lanes\.claims has unknown key\(s\) file; allowed: none yet\.$/],
    [{ ...LANES, landing: { lock: "x" } }, /^phaseRun\.lanes\.landing has unknown key\(s\) lock; allowed: none yet\.$/],
    // The rows' own shape.
    [{ claims: {} }, /^phaseRun\.lanes\.rows is empty: list one row per lane, or leave phaseRun\.lanes out\.$/],
    [rows(one, { ...two, id: 1 }), /^phaseRun\.lanes\.rows\[1\]\.id "1" is also phaseRun\.lanes\.rows\[0\]'s/],
    [rows(one, { ...two, id: "Lane 2" }), /^phaseRun\.lanes\.rows\[1\]\.id must be a whole number, 1 or more, or a lowercase word/],
    [rows(one, { ...two, takes: " " }), /^phaseRun\.lanes\.rows\[1\]\.takes is missing\.$/],
    [rows(one, { ...two, worktree: one.worktree }), /^phaseRun\.lanes\.rows\[1\]\.worktree "\.\.\/shop-lanes\/lane-1" is also phaseRun\.lanes\.rows\[0\]'s/],
    [rows(one, { ...two, ports: [{ port: 4100, what: "the QA server", name: "qa" }] }), /^phaseRun\.lanes\.rows\[1\]\.ports\[0\]\.port 4100 is also phaseRun\.lanes\.rows\[0\]\.ports\[0\]'s/],
    [rows(one, { ...two, ports: [{ port: 4200, what: "a", name: "qa" }, { port: 4201, what: "b", name: "qa" }] }), /^phaseRun\.lanes\.rows\[1\]\.ports\[1\]\.name "qa" is also phaseRun\.lanes\.rows\[1\]\.ports\[0\]'s/],
    [rows(one, { ...two, env: { CACHE_DB: "{qaUrl}" } }), /^phaseRun\.lanes\.rows\[1\]\.env\.CACHE_DB uses \{qaUrl\}; allowed here: none\.$/],
    [{ ...LANES, worktreeSetup: { copy: ["../.env"] } }, /^phaseRun\.lanes\.worktreeSetup\.copy\[0\] must be a path from the repo's root/],
  ];
  for (const [lanes, error] of cases) {
    assert.match(refusal(() => parseRunConfig(withLanes(lanes))), error, JSON.stringify(lanes).slice(0, 120));
  }
  // A row qa needs phaseRun.qa, whose url it goes into.
  assert.match(refusal(() => parseRunConfig({ version: 1, phaseRun: { lanes: LANES } })), /^phaseRun\.lanes\.rows\[1\]\.qa is set, but there is no phaseRun\.qa section/);
  // A port row's name is checked in phaseRun.ports too.
  assert.match(refusal(() => parseRunConfig({ version: 1, phaseRun: { ports: [{ port: 4100, what: "x", name: "" }] } })), /^phaseRun\.ports\[0\]\.name must be a lowercase word/);
});

test("the runner's loader refuses a bad hotspots section, naming the field", () => {
  const cases = [
    [{ ...HOTSPOTS, numbers: "NNN" }, /^phaseRun\.hotspots has unknown key\(s\) numbers; allowed: token, rows\.$/],
    [{ rows: [{ path: "docs/history/devlog.md", kind: "log", glob: "x" }] }, /^phaseRun\.hotspots\.rows\[0\] has unknown key\(s\) glob; allowed: path, kind\.$/],
    [{ rows: [{ path: "docs/history/devlog.md", kind: "merge" }] }, /^phaseRun\.hotspots\.rows\[0\]\.kind must be one of log, generated, own-file \(it is "merge"\)\./],
    [{ rows: [{ path: "./docs/history/devlog.md", kind: "log" }] }, /^phaseRun\.hotspots\.rows\[0\]\.path must be a path from the repo's root/],
    [{ token: "" }, /^phaseRun\.hotspots\.token must be a word/],
    [{ token: "N N" }, /^phaseRun\.hotspots\.token must be a word/],
    [{ rows: {} }, /^phaseRun\.hotspots\.rows must be a list\.$/],
  ];
  for (const [hotspots, error] of cases) {
    assert.match(refusal(() => parseRunConfig({ version: 1, phaseRun: { hotspots } })), error, JSON.stringify(hotspots));
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
