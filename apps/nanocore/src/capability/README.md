# Capability Usage Ledger

This directory owns the shared capability-call and usage-record lifecycle for Workspace and Server owners.

## Boundaries

- `usage-ledger.ts` starts capability calls, keeps the public measurement, finish, recovery, and export facades, and reads exportable ledger rows. Retained start, replay-attribution, and private import writers bind `sourceIdsJson` and `assertNoUnsafeLedgerValue` from the native owner.
- `usage-ledger-native.ts` owns the existing `finishCapabilityCallInDb` transaction and its complete helper closure: terminal Call compare-and-set, admitted attribution, delivered-answer framing, linked Audit, Call lookup and decoding, source-id normalization and decoding, and canonical extensions. It also owns the supplied-connection Call updates `stampCapabilityCallSchemaSnapshotInDb`, `persistLlmCapabilityCallSystemPromptDigestInDb`, `writeGatewayRouteLineageInDb`, `writeCapabilityCallCacheInDb`, and `clearCapabilityCallItemInDb`. It owns `recordUsageInDb` and that recorder's helper closure: the private equivalence check, source-id JSON, and recursive unsafe-value rejection. It exports `sourceIdsJson` and `assertNoUnsafeLedgerValue` for the retained Main writers. Worker checkpoints bind the finish transaction and `recordUsageInDb` from this file. Control Capability binds that finish transaction, these five Call updates, and `recordUsageInDb` from this file. The native module has no runtime import of the ledger, the worker client, Control Capability orchestration, or Policy evaluation.
- Storage table definitions remain in `../storage/schema/`; route-specific authorization and dispatch remain with their feature owners.
- Record only redacted lineage and positive, source-attributed measurements; failed calls must not fabricate usage.

## Verification

Run `pnpm --filter @openkit/nanocore exec vitest run src/capability` plus the affected Gateway tests.

See [Audit, Usage, And Evidence Records](../../../../docs/specs/20260703-audit_usage_evidence_records.md).

The optional CapabilityCall extensions document is stored in nullable `extensions_json`. The Gateway namespace has closed core values; readers ignore unknown namespaces and old null rows remain absent. `writeGatewayRouteLineage` appends or completes an attempt transactionally on the one running logical call. Equivalent usage returns the retained measurement IDs. Export/import carry both extensions and the existing gateway-entry system-prompt digest; restart recovery preserves entries and marks abandoned calls unknown.

Canonical rewrites and the existing Workspace archive path preserve other stored extension namespaces using storage-only validation. The recognized Gateway namespace still rejects unknown core values. Live protocol and audit projections continue to ignore and omit unknown namespaces; the canonical reader is not the public projection.

`CapabilityAuditLineage` supplies a trusted command request ID through `FinishCapabilityCallInput.auditLineage` and `RecordUsageInput.auditLineage`. When the stored call request is null, finish validates that command ID and writes it only to the existing AuditEvent request field; a stored call request takes precedence. Usage-recording failure forwards the same lineage to its existing finish path. The input is transient and does not change start keys, call or usage request fields, or usage equivalence. A null per-invocation request gives no request-key replay protection; the command owner must prevent duplicate or uncertain execution before invocation, as required by [Capability Usage Gateway Foundation](../../../../docs/specs/20260704-capability_usage_gateway_foundation.md#capabilitycall-lifecycle).

Server calls use the same recorder and SQL record families in Core, with a null SQL Workspace field and explicit `owner: { kind: 'server' }` protocol attribution. Workspace addressing inputs stay unchanged; call records carry the canonical explicit Workspace owner. Server callers pass a Core database as `workspaceDb` and supply `ServerGatewayCallContext`; current Server authority remains the producer's responsibility. Terminal audit uses the existing Server audit writer. Boot calls `recoverRunningCapabilityCalls({ workspaceDb: coreDb })` after Core migrations and never replays abandoned calls.

Capability admission captures the supplied actor in the existing linked Audit family before effect contact. Call insertion and this admission event share the owner's SQLite transaction. Terminal and restart-unknown Audit use that retained actor; a later caller cannot replace it. The admission outcome remains unknown until a terminal event. No actor is inferred for historical calls that did not capture one.

CapabilityCall uses one canonical owner union for both database scopes. The admitted database supplies storage authority; the existing nullable SQL Workspace column supplies none by itself. Exported Workspace calls retain their explicit owner, and Server calls remain in Core. Usage measurements keep their existing schema.

Ordinary portable Workspace import is absent and does not insert call rows into a target database. Exported Workspace calls keep their explicit owner. A Server or foreign Workspace owner is not target access authority.

The exported call ledger can project proved `upstreamContacted: false` from a retained correlated submission PermissionDecision. Only the exact denied captured-call submission reason and correlated call identity supply that fact. Missing knowledge is omitted; absence of usage alone does not prove no contact. This projection adds no call ledger, stored field or writer and does not change live protocol shapes.

Workspace mutation facades return Promises and use the admitted database worker for the complete Call, usage, PermissionDecision and required Audit tuple. Await acknowledgement before dependent contact, publication or handle closure. Core and Server mutations use the same native FIFO and FULL acknowledgement. Server admission and terminal Audit retain their original atomic tuples. Each Core measurement retains its original separate commit; a later refusal preserves earlier acknowledged measurements and performs the original failure closeout, while a lost acknowledgement remains unknown and is never retried. The `InDb` bodies are for the supplied native savepoint or an explicitly stopped private import; they are not a live Main fallback. Main reads worker-owned rows through existing read-only, query-only WAL views and rechecks current authority after native waits.

Model measurements retain logical modelId, the actual dispatched providerModel and existing measured-profile providerRef together. Nullable historical providerModel stays unknown. Native wire, equivalent-measurement comparison, reads and portable export preserve that same fact without another ledger.

A captured MCP submission refusal joins its existing PermissionDecision, linked Audit and failed Call finish in one native transition without Usage. A later refusal has a distinct decision identity, so the original allow remains immutable. Portable ledger reads derive known no-contact from the explicit retained refusal context; an error code alone never proves contact certainty.

Both Workspace LLM/MCP admission paths require an existing non-null authority actor before native dispatch or call insertion/replay. The shared recorder checks attribution presence only; producers retain current Policy admission. Unattributed Server diagnostics and existing other-family evidence stay separate, and historical actorless rows gain no inferred actor.

`usage-ledger-native.ts` records the pre-adapter system-prompt digest on the existing eligible CapabilityCall row in the supplied native savepoint. Control Capability calls this native mutation directly; prompt selection and digest computation remain in `../llm/system-prompt-digest.ts`.
