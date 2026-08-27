# Change Records

This directory contains non-authoritative lifecycle evidence for material repository work. `docs/change-execution.md` owns when to create a record and how material work proceeds; `docs/documentation-model.md` owns the type and precedence rules.

## When To Write One

Use one record when intent, accepted decisions, evidence, or recovery context must survive the chat or commit diff. Typical cases are cross-surface, public-contract, durable-data, rollout, multi-agent, long-running, strict-effect, or likely-audit work. Routine implementation, mechanical changes, and noisy progress stay out of this directory.

## Record Types

- `change-plan`: material work from intent through closeout.
- `pr-summary`: curated context for one pull request or branch.
- `standalone-change`: important bounded work that does not need a plan.
- `release-summary`: a completed release cycle.

Lifecycle status is `planned`, `in-progress`, `blocked`, `implemented`, `verified`, or `superseded`.

## Change Plans

Name a new bundle `YYYYMMDDHHMMSSssss-short_name/`. It contains required `plan.md`, optional `findings.md`, optional `route-log.md`, and optional unchanged legacy `state.json` only when an older program produced one. Each of the three approved pilot plans keeps a `route-log.md` in the shape `docs/change-execution.md` defines; no other plan owes one. Scripts, probes, attempt evidence, and raw output stay uncommitted under `temp/changes/`, in a directory with the same name as this bundle. A plan may still reference and use other `temp/` paths where the work needs them.

A material long-running plan records append-only Intent Epochs for outcome, non-negotiables, acceptance, and effect boundary. Never edit or delete a recorded epoch; append a sourced epoch when intent changes. Keep current facts, unknowns, method, frontier, and the predicted Next Action in a clearly marked rewritable checkpoint.

When a bundle has `findings.md`, keep its `Follow-up Index` at the start and keep each item in the fixed `open`, `deferred`, or `closed` shape owned by `docs/change-execution.md`. The index is a non-table projection: unchecked entries are unresolved, and an entry first listed there remains checked after later work closes the same finding; historical checked-line retention is self-reported because the current-file validator has no prior snapshot.

Do not freeze a complete future work-package queue, role order, correction count, artifact inventory, or event budget. Historical matrices, queues, assignments, gates, and state remain evidence and carry no dispatch authority.

## Content And Closeout

Link relevant Core and accepted specifications. Preserve accepted product decisions and direct evidence; do not restate their contracts as plan authority. Keep findings non-authorizing until user intent or an accepted owner admits them.

At closeout, record the actual implementation, commits, exact verification, external effects, cleanup, unresolved findings, and residual risk. Every unresolved finding appears unchecked in the findings `Follow-up Index`; later closure checks that line, changes the item status, retains the append-only `Next action` history, and appends the closing verdict and closure evidence together. Promote durable decisions to their owner before anything depends on them.

Change records may be pruned after no current owner or active plan depends on them. Historical deletion must not make current intent or behavior ambiguous.

## Local Rules

Read `AGENTS.md` before editing records here.
