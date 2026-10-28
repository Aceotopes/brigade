---
status: accepted
---
# The roadmap's source is the repo; its page is a generated view

A project's roadmap lives in `docs/status/roadmap.md`, in fixed tables (modules in build order with
what each depends on, and each module's phases with their spec and status) between markers that
doc-check reads. The roadmap page is a Brigade page template plus data made from those tables, the
handoff and `workflow.md`, published as an Artifact by `/roadmap`, and never edited by hand. The
page can therefore never say something the repo doesn't, and a redesign happens once, in Brigade,
for every project.

## Considered options

- **A hand-built page**, updated from the roadmap by following a structure map: the most design
  freedom, but every phase end means editing HTML by hand, and the page drifts from the repo.
- **A `roadmap.json` as the source**, with both the Markdown and the page generated from it: it
  can't break, but the owner would edit JSON instead of a document they can read on GitHub.

## Consequences

The format check applies only once a project's roadmap has the tables, so a project set up before
them keeps working until it converts. `/roadmap` offers the conversion.
