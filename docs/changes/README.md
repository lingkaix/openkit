# Change Records

This directory contains material change lifecycle records for important repository changes.

Use [`docs/change-tracking.md`](../change-tracking.md) as the canonical policy for when to create, update, and close change records.

## Purpose

- Preserve plans, related design links, execution checkpoints, final summaries, and verification context that would be hard to reconstruct from code diffs alone.
- Keep important PR, branch, standalone, and release context discoverable without turning this directory into a command transcript.
- Link material changes back to the relevant core docs, product docs, specs, working logs, PRs, branches, and commits.

## When To Write A Change Record

Create or update one change record when work is material enough to need future audit.

Typical triggers include cross-surface changes, protocol or API decisions, data layout work, rollout or migration risk, multi-agent work, long-running execution, or a curated release summary.

Do not create change records for routine implementation steps, temporary fixes, test-only follow-ups, mechanical renames, or intermediate long-run progress that belongs in `docs/working_logs/`.

## Record Types

- `change-plan`: lifecycle record for major or significant planned work.
- `pr-summary`: curated summary for one pull request or branch.
- `standalone-change`: small but important change that does not need a full spec.
- `release-summary`: curated summary for a completed long-run release cycle.

## Status Values

- `planned`: the change is planned but implementation has not started.
- `in-progress`: implementation is underway.
- `blocked`: implementation cannot proceed until a named blocker is resolved.
- `implemented`: implementation is complete but final verification or review is still pending.
- `verified`: implementation and final verification are complete.
- `superseded`: another change record, spec, or decision replaced this record.

## Filename Convention

Use a fixed-width sortable timestamp and short slug:

```text
YYYYMMDDHHMMSSssss-short_name.md
```

Example:

```text
202602142008590001-ui_refactor.md
```

## Required Links

Every material change record must link relevant design context, especially:

- `docs/core/architecture.md`
- `docs/core/work-model.md`
- `docs/product-vision.md`
- relevant `docs/core/*.md`
- relevant `docs/specs/*.md`
- relevant `docs/working_logs/...` archives

## Local Agent Rules

See [`AGENTS.md`](./AGENTS.md) for local execution rules that apply when creating, moving, updating, or closing change records.
