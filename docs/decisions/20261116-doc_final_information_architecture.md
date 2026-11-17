---
status: Accepted
date: "2026-11-16"
decider: "Engineer, delegated to the DOC-FINAL ruling of 2026-11-16"
---
# DOC-FINAL Information Architecture

## Decision

The repository documentation corpus adopts a simplified information architecture, one specification skeleton, and governance rules `G1` through `G12`:

1. **Basis (`P1`–`P6`)**: Every document exists for a reader who builds, operates, verifies, or changes the system; text that no reader or check acts on is deleted (`P1`). One fact has one owner, and every other document links to it (`P2`). Truth is code on `main` plus accepted rules: a document states the rule, states the gap where `main` does not meet it, and never narrates what code does (`P3`). Documents speak in the present while Git holds history, rationale trails, rollout stories, and superseded versions (`P4`). A rule that no reader procedure and no check uses is ceremony and is removed or made checkable (`P5`). File paths stay stable unless a reader gains from a rename (`P6`).
2. **Target family architecture**: Each sentence belongs to the family whose question it answers (`Intent`, `Core`, `Specification`, `Decision record`, `Guide`, `Cookbook` and `Manual`, `Governance`, `Platform reference`, transient `Evidence`, and `Generated index`). Core documents (`10–40 KB`) hold stable invariants without concrete wire schemas, endpoints, file paths, release staging labels, or non-contract numbers. Specifications (`docs/specs/YYYYMMDD-short_name.md`) are flat.
3. **Single specification skeleton (`G4`)**: Every specification has frontmatter (`status`, `kind`, `implementation`, `aspect`), `# Title`, one opening ownership paragraph, `## Scope` (`Owns`, `Does not own` in at most 5 lines naming each owner, and `Core` links), subject contract sections (`MUST` rules and closed-set tables), optional `## Acceptance` (real-environment or level criteria not already in a contract sentence, with no test filenames), `## Implementation` (at most 10 lines of directory pointers, no behavior text or `file:line`), `## Implementation Gaps`, and `## Decisions` (links only). Ceremony, history, and duplicate projection sections (`Summary`, `Goals`, `Non-goals`, `Background`, `Alternatives Considered`, `Consequences`, `Risks`, completed `Rollout / Migration`, `Resolved Decisions`, `Open Questions`, `Deferred / Future Work`, `Links / Related Docs`, `Current Implementation Projection`, and `Testing` lists) are removed after moving every criterion sentence into a kept section (`DOC-015`).
4. **Governance simplifications (`G1`–`G12`)**:
   - `G1`: Deletion replaces the terminal archive. A replaced or ended specification is deleted in the change that lands its replacement or removal, superseding the terminal lifecycle rules (`Deprecated`, `Superseded`, `Retired`, `Rejected`), both archive directories, the terminal-archive audit, the archive byte-freeze rule, and the frozen-referrer resolver. Commit `25d32dbc3` is the last SHA holding the old archived specification and evidence corpus.
   - `G2`: Specification `status` is `Draft` or `Accepted`; `implementation` is `Implemented`, `Partial`, or `Not Started`.
   - `G3`: Specification frontmatter is `status`, `kind`, `implementation`, and `aspect`, removing `date`, `updated`, `status-changed`, `current-guidance`, and `decision-evidence`. Core documents drop `updated`.
   - `G4`: `## Implementation Gaps` is the only statement of implementation state (`implementation: Implemented` if and only if `Implementation Gaps` is `None.`; otherwise each unmet rule is one line carrying `#<issue>`).
   - `G5`: Change records and audit records are transient working evidence deleted at closeout (at the latest in the next release change) once status is terminal, open/deferred findings are GitHub issues, and durable results are in their owners; live plans, the DOC-FINAL final audit record, and records read by scripts, tests, cookbooks, Skills, or acceptance steps remain. The append-only `Intent Revision` rule applies while work is open.
   - `G6`: The `aspect` field and generated aspect grouping in `docs/INDEX.md` replace the hand-maintained specification list in `docs/specs/README.md`.
   - `G7`: Decision record text is immutable after acceptance; a deleted link target may be repaired mechanically (repointed to the replacement or unlinked to plain text), with no historical backfill or consolidation.
   - `G8`: Document size is a signal, never a gate or validator cap (typical specification `15–60 KB`; specifications over `80 KB` after trimming, excluding registers, receive a duplication report).
   - `G9`: `docs/documentation-model.md` is the single owner of document rules and absorbs the documentation field contract specification; `docs/writing.md` owns specification skeleton text rules and cross-corpus sweep rules.
   - `G10`: Every deferral or open design question becomes a GitHub issue; `Accepted` specifications have no `Open Questions` or `Deferred / Future Work` sections.
   - `G11`: Cross-reference rules reduce to three: Core does not link specifications; Core, specifications, and decision records do not link evidence; no link resolves to a deleted or missing path.
   - `G12`: Default doc-versus-code resolution adds omitted code-level contract facts to documents, aligns unbacked non-retained first-party wire/UI shapes with code, keeps decision- or Core-backed rules that code violates as `Implementation Gaps` with `IMPL-FIX` issues, escalates retained-data/security/authorization/scope differences to the decider, and leaves below-contract internals undocumented (`DOC-002`). Rewrites and merges use a verified criterion inventory (`implemented`, `gap`, `draft-only`), and tooling `T1`–`T4` enforces `aspect` grouping, enum/archive shrinkage, `Implementation Gaps` alignment, and guide/`Implementation` path existence.

## Reason

Across 104 active specifications, 67 archived specifications (`877 KB`), and `5.3 MB` of change and audit evidence, duplicated projections (`~540 KB`), ceremony sections (`~500 KB`), hand-maintained indexes, and frozen terminal archives imposed high context cost and continual drift without helping a reader build, operate, verify, or change the system. Consolidating onto one owner per rule, one specification skeleton, issue-backed `Implementation Gaps`, and Git history for retired artifacts preserves every normative criterion (`DOC-015`) while removing unacted-on ceremony.

## Rejected Alternatives

- Retaining the 67 archived specifications, terminal status directories, terminal-archive audits, and byte-freeze rules in the working tree.
- Keeping six specification statuses (`Deprecated`, `Superseded`, `Retired`, `Rejected`), six implementation values (`In Progress`, `Diverged`, `N/A`), and date/transition frontmatter fields.
- Keeping narrative `Current Implementation Projection` sections and ceremony headings (`Summary`, `Goals`, `Non-goals`, `Background`, `Alternatives Considered`, `Consequences`, `Risks`, `Open Questions`, `Deferred / Future Work`, `Related Docs`) in specifications.
- Enforcing a fixed word-count cap or split gate on specifications.
- Keeping closed change plans and historical audit records permanently in `docs/changes/` and `docs/audits/`.

## Revisit When

Revisit if a sampled rebuild probe, verification calibration cycle, or repeated maintenance observation demonstrates that the specification skeleton, aspect-grouped index, or Git-backed archive deletion loses required criteria or impedes owner discovery.

## Affected Owners

- `docs/documentation-model.md`
- `docs/writing.md`
- `docs/change-execution.md`
- `docs/specs/README.md`
- `docs/specs/AGENTS.md`
- `docs/INDEX.md`
