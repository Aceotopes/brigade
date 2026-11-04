// Waits until a URL answers: a QA server the session started in the background.
//
//   node tools/phase-run/wait-url.mjs <url> [--minutes 15]
//
// Sessions used to write their own copy of this wait, or sleep for a fixed
// time while a server built. It returns as soon as the server answers with
// any HTTP status (a redirect or a 404 still means it is up). Exits 0 when it
// answers, 1 at the deadline, 2 without a URL.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const POLL_MS = 3_000;

/** Whether `url` answers at all. */
export async function answers(url) {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    return response.status > 0;
  } catch {
    return false; // not listening yet
  }
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf("--minutes");
  const minutes = at === -1 ? 15 : Number(args[at + 1]);
  const url = args.find((arg, i) => /^https?:\/\//.test(arg) && args[i - 1] !== "--minutes");
  if (!url || !Number.isFinite(minutes)) {
    console.log("Usage: node tools/phase-run/wait-url.mjs <url> [--minutes 15]");
    return 2;
  }
  const started = Date.now();
  while (Date.now() - started < minutes * 60_000) {
    if (await answers(url)) {
      console.log(`${url} answered after ${Math.round((Date.now() - started) / 1000)}s.`);
      return 0;
    }
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
  console.log(`${url} did not answer within ${minutes} min. Read the server's output.`);
  return 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main().then((code) => process.exit(code));
