---
job: Where things stand and the next step, for whoever picks the work up. Overwritten, not appended.
kind: living
max-lines: 120
---
# Handoff

## Where things stand

Brigade 0.5.2 is released and set up on itself; phase dogfood (#9) was built by a real phase run
and merged. Brigade 0.6.0 ("measure and trim", a port of one real project's runner upgrade) is
grilled and specced: discovery doc 04, ADRs 0004 and 0005, spec #11. Nothing of it is built.

## Next step

`/to-tickets` on spec #11, probe ticket first. Build only after the source project's first real
night after its pull request 307.

## Waiting on the owner

- The ticket slicing for #11 (proposed in discovery doc 04 and the spec).
- Block23GymV2's setup, the first real project with a Docker test database.
