// Tests for the phase runner's own logic (#194). Plain node:test: no database, no
// GitHub, no Claude session. Run: pnpm test:runner (node --test tools/phase-run/).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BROWSER_CHECK, fill, laneQaUrl, loadRunConfig, parseRunConfig, qaUrl, sessionEnv, targetFingerprint, targetUrl } from "./config.mjs";
import { afterPass, ignoredImports, ignoredImportsProblem, joinBranch, laneLockPath, lanePortProblems, laneRoots, laneRow, laneValues, liveLanes, mayFinishCopy, prepareWorktree, setupWorktree, writeLaneLock } from "./lane.mjs";
import { CLAIMS_LOCK, UNREADABLE_GRACE_MS, builtOn, claimNext, claimsPath, laneChoice, liveClaims, readClaims, takeClaim, takesTicket, withClaimLock } from "./claim.mjs";
import { compareFingerprint } from "./fingerprint.mjs";
import { brigadeCatalog, installedBrigade, parsePluginList, readInstalledBrigade, versionStop } from "./brigade.mjs";
import { readLedger } from "./ledger.mjs";
import { QUIET_MS, SETTLE_MS, applyMigrations, backgroundArgs, browserCheckVerdict, docCheck, folderTrusted, gatePlan, gotchasFile, holdReason, implementationLogAdded, loadResults, outsideAreas, printArgs, projectGates, promptValues, pullRequestBody, recordResult, render, report, runSession, runVariables, runnerFile, screenshotsSince, sessionSettings, trimmedSettings, turnOver } from "./run.mjs";
import { finishSnapshot, readManifest, runnerChanges, takeSnapshot } from "./snapshot.mjs";
import { PATCH_ARGS } from "./tampering.mjs";
import { TRIM_FLAGS, readTrim, trimPath } from "./trim.mjs";

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

/** A run that keeps a ledger, with ticket 14's session live and its transcript written. */
function ledgerRun({ brigade = "0.6.0", ledgerFile } = {}) {
  const run = tempRun();
  run.ledgerFile = ledgerFile ?? join(run.dir, "ledger.jsonl");
  run.brigade = brigade;
  run.prices = { checkedOn: "2026-11-07", fallback: "m", perMillion: { m: { input: 5, cacheWrite5m: 6, cacheWrite1h: 10, cacheRead: 0.5, output: 25 } } };
  const transcript = join(run.dir, "s14.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { id: "r1", model: "claude-opus-5-5", usage: { input_tokens: 1_000_000 } } })}\n`);
  run.ticketSession = { number: 14, sessionId: "s14", transcript };
  return run;
}

const AT = Date.UTC(2026, 10, 8, 2, 30);
const builtResult = { number: 14, title: "The ledger", status: "built", hash: "abc1234", assumptions: [], runByHand: [], foundElsewhere: [], handedForward: [], notes: [], outside: [], migrations: [], destructive: [], session: { denials: [], minutes: 9, turns: 3, calls: 1, metrics: { costUsd: 5, peakContext: 1_000_000 } } };
const crashResult = { number: 14, title: "The ledger", status: "failed", detail: "The runner stopped on an error of its own", keptOn: null, session: null };

test("a measured result and a crash each leave one priced night row in the ledger", () => {
  for (const result of [builtResult, crashResult]) {
    const run = ledgerRun();
    const stamped = recordResult(run, result, AT);
    assert.equal(stamped.ledger, undefined);
    const rows = readLedger(run.ledgerFile);
    assert.equal(rows.length, 1, result.status);
    assert.deepEqual(
      { ...rows[0], tokens: undefined, byModel: undefined },
      { at: "2026-11-08T02:30:00.000Z", sessionId: "s14", transcript: run.ticketSession.transcript, kind: "night", ticket: 14, branch: "phase-test", brigade: "0.6.0", costUsd: 5, tokens: undefined, peakContext: 1_000_000, byModel: undefined },
    );
    assert.deepEqual(rows[0].byModel, { "claude-opus-5-5": { requests: 1, nanoUsd: 5e9, costUsd: 5 } }); // 1M in × $5: an unlisted model at the fallback
  }
});

test("a night row records a null version when the installed Brigade could not be read", () => {
  const run = ledgerRun({ brigade: null });
  recordResult(run, crashResult, AT);
  assert.equal(readLedger(run.ledgerFile)[0].brigade, null);
});

test("a failed append marks the result 'ledger: not written', and the result is still saved and reported", () => {
  const run = ledgerRun();
  run.ledgerFile = run.dir; // a folder: appending to it fails
  const built = recordResult(run, builtResult, AT);
  assert.equal(built.ledger, "not written");
  assert.equal(loadResults(join(run.dir, "results.json"))[0].ledger, "not written");
  assert.match(report(run, options, []), /ledger: not written/);

  const unstarted = ledgerRun();
  unstarted.ticketSession = null; // the runner failed before the ticket's session started
  const failed = recordResult(unstarted, { ...crashResult, number: 15 }, AT);
  assert.equal(failed.ledger, "not written");
  assert.match(failed.ledgerError, /no session/);
  assert.match(report(unstarted, options, []), /ledger: not written/);

  // A session that never wrote a transcript: no $0 row counting a session that never ran.
  const silent = ledgerRun();
  silent.ticketSession.transcript = join(silent.dir, "never-written.jsonl");
  const crashed = recordResult(silent, crashResult, AT);
  assert.equal(crashed.ledger, "not written");
  assert.match(crashed.ledgerError, /no transcript was found for session s14/);
  assert.deepEqual(readLedger(silent.ledgerFile), []);
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

test("a lane's own .lane/ scratch files are never out of a ticket's areas (#37, D13), with or without the project's list", () => {
  const files = [".lane/docs/agents/gotchas/two-lanes.md", ".lane/src/notes.md", "src/a.ts", "lane/other.md"];
  assert.deepEqual(outsideAreas(files, ["src/a.ts"]), ["lane/other.md"], "only the folder itself, not a lookalike");
  assert.deepEqual(outsideAreas(files, ["src/a.ts"], [/^lane\//]), []);
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
    [{ steps: [{ kind: "sleeping", match: "x" }] }, /steps\[0\]\.kind must be one of testing, checking/],
    [{ steps: [{ kind: "browser", match: "(" }] }, /steps\[0\]\.match is not a valid pattern/],
    [{ ticketSize: [{ key: "k", kind: "lines", max: 5, label: "lines" }] }, /ticketSize\[0\]\.kind must be one of checkboxes, bullets, words/],
    [{ ticketSize: [{ key: "k", kind: "bullets", max: 5, label: "Areas" }] }, /ticketSize\[0\]\.section is missing/],
    [{ ticketSize: [{ key: "k", kind: "words", max: 0, label: "words" }] }, /ticketSize\[0\]\.max must be a whole number/],
  ];
  for (const [phaseRun, error] of cases) assert.throws(() => runConfig(phaseRun), error);
  const sized = runConfig({ steps: [{ kind: "browser", match: "walks/" }], ticketSize: [{ key: "words", kind: "words", max: 600, label: "words" }] });
  assert.equal(sized.steps[0].match.test("node walks/1.mjs"), true);
  assert.deepEqual(sized.ticketSize, [{ key: "words", kind: "words", section: null, max: 600, label: "words" }]);
  assert.equal(runConfig({}).ticketSize, null);
  const broken = mkdtempSync(join(tmpdir(), "phase-config-"));
  mkdirSync(join(broken, ".claude"));
  writeFileSync(join(broken, ".claude", "workflow.json"), '{ "version": 1, "phaseRun": { "gates": [ ');
  assert.match(loadRunConfig(broken).error, /^\.claude\/workflow\.json: .*JSON/);
});

// D12 (#19): `after` orders two gates of the parallel group. The hooks refuse only a name that names
// nothing (tests/phase-run-config.test.mjs); the rest is the runner's, which would wait forever.
test("an after links two gates of the parallel group, by a label only one gate has, and never in a circle", () => {
  const row = (label, over = {}) => ({ label, run: label, ...over });
  const cases = [
    [[row("a", { after: 3 })], /gates\[0\]\.after is missing/],
    [[row("a", { unreadOf: "" })], /gates\[0\]\.unreadOf is missing/],
    [[row("a", { after: "a" })], /gates\[0\]\.after "a" waits on itself: a → a\./],
    [[row("a", { after: "c" }), row("b", { after: "a" }), row("c", { after: "b" })], /gates\[0\]\.after "c" waits on itself: a → c → b → a\./],
    [[row("a"), row("suite", { alone: true, after: "a" })], /gates\[1\]\.after belongs on a gate of the parallel group: an "alone" gate already runs after all of it\./],
    [[row("suite", { alone: true }), row("b", { after: "suite" })], /gates\[1\]\.after "suite" names an "alone" gate, which runs after the whole parallel group: this gate would never start\./],
    [[row("a"), { label: "a", run: "a2" }, row("b", { after: "a" })], /gates\[2\]\.after "a" names a label two gates share: give each its own label\./],
  ];
  for (const [gates, error] of cases) assert.throws(() => runConfig({ gates }), error, JSON.stringify(gates));
  // Two gates may share a label nobody waits on, as before.
  assert.doesNotThrow(() => runConfig({ gates: [row("a"), { label: "a", run: "a2" }] }));
});

test("a placeholder is allowed only where it makes sense: a gate cannot reach the migration target", () => {
  assert.throws(() => runConfig({ gates: [{ label: "x", run: "deploy {targetUrl}" }] }), /gates\[0\]\.run uses \{targetUrl\}; allowed here: \{base\}, \{N\}, \{qaUrl\}, \{cache\}/);
  assert.doesNotThrow(() => runConfig({ gates: [{ label: "lint", run: "eslint --cache-location {cache}/eslintcache", env: { CACHE: "{cache}" } }] }));
  assert.throws(() => runConfig({ preflight: [{ label: "x", run: "x {cache}" }] }), /preflight\[0\]\.run uses \{cache\}/);
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

// The project's gates. A name-status diff as `git diff --name-status -M -z` prints it: each row's
// fields, each ended by a NUL.
const nameStatus = (...rows) => rows.map((row) => `${row.join("\0")}\0`).join("");
const modified = (...paths) => nameStatus(...paths.map((path) => ["M", path]));

// A fake job starter: what started, with what, and each job over at once.
function fakeStart(failing = []) {
  const ran = [];
  const start = (line, env) => {
    ran.push({ line, env });
    const ok = !failing.some((word) => line.includes(word));
    return { done: Promise.resolve({ ok, output: ok ? "" : `${line} broke` }), stop: async () => {} };
  };
  return { ran, start };
}

const GATE_CONFIG = runConfig({
  qa: { name: "cast", url: "postgresql://pg@localhost/cast" },
  gates: [
    { label: "lint", run: "npm run lint" },
    { label: "build", run: "npm run build", when: "^src/", env: { DATABASE_URL: "{qaUrl}" }, freePorts: true },
    { label: "tests", run: "npm test -- --changed {base}", alone: true },
  ],
});
const planFor = (diff, config = GATE_CONFIG) => gatePlan({ base: "abc123", diff, config });

test("the project's gates start with their env and {base} filled in, the alone gate last, after its strays", async () => {
  const fake = fakeStart();
  const jobs = [];
  const failed = await projectGates(planFor(modified("src/a.ts")), {
    values: { base: "abc123", N: 7, qaUrl: "postgresql://pg@localhost/cast" },
    browserCheck: () => null,
    start: fake.start,
    tickMs: 5,
    freePorts: async () => jobs.push("freed ports"),
    stopStray: (when) => jobs.push(`stray ${when}`),
  });
  assert.equal(failed, null);
  assert.deepEqual(fake.ran.map((r) => r.line), ["npm run lint", "npm run build", "npm test -- --changed abc123"]);
  assert.deepEqual(fake.ran[1].env, { DATABASE_URL: "postgresql://pg@localhost/cast" });
  assert.deepEqual(jobs, ["freed ports", "stray before the tests gate"], "the group's ports are freed once, before it starts");
});

test("a gate whose when matches no changed file is skipped, and a failure in the group keeps the alone gates from starting", async () => {
  const docsOnly = fakeStart();
  await projectGates(planFor(modified("docs/x.md")), { values: { base: "b" }, browserCheck: () => null, start: docsOnly.start, tickMs: 5 });
  assert.deepEqual(docsOnly.ran.map((r) => r.line), ["npm run lint", "npm test -- --changed b"], "no src/ change: no build");
  const broken = fakeStart(["lint"]);
  const failed = await projectGates(planFor(modified("docs/x.md")), { values: { base: "b" }, browserCheck: () => null, start: broken.start, tickMs: 5 });
  assert.deepEqual(failed, { gate: "lint", output: "npm run lint broke" });
  assert.deepEqual(broken.ran.map((r) => r.line), ["npm run lint"], "nothing after the first failure starts");
});

// D12 changed this: the browser check used to run where the config placed it. It stays after
// everything now, whatever its place in the list, so a project gate's failure is reported first.
test("the browser-check gate runs after every project gate, wherever the config places it, and its problem is the failure", async () => {
  const config = runConfig({
    gates: [{ label: "lint", run: "lint" }, { builtin: "browser-check" }, { label: "tests", run: "tests", alone: true }],
    browserCheck: { screenFiles: "^src/", sourceFiles: "^src/", screenshots: "shots/{N}", minimum: 2, redo: "walk it" },
  });
  const fake = fakeStart();
  const failed = await projectGates(planFor(modified("src/a.ts"), config), { values: {}, browserCheck: () => "shots/7/ holds 0 screenshot(s)", start: fake.start, tickMs: 5 });
  assert.deepEqual(failed, { gate: "browser check", output: "shots/7/ holds 0 screenshot(s)" });
  assert.deepEqual(fake.ran.map((r) => r.line), ["lint", "tests"]);
  let asked = false;
  const lint = fakeStart(["lint"]);
  await projectGates(planFor(modified("src/a.ts"), config), { values: {}, browserCheck: () => (asked = true) && null, start: lint.start, tickMs: 5 });
  assert.equal(asked, false, "a failed gate ends the run before the browser check");
});

// D13 (#19): the suite skip. One stop check's unread list, through the one matcher (unread.mjs).
const SKIP_CONFIG = runConfig(
  { gates: [{ label: "typecheck", run: "tsc" }, { label: "suite", run: "npm test", unreadOf: "tests", alone: true }, { label: "build", run: "next build", when: "^src/" }] },
  { stopGate: { checks: [{ name: "tests", label: "Tests", run: "npm test", receipt: true, unread: ["docs/**", "**/*.md"] }] } },
);
const skipped = (diff) => planFor(diff, SKIP_CONFIG).gates.map(({ gate, skip }) => `${gate.label}${skip ? ` (${skip})` : ""}`);

test("the decision function skips a gate on a non-empty diff wholly on its check's unread list, and on no matching when", () => {
  assert.deepEqual(skipped(modified("docs/guide.md", "README.md")), ["typecheck", "suite (unreadOf)", "build (when)"], "docs only");
  assert.deepEqual(skipped(modified("docs/guide.md", "src/a.ts")), ["typecheck", "suite", "build"], "mixed");
  assert.deepEqual(skipped(""), ["typecheck", "suite", "build (when)"], "an empty diff never takes the suite skip");
  // Both sides of a rename count: a doc moved into src/ is a change the suite reads.
  const renamed = planFor(nameStatus(["R087", "docs/old.md", "src/new.ts"]), SKIP_CONFIG);
  assert.deepEqual(renamed.paths, ["docs/old.md", "src/new.ts"]);
  assert.deepEqual(renamed.gates.map((g) => g.skip), [null, null, null]);
  assert.deepEqual(skipped(nameStatus(["R100", "docs/a.md", "docs/b.md"], ["D", "notes.md"])), ["typecheck", "suite (unreadOf)", "build (when)"]);
  // A copy names two paths too, and a path with a tab or a space is read whole.
  assert.deepEqual(planFor(nameStatus(["C075", "src/a.ts", "docs/a b.md"], ["A", "src/x\ty.ts"])).paths, ["src/a.ts", "docs/a b.md", "src/x\ty.ts"]);
  assert.equal(planFor("").base, "abc123");
});

// D15 (#20): the tampering gate. Fixture diffs as `git diff -U0` prints them (tampering.mjs's
// PATCH_ARGS), the rules read through a stand-in for `git show <rev>:<path>`.
const TAMPER = {
  testFiles: ["**/*.test.mjs"],
  markers: [
    { name: "skip", pattern: "\\.skip\\(|\\{ skip: true" },
    { name: "only", pattern: "\\.only\\(|\\{ only: true" },
    { name: "todo", pattern: "\\.todo\\(" },
  ],
  assertions: { pattern: "\\bassert\\.", maxNetRemoved: 0 },
  guarded: [".claude/workflow.json", "vitest.config.ts"],
  guardedScripts: [{ file: "package.json", script: "test" }],
  override: { heading: "Tests removed or weakened" },
};
const TAMPER_CONFIG = runConfig({ gates: [{ label: "lint", run: "lint" }], tampering: TAMPER });
const workflowWith = (tampering) => JSON.stringify({ version: 1, phaseRun: { tampering } });
const patchOf = (...files) =>
  files
    .map(({ from, to = from, added = [], removed = [] }) =>
      [`diff --git a/${from ?? to} b/${to ?? from}`, `--- ${from ? `a/${from}` : "/dev/null"}`, `+++ ${to ? `b/${to}` : "/dev/null"}`, "@@ -1 +1 @@", ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join("\n"),
    )
    .join("\n");
function tamperPlan({ diff, patch = "", body = "", message = "", files = {}, base = workflowWith(TAMPER), config = TAMPER_CONFIG } = {}) {
  const at = { "abc123:.claude/workflow.json": base, ...files };
  const readAt = (rev, path) => at[`${rev}:${path}`] ?? null;
  return gatePlan({ base: "abc123", diff, config, patch, readAt, body, message }).tampering;
}
const OVERRIDE = "## Tests removed or weakened\n\n- `tests/a.test.mjs`: its flaky case goes; #31 rewrites it.\n";

test("no tampering section means no tampering gate, and the reader is never asked", () => {
  assert.equal(planFor(modified("tests/a.test.mjs")).tampering, null);
  assert.equal(gatePlan({ base: "abc123", diff: modified("a"), config: GATE_CONFIG, readAt: () => assert.fail("read") }).tampering, null);
});

test("a marker on an added line of a test file fails, naming the marker and the file; one removed, or outside the tests, passes", () => {
  for (const [marker, line] of [["skip", '  test.skip("adds", () => {});'], ["only", 'test("adds", { only: true }, () => {});'], ["todo", 'test.todo("adds");']]) {
    const verdict = tamperPlan({ diff: modified("tests/a.test.mjs"), patch: patchOf({ from: "tests/a.test.mjs", added: [line] }) });
    assert.equal(verdict.ok, false, marker);
    assert.deepEqual(verdict.findings.map((f) => [f.kind, f.path, f.marker]), [["marker", "tests/a.test.mjs", marker]]);
    assert.match(verdict.output, new RegExp(`tests/a\\.test\\.mjs adds the "${marker}" marker`));
  }
  assert.equal(tamperPlan({ diff: modified("tests/a.test.mjs"), patch: patchOf({ from: "tests/a.test.mjs", removed: ['test.skip("x", () => {});'] }) }).ok, true, "removing a skip");
  assert.equal(tamperPlan({ diff: modified("src/a.mjs"), patch: patchOf({ from: "src/a.mjs", added: ["list.skip(2);"] }) }).ok, true, "not a test file");
});

test("assertions are counted over every test file together: a net removal past the limit fails, a moved test passes", () => {
  const two = ["assert.equal(a, 1);", "assert.ok(b); assert.ok(c);"];
  const removed = tamperPlan({ diff: modified("tests/a.test.mjs"), patch: patchOf({ from: "tests/a.test.mjs", removed: two }) });
  assert.equal(removed.ok, false);
  assert.deepEqual(removed.findings.map((f) => [f.kind, f.removed, f.added, f.paths]), [["assertions", 3, 0, ["tests/a.test.mjs"]]]);
  assert.match(removed.output, /3 assertion match\(es\) removed and 0 added across the test files, 3 net; at most 0 may be/);
  // Moved: out of one file, into another.
  const moved = tamperPlan({ diff: modified("tests/a.test.mjs", "tests/b.test.mjs"), patch: patchOf({ from: "tests/a.test.mjs", removed: two }, { from: "tests/b.test.mjs", added: two }) });
  assert.equal(moved.ok, true);
  // A deleted test file's assertions count as removed; a source file's never count.
  assert.equal(tamperPlan({ diff: nameStatus(["D", "tests/a.test.mjs"]), patch: patchOf({ from: "tests/a.test.mjs", to: null, removed: two }) }).ok, false);
  assert.equal(tamperPlan({ diff: modified("src/a.mjs"), patch: patchOf({ from: "src/a.mjs", removed: two }) }).ok, true);
  // A test file renamed out of the test globs takes every assertion with it, edited lines or not.
  const atBase = { "abc123:tests/a.test.mjs": two.join("\n") };
  const pureRename = "diff --git a/tests/a.test.mjs b/tests/a.mjs\nsimilarity index 100%\nrename from tests/a.test.mjs\nrename to tests/a.mjs";
  const out = tamperPlan({ diff: nameStatus(["R100", "tests/a.test.mjs", "tests/a.mjs"]), patch: pureRename, files: atBase });
  assert.deepEqual(out.findings.map((f) => [f.kind, f.removed, f.paths]), [["assertions", 3, ["tests/a.test.mjs"]]]);
  const unread = tamperPlan({ diff: nameStatus(["R100", "tests/a.test.mjs", "tests/a.mjs"]), patch: pureRename, files: {} });
  assert.deepEqual(unread.findings.map((f) => [f.kind, f.path]), [["unreadable", "tests/a.test.mjs"]], "its base text unreadable: never passes uncounted");
  const renamedWithin = "diff --git a/tests/a.test.mjs b/tests/b.test.mjs\nsimilarity index 100%\nrename from tests/a.test.mjs\nrename to tests/b.test.mjs";
  assert.equal(tamperPlan({ diff: nameStatus(["R100", "tests/a.test.mjs", "tests/b.test.mjs"]), patch: renamedWithin, files: atBase }).ok, true, "renamed among the tests");
  // Moved into a file the override names: its gains still count, so the move balances.
  const intoOverridden = tamperPlan({ diff: modified("tests/a.test.mjs", "tests/b.test.mjs"), patch: patchOf({ from: "tests/b.test.mjs", removed: two }, { from: "tests/a.test.mjs", added: two }), body: OVERRIDE });
  assert.equal(intoOverridden.ok, true);
  // Within the limit.
  const loose = workflowWith({ ...TAMPER, assertions: { pattern: "\\bassert\\.", maxNetRemoved: 3 } });
  assert.equal(tamperPlan({ base: loose, diff: modified("tests/a.test.mjs"), patch: patchOf({ from: "tests/a.test.mjs", removed: two }) }).ok, true);
});

test("any change to a guarded file fails, both sides of a rename counted", () => {
  for (const diff of [modified(".claude/workflow.json"), nameStatus(["R100", "vitest.config.ts", "old/vitest.config.ts"]), nameStatus(["D", "vitest.config.ts"])]) {
    const verdict = tamperPlan({ diff });
    assert.equal(verdict.ok, false, JSON.stringify(diff));
    assert.equal(verdict.findings[0].kind, "guarded");
    assert.match(verdict.output, /is guarded, and this ticket changes it/);
  }
  assert.equal(tamperPlan({ diff: modified("src/vitest.config.ts.md") }).ok, true);
});

test("a change to a guarded script's text fails; the rest of its file is free, and a missing script is a change", () => {
  const pkg = (scripts, extra = {}) => JSON.stringify({ name: "p", scripts, ...extra });
  const base = pkg({ test: "node --test", lint: "eslint ." });
  const at = (head) => ({ "abc123:package.json": base, ...(head === null ? {} : { "HEAD:package.json": head }) });
  const verdict = tamperPlan({ diff: modified("package.json"), files: at(pkg({ test: "node --test || true", lint: "eslint ." })) });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.findings.map((f) => [f.kind, f.path, f.script]), [["script", "package.json", "test"]]);
  assert.match(verdict.output, /package\.json's "test" script changed/);
  assert.equal(tamperPlan({ diff: modified("package.json"), files: at(pkg({ test: "node --test", lint: "eslint --fix ." }, { version: "2.0.0" })) }).ok, true);
  assert.equal(tamperPlan({ diff: modified("package.json"), files: at(pkg({ lint: "eslint ." })) }).ok, false, "the script removed");
  assert.equal(tamperPlan({ diff: nameStatus(["D", "package.json"]), files: at(null) }).ok, false, "the file deleted");
  assert.equal(tamperPlan({ diff: modified("package.json"), files: at("{ not json") }).ok, false, "unreadable: never fails open");
  assert.equal(tamperPlan({ diff: modified("src/a.mjs"), files: {} }).ok, true, "package.json untouched: nothing read");
});

test("a test override in the ticket body, naming the path as a whole word, lets that path through", () => {
  const marker = { diff: modified("tests/a.test.mjs"), patch: patchOf({ from: "tests/a.test.mjs", added: ['test.skip("x", () => {});'], removed: ["assert.ok(x);"] }) };
  const passed = tamperPlan({ ...marker, body: `## What to build\n\nIt.\n\n${OVERRIDE}\n## Areas\n\n- tests/\n` });
  assert.equal(passed.ok, true, "the marker and the file's assertions both let through");
  assert.deepEqual(passed.overridden, ["tests/a.test.mjs"]);
  assert.equal(tamperPlan({ ...marker, body: OVERRIDE.replace(/\n/g, "\r\n") }).ok, true, "a body with CRLF");
  assert.equal(tamperPlan({ diff: modified("vitest.config.ts"), body: "### Tests removed or weakened:\n- vitest.config.ts, the slow pool goes.\n" }).ok, true, "a guarded file");
  // Never a near miss: a longer path, a line under another heading, a bare file name.
  const fenced = "## Notes\n\n```sh\n# Tests removed or weakened\nrm tests/a.test.mjs\n```\n";
  for (const body of [OVERRIDE.replace("a.test.mjs", "a.test.mjs.bak"), "## Notes\n\n- `tests/a.test.mjs`: flaky.\n", "## Tests removed or weakened\n\n- a.test.mjs: flaky.\n", `${OVERRIDE.split("\n")[0]}\n\n## Areas\n- tests/a.test.mjs\n`, fenced]) {
    assert.equal(tamperPlan({ ...marker, body }).ok, false, body);
  }
  // Only the overridden file leaves the assertion count.
  const both = tamperPlan({ diff: modified("tests/a.test.mjs", "tests/b.test.mjs"), patch: patchOf({ from: "tests/a.test.mjs", removed: ["assert.ok(1);"] }, { from: "tests/b.test.mjs", removed: ["assert.ok(2);"] }), body: OVERRIDE });
  assert.deepEqual(both.findings.map((f) => [f.kind, f.removed, f.paths]), [["assertions", 1, ["tests/b.test.mjs"]]]);
});

test("a test override says why: a line naming only the path lets nothing through, and the output says so (#24)", () => {
  const marker = { diff: modified("tests/a.test.mjs"), patch: patchOf({ from: "tests/a.test.mjs", added: ['test.skip("x", () => {});'] }) };
  for (const line of ["- tests/a.test.mjs", "- `tests/a.test.mjs`", "* tests/a.test.mjs:", "1. **tests/a.test.mjs** —", "tests/a.test.mjs.", "- tests/a.test.mjs, tests/b.test.mjs"]) {
    const verdict = tamperPlan({ ...marker, body: `## Tests removed or weakened\n\n${line}\n` });
    assert.equal(verdict.ok, false, line);
    assert.match(verdict.output, /"Tests removed or weakened" names tests\/a\.test\.mjs with no reason/, line);
  }
  assert.equal(tamperPlan({ ...marker, body: "## Tests removed or weakened\n\n- tests/a.test.mjs (#31 rewrites it)\n" }).ok, true, "any words beside the path are a reason");
  assert.equal(tamperPlan({ ...marker, body: "## Tests removed or weakened\n\n- tests/a.test.mjs: e.g.\n" }).ok, true, "an abbreviation is a word, not a path");
});

test("a reason only in the commit message is refused, and said so for the morning report", () => {
  const message = "test: drop the flaky case — devlog #9, Closes #7\n\nTests removed or weakened: tests/a.test.mjs, the case was flaky.\n";
  const verdict = tamperPlan({ diff: modified("tests/a.test.mjs"), patch: patchOf({ from: "tests/a.test.mjs", added: ['test.skip("x", () => {});'] }), message });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.refused, ["tests/a.test.mjs"]);
  assert.match(verdict.output, /A reason in the commit message does not count \(found for tests\/a\.test\.mjs\)/);
  assert.match(verdict.refusedNote, /The commit message gave a reason for weakening `tests\/a\.test\.mjs`; it was refused/);
  // Naming the file in a commit message is no reason by itself.
  assert.deepEqual(tamperPlan({ diff: modified("tests/a.test.mjs"), patch: patchOf({ from: "tests/a.test.mjs", added: ['test.skip("x", () => {});'] }), message: "test: tests/a.test.mjs\n" }).refused, []);
  // The refusal reaches the morning report whichever way the ticket ends: a built ticket's notes, a
  // parked or failed one's detail (a runner error's too), through the one place results are recorded.
  const run = tempRun();
  run.tamperingNotes = new Map([[14, verdict.refusedNote], [15, verdict.refusedNote]]);
  recordResult(run, builtResult);
  recordResult(run, { ...crashResult, number: 15 });
  recordResult(run, { ...builtResult, number: 16 });
  assert.deepEqual(run.results.map((r) => [r.notes?.includes(verdict.refusedNote) ?? null, r.detail?.endsWith(verdict.refusedNote) ?? null]), [[true, null], [null, true], [false, null]]);
  const text = report(run, options, []);
  assert.equal(text.split(verdict.refusedNote).length - 1, 2, "once under the built ticket, once under the failed one");
  rmSync(run.dir, { recursive: true, force: true });
});

test("the rules are the base commit's: a section the ticket loosens is ignored, and a missing or broken one at the base fails", () => {
  // The ticket rewrote its own rules: the run's copy says anything goes; the base still judges.
  const loosened = runConfig({ gates: [], tampering: { testFiles: ["nothing/**"] } });
  const marker = { diff: modified("tests/a.test.mjs", ".claude/workflow.json"), patch: patchOf({ from: "tests/a.test.mjs", added: ['test.only("x", () => {});'] }) };
  const verdict = tamperPlan({ ...marker, config: loosened });
  assert.deepEqual(verdict.findings.map((f) => f.kind).sort(), ["guarded", "marker"]);
  assert.match(verdict.output, /read from the base commit abc123/);
  for (const [base, why] of [
    [null, /has no \.claude\/workflow\.json/],
    ["{ broken", /could not be read as JSON/],
    [JSON.stringify({ version: 1, phaseRun: {} }), /has no phaseRun\.tampering section, while this run has one/],
    [workflowWith({ ...TAMPER, markers: [{ name: "skip", pattern: "(" }] }), /phaseRun\.tampering\.markers\[0\]\.pattern is not a valid pattern/],
  ]) {
    const broken = tamperPlan({ diff: modified("src/a.mjs"), base });
    assert.equal(broken.ok, false, String(base));
    assert.match(broken.problem, why);
    assert.match(broken.output, /never passes a ticket it cannot judge/);
  }
  const noReader = gatePlan({ base: "abc123", diff: modified("src/a.mjs"), config: TAMPER_CONFIG }).tampering;
  assert.equal(noReader.ok, false, "no reader: never fails open");
});

test("the tampering verdict is the first gate: nothing else starts, and the browser check is never asked", async () => {
  const config = runConfig({
    gates: [{ label: "lint", run: "lint" }, { label: "tests", run: "tests", alone: true }],
    browserCheck: { screenFiles: "^src/", sourceFiles: "^src/", screenshots: "shots/{N}", minimum: 1, redo: "walk it" },
    tampering: TAMPER,
  });
  const at = { "abc123:.claude/workflow.json": workflowWith(TAMPER) };
  const plan = gatePlan({ base: "abc123", diff: modified("vitest.config.ts"), config, readAt: (rev, path) => at[`${rev}:${path}`] ?? null });
  const fake = fakeStart();
  let asked = false;
  const cache = mkdtempSync(join(tmpdir(), "tamper-cache-"));
  try {
    writeFileSync(join(cache, "kept"), "");
    const failed = await projectGates(plan, { values: { cache }, browserCheck: () => (asked = true) && null, start: fake.start, tickMs: 5 });
    assert.equal(failed.gate, "tampering");
    assert.match(failed.output, /vitest\.config\.ts is guarded/);
    assert.deepEqual(fake.ran, []);
    assert.equal(asked, false);
    assert.equal(existsSync(join(cache, "kept")), true, "it runs before {cache} is even emptied");
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
  const clean = gatePlan({ base: "abc123", diff: modified("src/a.ts"), config, readAt: (rev, path) => at[`${rev}:${path}`] ?? null });
  assert.equal(await projectGates(clean, { values: {}, browserCheck: () => null, start: fake.start, tickMs: 5 }), null);
  assert.deepEqual(fake.ran.map((r) => r.line), ["lint", "tests"]);
});

test("the verdict reads real git output: a quoted path, a path with a space, a pure rename", () => {
  const dir = mkdtempSync(join(tmpdir(), "tamper-git-"));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  mkdirSync(join(dir, "tests"));
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, ".claude", "workflow.json"), workflowWith(TAMPER));
  const body = 'test("a", () => {\n  assert.ok(1);\n});\n';
  for (const name of ["a b.test.mjs", "ü.test.mjs", "moved.test.mjs"]) writeFileSync(join(dir, "tests", name), body);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD").trim();
  writeFileSync(join(dir, "tests", "a b.test.mjs"), body.replace('test("a"', 'test.skip("a"'));
  writeFileSync(join(dir, "tests", "ü.test.mjs"), body.replace("  assert.ok(1);\n", ""));
  git("mv", "tests/moved.test.mjs", "tests/renamed.test.mjs");
  git("commit", "-q", "-am", "work");
  const readAt = (rev, path) => {
    const result = spawnSync("git", ["show", `${rev}:${path}`], { cwd: dir, encoding: "utf8" });
    return result.status === 0 ? result.stdout : null;
  };
  const plan = gatePlan({ base, diff: git("diff", "--name-status", "-M", "-z", `${base}..HEAD`), patch: git(...PATCH_ARGS, `${base}..HEAD`), config: TAMPER_CONFIG, readAt });
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(plan.tampering.findings.map((f) => [f.kind, f.path ?? f.paths.join(",")]), [["marker", "tests/a b.test.mjs"], ["assertions", "tests/ü.test.mjs"]]);
});

// Runner-seam tests with tiny real jobs: each gate is a `node -e` line, so the parallel group, the
// waits and the kills are the real ones. Each job reads its folder from DIR, and leaves flags there.
const node = (code) => `node -e "const fs=require('fs'),d=process.env.DIR;${code}"`;
/** Waits (up to 15 s) for `flag` in DIR, then runs `then`; exits 9 if it never comes. */
const waitFor = (flag, then) => `const t=Date.now();const i=setInterval(()=>{if(fs.existsSync(d+'/${flag}')){clearInterval(i);${then}}else if(Date.now()-t>15000)process.exit(9)},20);`;
const flag = (name) => `fs.writeFileSync(d+'/${name}','');`;
function jobRun(gates, { diff = modified("src/a.ts"), stopGate } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gates-"));
  const config = runConfig({ gates: gates.map((gate) => ({ ...gate, env: { DIR: dir } })) }, stopGate ? { stopGate } : {});
  return { dir, has: (name) => existsSync(join(dir, name)), plan: planFor(diff, config) };
}
const realGates = (plan, over = {}) => projectGates(plan, { values: {}, browserCheck: () => null, tickMs: 20, ...over });
async function gone(pid) {
  for (let i = 0; i < 200; i++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return true;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  return false;
}

test("gates run side by side: two jobs that each wait for the other's flag both pass", { timeout: 60_000 }, async () => {
  const run = jobRun([
    { label: "a", run: node(flag("a") + waitFor("b", "process.exit(0)")) },
    { label: "b", run: node(flag("b") + waitFor("a", "process.exit(0)")) },
  ]);
  assert.equal(await realGates(run.plan), null, "one after the other, the first would never see the second's flag");
});

test("an after gate starts once its gate passed, and never when it failed", { timeout: 60_000 }, async () => {
  const passing = jobRun([
    { label: "typecheck", run: node(`process.exit(fs.existsSync(d+'/built')?0:3)`), after: "build" },
    { label: "build", run: node(`setTimeout(()=>{${flag("built")}},300)`) },
  ]);
  assert.equal(await realGates(passing.plan), null);
  const failing = jobRun([
    { label: "build", run: node(`setTimeout(()=>process.exit(1),200)`) },
    { label: "typecheck", run: node(flag("ran")), after: "build" },
  ]);
  assert.equal((await realGates(failing.plan)).gate, "build");
  assert.equal(failing.has("ran"), false);
  // A skipped gate holds nobody up.
  const skippedBuild = jobRun([
    { label: "build", run: node("process.exit(1)"), when: "^nothing/" },
    { label: "typecheck", run: node(flag("ran")), after: "build" },
  ]);
  assert.equal(await realGates(skippedBuild.plan), null);
  assert.equal(skippedBuild.has("ran"), true);
});

test("alone gates run one at a time after the whole group, each after its strays are stopped", { timeout: 60_000 }, async () => {
  const run = jobRun([
    { label: "suite", run: node(`if(!fs.existsSync(d+'/lint'))process.exit(4);setTimeout(()=>{${flag("suite")}},300)`), alone: true },
    { label: "lint", run: node(`setTimeout(()=>{${flag("lint")}},300)`) },
    { label: "e2e", run: node(`process.exit(fs.existsSync(d+'/suite')?0:5)`), alone: true },
  ]);
  const strays = [];
  assert.equal(await realGates(run.plan, { stopStray: (when) => strays.push(when) }), null);
  assert.deepEqual(strays, ["before the suite gate", "before the e2e gate"]);
});

test("the first failure stops the rest: each job's process tree is killed and waited for, and a waiting job never starts", { timeout: 60_000 }, async () => {
  const run = jobRun([
    { label: "suite", run: node(`fs.writeFileSync(d+'/pid',String(process.pid));setInterval(()=>{},1000)`) },
    { label: "lint", run: node(waitFor("pid", "process.exit(1)")) },
    { label: "e2e", run: node(flag("ran")), after: "suite" },
  ]);
  const failed = await realGates(run.plan);
  assert.equal(failed.gate, "lint");
  assert.equal(await gone(Number(readFileSync(join(run.dir, "pid"), "utf8"))), true, "the long job's node process is gone");
  assert.equal(run.has("ran"), false);
});

// Off Windows a job leads its own process group, so the terminal's Ctrl-C no longer reaches it: the
// runner's exit must kill every job still open, or a suite outlives the night holding its ports.
test("a gate job still open when the runner exits is killed with it", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gates-"));
  const job = node(`fs.writeFileSync(d+'/pid',String(process.pid));setInterval(()=>{},1000)`);
  const runner = [
    `const { startJob } = await import(${JSON.stringify(pathToFileURL(join(HERE, "run.mjs")).href)});`,
    `startJob(${JSON.stringify(job)}, { DIR: ${JSON.stringify(dir)} });`,
    `const fs = await import("node:fs");`,
    `const i = setInterval(() => { if (fs.existsSync(${JSON.stringify(join(dir, "pid"))})) { clearInterval(i); process.exit(0); } }, 20);`,
  ].join("\n");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PHASE_RUN")));
  const exited = spawnSync(process.execPath, ["--input-type=module", "-e", runner], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(exited.status, 0, exited.stderr);
  assert.equal(await gone(Number(readFileSync(join(dir, "pid"), "utf8"))), true, "the job's node process died with the runner");
});

test("two jobs failing in the same tick are both reported, each output under its gate", { timeout: 60_000 }, async () => {
  const run = jobRun([
    { label: "lint", run: node(flag("l") + waitFor("t", "console.log('lint said no');process.exit(1)")) },
    { label: "typecheck", run: node(flag("t") + waitFor("l", "console.log('tsc said no');process.exit(2)")) },
  ]);
  const failed = await realGates(run.plan, { tickMs: 3000 });
  assert.equal(failed.gate, "lint, typecheck");
  assert.match(failed.output, /── lint ──\nlint said no[\s\S]*── typecheck ──\ntsc said no/);
});

test("the suite skip end to end: a docs-only diff never starts the gate, a mixed or empty one does", { timeout: 60_000 }, async () => {
  const stopGate = { checks: [{ name: "tests", label: "Tests", run: "npm test", receipt: true, unread: ["docs/**"] }] };
  const suite = [{ label: "suite", run: node(flag("ran")), unreadOf: "tests" }];
  for (const [diff, ran] of [[modified("docs/a.md"), false], [modified("docs/a.md", "src/a.ts"), true], ["", true]]) {
    const run = jobRun(suite, { diff, stopGate });
    assert.equal(await realGates(run.plan), null);
    assert.equal(run.has("ran"), ran, JSON.stringify(diff));
  }
});

test("the {cache} folder is emptied before the gates run, and the gates are given its path", { timeout: 60_000 }, async () => {
  const cache = join(mkdtempSync(join(tmpdir(), "gate-cache-")), "cache");
  mkdirSync(join(cache, "old"), { recursive: true });
  writeFileSync(join(cache, "old", "eslintcache"), "stale");
  const dir = mkdtempSync(join(tmpdir(), "gates-"));
  const config = runConfig({ gates: [{ label: "lint", run: node(`process.exit(fs.readdirSync(process.env.CACHE).length)`), env: { DIR: dir, CACHE: "{cache}" } }] });
  assert.equal(await realGates(planFor(modified("src/a.ts"), config), { values: { cache } }), null);
  assert.equal(existsSync(join(cache, "old")), false);
});

// The migrations' apply, with a fake shell standing in: what ran, in what order, with what.
function fakeShell(failing = []) {
  const ran = [];
  const run = (line, env) => {
    ran.push({ line, env });
    return failing.some((word) => line.includes(word)) ? { ok: false, output: `${line} broke` } : { ok: true, output: "" };
  };
  return { ran, run };
}

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

// ------------------------------------------------------ the frozen runner copy (#16)

/** A repo stand-in with a runner folder and a config, and a run folder beside it. */
function snapshotProject() {
  const root = mkdtempSync(join(tmpdir(), "phase-run-snapshot-"));
  const put = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put("tools/phase-run/run.mjs", "// the runner\n");
  put("tools/phase-run/receipt.mjs", "// the receipt\n");
  put("tools/phase-run/run.test.mjs", "// its tests\n");
  put("tools/phase-run/ticket-prompt.md", "the prompt\n");
  put(".claude/workflow.json", '{ "version": 1 }\n');
  // The doc tools (#31): doc-check, what it imports (some of it through another tool), and its baseline.
  put("tools/doc-check.mjs", 'import { a } from "./doc-lib.mjs";\nimport * as config from "./doc-config.mjs";\nimport "./doc-side.mjs";\n');
  put("tools/doc-side.mjs", "// imported for its side effect\n");
  put("tools/doc-lib.mjs", 'export { b } from "./roadmap-format.mjs";\n');
  put("tools/doc-config.mjs", "// the doc config\n");
  put("tools/roadmap-format.mjs", "// the roadmap's format\n");
  put("tools/doc-rotate.mjs", 'import { a } from "./doc-lib.mjs";\n');
  put("tools/doc-tools.test.mjs", "// the doc tools' tests\n");
  put("tools/doc-check-baseline.json", '{ "stale": {}, "missing": {} }\n');
  const runDir = join(root, ".phase-run", "phase-x");
  const take = (runId, at = AT, brigade = "0.6.0") => takeSnapshot({ root, runDir, runId, commit: "abc123", at, brigade });
  return { root, runDir, put, take };
}

test("at run start the copy is taken: the runner folder and the config, with its manifest", () => {
  const { runDir, take } = snapshotProject();
  const copy = take("run-1");
  assert.equal(copy.dir, join(runDir, "runner"));
  assert.equal(copy.reused, false);
  assert.deepEqual(copy.manifest, { takenAt: new Date(AT).toISOString(), commit: "abc123", runId: "run-1", brigade: "0.6.0", docCheck: true, finished: false });
  assert.deepEqual(readManifest(copy.dir), copy.manifest);
  assert.equal(readFileSync(join(copy.dir, "tools/phase-run/run.mjs"), "utf8"), "// the runner\n");
  assert.equal(readFileSync(join(copy.dir, "tools/phase-run/ticket-prompt.md"), "utf8"), "the prompt\n");
  assert.equal(readFileSync(join(copy.dir, ".claude/workflow.json"), "utf8"), '{ "version": 1 }\n');
});

test("a run that died restarts on the same copy, though its tests or its config changed since", () => {
  const { put, take } = snapshotProject();
  const first = take("run-1");
  put("tools/phase-run/run.test.mjs", "// a test written mid-night\n");
  put(".claude/workflow.json", '{ "version": 1, "note": "edited mid-night" }\n');
  const again = take("run-2", AT + 3_600_000);
  assert.equal(again.reused, true);
  assert.deepEqual(again.manifest, first.manifest, "the first run's manifest stands");
  assert.equal(readFileSync(join(again.dir, ".claude/workflow.json"), "utf8"), '{ "version": 1 }\n', "the copy keeps the config it was taken with");
});

test("the restart is refused, naming the files, when the live runner's code differs from the copy's", () => {
  const { root, put, take } = snapshotProject();
  take("run-1");
  put("tools/phase-run/run.mjs", "// changed\n");
  put("tools/phase-run/new.mjs", "// added\n");
  rmSync(join(root, "tools/phase-run/receipt.mjs"));
  put("tools/phase-run/run.test.mjs", "// a test change is not runner code\n");
  assert.deepEqual(runnerChanges(root, join(root, ".phase-run", "phase-x", "runner")), ["tools/phase-run/new.mjs", "tools/phase-run/receipt.mjs", "tools/phase-run/run.mjs"]);
  assert.throws(() => take("run-2"), (error) => {
    assert.match(error.message, /tools\/phase-run\/new\.mjs, tools\/phase-run\/receipt\.mjs, tools\/phase-run\/run\.mjs/);
    assert.doesNotMatch(error.message, /run\.test\.mjs/);
    assert.match(error.message, /\.phase-run[\\/]phase-x[\\/]runner/, "it says which copy to delete for a fresh start");
    return true;
  });
});

test("a finished run marks its copy finished, and the next run takes a fresh one", () => {
  const { put, take } = snapshotProject();
  const first = take("run-1");
  finishSnapshot(first.dir);
  assert.equal(readManifest(first.dir).finished, true);
  put("tools/phase-run/run.mjs", "// the next release\n");
  writeFileSync(join(first.dir, "tools/phase-run/left-over.mjs"), "// only in the old copy\n");
  const next = take("run-2", AT + 86_400_000);
  assert.equal(next.reused, false);
  assert.deepEqual(next.manifest, { takenAt: new Date(AT + 86_400_000).toISOString(), commit: "abc123", runId: "run-2", brigade: "0.6.0", docCheck: true, finished: false });
  assert.equal(readFileSync(join(next.dir, "tools/phase-run/run.mjs"), "utf8"), "// the next release\n");
  assert.equal(existsSync(join(next.dir, "tools/phase-run/left-over.mjs")), false, "nothing of the old copy is left");
});

test("a project with no workflow.json gets a copy whose config has no rules, so the hooks can refuse a copy with none", () => {
  const { root, take } = snapshotProject();
  rmSync(join(root, ".claude/workflow.json"));
  const copy = take("run-1");
  assert.equal(existsSync(join(copy.dir, ".claude/workflow.json")), true);
  const { config, error } = loadRunConfig(copy.dir);
  assert.equal(error, null);
  assert.deepEqual([config.gates, config.stopChecks], [[], []]);
  assert.equal(existsSync(join(copy.dir, "tools/phase-run/run.mjs")), true);
});

test("each ticket's env points the hooks at the copy and the copy at the repo", () => {
  const env = runVariables({ ticket: 7, base: "abc", spec: 5, runner: "/repo/.phase-run/phase-2/runner", root: "/repo" });
  assert.deepEqual(env, { PHASE_RUN: "1", PHASE_RUN_TICKET: "7", PHASE_RUN_BASE: "abc", PHASE_RUN_SPEC: "5", PHASE_RUN_RUNNER: "/repo/.phase-run/phase-2/runner", PHASE_RUN_ROOT: "/repo" });
  assert.equal("PHASE_RUN_SPEC" in runVariables({ ticket: 7, base: "abc", spec: null, runner: "r", root: "/repo" }), false);
  // The night's Edit deny on the runner and its config stays, with the copy itself under the run folder's.
  const settings = sessionSettings({}, { allow: [], deny: [] }, { branch: "phase-2", env, background: true, prompt: null });
  assert.equal(settings.env.PHASE_RUN_RUNNER, "/repo/.phase-run/phase-2/runner");
  for (const rule of ["Edit(./tools/phase-run/**)", "Edit(./.claude/workflow.json)", "Edit(./.phase-run/phase-2/**)"]) assert.ok(settings.permissions.deny.includes(rule), rule);
});

// D10 (#31): the copy carries doc-check too, so a night can't change the rules its own docs are checked by.

test("the copy holds doc-check, every doc tool it imports, and its baseline, and nothing else of tools/", () => {
  const { take } = snapshotProject();
  const copy = take("run-1");
  for (const name of ["doc-check.mjs", "doc-lib.mjs", "doc-config.mjs", "roadmap-format.mjs", "doc-side.mjs", "doc-check-baseline.json"]) {
    assert.equal(readFileSync(join(copy.dir, "tools", name), "utf8"), readFileSync(join(copy.dir, "..", "..", "..", "tools", name), "utf8"), name);
  }
  assert.equal(existsSync(join(copy.dir, "tools/doc-rotate.mjs")), false, "doc-check does not import it");
  assert.equal(existsSync(join(copy.dir, "tools/doc-tools.test.mjs")), false);
});

test("a restart keeps the copy's doc-check, baseline and doc config: a doc tool's change refuses it, the configs' do not", () => {
  const { root, put, take } = snapshotProject();
  take("run-1");
  put("tools/doc-check-baseline.json", '{ "stale": { "docs/x.md": ["accepted mid-night"] }, "missing": {} }\n');
  put("tools/doc-config.mjs", "// a ticket added a doc path mid-night\n");
  const again = take("run-2");
  assert.equal(again.reused, true);
  assert.equal(readFileSync(join(again.dir, "tools/doc-check-baseline.json"), "utf8"), '{ "stale": {}, "missing": {} }\n', "the copy keeps the baseline it was taken with");
  assert.equal(readFileSync(join(again.dir, "tools/doc-config.mjs"), "utf8"), "// the doc config\n", "and the doc config");
  put("tools/roadmap-format.mjs", "// changed mid-night\n");
  put("tools/doc-tools.test.mjs", "// a test change is not doc-check's code\n");
  assert.deepEqual(runnerChanges(root, again.dir), ["tools/roadmap-format.mjs"]);
  assert.throws(() => take("run-3"), /tools\/roadmap-format\.mjs/);
});

test("a copy taken before #31 has no doc tools: its restart is refused, naming them", () => {
  const { root, take } = snapshotProject();
  const copy = take("run-1");
  for (const name of ["doc-check.mjs", "doc-lib.mjs", "doc-config.mjs", "roadmap-format.mjs"]) rmSync(join(copy.dir, "tools", name));
  assert.deepEqual(runnerChanges(root, copy.dir), ["tools/doc-check.mjs", "tools/doc-lib.mjs", "tools/doc-side.mjs", "tools/roadmap-format.mjs"]);
  assert.throws(() => take("run-2"), /tools\/doc-check\.mjs, tools\/doc-lib\.mjs/);
});

/** A project with the real doc tools, its docs clean and committed, and its run's copy taken. */
function docsProject() {
  const { root, runDir, put } = snapshotProject();
  for (const name of ["doc-check.mjs", "doc-index.mjs", "doc-lib.mjs", "roadmap-format.mjs"]) put(`tools/${name}`, readFileSync(join(HERE, "..", name), "utf8"));
  rmSync(join(root, "tools/doc-rotate.mjs"));
  put(
    "tools/doc-config.mjs",
    [
      'export const DEVLOG = "docs/devlog.md";',
      'export const DEVLOG_ARCHIVE = "docs/devlog";',
      'export const PHASES = "docs/devlog/phases.json";',
      'export const LIVE_DOCS = ["docs/roadmap.md"];',
      "export const STATUS_DOCS = /^docs\\/roadmap\\.md$/;",
      'export const PATH_ROOTS = ["docs", "tools"];',
      'export const PATH_EXTENSIONS = ["md", "mjs"];',
      'export const HEADER_REQUIRED = ["docs"];',
      "export const HEADER_EXEMPT = [];",
      "export const GENERATED = [];",
      'export const DEVLOG_TYPES = ["chore"];',
      "export const DEVLOG_TAGGED_FROM = 1;",
      "",
    ].join("\n"),
  );
  put("docs/roadmap.md", "---\njob: Where things stand.\nkind: living\nmax-lines: 20\n---\n# Roadmap\n");
  put("docs/devlog.md", "---\njob: The timeline.\nkind: log\nmax-entry-lines: 15\n---\n# Devlog\n\n## #1 · chore · start\n- the repo\n\n---\n");
  put(".gitignore", ".phase-run/\n");
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  git("add", "-A");
  git("commit", "-q", "-m", "chore: start — devlog #1");
  const copy = takeSnapshot({ root, runDir, runId: "run-1", commit: "abc123", at: AT, brigade: "0.7.0" });
  const outsideRun = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PHASE_RUN/.test(key)));
  return { root, put, copy: copy.dir, check: (runner, ...args) => docCheck(runner, root, args, outsideRun) };
}

test("inside a run the gates' doc-check is the copy's: a live doc-check or baseline changed mid-night changes no verdict", () => {
  const { root, put, copy, check } = docsProject();
  assert.equal(check(copy).ok, true, check(copy).stderr);
  put("tools/doc-check.mjs", 'console.error("the live doc-check, broken mid-night"); process.exit(1);\n');
  assert.equal(check(copy).ok, true, "the copy judges, not the live file");
  assert.match(check(null).stderr, /broken mid-night/, "with no copy (outside a run), the live doc-check, as today");
  // The copy reads the repo's docs, against its own baseline: a phrase the live baseline took mid-night still fails.
  put("docs/roadmap.md", "---\njob: Where things stand.\nkind: living\nmax-lines: 20\n---\n# Roadmap\nnot yet pushed\n");
  put("tools/doc-check-baseline.json", JSON.stringify({ stale: { "docs/roadmap.md": ["not yet pushed"] }, missing: {} }));
  const verdict = check(copy);
  assert.equal(verdict.ok, false);
  assert.match(verdict.stderr, /docs\/roadmap\.md:7 reads as stale: not yet pushed/);
});

test("the copy's doc-check refuses a budget raise at the gate, though the runner's process has no PHASE_RUN", () => {
  const { put, copy, check } = docsProject();
  put("docs/roadmap.md", "---\njob: Where things stand.\nkind: living\nmax-lines: 30\n---\n# Roadmap\n");
  const gate = check(copy);
  assert.equal(gate.ok, false);
  assert.match(gate.stderr, /max-lines raised from 20 to 30\. A phase run never raises a budget/);
  const attended = check(null);
  assert.equal(attended.ok, true, attended.stderr);
  assert.match(attended.stdout, /Raising a budget is the owner's call/, "outside a run, a note, as today");
});

test("inside a run --update-baseline is refused, naming why, and the copy's baseline is untouched", () => {
  const { copy, check } = docsProject();
  const before = readFileSync(join(copy, "tools/doc-check-baseline.json"), "utf8");
  for (const flag of ["--update-baseline", "--adopt"]) {
    const refused = check(copy, flag);
    assert.equal(refused.ok, false, flag);
    assert.match(refused.stderr, /never updated inside a phase run[\s\S]*the baseline the run's copy took at run start/, flag);
  }
  assert.equal(readFileSync(join(copy, "tools/doc-check-baseline.json"), "utf8"), before);
});

test("the gate and the report run doc-check through docCheck, never the live path", () => {
  const source = readFileSync(join(HERE, "run.mjs"), "utf8");
  assert.doesNotMatch(source, /exec\("node", \["tools\/doc-check\.mjs"/);
  // `work`: the session's root, the lane's worktree in a lane (ADR 0007), else the repo, as before.
  assert.match(source, /docCheck\(run\.runner, work, \["--head"\]/);
  assert.match(source, /docCheck\(run\.runner, work, \["--report"\]\)/);
});

// D16 (#21): trim. A per-machine list switches off what the owner's nights don't need, and a
// project never loses what it enables itself or keeps.
function trimHome(trim) {
  const home = mkdtempSync(join(tmpdir(), "phase-trim-"));
  if (trim !== undefined) {
    mkdirSync(join(home, ".claude", "brigade"), { recursive: true });
    writeFileSync(join(home, ".claude", "brigade", "trim.json"), typeof trim === "string" ? trim : JSON.stringify(trim));
  }
  return home;
}

test("trim.json lives under ~/.claude, or under CLAUDE_CONFIG_DIR when that is set; a missing file means no trim", () => {
  assert.equal(trimPath({}, "/home/me"), join("/home/me", ".claude", "brigade", "trim.json"));
  assert.equal(trimPath({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/me"), join("/cfg", "brigade", "trim.json"));
  const home = trimHome();
  assert.equal(readTrim(trimPath({}, home)), null);
  // No file, no entries: the settings come back as they went in.
  const settings = { permissions: { allow: ["Bash(git *)"], deny: [] } };
  assert.deepEqual(trimmedSettings(settings, null, home, { plugins: [], skills: [] }), settings);
  rmSync(home, { recursive: true, force: true });
});

test("trim.json refuses a flag off the runner's list, a brigade@* plugin and a malformed file, naming what it refuses", () => {
  assert.deepEqual(TRIM_FLAGS, ["--strict-mcp-config", "--no-chrome"]);
  for (const [trim, error] of [
    [{ flags: ["--no-chrome", "--dangerously-skip-permissions"] }, /"--dangerously-skip-permissions" is not a flag trim may add; allowed: --strict-mcp-config, --no-chrome/],
    [{ plugins: ["brigade@market"] }, /"brigade@market" is Brigade itself/],
    [{ plugins: ["Brigade@other"] }, /"Brigade@other" is Brigade itself/],
    [{ skills: ["brigade:doc-sync"] }, /"brigade:doc-sync" is one of Brigade's own/],
    [{ plugins: ["figma"] }, /"figma" is not a plugin id/],
    [{ plugin: [] }, /unknown key\(s\) plugin; allowed: plugins, skills, flags/],
    [{ skills: "frontend-design" }, /skills must be a list of names/],
    ["{ not json", /is not JSON/],
  ]) {
    const home = trimHome(trim);
    assert.throws(() => readTrim(trimPath({}, home)), error, JSON.stringify(trim));
    rmSync(home, { recursive: true, force: true });
  }
  const home = trimHome({ plugins: ["figma@official"], skills: ["frontend-design"], flags: ["--strict-mcp-config", "--no-chrome"], note: "mine" });
  assert.deepEqual(readTrim(trimPath({}, home)), { plugins: ["figma@official"], skills: ["frontend-design"], flags: ["--strict-mcp-config", "--no-chrome"] });
  rmSync(home, { recursive: true, force: true });
});

test("trim writes no entry for a plugin the project enables, its own skills, or what phaseRun.keep names", () => {
  const root = mkdtempSync(join(tmpdir(), "phase-trim-root-"));
  mkdirSync(join(root, ".claude", "skills", "release-notes"), { recursive: true });
  writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "vercel@official": true, "figma@official": false } }));
  const trim = {
    plugins: ["vercel@official", "figma@official", "slack@official", "notion@official"],
    skills: ["release-notes", "frontend-design", "vercel:nextjs", "slack:post", "dataviz", "pdf"],
    flags: ["--strict-mcp-config"],
  };
  const keep = runConfig({ keep: { plugins: ["notion@official"], skills: ["dataviz"] } }).keep;
  const settings = trimmedSettings({ enabledPlugins: { "mine@local": true } }, trim, root, keep);
  // vercel is the project's own (and so are its skills); figma is set false there, not enabled, so trim may still write it.
  assert.deepEqual(settings.enabledPlugins, { "mine@local": true, "figma@official": false, "slack@official": false });
  assert.deepEqual(settings.skillOverrides, { "frontend-design": "off", "slack:post": "off", pdf: "off" });
  // A kept plugin skill keeps its plugin: a skill whose plugin is off is gone too.
  const withSkill = trimmedSettings({}, { plugins: ["figma@official"], skills: [], flags: [] }, root, { plugins: [], skills: ["figma:figma-use"] });
  assert.equal(withSkill.enabledPlugins, undefined);
  rmSync(root, { recursive: true, force: true });
});

test("the project's settings are read through a BOM; one that isn't JSON trims nothing rather than everything", () => {
  const root = mkdtempSync(join(tmpdir(), "phase-trim-root-"));
  mkdirSync(join(root, ".claude"), { recursive: true });
  const trim = { plugins: ["vercel@official", "figma@official"], skills: [], flags: [] };
  writeFileSync(join(root, ".claude", "settings.json"), `\uFEFF${JSON.stringify({ enabledPlugins: { "vercel@official": true } })}`);
  assert.deepEqual(trimmedSettings({}, trim, root, { plugins: [], skills: [] }).enabledPlugins, { "figma@official": false });
  writeFileSync(join(root, ".claude", "settings.json"), "{ broken");
  assert.deepEqual(trimmedSettings({ env: {} }, trim, root, { plugins: [], skills: [] }), { env: {} });
  rmSync(root, { recursive: true, force: true });
});

test("a night ticket's merged settings keep the run's rules, variables and Edit denials beside trim's entries", () => {
  const root = mkdtempSync(join(tmpdir(), "phase-trim-root-"));
  const env = runVariables({ ticket: 7, base: "abc", spec: 5, runner: "/repo/.phase-run/phase-2/runner", root: "/repo" });
  const base = { permissions: { allow: ["Bash(git *)"], deny: ["Read(./.env)"] } };
  const plain = sessionSettings(base, { allow: [], deny: [] }, { branch: "phase-2", env, background: true, prompt: null });
  const merged = trimmedSettings(plain, { plugins: ["figma@official"], skills: ["pdf"], flags: [] }, root, { plugins: [], skills: [] });
  assert.deepEqual(merged, { ...plain, enabledPlugins: { "figma@official": false }, skillOverrides: { pdf: "off" } });
  assert.equal(merged.env.PHASE_RUN_RUNNER, "/repo/.phase-run/phase-2/runner");
  assert.equal(merged.env.PHASE_RUN_ROOT, "/repo");
  for (const rule of ["Edit(./tools/phase-run/**)", "Edit(./.claude/workflow.json)", "Read(./.env)"]) assert.ok(merged.permissions.deny.includes(rule), rule);
  rmSync(root, { recursive: true, force: true });
});

// D8, D14 (#25): one run, one Brigade version. Night settings defer Brigade's auto-update, and a
// version change between tickets stops the run.
function settingsRoot(settings) {
  const root = mkdtempSync(join(tmpdir(), "phase-brigade-root-"));
  if (settings !== undefined) {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  }
  return root;
}

const CATALOG_SOURCE = { source: "github", repo: "owner/brigade" };

test("a night ticket's settings switch Brigade's auto-update off, keeping the catalog's source, for the catalog the project enables", () => {
  const root = settingsRoot({
    enabledPlugins: { "brigade@fork-market": true, "vercel@official": true },
    extraKnownMarketplaces: { "fork-market": { source: CATALOG_SOURCE, autoUpdate: true }, official: { source: { source: "github", repo: "o/o" } } },
  });
  const brigade = brigadeCatalog(root);
  assert.deepEqual(brigade, { catalog: "fork-market", entry: { source: CATALOG_SOURCE, autoUpdate: true } }, "the catalog is the project's own, never a literal");
  const env = runVariables({ ticket: 7, base: "abc", spec: 5, runner: "/repo/.phase-run/phase-2/runner", root: "/repo" });
  const base = { permissions: { allow: ["Bash(git *)"], deny: [] } };
  const plain = sessionSettings(base, { allow: [], deny: [] }, { branch: "phase-2", env, background: true, prompt: null });
  const night = sessionSettings(base, { allow: [], deny: [] }, { branch: "phase-2", env, background: true, prompt: null, catalog: brigade });
  assert.deepEqual(night, { ...plain, extraKnownMarketplaces: { "fork-market": { source: CATALOG_SOURCE, autoUpdate: false } } });
  // Trim's entries sit beside the override.
  const trimmed = trimmedSettings(night, { plugins: ["figma@official"], skills: [], flags: [] }, root, { plugins: [], skills: [] });
  assert.deepEqual(trimmed.extraKnownMarketplaces, night.extraKnownMarketplaces);
  assert.deepEqual(trimmed.enabledPlugins, { "figma@official": false });
  rmSync(root, { recursive: true, force: true });
});

test("with no brigade@… entry, no catalog entry or no readable settings, nothing is written and the report says why", () => {
  for (const [settings, why] of [
    [undefined, /has no \.claude\/settings\.json/],
    [{ enabledPlugins: { "vercel@official": true } }, /no brigade@… entry in enabledPlugins/],
    [{ enabledPlugins: { "brigade@market": true } }, /no extraKnownMarketplaces entry for "market"/],
    ["{ broken", /is not JSON/],
  ]) {
    const root = settingsRoot(settings);
    const brigade = brigadeCatalog(root);
    assert.equal(brigade.catalog, null, JSON.stringify(settings));
    assert.match(brigade.why, why);
    const night = sessionSettings({}, { allow: [], deny: [] }, { branch: "phase-2", env: {}, background: true, prompt: null, catalog: brigade });
    assert.equal("extraKnownMarketplaces" in night, false);
    const run = { ...tempRun(), brigade: "0.6.0", catalog: brigade };
    assert.match(report(run, options, []), /Brigade's auto-update was not switched off for this run: /);
    rmSync(root, { recursive: true, force: true });
  }
  // Read through a BOM, as trim's reader is; an entry that is on wins over one that is off.
  const root = settingsRoot(`\uFEFF${JSON.stringify({ enabledPlugins: { "brigade@old": false, "brigade@market": true }, extraKnownMarketplaces: { market: { source: CATALOG_SOURCE } } })}`);
  assert.equal(brigadeCatalog(root).catalog, "market");
  rmSync(root, { recursive: true, force: true });
});

const pluginRows = [
  { id: "brigade@market", version: "0.5.2", scope: "project", projectPath: "D:\\HGP\\other", projectEnabled: true },
  { id: "brigade@market", version: "0.6.0", scope: "project", projectPath: "D:\\HGP\\Brigade", projectEnabled: true },
  { id: "brigade@market", version: "0.4.0", scope: "user" },
  { id: "vercel@official", version: "9.9.9", scope: "project", projectPath: "D:\\HGP\\Brigade" },
];

test("the installed version is the brigade@… row for this repo, compared case-blind on Windows, else the user-scope row", () => {
  assert.equal(installedBrigade(pluginRows, "d:/hgp/brigade/", { platform: "win32" }), "0.6.0");
  assert.equal(installedBrigade(pluginRows, "D:\\HGP\\brigade", { platform: "linux" }), "0.4.0", "off Windows a path's case counts: no project row, so the user row");
  assert.equal(installedBrigade(pluginRows, "D:\\HGP\\Brigade", { platform: "linux" }), "0.6.0");
  assert.equal(installedBrigade(pluginRows, "D:/HGP/elsewhere", { platform: "win32" }), "0.4.0");
  assert.equal(installedBrigade(pluginRows.filter((row) => row.scope !== "user"), "D:/HGP/elsewhere", { platform: "win32" }), null, "no matching row: not installed for this repo");
  assert.deepEqual(parsePluginList(JSON.stringify(pluginRows)), pluginRows);
  assert.deepEqual(parsePluginList(JSON.stringify({ plugins: pluginRows })), pluginRows);
  assert.throws(() => parsePluginList("Plugins:\n  brigade 0.6.0"), /isn't JSON: "Plugins:/);
  assert.throws(() => parsePluginList('{"installed": {}}'), /a shape the runner can't read/);
  // Through the runner's exec: a failing command throws, naming its output.
  const exec = (stdout, ok = true) => (command, args) => (assert.deepEqual([command, ...args], ["claude", "plugin", "list", "--json"]), { ok, stdout, stderr: ok ? "" : "unknown command" });
  assert.equal(readInstalledBrigade("/nowhere", exec(JSON.stringify(pluginRows))), "0.4.0");
  assert.throws(() => readInstalledBrigade("/nowhere", exec("", false)), /failed: "unknown command"/);
});

test("a version change before a ticket stops the run, and so does a version that can't be read", () => {
  assert.equal(versionStop("0.6.0", () => "0.6.0"), null);
  assert.equal(versionStop("0.6.0", () => "0.6.1"), "Brigade updated mid-run (0.6.0 → 0.6.1), rerun.");
  assert.equal(versionStop("0.6.0", () => null), "Brigade updated mid-run (0.6.0 → not installed), rerun.");
  assert.match(versionStop("0.6.0", () => { throw new Error("spawn claude ENOENT"); }), /could not be read \(spawn claude ENOENT\)/);
  const run = { ...tempRun(), brigade: "0.6.0", stopped: versionStop("0.6.0", () => "0.6.1") };
  assert.match(report(run, options, []), /The run stopped early\.\*\* Brigade updated mid-run \(0\.6\.0 → 0\.6\.1\), rerun\./);
});

test("the morning report's header names the Brigade version that judged the run, and the stamp when it differs", () => {
  const header = (run) => report({ ...tempRun(), ...run }, options, []).split("\n").slice(0, 3).join("\n");
  assert.match(header({ brigade: "0.6.0", stamp: "0.6.0" }), /UTC · Brigade 0\.6\.0 · built 0/);
  const text = report({ ...tempRun(), brigade: "0.6.0", stamp: "0.5.2", catalog: { catalog: "market", entry: {} } }, options, []);
  assert.match(text, /This project's runner is stamped 0\.5\.2; Brigade 0\.6\.0 judged the run/);
  assert.doesNotMatch(text, /auto-update was not switched off/);
});

test("a restart is refused when another Brigade version is installed than the copy was taken under", () => {
  const { take, runDir } = snapshotProject();
  take("run-1");
  assert.equal(take("run-2", AT, "0.6.0").reused, true);
  assert.throws(() => take("run-3", AT, "0.6.1"), (error) => {
    assert.match(error.message, /taken under Brigade 0\.6\.0, and 0\.6\.1 is installed now/);
    assert.ok(error.message.includes(join(runDir, "runner")), "it says which copy to delete for a fresh start");
    return true;
  });
  // A copy whose manifest has no version (taken before #25) has nothing to compare: it is reused.
  const manifest = readManifest(join(runDir, "runner"));
  delete manifest.brigade;
  writeFileSync(join(runDir, "runner", "manifest.json"), JSON.stringify(manifest));
  assert.equal(take("run-4", AT, "0.6.1").reused, true);
});

test("trim's flags go on a session's first launch; a -p resume passes them again, a background resume passes no flag", () => {
  const flags = ["--strict-mcp-config", "--no-chrome"];
  const options = { permissionMode: "dontAsk", model: "opus" };
  const first = printArgs({ sessionId: "s-1", resume: false, options, settings: "settings-7.json", flags });
  const again = printArgs({ sessionId: "s-1", resume: true, options, settings: "settings-7.json", flags });
  for (const args of [first, again]) assert.deepEqual(args.slice(-2), flags);
  assert.ok(again.includes("--resume"));
  assert.deepEqual(printArgs({ sessionId: "s-1", resume: false, options, settings: "s.json" }).slice(-2), ["--model", "opus"]);
  const launch = backgroundArgs({ name: "ticket-7", options, settings: "settings-7.json", ask: "Read the file", flags });
  assert.deepEqual(launch, ["--bg", "--name", "ticket-7", "--permission-mode", "dontAsk", "--settings", "settings-7.json", "--model", "opus", ...flags, "Read the file"]);
  // Point 5: a resume with any flag quietly starts a copy, so it carries the id and the ask only.
  assert.deepEqual(backgroundArgs({ sessionId: "abcd1234-full", resume: true, name: "ticket-7", options, settings: "s.json", ask: "Read the file", flags }), ["--bg", "--resume", "abcd1234-full", "Read the file"]);
});

test("only the runner reads trim: no hook or setup script imports trim.mjs, so attended sessions get no trim", () => {
  const plugin = join(HERE, "..", "..", "..");
  if (!existsSync(join(plugin, "hooks", "hooks.json"))) return; // a project's copy of the runner, with no plugin around it
  const readers = ["hooks", "scripts"].flatMap((folder) =>
    readdirSync(join(plugin, folder), { recursive: true })
      .filter((name) => String(name).endsWith(".mjs") && !String(name).includes("fixtures"))
      .map((name) => join(plugin, folder, String(name))),
  );
  assert.ok(readers.length > 0);
  for (const file of readers) assert.doesNotMatch(readFileSync(file, "utf8"), /trim\.mjs/, file);
});

test("the session is told to run its check command from the copy", () => {
  const project = runConfig({}, { stopGate: { checks: [{ label: "Tests", run: "npm test", receipt: true }] } });
  const values = promptValues(project, "", { ...ticketValues, RUNNER: ".phase-run/phase-2/runner" });
  const command = "`node .phase-run/phase-2/runner/tools/phase-run/stop-tests.mjs`";
  assert.equal(values.STOP_CHECKS, `${command} (the tests)`);
  assert.ok(values.RECEIPT.includes(`Run the tests through ${command}`), values.RECEIPT);
});

test("a browserCheck with no place in the gates runs after the project's gates", () => {
  const check = { screenFiles: "^src/", sourceFiles: "^src/", screenshots: "shots/{N}", minimum: 2, redo: "walk it" };
  const config = runConfig({ gates: [{ label: "lint", run: "lint" }], browserCheck: check });
  assert.deepEqual(config.gates.map((g) => g.label ?? g.builtin), ["lint", BROWSER_CHECK]);
  const placed = runConfig({ gates: [{ builtin: "browser-check" }, { label: "lint", run: "lint" }], browserCheck: check });
  assert.deepEqual(placed.gates.map((g) => g.label ?? g.builtin), [BROWSER_CHECK, "lint"]);
});

// ADR 0003, ADR 0004: a session can forge a receipt, so no gate may read one. The runner is what runs
// the gates; if anything it imports, however deep, reaches receipt.mjs, a gate could start trusting one.
test("no gate reads a receipt: the runner's imports never reach the receipt reader", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const reached = new Set();
  const visit = (file) => {
    if (reached.has(file)) return;
    reached.add(file);
    const source = readFileSync(file, "utf8");
    for (const [, a, b] of source.matchAll(/\bfrom\s*["'](\.{1,2}\/[^"']+)["']|\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) visit(join(dirname(file), a ?? b));
  };
  visit(join(here, "run.mjs"));
  assert.ok(reached.has(join(here, "config.mjs")) && reached.has(join(here, "snapshot.mjs")), "the walk follows the runner's imports");
  assert.equal(reached.has(join(here, "receipt.mjs")), false, [...reached].join("\n"));
  for (const file of reached) assert.doesNotMatch(readFileSync(file, "utf8"), /\breadReceipt\b|receipt\.mjs["']/, file);
});

// ADR 0005, found in #24's review: a night's settings and prompts are rules too. Read live, a shell
// write to tools/phase-run/ mid-night would change what later tickets may do and are told.
test("a night reads its base settings and its prompts from the run's copy, never the live runner", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const copy = join(mkdtempSync(join(tmpdir(), "brigade-copy-")), "runner");
  for (const name of ["settings.json", "ticket-prompt.md", "fix-prompt.md"]) {
    assert.equal(runnerFile(copy, name), join(copy, "tools", "phase-run", name));
    assert.equal(runnerFile(null, name), join(here, name), "no run copy (a dry run): the runner's own folder");
  }
  const source = readFileSync(join(here, "run.mjs"), "utf8");
  assert.doesNotMatch(source, /join\(HERE, "(settings\.json|ticket-prompt\.md|fix-prompt\.md)"\)/, "every read goes through runnerFile");
});

// ------------------------------------------------------------------- the lane (#33)

const refusal = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.message;
  }
  assert.fail("expected a refusal");
};

const MAKE_TOOL = `node -e "const fs=require('fs');fs.mkdirSync('node_modules/.bin',{recursive:true});fs.writeFileSync('node_modules/.bin/tool','')"`;
const LANES = {
  qa: { name: "app_qa", url: "postgresql://qa:pw@localhost:5432/app_qa?schema=public" },
  lanes: {
    rows: [
      { id: 1, takes: "any", worktree: "../app-lanes/lane-1" },
      { id: 2, takes: "walk", worktree: "../app-lanes/lane-2", qa: "app_qa_2", ports: [{ port: 4402, what: "its QA server", name: "qa" }, { port: 4403, what: "its mail catcher" }], testDbPrefix: "lane2_", env: { CACHE_DB: "2" } },
    ],
    worktreeSetup: { copy: [".env"], commands: [MAKE_TOOL], leaves: ["node_modules/.bin/tool"] },
  },
};

/** A throwaway repo at `<parent>/app` with a phase branch, an ignored `.env` and the lane rows above. */
function laneProject(phaseRun = LANES) {
  const parent = mkdtempSync(join(tmpdir(), "phase-run-lane-"));
  const root = join(parent, "app");
  mkdirSync(root);
  const git = (cwd, ...args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const put = (dir, files) => {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
  };
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  put(root, { ".gitignore": ".env\nnode_modules/\n.phase-run/\ngenerated/\n", "README.md": "# app\n" });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "start");
  git(root, "branch", "phase-x");
  put(root, { ".env": "SECRET=primary\n" });
  const config = runConfig(phaseRun);
  const lane = laneRow(config, "2");
  const roots = laneRoots({ root, branch: "phase-x", lane });
  const shell = (command, cwd) => {
    const result = spawnSync(command, { cwd, shell: true, encoding: "utf8" });
    return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
  };
  const start = () => {
    const made = prepareWorktree({ root, tree: roots.tree, branch: "phase-x", ownBranch: roots.branch });
    setupWorktree({ root, tree: roots.tree, setup: config.lanes.worktreeSetup, shell });
    return made;
  };
  return { parent, root, git, put, config, lane, roots, shell, start };
}

test("--lane 2 makes the worktree at the row's path on its own branch, and runs worktreeSetup there", () => {
  const { parent, root, git, roots, start } = laneProject();
  assert.equal(roots.tree, join(parent, "app-lanes", "lane-2"), "the row's path, from the primary checkout");
  assert.equal(roots.branch, "phase-x-lane-2", "a phase-* branch: the guard lets a session commit only on one");
  const made = start();
  assert.equal(made.reused, false);
  assert.equal(git(roots.tree, "branch", "--show-current"), "phase-x-lane-2");
  assert.equal(git(roots.tree, "rev-parse", "HEAD"), git(root, "rev-parse", "phase-x"), "cut from the phase branch's tip");
  assert.equal(readFileSync(join(roots.tree, ".env"), "utf8"), "SECRET=primary\n", "copy brought the untracked file in");
  assert.ok(existsSync(join(roots.tree, "node_modules/.bin/tool")), "the commands ran in the worktree");
  assert.equal(existsSync(join(root, "node_modules")), false, "and never in the primary checkout");
});

test("the lane refuses to start when a leaves file is missing, or a copy file or a command fails, naming it", () => {
  const leaves = laneProject({ ...LANES, lanes: { ...LANES.lanes, worktreeSetup: { ...LANES.lanes.worktreeSetup, leaves: ["node_modules/.bin/tool", "generated/client.mjs"] } } });
  const missing = refusal(leaves.start);
  assert.match(missing, /worktreeSetup\.leaves: generated\/client\.mjs is missing/);
  assert.doesNotMatch(missing, /node_modules\/\.bin\/tool/, "only the missing one is named");

  const copy = laneProject({ ...LANES, lanes: { ...LANES.lanes, worktreeSetup: { copy: [".env", ".claude/settings.local.json"] } } });
  assert.match(refusal(copy.start), /worktreeSetup\.copy names \.claude\/settings\.local\.json, which the primary checkout/);

  const command = laneProject({ ...LANES, lanes: { ...LANES.lanes, worktreeSetup: { commands: ['node -e "process.exit(3)"'] } } });
  assert.match(refusal(command.start), /worktreeSetup\.commands: `node -e "process\.exit\(3\)"` failed/);
});

test("a second start reuses the worktree, reset to the phase branch's tip, its install kept", () => {
  const { root, git, put, roots, start } = laneProject();
  start();
  put(roots.tree, { "README.md": "an edit a dead session left\n", "stray.txt": "an untracked file\n" });
  put(root, { "later.md": "landed by the other lane\n" });
  git(root, "add", "later.md");
  git(root, "commit", "-q", "-m", "later");
  git(root, "branch", "-f", "phase-x", "HEAD");
  const again = start();
  assert.equal(again.reused, true);
  assert.equal(git(roots.tree, "rev-parse", "HEAD"), git(root, "rev-parse", "phase-x"), "at the new tip");
  assert.equal(git(roots.tree, "status", "--porcelain"), "", "the edit and the stray file are gone");
  assert.ok(existsSync(join(roots.tree, "later.md")));
  assert.ok(existsSync(join(roots.tree, "node_modules/.bin/tool")), "ignored files (an install) are kept");
  // A worktree folder deleted by hand is still registered with git: it is pruned and made again.
  rmSync(roots.tree, { recursive: true, force: true });
  const remade = start();
  assert.equal(remade.reused, false);
  assert.equal(git(roots.tree, "rev-parse", "HEAD"), git(root, "rev-parse", "phase-x"));
});

test("a passing ticket's commit stays on the lane's branch: the phase branch doesn't move, nothing is pushed or migrated", () => {
  const { root, git, put, roots, start } = laneProject();
  start();
  const tip = git(root, "rev-parse", "phase-x");
  put(roots.tree, { "feature.md": "the ticket\n" });
  git(roots.tree, "add", "feature.md");
  git(roots.tree, "commit", "-q", "-m", "feat: the ticket — Closes #7");
  assert.equal(git(root, "rev-parse", "phase-x"), tip, "the phase branch is where it was");
  assert.match(git(root, "log", "-1", "--format=%s", "phase-x-lane-2"), /Closes #7/);
  assert.deepEqual(afterPass(laneRow(runConfig(LANES), "2")), { push: false, migrate: false }, "Landing pushes and migrates (ADR 0008)");
  assert.deepEqual(afterPass(null), { push: true, migrate: true }, "a run without --lane, as before");
  // The gates and finishBuilt call git and gh, so the seam is pinned in the source, as docCheck's is.
  const source = readFileSync(join(HERE, "run.mjs"), "utf8").replace(/\r\n/g, "\n"); // a Windows checkout may have CRLF
  const body = (name) => source.slice(source.indexOf(`async function ${name}(`), source.indexOf("\n}\n", source.indexOf(`async function ${name}(`)));
  assert.match(body("runGates"), /if \(!afterPass\(lane\)\.migrate\) \{[\s\S]*?return \{ ok: true, fingerprint \};/, "the migration is skipped before it is applied");
  assert.match(body("finishBuilt"), /const pushing = afterPass\(lane\)\.push;[\s\S]*const push = pushing \? gitTry\("push"/, "the push waits on afterPass");
  // A restart would reset over it: it is refused, naming the commit, until Landing lands it.
  assert.match(refusal(start), /phase-x-lane-2 holds commits phase-x does not have[\s\S]*feat: the ticket — Closes #7/);
});

test("a folder at the row's path that is not one of the repo's worktrees is refused, never reused", () => {
  const { put, roots, start } = laneProject();
  put(roots.tree, { "notes.txt": "someone's folder\n" });
  assert.match(refusal(start), /exists and is not one of this repo's worktrees/);
});

test("a tracked script that imports an ignored file is refused at start, naming both", () => {
  const { root, git, put } = laneProject();
  put(root, {
    "scripts/seed.mjs": 'import { client } from "../generated/client.mjs";\nconst x = await import("./local-only.mjs");\n',
    "src/app.ts": 'import { helper } from "./helper.js";\nimport "./styles";\nconst cfg = require("./missing-and-not-ignored");\n',
    "src/helper.ts": "export const helper = 1;\n",
    "src/styles.ts": "export {};\n",
    "scripts/local-only.mjs": "export {};\n",
    "generated/client.mjs": "export const client = 1;\n",
  });
  put(root, { ".gitignore": ".env\nnode_modules/\n.phase-run/\ngenerated/\nscripts/local-only.mjs\n" });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "scripts");
  const found = ignoredImports(root);
  assert.deepEqual(found, [
    { script: "scripts/seed.mjs", imports: "generated/client.mjs" },
    { script: "scripts/seed.mjs", imports: "scripts/local-only.mjs" },
  ]);
  const problem = ignoredImportsProblem(found);
  assert.match(problem, /scripts\/seed\.mjs imports generated\/client\.mjs/);
  assert.match(problem, /scripts\/seed\.mjs imports scripts\/local-only\.mjs/);
  // A file worktreeSetup accounts for (made by a command and checked in leaves, or copied in) passes.
  assert.deepEqual(ignoredImports(root, ["generated", "scripts/local-only.mjs"]), []);
  assert.equal(ignoredImportsProblem([]), null);
});

test("each of the lane's ports is checked free at start, and only the lane's", async () => {
  const lane = laneRow(runConfig(LANES), "2");
  const busy = async (port) => port === 4403;
  assert.deepEqual(await lanePortProblems(lane, busy), ["Something is listening on :4403 (its mail catcher, lane 2). Stop it before the lane starts."]);
  assert.deepEqual(await lanePortProblems(lane, async () => false), []);
});

test("a lane started without --branch on a detached checkout joins the branch a live lane's lock names", () => {
  const state = mkdtempSync(join(tmpdir(), "phase-run-locks-"));
  const alive = (pid) => pid !== 999;
  assert.equal(joinBranch(state, alive), null, "no live lane: nothing to join");
  writeLaneLock(state, { id: 1, pid: 101, branch: "phase-x", at: AT });
  writeLaneLock(state, { id: 3, pid: 999, branch: "phase-old", at: AT }); // its process died
  assert.equal(laneLockPath(state, 1), join(state, "lane-1.lock"), "under .phase-run/ itself, found before the branch is known");
  assert.equal(joinBranch(state, alive), "phase-x");
  assert.deepEqual(liveLanes(state, alive).map((lock) => [lock.lane, lock.branch]), [["1", "phase-x"]]);
  writeLaneLock(state, { id: 2, pid: 102, branch: "phase-y", at: AT });
  assert.match(refusal(() => joinBranch(state, alive)), /two branches \(phase-x, phase-y\)/);
});

test("both lanes share one runner copy: the second reuses the first's, and is refused when the live runner differs", () => {
  const { root, put, take } = snapshotProject();
  const lane = (id, worktree) => laneRoots({ root, branch: "phase-x", lane: { id, worktree } });
  const one = lane(1, "../lanes/lane-1");
  const two = lane(2, "../lanes/lane-2");
  assert.equal(one.copyDir, two.copyDir, "one folder per branch");
  assert.notEqual(one.runDir, two.runDir);
  assert.equal(two.runDir, join(root, ".phase-run", "phase-x", "lane-2"), "results in the primary checkout's lane-<id>/");
  const first = takeSnapshot({ root, runDir: one.copyDir, runId: "lane-1", commit: "abc", at: AT, brigade: "0.6.0" });
  const second = takeSnapshot({ root, runDir: two.copyDir, runId: "lane-2", commit: "abc", at: AT + 60_000, brigade: "0.6.0" });
  assert.deepEqual([second.reused, second.dir, second.manifest.runId], [true, first.dir, "lane-1"]);
  put("tools/phase-run/run.mjs", "// changed after lane 1 started\n");
  assert.match(refusal(() => take("lane-2")), /tools\/phase-run\/run\.mjs/);
  // The copy is marked finished only by the last lane out, or the other's night is judged by a fresh one.
  const state = mkdtempSync(join(tmpdir(), "phase-run-locks-"));
  writeLaneLock(state, { id: 1, pid: 101, branch: "phase-x", at: AT });
  writeLaneLock(state, { id: 2, pid: 102, branch: "phase-x", at: AT });
  assert.equal(mayFinishCopy(state, { id: 2, branch: "phase-x" }, () => true), false, "lane 1 still runs");
  assert.equal(mayFinishCopy(state, { id: 2, branch: "phase-x" }, (pid) => pid !== 101), true, "lane 1 is gone");
});

test("a lane session's env holds the lane's PHASE_RUN_* values and its row's env; its root is the worktree", () => {
  const config = runConfig(LANES);
  const lane = laneRow(config, "2");
  const roots = laneRoots({ root: "/repo", branch: "phase-x", lane });
  const env = runVariables({ ticket: 7, base: "abc", spec: 5, runner: "/repo/.phase-run/phase-x/runner", root: roots.tree, lane: laneValues(lane, config) });
  assert.deepEqual(env, {
    CACHE_DB: "2",
    PHASE_RUN: "1",
    PHASE_RUN_TICKET: "7",
    PHASE_RUN_BASE: "abc",
    PHASE_RUN_SPEC: "5",
    PHASE_RUN_RUNNER: "/repo/.phase-run/phase-x/runner",
    PHASE_RUN_ROOT: resolve("/repo", "../app-lanes/lane-2"),
    PHASE_RUN_LANE: "2",
    PHASE_RUN_QA_PORT: "4402",
    PHASE_RUN_QA_DATABASE: "app_qa_2",
    PHASE_RUN_TEST_DB_PREFIX: "lane2_",
  });
  assert.equal("PHASE_RUN_FAKE_NOW" in env, false, "reserved, set by no runner code");
  // Lane 1's row has no qa port and no prefix: its database is qa.name's, and the project's own test names apply.
  const one = runVariables({ ticket: 7, base: "abc", spec: null, runner: "r", root: "/w", lane: laneValues(laneRow(config, "1"), config) });
  assert.deepEqual([one.PHASE_RUN_LANE, one.PHASE_RUN_QA_DATABASE, "PHASE_RUN_QA_PORT" in one, "PHASE_RUN_TEST_DB_PREFIX" in one], ["1", "app_qa", false, false]);
  // A row's env never names a runner variable.
  const reserved = { ...LANES, lanes: { rows: [{ id: 2, takes: "any", worktree: "../w", env: { PHASE_RUN_ROOT: "/elsewhere" } }] } };
  assert.match(refusal(() => runConfig(reserved)), /env names PHASE_RUN_ROOT: PHASE_RUN_\* names are the runner's own/);
});

test("the lane's QA url takes its database, by the loader's rule; a url with no place for it is refused", () => {
  const config = runConfig({ ...LANES, sessionEnv: { DATABASE_URL: "{qaUrl}" } });
  const lookup = () => undefined;
  const two = laneRow(config, "2");
  assert.equal(laneQaUrl(config, two, lookup), "postgresql://qa:pw@localhost:5432/app_qa_2?schema=public", "the path's database, never the user name's text");
  assert.equal(laneQaUrl(config, laneRow(config, "1"), lookup), qaUrl(config, lookup), "lane 1 rides on qa.name");
  assert.equal(laneQaUrl(config, null, lookup), qaUrl(config, lookup), "a run without --lane, as before");
  assert.deepEqual(sessionEnv(config, lookup, two), { DATABASE_URL: "postgresql://qa:pw@localhost:5432/app_qa_2?schema=public" });
  assert.deepEqual(sessionEnv(config, lookup), { DATABASE_URL: qaUrl(config, lookup) });
  const odd = runConfig({ ...LANES, qa: { name: "app_qa", url: "postgresql://localhost:5432/other" } });
  assert.match(refusal(() => laneQaUrl(odd, laneRow(odd, "2"), lookup)), /does not end in phaseRun\.qa\.name "app_qa"/);
});

test("--lane names a row the config has; with no lanes section it is refused", () => {
  assert.match(refusal(() => laneRow(runConfig({}), "2")), /has no phaseRun\.lanes/);
  assert.match(refusal(() => laneRow(runConfig(LANES), "9")), /no lane "9" \(its lanes: 1, 2\)/);
});

test("a lane's settings also deny edits to the run's folder by its absolute path: the shared copy sits outside the worktree", () => {
  const runFolder = process.platform === "win32" ? "D:\\work\\app\\.phase-run\\phase-x" : "/work/app/.phase-run/phase-x";
  const rule = process.platform === "win32" ? "Edit(//d/work/app/.phase-run/phase-x/**)" : "Edit(//work/app/.phase-run/phase-x/**)";
  const lane = sessionSettings({}, { allow: [], deny: [] }, { branch: "phase-x", env: {}, background: true, prompt: null, runFolder });
  assert.ok(lane.permissions.deny.includes(rule), lane.permissions.deny.join("\n"));
  assert.ok(lane.permissions.deny.includes("Edit(./.phase-run/phase-x/**)"), "the worktree's own run folder too");
  const plain = sessionSettings({}, { allow: [], deny: [] }, { branch: "phase-x", env: {}, background: true, prompt: null });
  assert.deepEqual(plain.permissions.deny.filter((r) => r.startsWith("Edit(//")), [], "a run without --lane, as before");
});

test("in a lane the docs gate takes the number token for the implementation log's number", () => {
  assert.equal(implementationLogAdded("docs/history/implementation-log/019-the-worktree.md\n", null), true);
  assert.equal(implementationLogAdded("docs/history/implementation-log/NNN-the-worktree.md\n", null), false, "one lane: a number, as before");
  assert.equal(implementationLogAdded("docs/history/implementation-log/NNN-the-worktree.md\n", "NNN"), true);
  assert.equal(implementationLogAdded("docs/history/devlog.md\n", "NNN"), false);
});

// ---------------------------------------------------------- the claim and the frontier (#34)

/** A fake clock and pause: `pause(ms)` moves `now()` on, so a lock's wait runs out without waiting. */
const fakeClock = (start = 1_000) => {
  let t = start;
  return { now: () => t, pause: (ms) => (t += ms) };
};
/** A process check that answers from a set: a pid outside it is gone. */
const livePids = (...pids) => {
  const set = new Set(pids);
  return Object.assign((pid) => set.has(pid), { kill: (pid) => set.delete(pid) });
};
const claimDir = () => join(mkdtempSync(join(tmpdir(), "phase-run-claims-")), ".phase-run", "phase-x");
const firstFree = (numbers) => (claims) => numbers.find((n) => !claims.some((claim) => claim.ticket === n)) ?? null;
/** A ticket as loadTickets shapes it. */
const ticketOf = (number, { labels = ["run-ready"], blockers = [] } = {}) => ({ number, title: `t${number}`, state: "open", labels, blockers: blockers.map((n) => ({ number: n, state: "open" })) });
/** holdReason's order, with "built" a set: done, then not run-ready, then the first unbuilt blocker. */
const holdFrom = (built) => (ticket) => (built.has(ticket.number) ? "done" : !ticket.labels.includes("run-ready") ? "not labelled run-ready" : (ticket.blockers.find((b) => !built.has(b.number)) ? `waiting on #${ticket.blockers.find((b) => !built.has(b.number)).number}` : null));

async function until(check, what, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

/** Two real processes take a claim at the same moment: each starts, waits for "go", takes, reports, and lives until "end", so its claim stays live. */
async function claimAtOnce(dir, tickets) {
  const sync = mkdtempSync(join(tmpdir(), "phase-run-race-"));
  const at = (name) => join(sync, name);
  const script = (i) =>
    [
      `import { takeClaim } from ${JSON.stringify(pathToFileURL(join(HERE, "claim.mjs")).href)};`,
      `import { existsSync, writeFileSync } from "node:fs";`,
      `const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);`,
      `writeFileSync(${JSON.stringify(at(`ready-${i}`))}, "");`,
      `while (!existsSync(${JSON.stringify(at("go"))})) pause(2);`,
      `const tickets = ${JSON.stringify(tickets)};`,
      `const { ticket } = takeClaim({ dir: ${JSON.stringify(dir)}, lane: "${i}", at: 0, choose: (claims) => tickets.find((n) => !claims.some((c) => c.ticket === n)) ?? null });`,
      `writeFileSync(${JSON.stringify(at(`result-${i}`))}, JSON.stringify(ticket));`,
      `while (!existsSync(${JSON.stringify(at("end"))})) pause(5);`,
    ].join("\n");
  const children = [1, 2].map((i) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script(i)], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    return { child, exited: new Promise((done) => child.on("close", (code) => done({ code, stderr }))) };
  });
  try {
    await until(() => existsSync(at("ready-1")) && existsSync(at("ready-2")), "both lanes to start");
    writeFileSync(at("go"), "");
    await until(() => existsSync(at("result-1")) && existsSync(at("result-2")), "both claims");
    return [1, 2].map((i) => JSON.parse(readFileSync(at(`result-${i}`), "utf8")));
  } finally {
    writeFileSync(at("end"), "");
    for (const { exited } of children) {
      const { code, stderr } = await exited;
      assert.equal(code, 0, stderr);
    }
  }
}

test("two lanes claiming at once: exactly one wins a ticket, and the other takes another, or none", { timeout: 60_000 }, async () => {
  const two = await claimAtOnce(claimDir(), [5, 6]);
  assert.deepEqual([...two].sort(), [5, 6], `each ticket claimed once (got ${JSON.stringify(two)})`);
  const one = await claimAtOnce(claimDir(), [5]);
  assert.deepEqual([...one].sort(), [5, null], `one lane wins #5, the other gets nothing (got ${JSON.stringify(one)})`);
});

test("the claim file sits in the primary checkout's branch folder, and a take writes the lane, its pid and the clock's time", () => {
  const roots = laneRoots({ root: join(tmpdir(), "app"), branch: "phase-x", lane: { id: "2", worktree: "../app-lanes/lane-2" } });
  assert.equal(claimsPath(roots.copyDir), join(tmpdir(), "app", ".phase-run", "phase-x", "claims.json"), "shared by both lanes (ADR 0007), never the worktree");
  const dir = claimDir();
  const { now } = fakeClock(Date.UTC(2026, 10, 10, 1, 2, 3));
  const taken = takeClaim({ dir, lane: "2", pid: 222, at: now(), alive: livePids(222), choose: firstFree([5]) });
  assert.equal(taken.ticket, 5);
  assert.deepEqual(readClaims(dir), [{ ticket: 5, lane: "2", pid: 222, at: "2026-11-10T01:02:03.000Z" }]);
  assert.equal(existsSync(join(dir, CLAIMS_LOCK)), false, "the lock is gone once the take is done");
  const none = takeClaim({ dir, lane: "2", pid: 222, at: now(), alive: livePids(222), choose: () => null });
  assert.equal(none.ticket, null);
  assert.equal(readClaims(dir).length, 1, "choosing nothing claims nothing and keeps the live claims");
});

test("a claim held by a process that is gone lapses, and the ticket can be claimed again", () => {
  const dir = claimDir();
  const alive = livePids(111, 222);
  assert.equal(takeClaim({ dir, lane: "1", pid: 111, at: 0, alive, choose: firstFree([5]) }).ticket, 5);
  assert.equal(takeClaim({ dir, lane: "2", pid: 222, at: 0, alive, choose: firstFree([5]) }).ticket, null, "held while lane 1 lives");
  alive.kill(111);
  const again = takeClaim({ dir, lane: "2", pid: 222, at: 0, alive, choose: firstFree([5]) });
  assert.equal(again.ticket, 5, "lane 1 died: its claim lapsed");
  assert.deepEqual(readClaims(dir).map(({ ticket, lane }) => ({ ticket, lane })), [{ ticket: 5, lane: "2" }], "the lapsed claim is dropped from the file");
  assert.deepEqual(liveClaims(readClaims(dir), livePids()), [], "and a claim lapses for every reader, not only on a take");
});

test("the claim file changes only under the lock: a dead holder's lock is broken, a live holder's is waited on and then refused", () => {
  const dir = claimDir();
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, CLAIMS_LOCK);
  writeFileSync(lock, `${JSON.stringify({ pid: 333, token: "dead" })}\n`);
  const clock = fakeClock();
  assert.equal(withClaimLock(dir, () => "ran", { pid: 222, alive: livePids(222), ...clock }), "ran", "pid 333 is gone: its lock is broken");
  assert.equal(existsSync(lock), false);

  writeFileSync(lock, `${JSON.stringify({ pid: 333, token: "live" })}\n`);
  let ran = false;
  const message = refusal(() => withClaimLock(dir, () => (ran = true), { pid: 222, alive: livePids(222, 333), ...fakeClock(), waitMs: 1_000 }));
  assert.equal(ran, false, "nothing runs without the lock");
  assert.match(message, /claims\.lock/, "the refusal names the lock");
  assert.match(message, /333/, "and its holder");
  assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "live", "a live holder's lock is never broken");

  rmSync(lock);
  assert.throws(() => withClaimLock(dir, () => assert.fail("a failing take"), { pid: 222, alive: livePids(222), ...fakeClock() }));
  assert.equal(existsSync(lock), false, "released when the take throws");

  // A lock its maker died before writing is empty: waited on for the grace, then broken, never spun on.
  writeFileSync(lock, "");
  let pauses = 0;
  const empty = fakeClock();
  assert.equal(withClaimLock(dir, () => "ran", { pid: 222, alive: livePids(222), now: empty.now, pause: (ms) => (pauses += 1, empty.pause(ms)) }), "ran");
  assert.equal(pauses, UNREADABLE_GRACE_MS / 50, "it paused until the grace ran out, then broke the lock");
  // A lock naming this very process is a leftover: a take never nests.
  writeFileSync(lock, `${JSON.stringify({ pid: 222, token: "old" })}\n`);
  assert.equal(withClaimLock(dir, () => "ran", { pid: 222, alive: livePids(222), ...fakeClock() }), "ran");
});

test("two lanes never wait on each other: a waiting lane is listed, and the other lane, looking next, stops", async () => {
  const dir = claimDir();
  const alive = livePids(111, 222);
  // Each lane holds a built, unlanded ticket (nothing releases a claim before #37), and each one's
  // next ticket waits on the other's: #6 (core) on lane 2's #7, #8 (walk) on lane 1's #5.
  const core = ["run-ready", "core"];
  const tickets = [ticketOf(5, { labels: core }), ticketOf(6, { labels: core, blockers: [7] }), ticketOf(7, { labels: ["run-ready", "walk"] }), ticketOf(8, { labels: ["run-ready", "walk"], blockers: [5] })];
  const byNumber = new Map(tickets.map((t) => [t.number, t]));
  takeClaim({ dir, lane: "1", pid: 111, at: 0, alive, choose: firstFree([5]) });
  takeClaim({ dir, lane: "2", pid: 222, at: 0, alive, choose: firstFree([7]) });
  const rows = { 1: { id: "1", takes: "core" }, 2: { id: "2", takes: "walk" } };
  const pids = { 1: 111, 2: 222 };
  const look = (self, sleep) =>
    claimNext({
      dir,
      lane: self,
      pid: pids[self],
      alive,
      now: () => 0,
      sleep,
      pollMs: 1,
      choose: (claims, idle) => laneChoice({ tickets, byNumber, hold: holdFrom(new Set()), done: () => false, takes: rows[self].takes, claims, self, idle, others: Object.values(rows).filter((row) => row.id !== self && alive(pids[row.id])) }),
    });
  let lane2 = null;
  const lane1 = await look("1", async () => {
    assert.deepEqual(JSON.parse(readFileSync(claimsPath(dir), "utf8")).waiting, [{ lane: "1", pid: 111 }], "lane 1 waits, and says so");
    lane2 = await look("2", async () => assert.fail("lane 2 never waits on a lane that is waiting"));
    alive.kill(222); // lane 2 stops and exits
  });
  assert.equal(lane2.ticket, null, "lane 2 stopped at once");
  assert.equal(lane1.ticket, null, "then lane 1, as no live lane can land #7");
  assert.deepEqual(JSON.parse(readFileSync(claimsPath(dir), "utf8")).waiting, [], "a lane that stops is no longer listed");
});

test("a ticket whose commit is on the phase branch is built; an unlanded one on a lane's branch is not, whichever worktree asks", () => {
  const { root, git, put, roots, start } = laneProject();
  start();
  put(roots.tree, { "feature.md": "the ticket\n" });
  git(roots.tree, "add", "feature.md");
  git(roots.tree, "commit", "-q", "-m", "feat: the ticket — Closes #7");
  const gitIn = (cwd) => (...args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
  };
  assert.equal(builtOn(gitIn(roots.tree), "HEAD", 7), true, "today's reading, HEAD, would count the lane's own unlanded pass");
  assert.equal(builtOn(gitIn(roots.tree), "phase-x", 7), false, "asked from the lane's worktree");
  assert.equal(builtOn(gitIn(root), "phase-x", 7), false, "asked from the primary checkout");
  git(root, "branch", "-f", "phase-x", "phase-x-lane-2"); // landed
  assert.equal(builtOn(gitIn(roots.tree), "phase-x", 7), true);
  assert.equal(builtOn(gitIn(root), "phase-x", 7), true);
  assert.equal(builtOn(gitIn(root), "phase-x", 70), false, "#7's commit never counts for #70");
});

test("a lane whose row takes a label never claims a ticket without it; a row that takes any claims any ready ticket", () => {
  const plain = ticketOf(5);
  const walk = ticketOf(6, { labels: ["run-ready", "walk"] });
  const tickets = [plain, walk];
  const byNumber = new Map(tickets.map((t) => [t.number, t]));
  const choose = (takes, claims = []) => laneChoice({ tickets, byNumber, hold: holdFrom(new Set()), done: () => false, takes, claims, self: "2" });
  assert.equal(takesTicket("walk", plain), false);
  assert.equal(takesTicket("any", plain), true);
  assert.equal(choose("walk").ticket.number, 6, "the walk lane passes over #5");
  assert.equal(choose("walk", [{ ticket: 6, lane: "1", pid: 1 }]).ticket, null, "and never falls back to it");
  assert.equal(choose("any").ticket.number, 5, "any: the first ready ticket, in order");
  assert.equal(choose("any", [{ ticket: 5, lane: "1", pid: 1 }]).ticket.number, 6, "a claimed ticket is passed over, a label ticket taken");
  assert.equal(laneChoice({ tickets: [ticketOf(8, { labels: ["walk"] })], byNumber, hold: holdFrom(new Set()), done: () => false, takes: "walk", claims: [], self: "2" }).ticket, null, "the label alone is not ready: run-ready still holds");
});

test("a lane with nothing ready waits while a live lane holds a claim that could unblock it, and stops when none can", async () => {
  const dir = claimDir();
  const alive = livePids(111, 222);
  // Lane 1 has #5. #7 (walk) waits on #6, which waits on #5: lane 1's #5 could unblock it.
  const tickets = [ticketOf(5), ticketOf(6, { blockers: [5] }), ticketOf(7, { labels: ["run-ready", "walk"], blockers: [6] }), ticketOf(9)];
  const byNumber = new Map(tickets.map((t) => [t.number, t]));
  assert.equal(takeClaim({ dir, lane: "1", pid: 111, at: 0, alive, choose: firstFree([5]) }).ticket, 5);
  const built = new Set();
  // The other lanes still running, as their rows: lane 1 takes any ticket while pid 111 lives.
  const lane1 = (takes = "any") => (alive(111) ? [{ id: "1", takes }] : []);
  const chooser = (others) => (claims) => laneChoice({ tickets, byNumber, hold: holdFrom(built), done: (b) => built.has(b.number), takes: "walk", claims, self: "2", others: others() });
  const lane2 = ({ dir: at = dir, sleep, waits = [], others = () => lane1() }) =>
    claimNext({ dir: at, lane: "2", pid: 222, alive, now: () => 0, sleep, pollMs: 30_000, onWait: (waitOn) => waits.push(waitOn.map((w) => `${w.lane}:#${w.ticket}${w.claimed ? "" : "?"}`).join(",")), choose: chooser(others) });

  // #5 lands, then #6 (which lane 1 may still take), while lane 2 waits: #7 is ready, and lane 2 claims it.
  const waits = [];
  let slept = 0;
  const landed = await lane2({
    waits,
    sleep: async (ms) => {
      assert.equal(ms, 30_000, "the injected pause, never a real one");
      slept += 1;
      if (slept === 1) built.add(5);
      if (slept === 2) built.add(6);
    },
  });
  assert.equal(landed.ticket, 7);
  assert.equal(slept, 2);
  assert.deepEqual(waits, ["1:#6?,1:#5", "1:#6?"], "#6, which lane 1 takes and may still land, and lane 1's claim on #5; then #6 alone");
  assert.ok(readClaims(dir).some((claim) => claim.ticket === 7 && claim.lane === "2"));

  // Lane 1 lives, but its claim is on #9 and it takes only "docs": nothing on #7's chain can land. It stops at once.
  const dir2 = claimDir();
  built.clear();
  takeClaim({ dir: dir2, lane: "1", pid: 111, at: 0, alive, choose: firstFree([9]) });
  const unrelated = await lane2({ dir: dir2, others: () => lane1("docs"), sleep: async () => assert.fail("never waits") });
  assert.equal(unrelated.ticket, null);

  // Lane 1 dies while lane 2 waits: its claim lapses, no live lane can land #5, and lane 2 stops.
  const dir3 = claimDir();
  takeClaim({ dir: dir3, lane: "1", pid: 111, at: 0, alive, choose: firstFree([5]) });
  let deaths = 0;
  const stopped = await lane2({ dir: dir3, sleep: async () => (deaths += 1, alive.kill(111)) });
  assert.equal(stopped.ticket, null);
  assert.equal(deaths, 1, "one wait, then the stop");

  // A lane never waits on its own claim: it cannot land it while it waits.
  const own = laneChoice({ tickets, byNumber, hold: holdFrom(new Set()), done: () => false, takes: "any", claims: [{ ticket: 5, lane: "2", pid: 222 }], self: "2", others: [] });
  assert.equal(own.ticket.number, 9, "any: #9 is ready");
  const ownOnly = laneChoice({ tickets: tickets.slice(0, 3), byNumber, hold: holdFrom(new Set()), done: () => false, takes: "any", claims: [{ ticket: 5, lane: "2", pid: 222 }], self: "2", others: [] });
  assert.deepEqual(ownOnly, { ticket: null, waitOn: [] });
  // A parked ticket on the chain is no one's to land: no wait for it.
  const parked = ticketOf(6, { labels: ["needs-info"], blockers: [] });
  const chain = [ticketOf(5, { labels: [] }), parked, ticketOf(7, { labels: ["run-ready", "walk"], blockers: [6] })];
  const parkedChoice = laneChoice({ tickets: chain, byNumber: new Map(chain.map((t) => [t.number, t])), hold: holdFrom(new Set()), done: () => false, takes: "walk", claims: [], self: "2", others: [{ id: "1", takes: "any" }] });
  assert.deepEqual(parkedChoice, { ticket: null, waitOn: [] });
});

test("a run without lanes picks tickets as today: the first ready one in order, built read off HEAD; a lane reads the phase branch", () => {
  const source = readFileSync(join(HERE, "run.mjs"), "utf8").replace(/\r\n/g, "\n"); // a Windows checkout may have CRLF
  const body = (name) => source.slice(source.indexOf(`function ${name}(`), source.indexOf("\n}\n", source.indexOf(`function ${name}(`)));
  assert.match(body("nextTicket"), /^function nextTicket\([^)]*\) \{\n {2}if \(!lane\) return inScope\.find\(\(ticket\) => holdReason\(ticket, byNumber\) === null\);/, "one lane: today's pick, before any claim");
  assert.match(source, /let builtRef = "HEAD";/, "one lane: main..HEAD, as before");
  assert.match(source, /if \(lane\) builtRef = branch;/, "a lane: the phase branch, never its own");
  assert.match(body("builtOnBranch"), /builtOn\(gitTry, builtRef, number\)/);
  // The claim file is run state: the primary checkout's, never the worktree's (ADR 0007).
  assert.match(source, /claims: roots \? roots\.copyDir : null/);
});

// ------------------------------------------------------------------ the fingerprint (#35)

const SHA_X = "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"; // sha256("x")
const SHA_SHOT = "8dccea5217902053b636f0e105c590eb30db4280b8a7a51806110f7ff7b5177e"; // sha256("shot")
/** A project whose screens live in `app/`, not `src/`: the browser check's own paths decide what is source. */
const appCheck = () => runConfig({ browserCheck: { screenFiles: "^app/", sourceFiles: "^app/", screenshots: "shots/{N}", minimum: 1, redo: "walk it" } }).browserCheck;

/**
 * A ticket's tree after a pass: app/page.tsx changed, app/gone.tsx deleted, a devlog edit, one
 * screenshot from before the last source edit, and one after it, in a subfolder. Fixed times only.
 */
function passedTree() {
  const root = mkdtempSync(join(tmpdir(), "phase-run-print-"));
  const put = (rel, body, at) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
    utimesSync(join(root, rel), new Date(at), new Date(at));
  };
  put("shots/35/old.png", "stale", 1000_000);
  put("app/page.tsx", "x", 2000_000);
  put("docs/history/devlog.md", "notes", 2500_000);
  put("shots/35/wide/1280.png", "shot", 3000_000);
  return { root, put, changed: ["app/page.tsx", "app/gone.tsx", "docs/history/devlog.md"] };
}
const ticket35 = (labels = ["run-ready"]) => ({ number: 35, labels });

test("a browser-check pass records a hash of each changed source file under the check's paths, and of each counted screenshot", () => {
  const { root, changed } = passedTree();
  const verdict = browserCheckVerdict({ check: appCheck(), ticket: ticket35(), changed, startedAt: 0, root });
  assert.equal(verdict.problem, null);
  assert.deepEqual(verdict.fingerprint, {
    // A file the ticket deleted is recorded as gone; the devlog is not source; the stale shot does not count.
    sources: { "app/page.tsx": SHA_X, "app/gone.tsx": null },
    screenshots: { "shots/35/wide/1280.png": SHA_SHOT },
  });
});

test("a fingerprint carries on a tree where all its files are unchanged, and says re-check, naming the file, when one changed or a counted screenshot is gone", () => {
  const { root, put, changed } = passedTree();
  const { fingerprint } = browserCheckVerdict({ check: appCheck(), ticket: ticket35(), changed, startedAt: 0, root });
  assert.deepEqual(compareFingerprint(fingerprint, root), { verdict: "carry" });
  // Files the fingerprint never judged may change: the devlog, the stale screenshot.
  put("docs/history/devlog.md", "more notes", 4000_000);
  put("shots/35/old.png", "other", 4000_000);
  assert.deepEqual(compareFingerprint(fingerprint, root), { verdict: "carry" });

  put("app/page.tsx", "y", 5000_000);
  assert.deepEqual(compareFingerprint(fingerprint, root), { verdict: "re-check", file: "app/page.tsx", why: "changed" });
  put("app/page.tsx", "x", 5000_000);

  put("app/gone.tsx", "back", 5000_000);
  assert.deepEqual(compareFingerprint(fingerprint, root), { verdict: "re-check", file: "app/gone.tsx", why: "changed" });
  rmSync(join(root, "app/gone.tsx"));

  rmSync(join(root, "shots/35/wide/1280.png"));
  assert.deepEqual(compareFingerprint(fingerprint, root), { verdict: "re-check", file: "shots/35/wide/1280.png", why: "gone" });
  put("shots/35/wide/1280.png", "another walk", 5000_000);
  assert.deepEqual(compareFingerprint(fingerprint, root), { verdict: "re-check", file: "shots/35/wide/1280.png", why: "changed" });
});

test("which files count as source is the browser check's sourceFiles, never a fixed src/", () => {
  const { root, put } = passedTree();
  put("src/legacy.ts", "x", 2000_000);
  const changed = ["app/page.tsx", "src/legacy.ts"];
  const { fingerprint } = browserCheckVerdict({ check: appCheck(), ticket: ticket35(), changed, startedAt: 0, root });
  assert.deepEqual(Object.keys(fingerprint.sources), ["app/page.tsx"]);
  const srcCheck = runConfig({ browserCheck: { screenFiles: "^app/", sourceFiles: "^src/", screenshots: "shots/{N}", minimum: 1, redo: "walk it" } }).browserCheck;
  assert.deepEqual(browserCheckVerdict({ check: srcCheck, ticket: ticket35(), changed, startedAt: 0, root }).fingerprint.sources, { "src/legacy.ts": SHA_X });
});

test("a ticket with no browser check records no fingerprint, and a failed check records none", () => {
  const { root } = passedTree();
  // No screen file changed and no frontend label: the check does not apply.
  assert.deepEqual(browserCheckVerdict({ check: appCheck(), ticket: ticket35(), changed: ["docs/history/devlog.md"], startedAt: 0, root }), { problem: null, fingerprint: null });
  // A project with no browser check at all.
  assert.deepEqual(browserCheckVerdict({ check: null, ticket: ticket35(["frontend"]), changed: ["app/page.tsx"], startedAt: 0, root }), { problem: null, fingerprint: null });
  // A failed check: today's problem text, and no fingerprint.
  const failed = browserCheckVerdict({ check: appCheck(), ticket: ticket35(["frontend"]), changed: ["app/page.tsx"], startedAt: 9000_000, root });
  assert.equal(failed.fingerprint, null);
  assert.match(failed.problem, /^This ticket changes what a screen shows, and shots\/35\/ holds 0 screenshot\(s\) saved after your last edit/);

  // The result gains the key only with a fingerprint: a ticket without one has a result as before.
  // Both of runGates' passing returns (a lane's, and the one after the migration) carry it.
  const source = readFileSync(join(HERE, "run.mjs"), "utf8").replace(/\r\n/g, "\n");
  const body = (name) => source.slice(source.indexOf(`async function ${name}(`), source.indexOf("\n}\n", source.indexOf(`async function ${name}(`)));
  assert.match(body("finishBuilt"), /\.\.\.\(fingerprint \? \{ fingerprint \} : \{\}\)/);
  assert.equal(body("runGates").match(/return \{ ok: true, fingerprint \};/g)?.length, 2);
  assert.doesNotMatch(body("runGates"), /return \{ ok: true \}/);
});

test("a fingerprint's paths keep one separator, and a changed path that is a folder is recorded as no file, never a crash", () => {
  const { root, put } = passedTree();
  mkdirSync(join(root, "app", "vendor"), { recursive: true }); // a submodule's folder
  utimesSync(join(root, "app", "vendor"), new Date(2000_000), new Date(2000_000)); // fixed, before the shot
  const slash = runConfig({ browserCheck: { screenFiles: "^app/", sourceFiles: "^app/", screenshots: "shots/{N}/", minimum: 1, redo: "walk it" } }).browserCheck;
  const { fingerprint } = browserCheckVerdict({ check: slash, ticket: ticket35(), changed: ["app/page.tsx", "app/vendor"], startedAt: 0, root });
  assert.deepEqual(fingerprint, { sources: { "app/page.tsx": SHA_X, "app/vendor": null }, screenshots: { "shots/35/wide/1280.png": SHA_SHOT } });
  assert.deepEqual(compareFingerprint(fingerprint, root), { verdict: "carry" });
  put("app/page.tsx", "y", 5000_000);
  assert.equal(compareFingerprint(fingerprint, root).file, "app/page.tsx");
});
