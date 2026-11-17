# Specifications

Flat design contracts (`docs/specs/YYYYMMDD-short_name.md`).

## Purpose

Specifications form the contract layer between [`docs/core/`](../core/README.md) and implementation under [`docs/change-execution.md`](../change-execution.md), stating verifiable rules, boundaries, wire/storage shapes, lifecycle invariants, recovery, and gaps so readers find current owners without reconstructing execution history.

## Find A Spec

Read `docs/core/<aspect>.md` first, then locate the specification by `aspect` in [`docs/INDEX.md`](../INDEX.md#specifications).

## Skeleton

[`docs/documentation-model.md`](../documentation-model.md#specifications) owns specification fields (`status`, `kind`, `implementation`, `aspect`), the single skeleton (`Scope`, contract sections, optional `Acceptance`, `Implementation`, `Implementation Gaps`, `Decisions`), deletion replacing archives, and link rules; [`docs/writing.md`](../writing.md) owns skeleton text and sweep rules; [`AGENTS.md`](AGENTS.md) holds local agent rules.
