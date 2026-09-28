# Findings

These observations are non-authorizing evidence from the independent Claude Code Auditor and direct execution. Existing owners and engineer intent decide their disposition.

## Follow-up Index

- [x] `QUALITY-FND-001` [closed] Round evidence location
- [x] `QUALITY-FND-002` [closed] Exact Round 0 command provenance
- [x] `QUALITY-FND-003` [closed] Duplicate DRY explanation
- [ ] `QUALITY-FND-004` [open] Existing Composer import-error visibility gap
- [ ] `QUALITY-FND-005` [open] Existing operations Skill archive-reference failure
- [ ] `QUALITY-FND-006` [open] Adjacent attention-route encoding candidate

## [closed] QUALITY-FND-001 — Round evidence location

- **Observation:** The Round 0 Auditor found no same-name temporary directory for the change bundle.
- **Impact:** A future reader entering by plan identity could miss the raw evidence.
- **Evidence:** `temp/quality-governance/evidence/round-00-audit.txt`, finding F1.
- **Owner:** `docs/change-execution.md` and `docs/changes/README.md`.
- **Next action:** Opened from the Round 0 audit. Primary moved the evidence directory into `temp/changes/202609220000000001-engineering_quality_pilot/` and retained the previous work-package path as a relative symlink. Closed after inspecting both paths.
- **Closing verdict:** The evidence now follows the plan identity without duplicating raw records or breaking existing work-package links.
- **Closure evidence:** The same-name temporary directory and `temp/quality-governance/evidence` symlink resolve to the same files.

## [closed] QUALITY-FND-002 — Exact Round 0 command provenance

- **Observation:** The first Round 0 output omitted invocation text and the broader corpus-budget check.
- **Impact:** The output alone was insufficient to reproduce the claimed check scope.
- **Evidence:** `temp/quality-governance/evidence/round-00-audit.txt`, finding F2.
- **Owner:** Root `AGENTS.md` CHECK-019.
- **Next action:** Opened from the Round 0 audit. Primary reran the four governing test files, document validators, index check, word count, and whitespace check with command tracing and pinned versions. Closed after the exact output showed success.
- **Closing verdict:** The corrected evidence retains invocations and observed outcomes; the initial incomplete record remains historical.
- **Closure evidence:** `temp/quality-governance/evidence/round-00-final-checks.txt`; 100 tests passed and all named validators exited successfully.

## [closed] QUALITY-FND-003 — Duplicate DRY explanation

- **Observation:** The new QUALITY-001 sentence repeated QUALITY-003's existing prohibition on deduplicating merely similar code.
- **Impact:** Two adjacent statements would maintain the same practical rule.
- **Evidence:** `temp/quality-governance/evidence/round-00-audit.txt`, finding F3; direct before/after root diff.
- **Owner:** Root `AGENTS.md` QUALITY-001 and QUALITY-003.
- **Next action:** Opened from the Round 0 audit. Primary removed the duplicated explanatory clause while retaining explicit DRY and the new SOLID applicability guidance. Closed after the final diff and contract checks.
- **Closing verdict:** The existing prohibition remains in QUALITY-003 and the requested principle remains named.
- **Closure evidence:** `AGENTS.md` actual diff and `temp/quality-governance/evidence/round-00-final-checks.txt`.

## [open] QUALITY-FND-004 — Existing Composer import-error visibility gap

- **Observation:** Both fresh discovery contexts identified that Composer catches import failures while its two screen callers provide no import-specific error display. Source inspection confirms the same behavior in the baseline and candidate; the cleanup preserves rejection and draft retention but does not repair the missing feedback.
- **Impact:** A failed file read or import can leave the draft intact without explaining the failure to the user. Successful characterization tests do not prove complete conformance to the owning Composer specification.
- **Evidence:** `apps/web/src/primitives/Composer.tsx` importFile catch, `apps/web/src/screens/chat/ChatStarter.tsx` and `ThreadScreen.tsx` import callers; `temp/quality-governance/evidence/discovery/session-one-answer.md` and `session-two-answer.md`.
- **Owner:** `docs/specs/20260831-unified_conversation_composer.md` and `docs/specs/20260713-work_resource_interaction_model.md`.
- **Next action:** Retain this baseline finding for a separately bounded behavior-fix slice with an observable error-display regression. Do not silently add product behavior to the current behavior-preserving extraction or treat this finding as a regression introduced by it.

## [open] QUALITY-FND-005 — Existing operations Skill archive-reference failure

- **Observation:** Two existing packaging tests reject the operations Skill reference from `skills/openkit-ops/references/nanocore-data-root-config.en.md` to `../../openkit/references/administration.md`, which escapes the packaged envelope. Both fail before and after Round 6 with the same diagnostic.
- **Impact:** Those standalone operations Skill verification paths remain failing. This cleanup cannot claim release readiness; the issue is separate from the six archive-creation failures caused by unavailable GNU tar.
- **Evidence:** `tests/package-release-assets.test.mjs` cases for repository-archive verification outside the checkout and stdin module import; `temp/quality-governance/evidence/round-06-before.txt`, `round-06-after.txt`, and `round-06-compare.mjs`.
- **Owner:** `docs/specs/20260829-release_management.md` and `docs/specs/20260910-agent_operator_skill.md`.
- **Next action:** Repair the reference within the accepted standalone Skill packaging boundary in a separate scoped fix, then rerun both existing tests. Preserve the failing checks and do not silently broaden the current lineage-guard deletion.

## [open] QUALITY-FND-006 — Adjacent attention-route encoding candidate

- **Observation:** The Pair 3 Auditor found Goal links in `apps/web/src/screens/workspace/data.ts` that interpolate owner identifiers without encodeURIComponent. These attention-specific routes were not among Round 5's three activity-based destinations and remain unchanged.
- **Impact:** If an admitted identifier contains a URL delimiter, the generated link may not preserve its owner tuple. This is a candidate requiring identifier-contract and consumer verification, not a demonstrated regression from the cleanup.
- **Evidence:** `openHrefForRow` in `apps/web/src/screens/workspace/data.ts`; `temp/quality-governance/evidence/pair-03-audit.txt`, final scope observation.
- **Owner:** `docs/specs/20260628-web_product_surface_projection.md` and the owning attention/Goal route contracts.
- **Next action:** Check admitted identifiers and all attention-route consumers before deciding a separately bounded route fix. Do not equate attention navigation with conversation activity or merge their rules based on similar URL text.
