---
job: The modules in build order and their phases, and where each stands, present tense only.
kind: living
max-lines: 120
---
# Roadmap

The one record of where the project stands. Modules go in build order: `#` is the order and the
module's number, and Depends on lists the numbers it waits for. Each phase names its module, its spec
issue and its branch. Stands is one word: a module is planned, building, delivered or blocked; a
phase is planned, building, merged or blocked; `blocked: <why>` carries its reason. A project without
modules leaves Module empty. doc-check checks the tables between the markers, and `/roadmap` keeps
them in step with GitHub and draws the roadmap page from them. Change the page only through here.

<!-- brigade:roadmap -->
## Modules

| # | Module | Depends on | Stands |
|---|---|---|---|

## Phases

| Phase | Module | Spec | Branch | Stands |
|---|---|---|---|---|
<!-- /brigade:roadmap -->

## Noted for later

One line per idea worth keeping but not yet planned.

- Nothing yet.
