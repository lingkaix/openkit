---
type: change-plan
status: implemented
date: "2026-10-19"
---
# Workspace Backup, Restore, And Move Design

## Intent Revision 1

Source: the engineer's 2026-10-19 direction, translated from Chinese. Each Workspace must support separate backup, restore, and movement between deployments. Complete the design now. Estimate implementation size and recommend its release placement. Keep analytical export separate. Change documentation only; do not change source, tests, configuration, agent contracts, or Product Vision. Do not dispatch agents or push.

## Intent Revision 2

Source: the engineer's delegated coordination direction on 2026-10-19. Ship minimal local hot backup, verified restore, and an operator-driven offline move before `v0.1.0`. Reuse the control-store design's snapshot, garbage-collection protection, staged-open, and quarantine primitives. Preserve move identities. Seal the move and mark the source moved-out in one local step. Do not add a cross-server acknowledgement protocol. An explicit administrator reactivation resolves an abandoned move. The importing administrator selects the owner and optional exact account mappings; drop and report unmapped members. Disable imported automation and executable bindings. Exclude Worker volumes by default. Defer copy/remint, remote synchronization, optional native-volume continuity, and whole-server hot-backup changes.

## Intent Revision 3

Source: the delegated coordination instruction on 2026-10-19 after independent review. Correct B1 by serializing source finalization/return with abandonment/reactivation and checking current capture rights. Correct M1 through explicit administrator-acknowledged restricted recovery when current Workspace safety authority is lost; report the unprovable window and disable automatic/executable bindings until re-admission. Correct M2 through exact target request/candidate ownership, finish, and fenced discard. Extend the existing fixture with both source interleavings, lost-current-database recovery, target pre-registration retry, opaque MCP writers, in-flight app effects, and Notebook pruning/repack. Add a bounded operator contract. Move detailed estimates here, keep the specification no longer, and preserve all safety boundaries. Commit separately without amendment, attribution, push, or agents.

## Owners And Scope

- [Operational specification](../../specs/20260704-workspace_backup_export_import.md): backup, restore, move, acceptance, and release prerequisites.
- [Local recovery decision](../../decisions/20261019-restricted_recovery_and_local_move_recovery.md): the accepted restricted-recovery limitation and source/target recovery corrections. The earlier accepted decision record remains unchanged.
- [Decision record](../../decisions/20261019-workspace_backup_restore_move.md): source, rationale, accepted release scope, alternatives, and limitations.
- [Control-store design](../../specs/20261019-durable_execution_and_control_store.md): layout, execution settlement, snapshots, and failure scope. Its author owns that specification; this change does not edit it.
- [Storage Service](../../specs/20261018-file_storage_and_knowledge_packages.md): existing content references and byte operations, not a new backup backend.
- Existing analytical export/import and whole-server recovery retain their separate contracts and regression obligations.

## Working Checkpoint

The original size recommendation assumed a larger transfer workflow. Intent Revision 2 removes that workflow and selects the minimal capability for the first stable release. Source inspection found whole-root backup, exact inventory verification, bounded archive staging, and clone/remint import. Those implementations provide primitives, not an implemented identity-preserving operational move.

The layout specification exists in a separate design branch, not this branch. Its snapshot-closure contract is the receiver for canonical placement and external-reference classification. Every mutable Workspace authority must be captured under quiescence or its owner's snapshot rule. Notebook history, Light App databases, authored configuration, and mutable catalog process data are explicit coverage requirements. The engineer confirmed that retained model I/O blobs and native transcripts enter the Workspace immutable-content closure.

Produced artifacts: one amended operational specification, one accepted decision record, and this execution record. The bounded acceptance design covers the requested positive move and negative cases. The diff changes documentation only. The coordinator explicitly directed dependency-order integration and authorized retaining only the missing-layout-link check failure on this branch. No layout file was copied, no link was removed to obtain green, and no existing analytical import criterion was intentionally weakened.

Independent review returned ACCEPT WITH FIXES on the first producer commit and withheld acceptance pending B1 and the major findings. The coordinator supplied the restricted-recovery decision and required the corrections in Intent Revision 3. The follow-up is documentation only; no agents are started here. Final acceptance of the corrected artifact remains with the coordinator. Structural checks do not prove runtime safety.

## Rewrite Traceability

- Current Product Boundary: activate detailed Workspace recovery and retain analytical export's separate purpose and Goal exclusions.
- Summary, Goals, Decision, and Personal Data: replace whole-root-only recovery wording with the per-Workspace boundary; preserve analytical import ownership/remint rules and secret exclusions.
- Backup And Restore: retain existing whole-server cold/hot/restore guarantees in a named subsection; add the per-Workspace snapshot, seal, and restore contracts.
- Generative App coverage: distinguish existing whole-server capture from the new per-Workspace snapshot closure; preserve definition, schema, digest, and presentation checks.
- Accepted Design and implementation projection: distinguish the operational target from the current export/import implementation.
- Risks, Deferred Work, and testing: retain existing analytical crash-window criteria; add mandatory pre-release operational acceptance and explicitly deferred extensions.

## Follow-Up Traceability

- B1: Source Seal And Moved-Out State now requires a shared operation fence, current revision/identity/digest/right checks, and durable revocation/local retirement before reopening. Acceptance covers both fence orders and restart.
- M1: Same-Deployment Restore names explicit restricted recovery, possible loss of post-capture Workspace safety facts, current server authority, disabled bindings, Audit/report window, and re-admission. The supplemental decision records the accepted limitation without changing the earlier accepted record.
- M2: Target Admission And Rebinding defines the request key/fingerprint, result-first lookup, exact-owned-candidate finish, changed/unrelated conflict, and fenced discard. Acceptance covers placement-before-registration crash retry and result replay.
- m1: The same fixture now includes active mutable MCP data without freeze/flush proof, an in-flight app effect at the common cut, and Notebook pruning/repack during the GC race.
- m2: Operator Contract names capture, inspect/finish/abandon, restore, move mapping, revision-checked reactivation, next-action reports, and ONE destination per move bundle.
- Deletions: detailed estimates and source reuse pointers move below; the specification keeps release prerequisites and a concise reuse boundary. Duplicate offline-exclusivity explanation is removed; actual operator preconditions remain.

## Implementation Estimate And Prerequisites

These are planning estimates, not normative implementation limits. The review found the original 8-14 additional engineer-days plausible but optimistic only after shared primitives are implemented and fault-tested. Lower-layer crash coverage is a prerequisite for the combined fixture estimate. Re-estimate after the B1/M1/M2 interfaces and shared primitives are qualified; no runtime work was measured here. Counts overlap.

| Increment | Production files/modules and tests | Additional engineer-days | Release |
| --- | --- | --- | --- |
| Local hot backup, verify, seal | 3-4 production files/modules; 3-5 suites | 2-3 | `v0.1.0` |
| Same-deployment restore/quarantine | 3-5 production files/modules; 4-6 suites | 2-4 | `v0.1.0` |
| Offline MOVE, mapping/report, disabled activation | 4-6 production files/modules; 4-6 suites | 3-5 | `v0.1.0` |
| Combined two-deployment/fault fixture | 2-3 test/support files; lower-layer cases above | 1-2 | `v0.1.0` |

Prerequisites: qualify the common-cut gate across control/app/MCP writers, durable snapshot/GC protection including Git repack, staged existing-only open and scoped quarantine, source finalization/reactivation fencing, target request/provenance ownership, and current-authority admission. Ownership text alone proves no ready API. This estimate excludes the control-store replacement, COPY, remote sync, native-volume continuity, and whole-server redesign.

Source reuse candidates: `storage/workspace-archive.ts` supplies confined USTAR paths/private staging; `storage/workspace-export.ts` supplies exact inventory/content-digest verification rules; `storage/data-root-backup.ts` supplies inventory and the public SQLite backup-API pattern; existing canonical path publication supplies durable placement. Adapt these primitives for the distinct backup manifest, not the V3 parser.

Retire global synchronous tree-copy pause and whole-root replacement from the new Workspace path only. Replace its equivalent of `storage/workspace-transfer-routes.ts`'s synchronous cross-store compensation with complete staged registration/quarantine. `storage/workspace-import.ts`'s remint graph remains for existing analytical import and later COPY, never MOVE. Existing analytical/whole-server behaviors and regression obligations remain.

## Verification And Review

The follow-up keeps the specification at 654 lines and reduces it from 18,462 to 18,460 whitespace-delimited words. Detailed estimates/reuse evidence now live here. A supplemental accepted decision records restricted recovery and local move recovery; the earlier accepted decision remains byte-identical. Both source-fence orders, lost-current-database acknowledgement, exact owned-candidate finish/discard, and the common-cut fixture additions are explicit acceptance predicates. This is a design correction, not execution of those runtime tests.

Final focused checks used the pinned Node `24.18.0`. `node scripts/validate-spec-lifecycle.mjs` exited 0 with `Validated spec lifecycle metadata.`. `node scripts/generate-doc-index.mjs --check` exited 0 with `Documentation index is current.`. `git diff --check` exited 0. `node scripts/validate-doc-model.mjs` exited 1 with exactly four missing-link diagnostics, all for the separate control-store specification: one in this record, one in the decision, and two in the operational specification. The coordinator owns dependency integration and the joined rerun; this is not a document-model pass.

Initial probes failed before validation because this worktree lacked existing `yaml` and `zod` dependencies. Ignored local links to the existing installed packages resolved setup without package or lockfile changes. No production tests, implementation, live deployment, or external transfer ran. No agents were dispatched and no push was made.

Producer inspection covered actual changed paragraphs, removed criteria, seal ordering, the bounded acceptance set, and private-text patterns. The specification already exceeds the writing guide's split-review trigger; this change keeps the operational mechanism together and does not start a separate reorganization. Independent review of the first commit produced the findings above. Follow-up acceptance remains with the coordinator; `implemented` does not mean independently verified.

Follow-up complexity: three Markdown files changed; one behavioral specification, one supplemental decision record, and one change record. Across both commits, four Markdown files carry the design. The new bundle core names purpose values `backup`/`move`, consistency values `workspace-consistent`/`quiescent`, and a source moved-out disposition. No registry, runtime service, dependency, or additional canonical store was added. The operational estimate is 8-14 engineer-days after shared layout primitives, with all four increments assigned to `v0.1.0`.

## Bundle Implementation Status

The first implementation slice adds the independent `wsbak` identity kind and the version-1 bundle parser and structural byte verifier in `storage/workspace-backup-bundle.ts`. Exact inventory entries and original metadata bytes determine digests; parsed manifest and seal projections omit ignored descriptive additions. Bounded private copies use existing capacity admission and expire with the consuming callback. This slice does not capture or seal a Workspace, prove database/reference closure, restore, or MOVE; shared primitives, independent verification, review, and exact-candidate CI remain required.
