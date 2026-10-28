// Waits until every subagent this phase-run session started has finished.
//
//   node tools/phase-run/wait-subagents.mjs [--minutes 25]
//
// A session cannot end its turn to wait for a reviewer (the turn's end runs
// the Stop hook and tells the runner the ticket is done), so sessions slept in
// fixed pauses: 1.6 hours over one phase's 14 tickets, mostly after the
// reviewer had already finished. This returns the moment the last one finishes.
//
// How it knows: Claude Code writes `<session>/subagents/<agent>.meta.json`
// when a subagent starts, and adds `"finished": true` when it ends (checked
// 2026-10-28; the field is absent while the subagent runs). The session is
// the transcript whose agent name starts `ticket-<PHASE_RUN_TICKET>-` (the
// runner names it so: run.mjs runTicket). Exits 0 when all have finished (or
// none was started), 1 at the deadline, naming what is still running.
import { existsSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const POLL_MS = 5_000;

export function projectsDir() {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
}

function head(file, bytes = 4096) {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** The newest transcript whose agent name is ticket-<N>-…, as { folder, sessionId }; null if none. */
export function findTicketSession(projects, ticket) {
  if (!existsSync(projects)) return null;
  const marker = `"agentName":"ticket-${ticket}-`;
  let best = null;
  for (const folder of readdirSync(projects)) {
    const dir = join(projects, folder);
    let names;
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = join(dir, name);
      const modified = statSync(file).mtimeMs;
      if (best && modified <= best.modified) continue;
      if (head(file).includes(marker)) best = { folder: dir, sessionId: name.slice(0, -".jsonl".length), modified };
    }
  }
  return best && { folder: best.folder, sessionId: best.sessionId };
}

/** Every subagent of a session: { name, description, finished }. */
export function subagentsOf(folder, sessionId) {
  const dir = join(folder, sessionId, "subagents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".meta.json"))
    .map((name) => {
      let meta = {};
      try {
        meta = JSON.parse(readFileSync(join(dir, name), "utf8"));
      } catch {
        // written at this moment: read it as still running
      }
      return { name: name.slice(0, -".meta.json".length), description: meta.description ?? meta.agentType ?? "?", finished: meta.finished === true };
    });
}

async function main() {
  const at = process.argv.indexOf("--minutes");
  const minutes = at === -1 ? 25 : Number(process.argv[at + 1]);
  const ticket = process.env.PHASE_RUN_TICKET;
  if (!ticket) {
    console.log("PHASE_RUN_TICKET is not set: this script waits for a phase-run session's subagents.");
    return 2;
  }
  const session = findTicketSession(projectsDir(), ticket);
  if (!session) {
    console.log(`No transcript named ticket-${ticket}-… was found, so there is nothing to wait for.`);
    return 2;
  }
  const started = Date.now();
  const deadline = started + minutes * 60_000;
  for (;;) {
    const all = subagentsOf(session.folder, session.sessionId);
    const running = all.filter((agent) => !agent.finished);
    if (running.length === 0) {
      const waited = Math.round((Date.now() - started) / 1000);
      console.log(all.length ? `All ${all.length} subagent(s) have finished (waited ${waited}s). Read their results now.` : "This session has started no subagent.");
      return 0;
    }
    if (Date.now() > deadline) {
      console.log(`Still running after ${minutes} min: ${running.map((agent) => agent.description).join("; ")}.`);
      return 1;
    }
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main().then((code) => process.exit(code));
