---
status: accepted
---
# Landing replays each lane's ticket onto the newest tip, re-gates it there, and never forces

ADR 0003 says the gates trust no receipt: a ticket passes on what the runner itself saw. A lane's
gates, though, ran on the tip as it was when the lane cut its branch. By the time the ticket is
ready, the other lane may have landed something, so the code that passed is not the code that would
reach the branch. Decided in 0.7.0's grill (2026-11-09, `docs/discovery/05-brigade-0.7.0.md` D13),
as a port of one real project's runner, where both lanes landed in order on its trial.

## Decision

- **One landing lock.** It is held for a whole landing, so one lane lands at a time.
- **Each landing runs in this order:**
  1. replay the commit onto the newest tip;
  2. settle the hotspot conflicts Landing owns, and number the unnumbered entries (ADR 0006);
  3. rebuild every generated file;
  4. run the real gates again on the result, with the migration last;
  5. fast-forward the branch by compare-and-swap, then push.
- **Any conflict outside a hotspot rule, or any failed re-gate, parks the ticket.** The branch stays
  unmoved, and the ticket keeps its own `-parked-<N>` branch for the morning.
- **The only pass Landing may carry over a rebase** is the browser check's, through its fingerprint:
  the hashes of the source files and screenshots it judged, if the rebase left them all unchanged.

## Considered and rejected

- **Push the lane's commit as it passed.** That trusts a result from another tree, which breaks ADR
  0003.
- **Merge the two lanes' work in the morning.** The night's branch would then never be one
  checked line of commits, and the owner would resolve conflicts by hand.
- **Force-push, or rebase over a conflict automatically.** That risks losing the other lane's
  landed work, and it hides the conflict the owner needs to see.
- **Run the migration after the fast-forward.** A failed migration would then leave the branch
  moved over a broken tree. Running it as the re-gate's last step parks the ticket with the branch
  unmoved.

## Consequences

- Every landing costs a re-gate. On a docs-only diff, 0.6.0's skips keep it short (about 2 minutes
  at the source).
- This extends ADR 0003 from "a ticket" to "a ticket on the tip it lands on". Neither ADR may be
  loosened alone.
- A busy night can park a ticket the other lane overtook. That is by design: a parked ticket costs
  a morning's look, while a forced one costs trust in the branch.
