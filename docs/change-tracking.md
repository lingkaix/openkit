# Change Tracking

This document defines how OpenKit records material decisions, planned implementation changes, in-flight agent progress, and long-run release work.

The goal is to keep future context discoverable by preserving the plan, related design links, execution checkpoints, and final summary for major changes without turning every repository task into an implementation diary.

## Directory Ownership

`docs/core/` owns stable core model decisions.

Use it for concepts and protocol boundaries that should not change casually.

`docs/specs/` owns non-trivial design decisions.

Use it for architecture, protocol, public API, workflow, data layout, migration, rollout, compatibility, and trade-off records.

`docs/changes/` owns material change lifecycle records.

Use it for major or significant changes that need a durable change plan, curated tracking checkpoints, a final implementation summary, or a PR, standalone, or release-level record that future maintainers should find quickly.

Every material change record MUST link related documents that explain the surrounding model, product intent, or design constraints. Include applicable core architecture and product design documents such as `docs/core/architecture.md`, `docs/core/work-model.md`, and `docs/product-vision.md`, plus relevant `docs/core/*.md`, `docs/specs/*.md`, and archived `docs/working_logs/...` entries.

`docs/working_logs/` owns archived long-run execution records.

Use it for release PRDs, machine-readable task lists, and progress logs after a large agent-driven cycle is complete.

## Write Triggers

Write or update a spec when a change has meaningful alternatives, long-term consequences, migration concerns, or protocol/API impact.

Create a change plan before starting a major or significant change when the work crosses app or package boundaries, affects protocol, API, data, product workflow, or architecture, requires multi-agent or long-running execution, carries rollout or migration risk, or is likely to need future audit.

Write or update a change record when a PR, branch, standalone change, or release cycle has context that should survive beyond the commit diff.

Archive a working log when a release or focused long-run cycle used release-specific root files such as `prd.json` and `progress.txt`.

Do not write a change record for every user story, routine task, intermediate agent step, mechanical rename, or test-only adjustment.

## Material Change Lifecycle

Start major work by creating a `change-plan` record under `docs/changes/` before implementation begins.

The initial record MUST state intent, scope, non-goals, related core architecture docs, product design docs, specs, impacted surfaces, execution plan, verification plan, expected handoff points, and known risks.

During implementation, update the same record only at meaningful checkpoints.

Checkpoint entries SHOULD capture completed phases, scope changes, important deviations from the plan, new decisions, blockers, agent handoffs, verification results, and links to commits or PRs.

Do not use the tracking log as a command transcript or per-file implementation diary.

When implementation finishes, close the same record with an implementation summary, final verification evidence, remaining follow-ups, and links to final commits, branches, PRs, specs, and working logs.

If execution discovers durable design guidance, promote that guidance to `docs/specs/` or `docs/core/` and link the promoted document from the change record.

## Long-Run Release Flow

During a long-run release, keep high-signal plan and checkpoint context in the change record, and keep noisy execution detail in the release PRD, task list, and progress log.

After release verification, move those files into `docs/working_logs/YYYY-MM-DD-openkit-vX-X-X/`.

If the release contains material decisions, create or complete one `release-summary` or `change-plan` record in `docs/changes/` that links to the archived working log, relevant core and product docs, and any relevant specs.

If a release decision is durable design guidance, promote it to `docs/specs/` or `docs/core/` instead of leaving it only in `progress.txt`.

## PR and Commit Linkage

For a material PR that did not require a pre-existing change plan, prefer one `pr-summary` change record that links the PR, important commits, related core docs, product docs, specs, and verification evidence.

For a major branch or PR that started from a change plan, keep the existing `change-plan` record as the canonical lifecycle record and complete its final summary instead of creating a duplicate PR summary.

For a small but important direct commit or commit group, write one `standalone-change` record when a full spec would be too heavy.

For commits inside a long-run release, do not create per-commit change records unless the commit introduces an independent decision that future work must preserve.

## Review Checklist

Before finishing documentation or implementation work, check:

- Stable core model changes are reflected in `docs/core/`.
- Non-trivial design choices are captured in `docs/specs/`.
- Material change plans, PR summaries, standalone changes, or release context are captured in `docs/changes/` when they are useful.
- Long-run release artifacts are archived in `docs/working_logs/`.
- Links between core docs, product docs, specs, change records, working logs, PRs, and commits are current.
