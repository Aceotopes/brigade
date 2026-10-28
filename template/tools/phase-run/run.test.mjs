// Tests for the phase runner's own logic (#194). Plain node:test: no database, no
// GitHub, no Claude session. Run: pnpm test:runner (node --test tools/phase-run/).
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { BROWSER_CHECK, fill, loadRunConfig, parseRunConfig, qaUrl, sessionEnv, targetFingerprint, targetUrl } from "./config.mjs";
import { QUIET_MS, SETTLE_MS, applyMigrations, folderTrusted, gotchasFile, holdReason, loadResults, outsideAreas, projectGates, promptValues, pullRequestBody, recordResult, render, report, runSession, screenshotsSince, sessionSettings, turnOver } from "./run.mjs";

const options = { minutes: 120, waitHours: 6, print: true, spec: 179 };
const call = (claude, extra = {}) => ({ options, prompt: "Build it.", sessionId: "s-1", resume: false, claude, online: async () => true, sleep: async () => {}, ...extra });
const turn = (result, isError = false) => ({ timedOut: false, json: { session_id: "s-1", is_error: isError, result }, raw: result });

test("a dropped connection resumes the same session, and is not handed to the gates", async () => {
  const seen = [];
  const answers = [turn("API Error: Connection lost mid-response", true), turn("Done: committed #185.")];
  const result = await runSession(call(async (attempt) => (seen.push(attempt), answers.shift())));
  assert.equal(seen.length, 2);
  assert.equal(seen[1].resume, true);
  assert.equal(seen[1].sessionId, "s-1");
  assert.match(seen[1].prompt, /cut off/);
  assert.equal(result.json.result, "Done: committed #185.");
  assert.equal(result.cutOffs, 1);
});

test("a fix round's instruction is repeated when its turn was cut off", async () => {
  const seen = [];
  const answers = [turn("API Error: server_error", true), turn("Fixed.")];
  await runSession(call(async (attempt) => (seen.push(attempt), answers.shift()), { resume: true, prompt: "Fix the lint failure." }));
  assert.match(seen[1].prompt, /Fix the lint failure\./);
});

test("a connection that keeps dropping stops resuming after three tries", async () => {
  let calls = 0;
  const result = await runSession(call(async () => (calls += 1, turn("API Error: Connection lost mid-response", true))));
  assert.equal(calls, 4);
  assert.equal(result.cutOffs, 3);
});

test("an untrusted folder stops the run at once: no fix rounds, and the ticket is not to blame", async () => {
  let calls = 0;
  const refused = { timedOut: false, json: null, raw: "Workspace not trusted. Run `claude` in D:\\x once and accept the trust prompt, then retry." };
  const result = await runSession(call(async () => (calls += 1, refused)));
  assert.equal(calls, 1);
  assert.match(result.gaveUp, /does not trust this folder yet[\s\S]*run `claude` once, accept the trust prompt/);
});

test("a session that merely quotes the trust error (from a log it read) is not stopped", async () => {
  const quoting = turn('Done: committed #3. The earlier attempt failed with "Workspace not trusted" in run.log; this run is the retry.');
  const result = await runSession(call(async () => quoting));
  assert.equal(result.gaveUp, undefined);
  assert.match(result.json.result, /committed #3/);
});

test("preflight reads Claude Code's own trust record for the folder", () => {
  const state = { projects: { "D:/HGP/app": { hasTrustDialogAccepted: true }, "D:/HGP/new": { hasTrustDialogAccepted: false } } };
  assert.equal(folderTrusted(state, "D:\\HGP\\app"), true, "the record uses forward slashes; the path may not");
  assert.equal(folderTrusted(state, "d:/hgp/APP/"), true);
  assert.equal(folderTrusted(state, "D:/HGP/new"), false);
  assert.equal(folderTrusted(state, "D:/HGP/never-opened"), false, "a folder Claude Code never opened was never trusted");
  assert.equal(folderTrusted(null, "D:/HGP/app"), null, "no state to read: unknown, not refused");
});

test("an ordinary end of turn is returned at once", async () => {
  let calls = 0;
  const result = await runSession(call(async () => (calls += 1, turn("All done."))));
  assert.equal(calls, 1);
  assert.equal(result.cutOffs ?? 0, 0);
});

function tempRun() {
  const dir = mkdtempSync(join(tmpdir(), "phase-run-"));
  return { branch: "phase-test", dir, runId: "2026-10-17T22:00:00.000Z", results: [], all: [], carried: [] };
}

test("each result is written to results.json as it is recorded", () => {
  const run = tempRun();
  recordResult(run, { number: 180, title: "Announcements", status: "built", hash: "abc1234", assumptions: [], runByHand: [], foundElsewhere: [], handedForward: [], notes: [], outside: [], migrations: [], destructive: [] });
  const saved = loadResults(join(run.dir, "results.json"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].number, 180);
  assert.equal(saved[0].runId, run.runId);
  assert.equal(saved[0].reported, false);
});

test("the pull request lists every ticket built on the branch, across nights", () => {
  const all = [
    { number: 180, title: "Announcements", status: "built", hash: "aaa1111", runId: "night-1" },
    { number: 183, title: "Calendar", status: "failed", runId: "night-1" },
    { number: 183, title: "Calendar", status: "built", hash: "bbb2222", runId: "night-2" },
  ];
  const body = pullRequestBody(all, { spec: 179 });
  assert.match(body, /#180 Announcements \(`aaa1111`\)/);
  assert.match(body, /#183 Calendar \(`bbb2222`\)/);
  assert.equal((body.match(/#183/g) ?? []).length, 1);
});

test("a night that died before its report is carried into the next report", () => {
  const run = tempRun();
  run.carried = [{ number: 166, title: "Answer a request", status: "built", hash: "ccc3333", assumptions: ["Lapsed requests move to Answered."], runByHand: [], foundElsewhere: [], handedForward: [], notes: [], outside: [], migrations: [], destructive: [], runId: "night-0", reported: false }];
  const text = report(run, options, []);
  assert.match(text, /stopped before writing its report/i);
  assert.match(text, /#166: Lapsed requests move to Answered\./);
});

test("the report points at the pull request only when there is one", () => {
  const run = tempRun();
  assert.match(report(run, options, []), /Nothing was pushed, so there is no pull request yet\./);
  assert.doesNotMatch(report(run, options, []), /CI runs on the pull request/);
  run.pullRequest = "https://github.com/owner/repo/pull/4";
  assert.match(report(run, options, []), /CI runs on the pull request \(https:\/\/github\.com\/owner\/repo\/pull\/4\)/);
});

test("a finish ticket without run-ready is held as the finish ticket, not sent to /ticket-check", () => {
  const build = { number: 2, state: "closed", labels: ["run-ready"], blockers: [] };
  const finish = { number: 3, state: "open", labels: [], blockers: [{ number: 2, state: "closed" }] };
  const stray = { number: 4, state: "open", labels: [], blockers: [] };
  const byNumber = new Map([build, finish, stray].map((t) => [t.number, t]));
  assert.match(holdReason(stray, byNumber), /run \/ticket-check first/);
  assert.match(holdReason(finish, new Map([build, finish].map((t) => [t.number, t]))), /the finish ticket: built attended/);
  // Blocked by only some of the others: not the finish ticket.
  assert.match(holdReason(finish, byNumber), /run \/ticket-check first/);
});

test("the report shows what a session found in other tickets' code and what it handed forward", () => {
  const run = tempRun();
  recordResult(run, { number: 185, title: "Doing a task", status: "built", hash: "ddd4444", assumptions: [], runByHand: [], foundElsewhere: ["#184's day read counts a removed task."], handedForward: ["#187 owes the untick audit row."], notes: [], outside: [], migrations: [], destructive: [] });
  const text = report(run, options, []);
  assert.match(text, /#185: #184's day read counts a removed task\./);
  assert.match(text, /#185: #187 owes the untick audit row\./);
});

test("screenshots taken before the last source edit do not count", () => {
  const root = mkdtempSync(join(tmpdir(), "phase-run-shots-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".impeccable", "review-185"), { recursive: true });
  const old = join(root, ".impeccable", "review-185", "390.png");
  const fresh = join(root, ".impeccable", "review-185", "1280.png");
  const source = join(root, "src", "page.tsx");
  for (const file of [old, fresh, source]) writeFileSync(file, "x");
  utimesSync(old, new Date(1000_000), new Date(1000_000));
  utimesSync(source, new Date(2000_000), new Date(2000_000));
  utimesSync(fresh, new Date(3000_000), new Date(3000_000));
  const since = screenshotsSince(root, ".impeccable/review-185", 0, ["src/page.tsx", "docs/history/devlog.md"], /^src\//);
  assert.deepEqual(since.fresh, ["1280.png"]);
  assert.equal(since.stale, 1);
});

test("the shared registries are never out of a ticket's areas, but the audit log is", () => {
  const files = ["src/components/shell/nav-config.ts", "src/components/shell/icons.tsx", "src/lib/audit-log.ts", "src/lib/notifications.ts", "scripts/walks/185-doing-a-task.mjs", "src/lib/payroll.ts"];
  // A project's shared registries (phaseRun.alwaysInScope); its global audit log is left off on purpose.
  const registries = [/^src\/components\/shell\/(nav-config\.ts|icons\.tsx)$/, /^src\/lib\/notifications\.ts$/, /^scripts\/walks\//];
  assert.deepEqual(outsideAreas(files, ["src/lib/task*.ts"], registries), ["src/lib/audit-log.ts", "src/lib/payroll.ts"]);
  // Without the project's list, only the workflow's own files are always in scope.
  assert.equal(outsideAreas(files, ["src/lib/task*.ts"]).length, 6);
  assert.deepEqual(outsideAreas(["docs/x.md", "CLAUDE.md", "src/a.ts"], ["src/a.ts"]), []);
});

test("results.json that cannot be read starts empty rather than stopping the run", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase-run-bad-"));
  writeFileSync(join(dir, "results.json"), "{ not json");
  assert.deepEqual(loadResults(join(dir, "results.json")), []);
  assert.deepEqual(loadResults(join(dir, "missing.json")), []);
});

test("a print session that died mid-stream without JSON is resumed too", async () => {
  const seen = [];
  const answers = [{ timedOut: false, json: null, raw: "API Error: Connection lost mid-response" }, turn("Done.")];
  const result = await runSession(call(async (attempt) => (seen.push(attempt), answers.shift())));
  assert.equal(seen.length, 2);
  assert.equal(result.cutOffs, 1);
});

test("an API error that will fail the same way again is not resumed", async () => {
  let calls = 0;
  const result = await runSession(call(async () => (calls += 1, turn("API Error: 400 prompt is too long: 212000 tokens", true))));
  assert.equal(calls, 1);
  assert.equal(result.cutOffs, 0);
});

test("a parked ticket carried from a dead night keeps its question in the report", () => {
  const run = tempRun();
  run.carried = [{ number: 168, title: "Leave", status: "parked", detail: "Should a past leave need a reason? Recommended: yes.", runId: "night-0", reported: false }];
  assert.ok(report(run, options, []).includes("  > Should a past leave need a reason? Recommended: yes."));
});

test("a ticket rebuilt tonight is reported once, not again among the carried ones", () => {
  const run = tempRun();
  run.carried = [{ number: 168, title: "Leave", status: "failed", detail: "Cap reached.", runId: "night-0", reported: false }];
  recordResult(run, { number: 168, title: "Leave", status: "built", hash: "eee5555", assumptions: [], runByHand: [], foundElsewhere: [], handedForward: [], notes: [], outside: [], migrations: [], destructive: [] });
  const text = report(run, options, []);
  assert.doesNotMatch(text, /stopped before writing its report/);
  assert.equal((text.match(/#168 Leave/g) ?? []).length, 1);
});

// #181 on 6D's night (point 7 in run.mjs): a finished session listed as working until the cap.
const poll = (over = {}) => ({ listed: true, working: true, ended: false, endedFor: null, verdictFresh: false, quietFor: null, stopCheck: false, ...over });

test("a turn that ended with its verdict written is over once settled, though still listed as working", () => {
  assert.equal(turnOver(poll({ ended: true, verdictFresh: true, endedFor: SETTLE_MS })), "ended, still listed as working");
  assert.equal(turnOver(poll({ ended: true, verdictFresh: true, endedFor: SETTLE_MS - 1 })), null);
});

test("a turn ended to wait for a subagent is not over while working: no verdict written this turn", () => {
  assert.equal(turnOver(poll({ ended: true, verdictFresh: false, endedFor: 60 * 60_000 })), null);
});

test("a fix round's old verdict does not end it: only one written during the turn counts", () => {
  // verdictFresh is false when the file predates the turn; the cap is then the fallback, as before.
  assert.equal(turnOver(poll({ ended: true, verdictFresh: false, endedFor: SETTLE_MS * 10 })), null);
});

test("a turn woken again starts the settle over", () => {
  // readTurn reports ended=false once a notification opens a new turn, and the loop clears endedFor.
  assert.equal(turnOver(poll({ ended: false, verdictFresh: true, endedFor: null })), null);
});

test("an idle session still ends as before: at the end of its turn, after QUIET_MS, or when stopped", () => {
  assert.equal(turnOver(poll({ working: false, ended: true })), "ended");
  assert.equal(turnOver(poll({ working: false, quietFor: QUIET_MS + 1 })), "quiet");
  assert.equal(turnOver(poll({ working: false, quietFor: QUIET_MS - 1 })), null);
  assert.equal(turnOver(poll({ working: false, quietFor: null, stopCheck: true })), null);
  assert.equal(turnOver(poll({ listed: false })), "stopped");
});

test("the morning report names the docs near their budget and folds the whole table away", () => {
  const run = tempRun();
  run.docHealth = [
    "Doc                     Lines / budget   Used",
    "CLAUDE.md                 176 / 180      98%  near the limit: trim before it blocks",
    "docs/status/roadmap.md     99 / 120      83%",
  ].join("\n");
  const text = report(run, options, []);
  assert.match(text, /### Doc health\n\n1 doc\(s\) at 90% of their budget or over/);
  assert.match(text, /- `CLAUDE\.md` 176 \/ 180 lines \(98%\)/);
  assert.match(text, /<details><summary>Every doc's size against its budget<\/summary>[\s\S]*docs\/status\/roadmap\.md/);
  run.docHealth = "Doc  Lines / budget   Used\ndocs/status/roadmap.md  99 / 120  83%";
  assert.match(report(run, options, []), /Every doc is under 90% of its budget\./);
});

// ------------------------------------------------------------ the project config

const runConfig = (phaseRun, extra = {}) => parseRunConfig({ version: 1, phaseRun, ...extra });

test("a project with no phaseRun section, or no file at all, has no project gates", () => {
  assert.deepEqual(runConfig(undefined).gates, []);
  const { config, error } = loadRunConfig(mkdtempSync(join(tmpdir(), "phase-config-")));
  assert.equal(error, null);
  assert.deepEqual([config.gates, config.qa, config.migrations, config.prompt], [[], null, null, null]);
});

test("a mistake in the run config is named: a typo'd key, a bad pattern, a port, a missing field", () => {
  const cases = [
    [{ gate: [] }, /phaseRun has unknown key\(s\) gate/],
    [{ gates: [{ label: "lint", run: "pnpm lint", wehn: "^src/" }] }, /gates\[0\] has unknown key\(s\) wehn/],
    [{ gates: [{ label: "lint", run: "pnpm lint", when: "(" }] }, /gates\[0\]\.when is not a valid pattern/],
    [{ gates: [{ run: "pnpm lint" }] }, /gates\[0\]\.label is missing/],
    [{ gates: [{ builtin: "lint" }] }, /builtin must be "browser-check"/],
    [{ gates: [{ builtin: "browser-check" }] }, /there is no phaseRun\.browserCheck section/],
    [{ ports: [{ port: 99999, what: "x" }] }, /ports\[0\]\.port must be a port number/],
    [{ migrations: { added: "^db/[^/]+\\.sql$", target: { name: "t", urlFrom: "X" }, apply: { run: "migrate" } } }, /added needs a group/],
  ];
  for (const [phaseRun, error] of cases) assert.throws(() => runConfig(phaseRun), error);
  const broken = mkdtempSync(join(tmpdir(), "phase-config-"));
  mkdirSync(join(broken, ".claude"));
  writeFileSync(join(broken, ".claude", "workflow.json"), '{ "version": 1, "phaseRun": { "gates": [ ');
  assert.match(loadRunConfig(broken).error, /^\.claude\/workflow\.json: .*JSON/);
});

test("a placeholder is allowed only where it makes sense: a gate cannot reach the migration target", () => {
  assert.throws(() => runConfig({ gates: [{ label: "x", run: "deploy {targetUrl}" }] }), /gates\[0\]\.run uses \{targetUrl\}; allowed here: \{base\}, \{N\}, \{qaUrl\}/);
  assert.throws(() => runConfig({ gates: [{ label: "x", run: "x", env: { DB: "{targetUrl}" } }] }), /gates\[0\]\.env\.DB uses \{targetUrl\}/);
  assert.throws(() => runConfig({ sessionEnv: { DB: "{base}" } }), /sessionEnv\.DB uses \{base\}; allowed here: \{qaUrl\}/);
  assert.throws(() => runConfig({ qa: { name: "q", url: "postgres://{qaUrl}" } }), /only placeholder allowed here is \{loopbackNotUsedBy:VAR\}/);
  assert.doesNotThrow(() =>
    runConfig({ qa: { name: "q", url: "postgres://localhost/q" }, gates: [{ label: "tests", run: "vitest run --changed {base}", env: { DB: "{qaUrl}" } }] }),
  );
  // A filled value never runs with a placeholder left in it.
  assert.equal(fill("vitest run --changed {base}", { base: "abc123" }), "vitest run --changed abc123");
  assert.throws(() => fill("deploy {targetUrl}", {}), /No value for \{targetUrl\}/);
});

test("the QA address takes the loopback name its neighbour does not use; the target takes its direct rewrites", () => {
  const config = runConfig({
    qa: { name: "cast", url: "postgresql://pg@{loopbackNotUsedBy:TEST_DB}:5432/cast" },
    sessionEnv: { DATABASE_URL: "{qaUrl}", VENDOR_TOKEN: "placeholder" },
    migrations: {
      added: "^db/migrations/([^/]+)/up\\.sql$",
      target: { name: "staging", urlFrom: "DATABASE_URL", direct: [["-pooler.", "."]] },
      apply: { run: "migrate up", env: { DATABASE_URL: "{targetUrl}" } },
    },
  });
  const env = (vars) => (name) => vars[name];
  assert.equal(qaUrl(config, env({ TEST_DB: "postgresql://x@localhost/t" })), "postgresql://pg@127.0.0.1:5432/cast");
  assert.equal(qaUrl(config, env({ TEST_DB: "postgresql://x@127.0.0.1/t" })), "postgresql://pg@localhost:5432/cast");
  assert.equal(qaUrl(config, env({})), "postgresql://pg@127.0.0.1:5432/cast", "no neighbour: it is taken as localhost");
  assert.deepEqual(sessionEnv(config, env({})), { DATABASE_URL: "postgresql://pg@127.0.0.1:5432/cast", VENDOR_TOKEN: "placeholder" });
  const url = targetUrl(config, env({ DATABASE_URL: "postgresql://u:p@ep-a-pooler.eu.example.tech/db" }));
  assert.equal(url, "postgresql://u:p@ep-a.eu.example.tech/db");
  assert.equal(targetFingerprint(url), "ep-a.eu.example.tech", "a host, never the credentials");
  assert.equal(targetUrl(config, env({})), null);
});

test("a field that uses {qaUrl} with no qa section is refused", () => {
  assert.throws(() => runConfig({ gates: [{ label: "build", run: "build", env: { DB: "{qaUrl}" } }] }), /uses \{qaUrl\}, but there is no phaseRun\.qa section/);
  // A note is prose: mentioning {qaUrl} there uses nothing.
  assert.doesNotThrow(() => runConfig({ gates: [{ note: "points at {qaUrl} once qa is set", label: "build", run: "build" }] }));
});

// The project's gates, with a fake shell standing in: what ran, in what order, with what.
function fakeShell(failing = []) {
  const ran = [];
  const run = (line, env) => {
    ran.push({ line, env });
    return failing.some((word) => line.includes(word)) ? { ok: false, output: `${line} broke` } : { ok: true, output: "" };
  };
  return { ran, run };
}

const GATES = runConfig({
  qa: { name: "cast", url: "postgresql://pg@localhost/cast" },
  gates: [
    { label: "lint", run: "npm run lint" },
    { label: "build", run: "npm run build", when: "^src/", env: { DATABASE_URL: "{qaUrl}" }, freePorts: true },
    { label: "tests", run: "npm test -- --changed {base}", alone: true },
  ],
}).gates;

test("the project's gates run in order, each with its env and {base} filled in", async () => {
  const shell = fakeShell();
  const jobs = [];
  const failed = await projectGates(GATES, {
    changed: ["src/a.ts"],
    values: { base: "abc123", N: 7, qaUrl: "postgresql://pg@localhost/cast" },
    browserCheck: () => null,
    run: shell.run,
    freePorts: async () => jobs.push("freed ports"),
    stopStray: (when) => jobs.push(`stray ${when}`),
  });
  assert.equal(failed, null);
  assert.deepEqual(shell.ran.map((r) => r.line), ["npm run lint", "npm run build", "npm test -- --changed abc123"]);
  assert.deepEqual(shell.ran[1].env, { DATABASE_URL: "postgresql://pg@localhost/cast" });
  assert.deepEqual(jobs, ["freed ports", "stray before the tests gate"]);
});

test("a gate whose files the ticket did not touch is skipped, and the first failure is returned", async () => {
  const shell = fakeShell(["lint"]);
  const failed = await projectGates(GATES, { changed: ["docs/x.md"], values: { base: "b" }, browserCheck: () => null, run: shell.run });
  assert.deepEqual(failed, { gate: "lint", output: "npm run lint broke" });
  assert.deepEqual(shell.ran.map((r) => r.line), ["npm run lint"], "nothing after the first failure runs");
  const docsOnly = fakeShell();
  await projectGates(GATES, { changed: ["docs/x.md"], values: { base: "b" }, browserCheck: () => null, run: docsOnly.run });
  assert.deepEqual(docsOnly.ran.map((r) => r.line), ["npm run lint", "npm test -- --changed b"], "no src/ change: no build");
});

test("the browser-check gate runs where the config places it, and its problem is the failure", async () => {
  const gates = runConfig({
    gates: [{ label: "lint", run: "lint" }, { builtin: "browser-check" }, { label: "tests", run: "tests" }],
    browserCheck: { screenFiles: "^src/", sourceFiles: "^src/", screenshots: "shots/{N}", minimum: 2, redo: "walk it" },
  }).gates;
  const shell = fakeShell();
  const failed = await projectGates(gates, { changed: [], values: {}, browserCheck: () => "shots/7/ holds 0 screenshot(s)", run: shell.run });
  assert.deepEqual(failed, { gate: "browser check", output: "shots/7/ holds 0 screenshot(s)" });
  assert.deepEqual(shell.ran.map((r) => r.line), ["lint"]);
});

const MIGRATIONS = runConfig({
  migrations: {
    added: "^db/migrations/([^/]+)/up\\.sql$",
    target: { name: "staging", urlFrom: "DATABASE_URL" },
    apply: { run: "migrate deploy", env: { DATABASE_URL: "{targetUrl}" } },
    rollBack: { run: "migrate resolve --rolled-back {name}", env: { DATABASE_URL: "{targetUrl}" } },
  },
}).migrations;
const values = { targetUrl: "postgresql://u:p@staging.example/db", base: "abc" };

test("an applied migration is recorded, with the target's address in the command's env", () => {
  const shell = fakeShell();
  const applied = new Set();
  assert.deepEqual(applyMigrations(["001_a", "002_b"], applied, { migrations: MIGRATIONS, values, run: shell.run }), { ok: true });
  assert.deepEqual([...applied], ["001_a", "002_b"]);
  assert.deepEqual(shell.ran, [{ line: "migrate deploy", env: { DATABASE_URL: "postgresql://u:p@staging.example/db" } }]);
});

test("a failed apply keeps what went in and rolls back the rest, by the names it printed", () => {
  const ran = [];
  // Like Prisma: it names each migration as it starts it, and stops at the one that fails.
  const run = (line, env) => {
    ran.push(line);
    return line === "migrate deploy" ? { ok: false, output: "Applying 001_a\nApplying 002_b\nError in 002_b" } : { ok: true, output: "" };
  };
  const applied = new Set();
  const result = applyMigrations(["001_a", "002_b", "003_c"], applied, { migrations: MIGRATIONS, values, run });
  assert.equal(result.ok, false);
  assert.deepEqual([...applied], ["001_a"]);
  assert.deepEqual(ran, ["migrate deploy", "migrate resolve --rolled-back 002_b", "migrate resolve --rolled-back 003_c"]);
  // With no rollBack, a failure records nothing and rolls nothing back.
  const plain = { ...MIGRATIONS, rollBack: null };
  const untouched = new Set();
  ran.length = 0;
  applyMigrations(["001_a", "002_b"], untouched, { migrations: plain, values, run });
  assert.deepEqual([[...untouched], ran], [[], ["migrate deploy"]]);
});

test("a session's settings hold the run's rules, the project's rows and the denials that guard the checks", () => {
  const base = { permissions: { allow: ["Bash(git *)"], deny: ["Read(./.env)"] } };
  const project = runConfig({ prompt: "docs/agents/phase-run-prompt.md", permissions: { allow: ["Bash(npm *)"], deny: ["Bash(npm publish *)"] } });
  const env = { PHASE_RUN: "1", DATABASE_URL: "postgresql://localhost/qa" };
  const bg = sessionSettings(base, project.permissions, { branch: "phase-2", env, background: true, prompt: project.prompt });
  assert.deepEqual(bg.permissions.allow, ["Bash(git *)", "Bash(npm *)", "Edit", "Write"]);
  for (const rule of ["Read(./.env)", "Bash(npm publish *)", "Edit(./tools/phase-run/**)", "Edit(./.claude/workflow.json)", "Edit(./.claude/spec-issues.json)", "Edit(./docs/agents/phase-run-prompt.md)", "Edit(./.phase-run/phase-2/**)", "AskUserQuestion"]) {
    assert.ok(bg.permissions.deny.includes(rule), `${rule} is denied`);
  }
  assert.deepEqual(bg.env, env);
  assert.equal(bg.worktree.bgIsolation, "none");
  // A --print session gets the same rules and variables, without the background-only parts.
  const print = sessionSettings(base, project.permissions, { branch: "phase-2", env, background: false, prompt: null });
  assert.deepEqual(print.permissions.allow, ["Bash(git *)", "Bash(npm *)"]);
  assert.equal(print.worktree, undefined);
  assert.ok(!print.permissions.deny.some((rule) => rule.includes("phase-run-prompt")));
});

const HERE = dirname(fileURLToPath(import.meta.url));
const ticketValues = { N: 7, TITLE: "t", BRANCH: "phase-2", PHASE: "2", GOTCHAS_FILE: gotchasFile("phase-2"), SPEC: "#5", BASE: "abc", FRONTEND: "no" };

test("a phase's gotchas file is flat by default: one file per phase, named after the branch", () => {
  assert.equal(gotchasFile("phase-2b"), "docs/agents/gotchas/2b.md");
  assert.match(render(prompts()[0], ticketValues), /`docs\/agents\/gotchas\/2\.md` \(made from/);
});
const prompts = () => ["ticket-prompt.md", "fix-prompt.md"].map((name) => readFileSync(join(HERE, name), "utf8"));
const fixValues = { GATE: "lint", OUTPUT: "x", ROUND: 1, ROUNDS: 3 };

test("with a blank config, both prompts render with no marker left and say what the project lacks", () => {
  const values = { ...ticketValues, ...fixValues, ...promptValues(runConfig(undefined), "", ticketValues) };
  for (const text of prompts()) assert.doesNotMatch(render(text, values), /\{\{\w+\}\}/);
  const ticket = render(prompts()[0], values);
  assert.match(ticket, /This project names no design review: skip this section\./);
  assert.match(ticket, /this project's runner applies none, so never apply one to a shared database/);
  assert.match(ticket, /\*\*Never open or print `\.env`\*\*/);
});

test("the project's prose is spliced in by section, its header dropped, and an unknown section refused", () => {
  const project = runConfig(
    {
      prompt: "docs/agents/phase-run-prompt.md",
      qa: { name: "cast", url: "postgresql://localhost/cast" },
      sessionEnv: { DATABASE_URL: "{qaUrl}" },
      migrations: { added: "^db/([^/]+)\\.sql$", target: { name: "staging", urlFrom: "DATABASE_URL" }, apply: { run: "migrate" } },
    },
    { stopGate: { checks: [{ label: "Tests", run: "npm test -- --changed {base}" }] } },
  );
  const prose = "---\njob: x\nkind: living\n---\n# Ours\n\n## Build\n\n- Use the house linter.\n\n## Fix\n\n- Walk it again.\n";
  const values = promptValues(project, prose, ticketValues);
  const [ticket, fix] = prompts().map((text) => render(text, { ...ticketValues, ...fixValues, ...values }));
  assert.match(ticket, /- Use the house linter\./);
  assert.doesNotMatch(ticket, /job: x|# Ours/);
  assert.match(ticket, /`npm test -- --changed abc`/);
  assert.match(ticket, /never apply a migration to staging yourself/);
  assert.match(ticket, /`DATABASE_URL` is already set for this run/);
  assert.match(fix, /- Walk it again\./);
  assert.match(fix, /already applied to\s+staging/);
  assert.match(fix, /QA on `cast` only/);
  assert.throws(() => promptValues(project, "## Biuld\n- x\n", ticketValues), /"## Biuld" section has no place in the prompt/);
});

test("a browserCheck with no place in the gates runs after the project's gates", () => {
  const check = { screenFiles: "^src/", sourceFiles: "^src/", screenshots: "shots/{N}", minimum: 2, redo: "walk it" };
  const config = runConfig({ gates: [{ label: "lint", run: "lint" }], browserCheck: check });
  assert.deepEqual(config.gates.map((g) => g.label ?? g.builtin), ["lint", BROWSER_CHECK]);
  const placed = runConfig({ gates: [{ builtin: "browser-check" }, { label: "lint", run: "lint" }], browserCheck: check });
  assert.deepEqual(placed.gates.map((g) => g.label ?? g.builtin), [BROWSER_CHECK, "lint"]);
});
