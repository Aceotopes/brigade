// Tests for the phase runner's own logic (#194). Plain node:test: no database, no
// GitHub, no Claude session. Run: pnpm test:runner (node --test tools/phase-run/).
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { QUIET_MS, SETTLE_MS, loadResults, outsideAreas, pullRequestBody, recordResult, report, runSession, screenshotsSince, turnOver } from "./run.mjs";

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
  const since = screenshotsSince(root, 185, 0, ["src/page.tsx", "docs/history/devlog.md"]);
  assert.deepEqual(since.fresh, ["1280.png"]);
  assert.equal(since.stale, 1);
});

test("the shared registries are never out of a ticket's areas, but the audit log is", () => {
  const files = ["src/components/shell/nav-config.ts", "src/components/shell/icons.tsx", "src/lib/audit-log.ts", "src/lib/notifications.ts", "scripts/walks/185-doing-a-task.mjs", "src/lib/payroll.ts"];
  // The global audit log stays flagged unless a ticket names it (CLAUDE.md rule 6).
  assert.deepEqual(outsideAreas(files, ["src/lib/task*.ts"]), ["src/lib/audit-log.ts", "src/lib/payroll.ts"]);
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
