---
job: Where this repo's issues live and what each label means.
kind: living
max-lines: 60
---
# Issue tracker

Issues live on GitHub, in this repo. A spec is a parent issue; its tickets are its sub-issues, each
in the shape of `docs/agents/ticket-template.md`.

| Label | Means |
|---|---|
| `run-ready` | `/ticket-check` found no open question: a phase run may build it |
| `needs-info` | A phase run parked it on a question for the owner, asked on the issue |
| `ready-for-human` | A phase run parked it after its gates failed three rounds |
| `frontend` | It changes a screen: the browser check and the design review apply |

The triage labels (`/triage`) come from `/setup-matt-pocock-skills`, which may rewrite this file.
