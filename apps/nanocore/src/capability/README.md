# Capability Usage Ledger

This directory owns the shared workspace-scoped capability-call and usage-record lifecycle.

## Boundaries

- `usage-ledger.ts` starts and finishes capability calls, records measurements, and reads exportable ledger rows.
- Storage table definitions remain in `../storage/schema/`; route-specific authorization and dispatch remain with their feature owners.
- Record only redacted lineage and positive, source-attributed measurements; failed calls must not fabricate usage.

## Verification

Run `pnpm --filter @openkit/nanocore exec vitest run src/capability` plus the affected Gateway tests.

See [Audit, Usage, And Evidence Records](../../../../docs/specs/20260703-audit_usage_evidence_records.md).
