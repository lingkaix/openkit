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

## Owners And Scope

- [Operational specification](../../specs/20260704-workspace_backup_export_import.md): backup, restore, move, acceptance, and implementation estimates.
- [Decision record](../../decisions/20261019-workspace_backup_restore_move.md): source, rationale, accepted release scope, alternatives, and limitations.
- [Control-store design](../../specs/20261019-durable_execution_and_control_store.md): layout, execution settlement, snapshots, and failure scope. Its author owns that specification; this change does not edit it.
- [Storage Service](../../specs/20261018-file_storage_and_knowledge_packages.md): existing content references and byte operations, not a new backup backend.
- Existing analytical export/import and whole-server recovery retain their separate contracts and regression obligations.

## Working Checkpoint

The original size recommendation assumed a larger transfer workflow. Intent Revision 2 removes that workflow and selects the minimal capability for the first stable release. Source inspection found whole-root backup, exact inventory verification, bounded archive staging, and clone/remint import. Those implementations provide primitives, not an implemented identity-preserving operational move.

The layout specification exists in a separate design branch, not this branch. Its snapshot-closure contract is the receiver for canonical placement and external-reference classification. Every mutable Workspace authority must be captured under quiescence or its owner's snapshot rule. Notebook history, Light App databases, authored configuration, and mutable catalog process data are explicit coverage requirements. The engineer confirmed that retained model I/O blobs and native transcripts enter the Workspace immutable-content closure.

Produced artifacts: one amended operational specification, one accepted decision record, and this execution record. The bounded acceptance design covers the requested positive move and negative cases. The diff changes documentation only. The coordinator explicitly directed dependency-order integration and authorized retaining only the missing-layout-link check failure on this branch. No layout file was copied, no link was removed to obtain green, and no existing analytical import criterion was intentionally weakened.

Independent review and acceptance belong to the coordinator's separately arranged review. No agents will be started here. Structural checks establish document structure and drift only; they cannot establish operational correctness or accept this author's governing text.

## Rewrite Traceability

- Current Product Boundary: activate detailed Workspace recovery and retain analytical export's separate purpose and Goal exclusions.
- Summary, Goals, Decision, and Personal Data: replace whole-root-only recovery wording with the per-Workspace boundary; preserve analytical import ownership/remint rules and secret exclusions.
- Backup And Restore: retain existing whole-server cold/hot/restore guarantees in a named subsection; add the per-Workspace snapshot, seal, and restore contracts.
- Generative App coverage: distinguish existing whole-server capture from the new per-Workspace snapshot closure; preserve definition, schema, digest, and presentation checks.
- Accepted Design and implementation projection: distinguish the operational target from the current export/import implementation.
- Risks, Deferred Work, and testing: retain existing analytical crash-window criteria; add mandatory pre-release operational acceptance and explicitly deferred extensions.

## Verification And Review

Final focused checks used the pinned Node `24.18.0`. `node scripts/validate-spec-lifecycle.mjs` exited 0 with `Validated spec lifecycle metadata.`. `node scripts/generate-doc-index.mjs --check` exited 0 with `Documentation index is current.`. `git diff --check` exited 0. `node scripts/validate-doc-model.mjs` exited 1 with exactly four missing-link diagnostics, all for the separate control-store specification: one in this record, one in the decision, and two in the operational specification. The coordinator owns dependency integration and the joined rerun; this is not a document-model pass.

Initial probes failed before validation because this worktree lacked existing `yaml` and `zod` dependencies. Ignored local links to the existing installed packages resolved setup without package or lockfile changes. No production tests, implementation, live deployment, or external transfer ran. No agents were dispatched and no push was made.

Producer inspection covered actual changed paragraphs, removed criteria, seal ordering, the bounded acceptance set, and private-text patterns. The specification already exceeds the writing guide's split-review trigger; this change keeps the operational mechanism together and does not start a separate reorganization. Independent criterion review and authority acceptance remain pending with the coordinator; `implemented` does not mean independently verified.

Complexity: three Markdown files; one behavioral specification, one decision record, and one change record. The new bundle core names purpose values `backup`/`move`, consistency values `workspace-consistent`/`quiescent`, and a source moved-out disposition. No registry, runtime service, dependency, or additional canonical store was added. The operational estimate is 8-14 engineer-days after shared layout primitives, with all four increments assigned to `v0.1.0`.
