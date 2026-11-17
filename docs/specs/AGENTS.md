# Specifications

Read [`README.md`](README.md) and [`docs/documentation-model.md`](../documentation-model.md#specifications) first. This file contains only local agent execution rules for `docs/specs/`. The [2026-10-31 rulings](../decisions/20261031-reserved_audit_question_rulings.md) and [DOC-FINAL Information Architecture](../decisions/20261116-doc_final_information_architecture.md) record this boundary.

## Local Agent Rules

- Keep all specifications flat at the root of `docs/specs/YYYYMMDD-short_name.md`.
- When a specification is replaced or ended, delete it in the same change that lands its replacement and repoint or unlink every inbound reference (**G1**); do not create or move files into archive subdirectories.
- Every specification frontmatter block declares `status` (`Draft` or `Accepted`), `kind` (`concept`, `boundary`, `mechanism`, `topology`, or `process`), `implementation` (`Implemented`, `Partial`, or `Not Started`), and `aspect` (a Core aspect basename or `process`) (**G2**, **G3**). Do not use `Completed` as a status or add date/transition metadata fields.
- Structure every new or edited specification to the single skeleton in [`docs/documentation-model.md`](../documentation-model.md#skeleton) (**G4**): opening ownership paragraph, `## Scope`, subject contract sections, optional `## Acceptance`, `## Implementation` (at most 10 lines of directory pointers), `## Implementation Gaps`, and `## Decisions`.
- Before deleting any ceremony, history, or projection section, move every sentence carrying a criterion (`MUST`, closed set, number, retained field, refusal, owner assignment) into a kept contract or acceptance section (`DOC-015`).
- Set `implementation: Implemented` if and only if `## Implementation Gaps` is `None.`; otherwise list one line per unmet rule with an issue number (`<rule> - <gap> - #<issue>`), and update both in the same change whenever a gap opens or closes.
- Do not include `Open Questions` or `Deferred / Future Work` sections in an `Accepted` specification; file deferrals and open design questions as GitHub issues (**G10**).
- Link to [`docs/core/`](../core/README.md) documents and peer specifications instead of restating their rules, follow [`docs/writing.md`](../writing.md) for skeleton text and sweep rules (`R-SCHEMA`, `R-NUM`, `R-LABEL`, `R-DIGEST`, `R-TIME`), and follow [`docs/core/contract-evolution.md`](../core/contract-evolution.md) for retained-data continuity and first-party surface replacement.
- Keep execution plans and working evidence in `docs/changes/` or uncommitted `temp/` space, never in `docs/specs/`, and never link from a specification to `docs/changes/` or `docs/audits/` (**G11**).
- After adding, deleting, or editing a specification, run `node scripts/generate-doc-index.mjs`, `node scripts/validate-doc-model.mjs`, and `node scripts/validate-spec-lifecycle.mjs`.
