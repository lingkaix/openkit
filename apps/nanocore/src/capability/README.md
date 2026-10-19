# Capability Usage Ledger

This directory owns the shared capability-call and usage-record lifecycle for Workspace and Server owners.

## Boundaries

- `usage-ledger.ts` starts and finishes capability calls, records measurements, and reads exportable ledger rows.
- Storage table definitions remain in `../storage/schema/`; route-specific authorization and dispatch remain with their feature owners.
- Record only redacted lineage and positive, source-attributed measurements; failed calls must not fabricate usage.

## Verification

Run `pnpm --filter @openkit/nanocore exec vitest run src/capability` plus the affected Gateway tests.

See [Audit, Usage, And Evidence Records](../../../../docs/specs/20260703-audit_usage_evidence_records.md).

The optional CapabilityCall extensions document is stored in nullable `extensions_json`. The Gateway namespace has closed core values; readers ignore unknown namespaces and old null rows remain absent. `writeGatewayRouteLineage` appends or completes an attempt transactionally on the one running logical call. Equivalent usage returns the retained measurement IDs. Export/import carry both extensions and the existing gateway-entry system-prompt digest; restart recovery preserves entries and marks abandoned calls unknown.

Canonical rewrites and the existing Workspace archive path preserve other stored extension namespaces using storage-only validation. The recognized Gateway namespace still rejects unknown core values. Live protocol and audit projections continue to ignore and omit unknown namespaces; the canonical reader is not the public projection.

`CapabilityAuditLineage` supplies a trusted command request ID through `FinishCapabilityCallInput.auditLineage` and `RecordUsageInput.auditLineage`. When the stored call request is null, finish validates that command ID and writes it only to the existing AuditEvent request field; a stored call request takes precedence. Usage-recording failure forwards the same lineage to its existing finish path. The input is transient and does not change start keys, call or usage request fields, or usage equivalence. A null per-invocation request gives no request-key replay protection; the command owner must prevent duplicate or uncertain execution before invocation, as required by [Capability Usage Gateway Foundation](../../../../docs/specs/20260704-capability_usage_gateway_foundation.md#capabilitycall-lifecycle).

Server calls use the same recorder and SQL record families in Core, with a null SQL Workspace field and explicit `owner: { kind: 'server' }` protocol attribution. Workspace inputs and returned types stay unchanged. Server callers pass a Core database as `workspaceDb` and supply `ServerGatewayCallContext`; current Server authority remains the producer's responsibility. Terminal audit uses the existing Server audit writer. Boot calls `recoverRunningCapabilityCalls({ workspaceDb: coreDb })` after Core migrations and never replays abandoned calls.

Capability admission captures the supplied actor in the existing linked Audit family before effect contact. Call insertion and this admission event share the owner's SQLite transaction. Terminal and restart-unknown Audit use that retained actor; a later caller cannot replace it. The admission outcome remains unknown until a terminal event. No actor is inferred for historical calls that did not capture one.
