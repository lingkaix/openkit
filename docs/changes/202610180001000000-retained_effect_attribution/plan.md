---
type: change-plan
status: in-progress
---
# Retained Effect Attribution

## Intent Revision 1

The coordinator approved the R034 retained-attribution plan and then authorized free-path preparation before naming on 2026-10-18. Preserve the actor, resource, request, outcome and available non-secret credential facts for baseline governed effects, under the existing [Audit owner](../../core/audit.md) and [record specification](../../specs/20260703-audit_usage_evidence_records.md). Keep only authentication credential kind and nullable credential id; add no channel, record family, ledger, evaluator or workflow. Reuse L-AK's Server capability/usage shape after its normal landing. L-WEB retains R031 evaluation and exact PermissionDecision/Audit linkage; R080 remains separate.

## Working Checkpoint

The complete implementation adds the strict optional Audit authentication summary, ordinary migrations in the four existing Audit homes, shared storage/read/import support and actual known actor/authentication facts at existing producers. It reuses the landed Server CapabilityCall/UsageRecord home. Capability admission records the original actor and terminal or restart-unknown Audit reads that retained admission; it never substitutes a later caller. Runtime, staged-review, Gateway, Vault and App consuming contexts are joined. Subscription login retains its caller across asynchronous completion while unrelated background work remains unattributed. Known source credential ids remain historical and non-authorizing through portability. Unknown optional authentication is omitted from the SQL insert so the existing native Light App snapshot rollback can retain its captured format and write its Audit event. The named production and fixture corrections require independent review and complete owner-module qualification before landing. L-WEB retains R031 evaluation and PermissionDecision/Audit linkage. R033 and R080 land first; R034 follows the coordinator pre-reset cut.

## Verification

The authentication regression first failed on the old protocol schema with an unrecognized authentication field. Checkpoint and apply actor regressions fail against the unchanged Main producers. The first review assertion inspected replayed historical rows; it was corrected to inspect a first accepted write, preserving Audit immutability. The first broader preparation run passed Protocol301 and NanoCore490 tests, but failed seven setup-dependent consumers because Core/retrieval binaries were not built; it is not a passing aggregate. The next preparation run passed Protocol301 and NanoCore317 tests but found the session mapper defect, a stale Protocol build in portability, and that invalid replay oracle. The mapper now prefers the canonical browser Session id, dependency builds are explicit, and the review regression checks the first accepted write. Corrected checks and independent review remain in the external lane evidence until the complete feature is joined and qualified. Required final proof includes complete touched owner-module directories, protocol and portability consumers, shared-list guards, independent Sol review and the exact local gate on green Main. No host action or external effect is part of preparation.
