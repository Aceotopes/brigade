// How a phase run looks in the terminal, and in `status.mjs`.
//
// A compact table: one row per finished ticket with a dim detail line under
// it, and a two-line live area at the bottom (the progress line and the
// ticket being built) that is redrawn in place. Colour and redrawing happen
// only on a terminal (and never under NO_COLOR); anywhere else the runner
// prints its plain lines as before, and run.log is always plain.
import { spawn } from "node:child_process";

const ANSI = /\x1b\[[0-9;]*m/g;
const CODES = { dim: 2, bold: 1, red: 31, green: 32, yellow: 33, cyan: 36 };

/** Colour helpers; each returns its text unchanged when colour is off. */
export function makePaint(enabled) {
  const paint = {};
  for (const [name, code] of Object.entries(CODES)) paint[name] = (text) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : String(text));
  return paint;
}

export const visible = (text) => String(text).replace(ANSI, "");

/** Cut a plain line to `width` visible characters. */
export function fit(text, width) {
  return width && text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
}

function pad(text, width, right = false) {
  const room = width - visible(text).length;
  if (room <= 0) return text;
  return right ? " ".repeat(room) + text : text + " ".repeat(room);
}

/** "2B: Export the report — as a spreadsheet" → "Export the report". */
export function shortTitle(title, width = 24) {
  const plain = String(title).replace(/^\d+[A-Z]?\d*:\s*/, "").split(/ [—–:] /)[0];
  return fit(plain, width);
}

export function shortStat(stat) {
  const m = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(stat ?? "");
  return m ? `${m[1]} files +${m[2] ?? 0} −${m[3] ?? 0}` : "no diff";
}

const money = (usd) => (usd == null ? "—" : `$${usd.toFixed(2)}`);
const kilo = (tokens) => `${Math.round(tokens / 1000)}k`;

/** A finished ticket's minutes, from its metrics or (an older result) its session's own count. */
export function ticketMinutes(result) {
  return result.session?.metrics?.minutes?.total ?? result.session?.minutes ?? null;
}

/** The questions a ticket left for the owner: a parked question, or assumptions worded as a question or decision. */
export function forYou(result) {
  if (result.status === "parked") return [String(result.detail ?? "").split("\n")[0]];
  return (result.assumptions ?? []).filter((line) => /^(question|decision)\b/i.test(String(line)));
}

export const TABLE_HEAD = `  ${pad("#", 5)}${pad("ticket", 25)}${pad("time", 6, true)}  ${pad("cost", 7, true)}  result`;

/** One finished ticket: its row and its dim detail lines. */
export function resultLines(result, paint) {
  const metrics = result.session?.metrics;
  const fixes = Math.max(0, (result.session?.calls ?? 1) - 1);
  const minutes = ticketMinutes(result);
  let outcome;
  if (result.status === "built") {
    const text = `✔ ${result.hash}${fixes ? ` · ${fixes} fix${fixes > 1 ? "es" : ""}` : ""}`;
    outcome = fixes ? paint.yellow(text) : paint.green(text);
  } else outcome = paint.red(result.status === "parked" ? "⏸ parked: needs you" : "✖ failed");
  const row = `  ${pad(String(result.number), 5)}${pad(shortTitle(result.title), 25)}${pad(minutes == null ? "—" : `${minutes}m`, 6, true)}  ${pad(money(metrics?.costUsd), 7, true)}  ${outcome}`;

  const lines = [row];
  const m = metrics?.minutes;
  if (m) {
    const parts = [["Claude", m.claude], ["tests", m.tests], ["checks", m.checks], ["browser", m.browser], ["slept", m.waiting], ["reviews", m.reviewing], ["hook", m.hook], ["gates", m.gates]];
    lines.push(paint.dim(`       ${parts.filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(" · ")}`));
  }
  const questions = forYou(result);
  const facts = [
    result.status === "built" ? shortStat(result.stat) : null,
    metrics?.peakContext ? `peak ${kilo(metrics.peakContext)}` : null,
    metrics?.size ? `${metrics.size.criteria} criteria · ${metrics.size.areas} areas` : null,
    questions.length ? `${questions.length} for you` : "nothing for you",
  ].filter(Boolean);
  lines.push(questions.length ? paint.yellow(`       ${facts.join(" · ")}`) : paint.dim(`       ${facts.join(" · ")}`));
  return lines;
}

function clock(ms) {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

function span(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}

/**
 * The run's progress: "6 of 10 · 4 after this · 7h31m in · done ≈ 12:20".
 * The estimate is the average ticket so far times what is left.
 */
export function progressText(progress, now) {
  const { label, done, total, startedAt, avgMinutes, current } = progress;
  const ordinal = current ? done + 1 : done;
  const after = Math.max(0, total - ordinal);
  const bar = "■".repeat(Math.min(done, total)) + (current && done < total ? "▣" : "") + "□".repeat(Math.max(0, total - ordinal));
  const left = current ? Math.max(5, avgMinutes - (now - current.startedAt) / 60_000) + avgMinutes * after : avgMinutes * after;
  const eta = current || after ? ` · done ≈ ${clock(now + left * 60_000)}` : "";
  return `${label}  ${bar}  ${ordinal} of ${total} · ${after} after this · ${span(now - startedAt)} in${eta}`;
}

export function liveText(current, now) {
  if (!current) return "";
  const steps = current.steps ? ` · ${current.steps} steps` : "";
  const attach = current.attach ? ` · claude attach ${current.attach}` : "";
  return `▶ ${pad(String(current.number), 5)}${pad(shortTitle(current.title), 25)}${pad(span(now - current.startedAt), 6, true)}  ${current.stage ?? "starting"}${steps}${attach}`;
}

/** The end-of-run (and status.mjs) table: every row, then the totals. */
export function scoreboard(results, paint) {
  const lines = [paint.bold(TABLE_HEAD)];
  for (const result of results) lines.push(...resultLines(result, paint));
  const minutes = results.reduce((sum, r) => sum + (ticketMinutes(r) ?? 0), 0);
  const costs = results.map((r) => r.session?.metrics?.costUsd).filter((c) => c != null);
  const built = results.filter((r) => r.status === "built").length;
  lines.push(
    "  " + "─".repeat(50),
    paint.bold(`  ${results.length} ticket(s) · built ${built} · ${span(minutes * 60_000)} of work${costs.length ? ` · ${money(costs.reduce((a, b) => a + b, 0))} at API rates (${costs.length} priced)` : ""}`),
  );
  return lines;
}

/**
 * The terminal. On a TTY: notes and rows print above a live area that is
 * redrawn in place, and the tab title follows the run. Elsewhere: notes print
 * as plain lines and nothing is redrawn.
 */
export class Screen {
  constructor(out = process.stdout, { tty = Boolean(out.isTTY), colour = tty && !process.env.NO_COLOR } = {}) {
    this.out = out;
    this.tty = tty;
    this.paint = makePaint(colour);
    this.liveLines = 0;
    this.progress = null;
  }

  clearLive() {
    if (!this.tty || this.liveLines === 0) return;
    this.out.write(`\r\x1b[2K${"\x1b[1A\x1b[2K".repeat(this.liveLines - 1)}`);
    this.liveLines = 0;
  }

  drawLive(now = Date.now()) {
    if (!this.tty || !this.progress) return;
    const width = (this.out.columns ?? 120) - 1;
    const lines = [this.paint.bold(fit(progressText(this.progress, now), width))];
    const live = liveText(this.progress.current, now);
    if (live) lines.push(this.paint.cyan(fit(live, width)));
    this.out.write(lines.join("\n"));
    this.liveLines = lines.length;
    const c = this.progress.current;
    const ordinal = this.progress.done + (c ? 1 : 0);
    this.out.write(`\x1b]0;${this.progress.label} ${ordinal}/${this.progress.total}${c ? ` · #${c.number} ${span(now - c.startedAt)}` : ""}\x07`);
  }

  /** Lines that stay, printed above the live area. */
  print(lines) {
    if (!this.tty) {
      for (const line of lines) this.out.write(`${visible(line)}\n`);
      return;
    }
    this.clearLive();
    this.out.write(`${lines.join("\n")}\n`);
    this.drawLive();
  }

  /** A log line worth seeing on screen, coloured by what it says. */
  note(line) {
    if (!this.tty) return this.print([line]);
    const p = this.paint;
    const colour = /fail|error|could not|stopped|🚨/i.test(line) ? p.red : /fix round|usage limit|internet|parked|waiting/i.test(line) ? p.yellow : p.dim;
    this.print([colour(line)]);
  }

  /** The run starts: the table's head, then the live area. */
  begin(progress) {
    this.progress = progress;
    if (this.tty) this.print(["", this.paint.bold(`  ${progress.label}`), this.paint.bold(TABLE_HEAD), "  " + "─".repeat(50)]);
  }

  update(progress, now = Date.now()) {
    this.progress = progress;
    if (!this.tty) return;
    this.clearLive();
    this.drawLive(now);
  }

  ticketDone(result) {
    if (this.tty) this.print(resultLines(result, this.paint));
  }

  end(results) {
    if (this.tty) {
      this.clearLive();
      this.progress = null;
    }
    this.print(["", ...scoreboard(results, this.paint), ""]);
  }
}

/**
 * A desktop notification, best-effort: a Windows balloon through PowerShell,
 * started detached so the run never waits on it. Off with PHASE_RUN_NOTIFY=0
 * (set by the owner), and anywhere but Windows. It never throws.
 */
export function notify(title, message) {
  if (process.platform !== "win32" || process.env.PHASE_RUN_NOTIFY === "0") return;
  try {
    const quote = (text) => `'${String(text).replace(/'/g, "''").slice(0, 240)}'`;
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$n = New-Object System.Windows.Forms.NotifyIcon",
      "$n.Icon = [System.Drawing.SystemIcons]::Information",
      "$n.Visible = $true",
      `$n.ShowBalloonTip(15000, ${quote(title)}, ${quote(message)}, 'Info')`,
      "Start-Sleep -Seconds 16",
      "$n.Dispose()",
    ].join("; ");
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // a notification is a courtesy; the run goes on without it
  }
}
