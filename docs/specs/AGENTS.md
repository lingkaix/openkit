# Specifications

Read `README.md` first. This file contains only local agent execution rules for specifications.

## Local Agent Rules

- Keep active specs at the root of `docs/specs/` unless they are explicitly retired or superseded material.
- Do not leave stale, obsolete, or known-wrong information in an active spec in a way that can mislead future implementation or review.
- Update, supersede, or move obsolete specs with an explicit replacement link and status note.
- Do not use specs as task logs, release progress logs, or one-off implementation summaries.
- If a related design document does not exist and a change has meaningful design trade-offs, create or update a spec before implementation proceeds.
- Use `Status` for document authority and `Implementation` for implementation alignment. Do not use `Completed` as a spec status.

## Spec Boundary Rules

Specs are the contract layer between stable core documents and implementation.
When writing or updating a spec:

- Link to the relevant `docs/core/` documents instead of redefining their canonical concepts.
- State what the spec owns and does not own near the top of the document.
- Keep product vision, mission, and product-level principles out of specs unless the spec is explicitly projecting a core principle into an implementation contract.
- Keep release progress, task history, and one-off implementation summaries in `docs/changes/` or `docs/working_logs/`, not in active specs.
- Use cross-references when another active spec owns a related concept, protocol, or data shape.
- Do not let a current implementation detail become a core concept by implication.

## Required Structure For New Or Material Specs

New important specs and material updates should include these sections unless
there is a clear reason to omit one:

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

Small specs may omit irrelevant sections, but they must still include `Status`,
`Owns`, `Does Not Own`, `Core References`, `Summary`, and `Decision`.

Active specs with meaningful implementation impact should also include
`Implementation`.

Protocol, storage, data model, lifecycle, gateway, permission, identity,
metering, audit, runtime, or worker-facing specs should include
`Contract / Expected Behavior` and `Testing Strategy / Acceptance Criteria`.

Removal, migration, deprecation, or rollout specs should include
`Rollout / Migration Plan`.

## Status And Implementation Rules

`Status` describes whether the document is current guidance:

- `Draft`: proposed or still being shaped.
- `Accepted`: current guidance for implementation and review.
- `Deprecated`: still describes existing legacy or external interoperability behavior, but should not be extended as the future design direction.
- `Superseded`: replaced by another spec or stable core document and no longer active guidance.

`Implementation` describes how the current system relates to the spec contract:

- `Not Started`: the accepted contract has no meaningful implementation yet.
- `In Progress`: implementation work is actively underway.
- `Partial`: the system implements part of the contract, but acceptance criteria are not fully satisfied.
- `Implemented`: the system, tests, and current implementation projection are aligned with the spec contract.
- `Diverged`: the current system no longer matches the spec and the spec or implementation needs review.
- `N/A`: implementation alignment does not apply to this spec.

Rules:

- Do not mark a spec `Accepted` only because implementation is complete; mark it `Accepted` when the design contract is approved as current guidance.
- Do not mark a spec `Superseded` only because implementation has drifted; use `Implementation: Diverged` when the design is still intended to be current.
- Use `Status: Deprecated` when legacy or external interoperability behavior still exists but should not be extended.
- Use `Status: Superseded` when another spec or core document is the current source of guidance.
- When a diverged spec is reconciled, keep or restore `Status: Accepted` and set `Implementation` to the real alignment value.
- Superseded specs must link to their replacement or current guidance where possible.
- When editing an existing spec that has implementation progress in the `Status` line, split it into separate `Status` and `Implementation` fields.

## Contract Writing Rules

- Do not preserve repository-owned backward compatibility layers for old internal shapes, names, file layouts, route forms, command forms, schema defaults, or runtime selectors. Prefer clean replacement, direct removal, same-change migration, or repair tooling.
- Prefer verifiable language: `MUST`, `SHOULD`, and `MAY`, or direct equivalents such as "must", "should", and "may".
- Write normative rules as specific behavior, interface, lifecycle, state, error, permission, data, or recovery requirements.
- Keep examples clearly subordinate to rules.
- Put package names, endpoints, table names, file paths, and current implementation status under `Current Implementation Projection`.
- Mark unresolved current-scope design decisions as `Open Questions`.
- Mark important out-of-scope future material as `Deferred / Future Work`.
- Do not mix accepted contract text with speculative implementation notes.
- If a spec becomes the current owner of a contract previously spread across several specs, consolidate the active guidance and move older detail to `retired/` or `superseded/`.

## Open Questions Rules

`Open Questions` must be unresolved design decisions related to the current spec
contract. They are not a place for broad brainstorming, product philosophy,
general prompts, task lists, or release progress.

Use explicit markers:

- `[Blocking]`: must be answered before the spec can move from `Draft` to `Accepted`.
- `[Non-blocking]`: does not block the current contract, but may affect future extension or implementation choices.

Rules:

- Do not mark a spec `Accepted` while it still has `[Blocking]` open questions.
- If a question does not belong to the current spec or its related implementation, move it to `Deferred / Future Work`, another owning spec, a retired spec, or a change record.
- If a question is only meant to encourage thinking and has no decision owner, acceptance impact, or follow-up path, remove it from the spec.
- `Deferred / Future Work` must not change the meaning of the accepted contract.

## Retired And Superseded Handling

Use `docs/specs/retired/` for superseded specs that still contain useful field-level details, prior alternatives, edge cases, or implementation notes.

Retired specs are not active guidance. They MUST state `Status: Superseded` and link to the consolidated root-level spec or stable `docs/core/` document that replaced them.

Use `docs/specs/superseded/` for historical superseded specs that should not influence current product direction, release readiness, or implementation planning.

Historical superseded specs MUST state `Status: Superseded` and explain why they are retained. Prefer subfolders with explicit intent, such as `superseded/web-ui-pre-rebuild/`.

When several specs describe one strongly related contract, create one consolidated root-level spec and move the older files under `retired/`.

When a product surface is being intentionally rebuilt later, move the old slice specs under `superseded/` and create one root-level posture spec that explains the future direction.

Do not leave active docs pointing at moved historical specs as the current entry point. Active docs should link to the consolidated root-level spec first and only link to `retired/` or `superseded/` when historical detail is explicitly needed.

When moving specs between active, retired, and superseded locations, update replacement links in the moved files and keep the live file layout consistent with `README.md`.
