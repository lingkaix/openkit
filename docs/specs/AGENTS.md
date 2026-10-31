# Specifications

Read `README.md` first. This file contains only local agent execution rules for specifications. The [2026-10-31 rulings](../decisions/20261031-reserved_audit_question_rulings.md) record this editorial boundary.

## Local Agent Rules

- Keep active specs at the root of `docs/specs/`; keep terminal specs only in the directory matching their canonical status.
- Do not leave stale, obsolete, or known-wrong information in an active spec in a way that can mislead future implementation or review.
- Update an obsolete active spec in place only while it remains active or Deprecated.
- Do not use specs as task logs, release progress logs, or one-off implementation summaries.
- If a related design document does not exist and a change has meaningful design trade-offs, create or update a spec before implementation proceeds.
- Use `Status` for document authority and `Implementation` for implementation alignment. Do not use `Completed` as a spec status.

## Spec Boundary Rules

`README.md` owns the contract-layer role of specifications. When writing or updating a spec:

- Link to the relevant `docs/core/` documents instead of redefining their canonical concepts.
- State what the spec owns and does not own near the top of the document.
- Keep product vision, mission, and product-level principles out of specs unless the spec is explicitly projecting a core principle into an implementation contract.
- Keep durable release context and implementation summaries in `docs/changes/`, and noisy progress in uncommitted working space, not in active specs.
- Use cross-references when another active spec owns a related concept, protocol, or data shape.
- Do not let a current implementation detail become a core concept by implication.

## Required Structure For New Or Material Specs

New important specs and material updates should include these sections unless there is a clear reason to omit one:

- `Status`
- `Implementation`
- `Owns`
- `Does Not Own`
- `Core References`
- `Summary`
- `Goals / Non-goals`
- `Background`
- `Decision`
- `Contract / Expected Behavior`
- `Proposed Design`
- `Current Implementation Projection`
- `Alternatives Considered`
- `Consequences`
- `Rollout / Migration Plan`
- `Testing Strategy / Acceptance Criteria`
- `Risks & Mitigations`
- `Open Questions`
- `Deferred / Future Work`
- `Links`

Small specs may omit irrelevant sections, but they must still include `Status`, `Owns`, `Does Not Own`, `Core References`, `Summary`, and `Decision`.

Every spec must include `Implementation` using one exact value defined in `README.md`.

Protocol, storage, data model, lifecycle, gateway, permission, identity, metering, audit, runtime, or worker-facing specs should include `Contract / Expected Behavior` and `Testing Strategy / Acceptance Criteria`.

Removal, migration, deprecation, or rollout specs should include `Rollout / Migration Plan`.

## Status And Implementation Rules

`README.md` owns status values, implementation values, lifecycle transitions, archive directories, required metadata, and evidence. Do not restate or extend its enums in an individual spec.

- Do not mark a spec `Accepted` only because implementation is complete; mark it `Accepted` when the design contract is approved as current guidance.
- Do not mark a spec `Superseded` only because implementation has drifted; use `Implementation: Diverged` when the design is still intended to be current.
- Use `Status: Deprecated` when legacy or external interoperability behavior still exists but should not be extended.
- Use `Status: Superseded` only when a named current authority continues or absorbs the old contract or substantive proposal.
- Use `Status: Retired` when the old contract, module, capability, or product direction ended without a successor contract, including a deliberate reset.
- Use `Status: Rejected` when a proposal was declined before it became current guidance.
- When a diverged spec is reconciled, keep or restore `Status: Accepted` and set `Implementation` to the real alignment value.
- Do not treat the existence of later work in the same area as proof of supersession; verify contract continuity from current guidance and decision evidence.
- Do not move or relabel a terminal spec until its lifecycle reason and decision evidence are trustworthy.
- When editing an existing spec that has implementation progress in the `Status` line, split it into separate `Status` and `Implementation` fields.

## Contract Writing Rules

- Do not preserve repository-owned backward compatibility layers for old shapes of first-party surfaces that ship with each release, such as names, repository file layouts, route forms, command forms, schema defaults, or runtime selectors. Prefer clean replacement, direct removal, same-change migration, or repair tooling. Retained data keeps its continuity under `docs/core/contract-evolution.md`; see `README.md`.
- Prefer verifiable language: `MUST`, `SHOULD`, and `MAY`, or direct equivalents such as "must", "should", and "may".
- Write normative rules as specific behavior, interface, lifecycle, state, error, permission, data, or recovery requirements.
- Keep examples clearly subordinate to rules.
- Put package names, endpoints, table names, file paths, and current implementation status under `Current Implementation Projection`.
- Mark unresolved current-scope design decisions as `Open Questions`.
- Mark important out-of-scope future material as `Deferred / Future Work`.
- Do not mix accepted contract text with speculative implementation notes.
- If a spec becomes the current owner of a contract previously spread across several specs, consolidate the active guidance and archive the older contracts under `superseded/` with evidence.

## Open Questions Rules

`Open Questions` must be unresolved design decisions related to the current spec contract. They are not a place for broad brainstorming, product philosophy, general prompts, task lists, or release progress.

Use explicit markers:

- `[Blocking]`: must be answered before the spec can move from `Draft` to `Accepted`.
- `[Non-blocking]`: does not block the current contract, but may affect future extension or implementation choices.

Rules:

- Do not mark a spec `Accepted` while it still has `[Blocking]` open questions.
- If a question does not belong to the current spec or its related implementation, move it to `Deferred / Future Work`, another owning spec, a retired spec, or a change record.
- If a question is only meant to encourage thinking and has no decision owner, acceptance impact, or follow-up path, remove it from the spec.
- `Deferred / Future Work` must not change the meaning of the accepted contract.

## Archived Spec Handling

Terminal archive, directory placement, metadata, and freeze are owned by [Documentation Model](../documentation-model.md#terminal-archive-audit-and-archive-immutability) and [README](README.md#active-and-archived-specs).

- When several specs describe one strongly related contract, create one consolidated root-level spec and move absorbed older contracts under `superseded/`.
- Do not leave active docs pointing at archived specs as the current entry point. Active docs should link to current guidance first and only link to archived specs when historical detail is explicitly needed.
- When moving specs between active and archived locations, update inbound and outbound links and keep the live file layout consistent with `README.md`.
