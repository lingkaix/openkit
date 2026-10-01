# Capability Usage Ledger

This directory owns the shared workspace-scoped capability-call and usage-record lifecycle.

## Boundaries

- `usage-ledger.ts` starts and finishes capability calls, records measurements, and reads exportable ledger rows.
- Storage table definitions remain in `../storage/schema/`; route-specific authorization and dispatch remain with their feature owners.
- Record only redacted lineage and positive, source-attributed measurements; failed calls must not fabricate usage.

## Verification

Run `pnpm --filter @openkit/nanocore exec vitest run src/capability` plus the affected Gateway tests.

See [Audit, Usage, And Evidence Records](../../../../docs/specs/20260703-audit_usage_evidence_records.md).

The optional CapabilityCall extensions document is stored in nullable `extensions_json`. The Gateway namespace has closed core values; readers ignore unknown namespaces and old null rows remain absent. `writeGatewayRouteLineage` appends or completes an attempt transactionally on the one running logical call. Equivalent usage returns the retained measurement IDs. Export/import carry both extensions and the existing gateway-entry system-prompt digest; restart recovery preserves entries and marks abandoned calls unknown.

Canonical rewrites and the existing Workspace archive path preserve other stored extension namespaces using storage-only validation. The recognized Gateway namespace still rejects unknown core values. Live protocol and audit projections continue to ignore and omit unknown namespaces; the canonical reader is not the public projection.
