---
type: change-plan
status: implemented
date: "2026-10-16"
branch: lane/ga
---
# Supported Workspace Vault Grant Administration

## Intent Revision 1

Source: the L-GA P22 assignment and the Vault injection identity-conflict backlog item. Reject changed immutable content under an existing plan or receipt identity. Preserve exact replay, original completion and current lifecycle projections. This feature changes no credential class, durable format, public operation or import authority.

## Intent Revision 2

Source: the same engineer assignment, P22 receipt-revocation and governed-effect attribution items. Complete the existing receipt projection for grant and reference revocation. Preserve original completion, mark gateway-only use revoked, and keep unproved runtime reachability stale. Correct the existing Vault administrative audit producer so the general Audit records the same initiating human as the Vault audit row. Reuse existing records and add no secret-use authority, storage lifecycle or external effect.

## Owners And Boundaries

[Vault Secret Injection](../../specs/20260703-vault_secret_injection.md) owns plan intent, successful receipt completion, immutable lineage and lifecycle projections. The existing SQLite plan and receipt modules remain the writers. Creation cannot change revocation. Import remains historical and does not gain use authority. This feature does not claim the full P22 grant-review, shared MCP or delegated Policy outcome.

## Intent Revision 3

Source: the P22 exact-grant review and narrowing assignment. Complete supported Workspace grant administration through current inventory, constrained issuance, atomic revoke-and-replace narrowing, explicit replacement binding and revocation. Preserve the original reference, scope, lifetime, issuance and approval or Policy lineage. Add no credential class, request registry, backend effect or automatic binding. Broader User/Agent requests, approval workflow, cross-scope review and additional lifetimes remain open. This revision supersedes Revision 1's no-public-operation boundary only for the supported grant operation.

An independent Astra Consultant read source intent, the primary checkpoint, actual Git state and owning criteria after primary compaction and returned Continue for this bounded route. It preferred replacement over in-place authority mutation or separate revoke/create requests, required a recoverable Audit link in the same Core transaction, and limited capability targets to current exact Gateway operations. The backend owner criterion is amended under the engineer's explicit design delegation; the hosting decision and unsupported credential classes remain unchanged. The Web addition uses the existing Vault backend panel and accessible primitives. The [backend owner](../../specs/20260704-vault_backend_implementation.md#public-workspace-secret-administration) owns the public contract, and the [Web projection owner](../../specs/20260628-web_product_surface_projection.md) owns its presentation.

## Checkpoint

Implementation is complete locally. Plan and receipt identity replay compares every immutable input and preserves current lifecycle state. Grant and reference revocation share the visibility-aware receipt projection. Administrative Audit preserves the initiating human; narrowing records the original resource and replacement grant in its Core transaction. Supported issuance preserves exact targets and canonical expiry. Narrowing refuses stale source authority and missing required Approval/Policy lineage, rejects widening or no-op, and rolls back dependent writes and Audit together. The MCP consumer compares every non-null capability target exactly; its unconstrained fixture now uses null.

The lowest regressions observed changed-identity acceptance, incorrect gateway receipt status, absent general Audit actor, missing narrowing operation (404), the MCP wildcard, hidden Web constraints, noncanonical issued expiry and missing source Policy lineage. Each failed at its intended subject before correction. An earlier Workspace setup 403 did not reach narrowing and is not defect evidence. The first broader Worker run failed 38 retrieval-admission cases because the declared Retrieval Kernel executable was missing; building that prerequisite restored the same seven-file run to 310 passes. No retrieval product change or check bypass occurred. Two later MCP replacement fixtures failed scheduler admission before consumer use; completing and releasing their prior accepted attempt through the existing simulated executor allowed a fresh admitted Turn. Both corrected fake-upstream route cases passed, including unchanged contacts for the revoked binding and a successful explicitly rebound replacement.

Final observed evidence before landing integration:

- Nine NanoCore files covering grant administration, exact consumer constraints, actor Audit, revocation, references, injection plans and receipts passed 89 tests. The final two-file rerun after the expiry and source-lineage corrections passed all 36 tests.
- The grant panel and Settings suites passed 49 Web tests, including exact issuance, explicit narrowing, draft clearing, secret/cache exclusion and failure refresh without replay.
- Two App API schema files passed eight tests. The root Web operation-surface guard passed one test with the new live action and exact catalog counts.
- NanoCore and Web typecheck exited 0. Focused Biome and diff-whitespace checks passed after formatting correction. Earlier identity-only repository check and lint passed; full integration checks must run again inside the landing window.

Named command output remains in the lane's uncommitted evidence folder: `p22-grant-final-nine.log`, `p22-grant-current-source-green.log`, `p22-web-grant-final.log`, `p22-schema-tests.log` and the corresponding red-probe logs. The real consumer evidence uses synthetic HTTP upstreams and simulated release proof; it establishes no live vendor or Sandbox acceptance. No real secret or host operation was used. P14 has not landed, and new code uses the current identifier API without a format assertion. The exact source branch still needs main integration, generated interfaces, independent implementation review and full CI before landing. Broader grant request/review and other P22 work remain open.
