# #013 — Setup reuses an existing compose file

**Ticket:** `#23` · **Devlog:** `#18` · **ADRs:** 0001 amended (D20 in discovery 04)
**Date:** 2026-11-08

---

## The Problem

Setup's testDatabase step assumed a project had no Docker setup of its own: "if it runs in Docker,
write `docker-compose.yml` for it". An existing project whose test database already runs in Docker
would have been handed a second compose file beside its own, and `docker compose` would then pick
one of the two by name, maybe not the owner's. Setup also could not see what the existing file
held, so it could not propose the preflight row or the database's port from it.

The same step said the database's port goes in `phaseRun.ports`. That was wrong. `phaseRun.ports`
is the list of ports that must be **free** before a run starts, and the runner checks it right
after the preflight rows run. The preflight row `docker compose up -d --wait` starts the database on
its port, so the check would find it busy and refuse every run. The owner settled this when the
ticket was parked (option (a), 2026-11-08).

## The Solution

- **`scripts/setup.mjs`, `detect().compose`**: one entry per compose file at the repo root, in
  `COMPOSE_FILES` order (`compose.yaml`, `compose.yml`, `docker-compose.yml`,
  `docker-compose.yaml`, which is Docker Compose's own default file-name list: the first found is
  the one `docker compose up` runs). Each entry is `{ file, services, lines, skipped }`, where
  `services` is `[{ name, image, ports }]` and `lines` is the owner's view (`db: postgres:16,
  5432`). A file it can't read is `{ file, error: "could not read: line N: …" }`. detect never throws
  for it. A compose file in a subfolder is not read.
- **`parseCompose(text)`**: a small indentation reader with no dependency. It walks the top-level
  keys, keeps `services:`, and for each service reads `image:` and `ports:`. The ports can be the
  short form (`"5432:5432"`, `127.0.0.1:5433:5432/tcp`), a flow list (`['3000:3000']`) or the long
  form (`- target: 80` with `published: "8080"`). Everything else goes in `skipped` by name
  (`db.environment`, `volumes`, `web.build`). A port with no fixed host port (`"6543"`,
  `${PG_PORT:-5432}:5432`, a long form without `published`) is also listed there, never guessed. A
  leading `---` document marker is passed over. On a shape it can't place it throws with the line: a tab in the indentation, a one-line
  `services: {…}`, an unclosed quote, a list where services belong, no `services:` block at all.
- **`composeLines`**: each service as one line, for the owner.
- **`refresh`'s report gains `compose`**, detect's list, so a project that gained a compose file is
  walked through the same step. It is a report field, not an item: refresh writes nothing for it.
- **Setup skill §3, testDatabase**: a found compose file (read or not) is reused. Setup shows its
  lines and what it skipped, asks which service is the test database (and, beside an override
  file, whether that changes the port), and proposes the preflight row
  `docker compose up -d --wait` with the hint "Is Docker running? Or another project's container
  holds the port: stop it, or give this one another port in its compose file." The port goes in the
  address sessions use (`phaseRun.qa`'s `url`, or the `sessionEnv` variable holding it), never in
  `phaseRun.ports`. It never writes a second compose file and never edits the owner's. With no
  file, it asks where the test database runs, as before. Then §6's Docker check. **§8 step 4** does
  the same on a refresh.

## Why This Approach

A real YAML library would read every compose file, but Brigade's setup script ships with node
builtins only, and adding a dependency to a plugin means every project's install carries it. The
fields setup needs are few and shallow, so a reader that knows only `services:`, `image:` and
`ports:` is enough. Its limit is honest: what it skips, it names, and what it can't read is an
error with a line number rather than a wrong answer.

The parser throws, and `detect` catches. That keeps the parser simple to test (a bad input is
`assert.throws` with the line), while the seam that setup calls never throws.

Refresh reports instead of adding an item because ADR 0001 says Brigade writes no stack recipes:
the preflight row and the database's address depend on which service is the database and how the
project's sessions reach it, which only the owner can say.

**Interview version:** "Setup had to recognise an existing Docker setup without adding a YAML
dependency to a plugin. I wrote a narrow reader for the three fields we use, made it report what it
skipped and fail loudly with a line number, and caught that failure at the boundary so the caller
always gets data. The trade-off is coverage for zero dependencies, and the failure mode is a clear
'could not read' instead of a wrong port."

## Alternatives turned down

- **A YAML dependency** (`yaml`, `js-yaml`): reads anything, but adds a package to a plugin that has
  none. The ticket asked for none.
- **Running `docker compose config`** to have Docker parse the file: exact, but needs Docker
  installed and running at detect time, and the Docker check comes after.
- **The database's port in `phaseRun.ports`** (the ticket's first wording): refuses every run, as
  above. The owner chose the address instead.
- **On a file it can't read, fall back to "no compose file"**: that branch writes a new
  `docker-compose.yml`, which is the second file the ticket forbids. Docker can still run a file
  Brigade's reader can't, so the file is reused and the port asked for by hand.
- **From the code review, turned down** (each reads as "could not read" or a `skipped` port, so the
  owner is asked by hand; none gives a wrong port): escaped quotes inside a value (`"echo \" "`),
  anchors and merge keys (`<<: *db`, `image: *img` reported as `*img`), a multi-line flow list, a
  port range (`5432-5433:5432-5433`), a variable in the container half (`5433:${INNER:-5432}`), a
  tab inside a block of text. Each is a YAML feature a narrow reader would have to grow into a
  real one for.
- **Moving the reader to its own `scripts/compose.mjs`** (review, Divergent Change): a fair split,
  but `detect` is its only caller and the tests import from `setup.mjs`. Worth doing if a second
  caller appears.
- **Reading `compose.override.yaml`**: Docker merges it, so its ports can differ. Outside the
  ticket's four names; the skill asks the owner about it instead.

## Real bugs found along the way

- The skill's old line, "its port in `phaseRun.ports`", would have made every run on a Docker test
  database refuse to start. Corrected.

## What This Concretely Unblocks

An existing project with its own compose file can adopt Brigade without a duplicate file, with the
preflight row and the database's port proposed from what is already there.

## Run by hand

None.

## Assumptions made

- **A project with no compose file and a Docker test database still gets `docker-compose.yml`
  written**, as before: the ticket stops only a *second* file. To reverse: change §3's "None" branch.
- **The port may go in `sessionEnv`** as well as `phaseRun.qa`'s `url`, whichever holds the address
  the project's sessions read. To reverse: name only `phaseRun.qa` in §3.
- **Setup never edits the owner's compose file**, even to add a missing database service: the owner
  adds it. To reverse: allow a proposed edit in §3.
- **`COMPOSE_FILES` order** is Docker Compose's default file-name list; the two-file test pins only
  that `compose.yaml` comes before `docker-compose.yml`. To reverse: reorder the constant.
- **ADR 0001's "test database → preflight and ports"** is kept, with `status: amended` and a dated
  note: its "ports" means the database's address, not `phaseRun.ports`. To reverse: drop the note.

## Common Questions

- **Why does detect list a file it couldn't read?** So setup can still reuse it. Docker reads more
  YAML than Brigade's reader does.
- **Why no browser check?** Backend only: a script and a skill's text. No screen changes.
- **Found elsewhere / handed forward:** none.

## References

- Discovery 04, D20; spec #11; ticket #23 and its parked question.
- `scripts/setup.mjs` (`COMPOSE_FILES`, `parseCompose`, `composeLines`, `detect`, `refresh`),
  `skills/setup-workflow/SKILL.md` §3 and §8, `tests/setup.test.mjs`.
