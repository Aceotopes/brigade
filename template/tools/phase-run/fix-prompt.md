# Phase run: ticket #{{N}} did not pass (fix round {{ROUND}} of {{ROUNDS}})

The runner checked your work on ticket #{{N}} and the **{{GATE}}** check failed. Nobody is
watching; fix it and stop again. The end of the check's output:

```
{{OUTPUT}}
```

- Find the cause and fix that. Never weaken, skip or delete a test to make a check pass, and never
  silence a lint or type error.
- Then review the fix as you would any change: does it still meet the ticket's acceptance criteria,
  and did it stay inside the ticket?
- **Amend the ticket's commit** (`git commit --amend`). A ticket is exactly one commit, with
  `Closes #{{N}}`, no trailer, and nothing left uncommitted in the tree.
- If the fix changes what the implementation log or the devlog entry says, correct them in the same
  amend. A real bug you found this way belongs under "Real bugs found along the way".
- If the fix touched a screen's source and the ticket changes a screen, run its browser check again
  and save fresh screenshots: the gate counts only ones newer than your last source edit.
- A migration that an earlier commit added, or that the output says is already applied to
  {{TARGET}}, is never edited: add a new migration after it.

{{PROJECT_FIX}}
- If the failure shows the ticket cannot be finished without the owner's decision, park it: write
  `.phase-run/verdict-{{N}}.json` with `"status": "parked"` and the question, and stop.
- Stop every background task you started (TaskStop). Then, last, write the verdict file again,
  even if nothing in it changed (update it if your summary, assumptions or run-by-hand steps did):
  the runner reads a verdict written in this round, with the turn over, as your end.

The same rules as before hold: stay on `{{BRANCH}}`, never push, QA on {{QA}} only, temporary
files in `.phase-run/tmp/`, no redirects or `cd … &&` chains, never `git stash`.
