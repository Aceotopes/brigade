# #002 — Pricing: five rates, three models, each request on its own

**Ticket:** `#13` · **Devlog:** `#7` · **ADRs:** none
**Date:** 2026-11-08

---

## The Problem

The runner's per-ticket cost (the morning report's scoreboard, `status.mjs`) added a session's
tokens up per model and priced the totals with four rates. That missed three things about how
Claude bills:

- **A cache write has two prices.** A five-minute write costs 1.25× input and a one-hour write 2×.
  The old list had one `cacheWrite` rate, the one-hour one, so a session that wrote five-minute
  cache read high.
- **Advisor passes were free.** A response that called the advisor records the advisor's own
  request (often 100k+ tokens at Fable's rates) only inside `usage.iterations`. The top-level
  `usage` the old code read leaves it out, so every advisor pass cost $0.
- **Pricing is per request.** A large-prompt tier, if a model has one, applies to one request's
  prompt, not to a session's totals, so totals can't be tiered at all.

The price list also still carried a Haiku row, which the owner's rule (D1, RU-D39) removes. The
coming ledger (#14) and attended hook (#15) need the cost of only what a transcript added since
the last reading, which the whole-file reader couldn't give.

## The Solution

- **`prices.json`** now has `checkedOn: "2026-11-07"`, `fallback: "claude-opus-5-5"`, and five rates
  per row (`input`, `cacheWrite5m`, `cacheWrite1h`, `cacheRead`, `output`) for Opus 5.5, Sonnet 5.5
  and Fable 5.1 only. A row may carry `above: { promptTokens, <five rates> }`.
- **`loadPrices(file)`** refuses (throws) a row missing a rate, an `above` tier missing a rate or
  `promptTokens`, and a `fallback` that names no row. `pricesAgeDays(prices, at)` counts days
  since `checkedOn`. A test warns when that is over `PRICES_STALE_DAYS` (90).
- **`requestCost(model, usage, prices)`** (internal to `metrics.mjs`) prices one request in whole nano-dollars. The write is
  split by `cache_creation.ephemeral_5m/1h_input_tokens`, and any write the split doesn't cover
  goes at the one-hour rate. A prompt (input + writes + read) over `above.promptTokens` uses the
  tier. An unlisted model uses the fallback row.
- **`sessionCostFrom(transcript, prices, state)`** reads the transcript and every
  `<session>/subagents/*.jsonl` from each file's saved byte offset. For each response it prices
  `usage.iterations` when present (an `advisor_message` at its own `model`), else the top-level
  usage. It returns `{ cost, state }`. `cost` holds `nanoUsd`, `costUsd`, `calls`, `advisorCalls`,
  the session's own token totals and `peakContext`. **`sessionCost(transcript, prices)`** is the
  same with no state: the whole session.
- `ticketMetrics` and `status.mjs`'s backfill use `sessionCost`. The old `usageOf`,
  `sessionUsage` and `costOf` are gone. The report's metrics keep their shape.

## Why This Approach

**Iterations, not top-level.** I printed a real advisor response from a transcript on this
machine. Its top-level `input/cache/output` equals the sum of its two `message` iterations
exactly, and the `advisor_message` iteration (135,883 in, 9,959 out, `claude-fable-5-1`) is in
neither. So the iterations are the full list of requests, and the top-level is a partial sum.
Pricing both would double-count; pricing only the top-level is the old bug.

**Whole nano-dollars.** The ticket asks that pricing a transcript in two steps equal pricing it
whole. In floating point, adding the same costs in a different order (step 1 reads part of the
session and part of a subagent, step 2 the rest) can differ in the last digit. Every rate has at
most three decimals, so `tokens × rate × 1000` is a whole number of nano-dollars, and whole
numbers add exactly in any order up to about $9 million.

**Offsets at a line's end.** The incremental reader saves the offset after the last complete line.
A half-written last line is left for the next reading, unless it already parses as JSON (a JSON
object can't parse until it is complete). Saving the file's size instead would skip that line for
good. The state also keeps the response ids already counted, because Claude Code writes one
response as several lines, and a reading can fall between them.

Interview version: "The cost gauge summed tokens and priced the totals. Billing is per request,
with two cache-write lifetimes and advisor calls at their own model, so I moved pricing down to the
request and summed dollars instead. Then I made it incremental with a byte offset plus a set of
seen ids, and counted in integer nano-dollars so two partial readings add up exactly to one whole
reading."

## Alternatives turned down

- **Keep `costOf(usage, prices)` beside the new functions.** Two pricing paths would drift, and the
  per-model token totals it priced can't carry a per-request tier. All callers moved.
- **Store only the last response id in the state, not all of them.** It would be smaller, and a
  response's lines are consecutive in every transcript seen. But that is an observation, not a
  guarantee, and the whole-file reader never relied on it, so two steps might not equal the whole.
  A long session's state is a few thousand ids (tens of KB). #15 can revisit this if that matters.
- **Refuse a missing `checkedOn` in `loadPrices`.** The ticket names two refusals. A missing date
  instead shows up as the age test's warning, and the real-file test pins that it is a date.
- **(Review) Make `stop-tests.mjs` keep warning lines on a pass.** The age warning is a TAP
  `t.diagnostic`, and the stop check's quiet output drops it when the suite passes, so it shows
  only on a direct `node --test` run. Changing what the stop check prints is a different tool's
  job and every project's output, beyond this ticket. It is noted for the owner instead.
- **(Review) Share one formula for "prompt tokens" between `requestCost` and the peak context.**
  They read different usages: one request's, and a whole response's top-level. Sharing one
  helper would hide that difference.
- **(Review) Spot a same-size replacement of a transcript.** It would need a content fingerprint
  in the state, for a case an append-only file never produces.

## Real bugs found along the way

- Advisor passes were priced at $0 (above). On a ticket that calls the advisor a few times at
  Fable's rates, that is about $2 per call left off the scoreboard.
- The code review caught two in this ticket's first draft of `sessionCostFrom`, both now fixed and
  tested. A transcript rewritten shorter was priced again in full. The same file under a different
  spelling of its path (forward vs back slashes) was priced again from byte 0.
- **Found elsewhere, not fixed here:** the root `tools/phase-run/`, the pinned runner that judges
  this phase, still prices with four rates and a Haiku row, so this phase's scoreboard shows advisor
  passes at $0 until `/update-workflow` copies this template in. And `stop-tests.mjs`'s quiet
  output drops TAP `#` diagnostics on a pass, so the age warning never reaches the stop check.

## What This Concretely Unblocks

- #14 (the ledger) and #15 (the attended hook) import `sessionCost` and `sessionCostFrom` from
  `metrics.mjs`, and store the returned `state` between readings. They should add up `nanoUsd`
  across readings, not `costUsd`, which is rounded to cents at each step.

## Run by hand

- None. The root `tools/phase-run/` (the pinned runner) still prices the old way until
  `/update-workflow` copies this template in.

## Assumptions made

- **The real-file test pins the exact rates**, not just their keys, so a typo in today's numbers
  fails. To reverse: assert the five keys only.
- **The age warning is a `t.diagnostic`** in the one test that reads the real clock, and it never
  asserts. Every other date test passes a fixed `at`. To reverse: print with `console.warn`
  instead.
- **A response whose `iterations` has no `message` entry** prices its top-level usage as well as
  its advisor entries, so its own tokens are never dropped. No transcript has shown one yet.
- **Token totals stay the session's own** (top-level, `cacheWrite` = both lifetimes). Advisor
  tokens are priced but not counted there, as before; `advisorCalls` counts the passes. To reverse:
  add advisor iterations to the totals in `addResponse`.
- **A file shorter than its saved offset** was replaced, so it is read again from the start, and
  its counted ids are kept so nothing already priced is priced twice (the code review found that
  clearing them double-counted). A same-size or longer replacement is not looked for, since a
  transcript is only ever appended to.
- **The state is keyed by the resolved path** (`path.resolve`), so `C:\x\s.jsonl` and `C:/x/s.jsonl`
  are one file. Case is not folded. To reverse: key by the path as given.
- **The changelog gets an `## Unreleased` entry**, as #001's did, so `/update-workflow` can show
  the price list's new shape.

## Common Questions

**Why does a five-minute write cost less than a one-hour write?** A cache write is priced as input
plus the cost of keeping it. The longer lifetime costs more (1.25× vs 2× input), and a cache read
is far cheaper than either (0.05× here).

**What happens to a model the list doesn't name?** It is priced at Opus 5.5's rates, the
`fallback` (D1). Opus is the costliest common model, so an unknown model reads high rather than
free.

**Does this change what a subscription costs?** No. It is a gauge of what the same tokens would cost
on the pay-as-you-go API.

**Was a browser check run?** No. This is a backend-only ticket: no screen changes.

## References

- Spec #11, `docs/discovery/04-brigade-0.6.0.md` D1.
- `template/tools/phase-run/metrics.mjs`, `prices.json`, `status.mjs`, `measure.test.mjs`.
- Gotchas: `docs/agents/gotchas/measure-trim.md`, block `#13`.
