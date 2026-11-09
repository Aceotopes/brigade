// The claim and the frontier (0.7.0, #34): how two lanes never build the same ticket.
//
//   - A **claim** is a lane's hold on the ticket it builds (glossary: Claim). Both lanes' claims are in
//     one file, `.phase-run/<branch>/claims.json`, in the primary checkout (ADR 0007), changed only
//     under an exclusive-create lock beside it. A claim lapses when its process dies.
//   - The **frontier** is a lane's ready tickets: blockers built, the label its row `takes` (or any),
//     and no live claim on them. A lane takes the first, under the lock, so of two lanes claiming at
//     once one wins and the other chooses again with the winner's claim in view.
//   - **Built** is read off the phase branch, never HEAD: in a lane's worktree HEAD is the lane's own
//     branch, whose passes are unlanded.
//   - A lane with an empty frontier **waits** while another live lane may still land a ticket one of
//     its own waits on, and stops when none can.
//
// Releasing a claim once its ticket lands or parks is Landing's (#37): until then a claim lives as
// long as its lane's process.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ANY_TICKET } from "./config.mjs";
import { pidAlive } from "./lane.mjs";

export const CLAIMS_FILE = "claims.json";
export const CLAIMS_LOCK = "claims.lock";
/** How long a take waits on a live holder of the lock before it is refused. A take holds it for a few git reads. */
export const LOCK_WAIT_MS = 60_000;
/** How long a lock may stay unreadable (made, not yet written) before it is taken as its maker's crash. */
export const UNREADABLE_GRACE_MS = 2_000;
/** How often a waiting lane looks again. */
export const CLAIM_POLL_MS = 30_000;

/** The claim file in a branch's run folder (`laneRoots(...).copyDir`). */
export function claimsPath(dir) {
  return join(dir, CLAIMS_FILE);
}

/** A synchronous pause: the lock is held for milliseconds, so a take never needs to be async. */
function pauseFor(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Takes a crashed holder's lock off: a rename to a name only this caller uses, then a check that what
 * moved is the lock judged dead (`seen`, its text). If the other lane broke that one and took the
 * lock meanwhile, what moved is its live lock, and it is put back by exclusive create, which works on
 * any file system. With two lanes nobody else can create the lock in that instant.
 */
function breakLock(lock, seen, token) {
  const aside = `${lock}.${token}.dead`;
  try {
    renameSync(lock, aside);
  } catch {
    return; // already gone
  }
  const moved = readText(aside);
  if (moved !== null && moved !== seen) {
    try {
      writeFileSync(lock, moved, { flag: "wx" });
    } catch {
      // Only a third process could have made the lock since: lanes are two at most (MAX_LANES).
    }
  }
  rmSync(aside, { force: true });
}

/**
 * Runs `fn` holding the claim file's lock: `claims.lock`, made by exclusive create, so two lanes
 * never hold it at once. Released however `fn` ends. The lock names its holder's pid. A holder that
 * is gone, or is this process (a take never nests, so its own lock is a leftover), loses it; so does
 * a lock left empty past UNREADABLE_GRACE_MS (its maker died before writing it). A live holder is
 * waited on, `waitMs` by the injected clock, then refused, naming the lock and the holder.
 */
export function withClaimLock(dir, fn, { pid = process.pid, alive = pidAlive, now = Date.now, pause = pauseFor, waitMs = LOCK_WAIT_MS } = {}) {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, CLAIMS_LOCK);
  const token = `${pid}-${randomUUID()}`;
  const started = now();
  let unreadableSince = null;
  for (;;) {
    try {
      writeFileSync(lock, `${JSON.stringify({ pid, token, at: new Date(now()).toISOString() })}\n`, { flag: "wx" });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const seen = readText(lock);
    if (seen === null) continue; // released between the create and the read
    const holder = (() => {
      try {
        return JSON.parse(seen);
      } catch {
        return null;
      }
    })();
    if (Number.isInteger(holder?.pid) && (holder.pid === pid || !alive(holder.pid))) {
      breakLock(lock, seen, token);
      continue;
    }
    if (!Number.isInteger(holder?.pid)) {
      // Made, its content not yet written: a holder mid-write, or one that died there.
      unreadableSince ??= now();
      if (now() - unreadableSince >= UNREADABLE_GRACE_MS) {
        breakLock(lock, seen, token);
        unreadableSince = null;
        continue;
      }
    } else unreadableSince = null;
    if (now() - started >= waitMs) {
      const who = Number.isInteger(holder?.pid) ? `process ${holder.pid}` : "a process that never wrote its pid";
      throw new Error(`The claim file's lock, ${lock}, is held by ${who}, and this lane waited ${Math.round(waitMs / 1000)} s for it. If no lane of this run is taking a claim, delete the lock and start the lane again.`);
    }
    pause(50);
  }
  try {
    return fn();
  } finally {
    if (readJson(lock)?.token === token) rmSync(lock, { force: true });
  }
}

/**
 * The claim file: `claims`, each `{ ticket, lane, pid, at }`, and `waiting`, each `{ lane, pid }`, the
 * lanes that found nothing ready and wait (claimNext). Both empty when there is no file yet.
 */
function readState(dir) {
  const path = claimsPath(dir);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { claims: [], waiting: [] };
    throw error;
  }
  const state = (() => {
    try {
      return JSON.parse(text) ?? {};
    } catch {
      return {};
    }
  })();
  // Never read as "nothing is claimed": that would let a ticket be built twice.
  if (!Array.isArray(state.claims)) throw new Error(`${path} can't be read as claims. If no lane is running, delete it and start again.`);
  return { claims: state.claims, waiting: Array.isArray(state.waiting) ? state.waiting : [] };
}

/** The claims in a branch's run folder, as `{ ticket, lane, pid, at }`; none when there is no file yet. */
export function readClaims(dir) {
  return readState(dir).claims;
}

/** The claims (or waiting entries) whose process still runs: a dead process's lapse (glossary: Claim). */
export function liveClaims(claims, alive = pidAlive) {
  return claims.filter((claim) => Number.isInteger(claim.pid) && alive(claim.pid));
}

/**
 * Changes the claim file under the lock. `change(live)` gets its live claims and waiting entries
 * (lapsed ones are dropped from the file) and returns `{ claims?, waiting?, result }`. The file is
 * written whole and renamed into place, so a crash mid-write never leaves half a file.
 */
function changeClaims({ dir, pid = process.pid, alive = pidAlive, now, pause, waitMs }, change) {
  return withClaimLock(
    dir,
    () => {
      const file = readState(dir);
      const live = { claims: liveClaims(file.claims, alive), waiting: liveClaims(file.waiting, alive) };
      const { claims = live.claims, waiting = live.waiting, result } = change(live);
      const path = claimsPath(dir);
      const part = `${path}.${pid}.part`;
      writeFileSync(part, `${JSON.stringify({ claims, waiting }, null, 2)}\n`);
      renameSync(part, path);
      return result;
    },
    { pid, alive, now, pause, waitMs },
  );
}

const claimFor = ({ ticket, lane, pid, at }) => ({ ticket, lane: String(lane), pid, at: new Date(at).toISOString() });

/**
 * Lane `lane` takes a claim, under the lock: the live claims are read, `choose(claims)` names a
 * ticket number or null, and a number is claimed for `pid` at `at`. Returns `{ ticket, claims }`,
 * the live claims as `choose` saw them.
 */
export function takeClaim({ dir, lane, choose, pid = process.pid, at = Date.now(), alive = pidAlive, now, pause, waitMs }) {
  return changeClaims({ dir, pid, alive, now, pause, waitMs }, ({ claims }) => {
    const ticket = choose(claims) ?? null;
    return { claims: ticket === null ? claims : [...claims, claimFor({ ticket, lane, pid, at })], result: { ticket, claims } };
  });
}

// ------------------------------------------------------------------ the frontier

/** Whether a row that `takes` this may build the ticket: any ticket, or one with the label (D6). */
export function takesTicket(takes, ticket) {
  return takes === ANY_TICKET || ticket.labels.includes(takes);
}

/**
 * Whether a ticket's `Closes #N` commit is on `ref`, past main: `git(...args)` answers `{ ok, stdout }`.
 * A lane passes the phase branch, so its own unlanded passes don't count, whichever tree asks.
 */
export function builtOn(git, ref, number) {
  const result = git("log", `main..${ref}`, "-i", "-E", `--grep=Closes #${number}([^0-9]|$)`, "--format=%h");
  return result.ok && result.stdout !== "";
}

/**
 * What lane `self` does next. `tickets` are the run's, in order; `byNumber` every ticket of the spec;
 * `hold(ticket)` is the runner's holdReason (null when ready, "waiting on #N" on an unbuilt blocker);
 * `done(blocker)` reads a `{ number, state }` blocker; `claims` the live ones; `others` the rows of the
 * other lanes still running, as `{ id, takes }`; `idle` the ids of those that are waiting themselves.
 *
 * Returns `{ ticket, waitOn }`: the first ticket of the frontier, or none, and then what may still
 * unblock one this lane takes: each unbuilt ticket on its blocker chain that another live lane has
 * claimed (`claimed: true`), or may still claim, as its row takes it and it is not parked. A lane
 * never waits on its own claim: it can't land one while it waits. Nor on an idle lane's claim or
 * takes: that lane builds nothing while it waits, so two lanes never wait on each other.
 */
export function laneChoice({ tickets, byNumber, hold, done, takes, claims, self, others = [], idle = [] }) {
  const busy = (id) => String(id) !== String(self) && !idle.includes(String(id));
  const reasons = new Map();
  const reason = (ticket) => {
    if (!reasons.has(ticket.number)) reasons.set(ticket.number, hold(ticket));
    return reasons.get(ticket.number);
  };
  const claimOf = new Map(claims.map((claim) => [claim.ticket, claim]));
  const mine = tickets.filter((ticket) => takesTicket(takes, ticket) && !claimOf.has(ticket.number));
  const ready = mine.find((ticket) => reason(ticket) === null);
  if (ready) return { ticket: ready, waitOn: [] };

  const buildable = (ticket) => reason(ticket) === null || /^waiting on #/.test(reason(ticket) ?? "");
  const waitOn = new Map();
  const seen = new Set();
  const walk = (ticket) => {
    for (const blocker of ticket.blockers) {
      if (seen.has(blocker.number)) continue;
      seen.add(blocker.number);
      const known = byNumber.get(blocker.number);
      if (known ? reason(known) === "done" : done(blocker)) continue;
      const claim = claimOf.get(blocker.number);
      if (claim) {
        if (busy(claim.lane)) waitOn.set(blocker.number, { ticket: blocker.number, lane: claim.lane, claimed: true });
        continue; // being built: what it waits on was built first
      }
      if (!known || !buildable(known)) continue; // parked, not run-ready, or outside the spec: no lane builds it tonight
      const taker = others.find((row) => busy(row.id) && takesTicket(row.takes, known));
      if (taker) waitOn.set(blocker.number, { ticket: blocker.number, lane: String(taker.id), claimed: false });
      walk(known);
    }
  };
  for (const ticket of mine) if (/^waiting on #/.test(reason(ticket) ?? "")) walk(ticket);
  return { ticket: null, waitOn: [...waitOn.values()] };
}

/**
 * A lane's next ticket, claimed: `choose(claims, idle)` is laneChoice for this lane, read again on
 * each look, `idle` the other lanes waiting. With nothing ready it waits `pollMs` through the
 * injected `sleep`, calling `onWait(waitOn)`, while some other live lane may still unblock it, and
 * returns `{ ticket: null }` when none can. While it waits, the claim file lists it in `waiting`, in
 * the same write as the look, so the other lane, looking next, never waits on it in turn.
 */
export async function claimNext({ dir, lane, choose, pid = process.pid, alive = pidAlive, now = Date.now, sleep, pollMs = CLAIM_POLL_MS, onWait = () => {} }) {
  const self = String(lane);
  for (;;) {
    const { ticket, waitOn } = changeClaims({ dir, pid, alive, now }, ({ claims, waiting }) => {
      const others = waiting.filter((entry) => entry.lane !== self);
      const choice = choose(claims, others.map((entry) => entry.lane));
      const number = choice.ticket?.number ?? null;
      const waits = number === null && choice.waitOn.length > 0;
      return {
        claims: number === null ? claims : [...claims, claimFor({ ticket: number, lane: self, pid, at: now() })],
        waiting: waits ? [...others, { lane: self, pid }] : others,
        result: { ticket: number, waitOn: waits ? choice.waitOn : [] },
      };
    });
    if (ticket !== null) return { ticket };
    if (waitOn.length === 0) return { ticket: null };
    onWait(waitOn);
    await sleep(pollMs);
  }
}
