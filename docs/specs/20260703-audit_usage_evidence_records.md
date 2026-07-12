# Audit, Usage, And Evidence Records

Status: Accepted
Implementation: Diverged

## Summary

This spec defines the target record model for audit, usage, and evidence.

The clean target is to split three concerns that are currently easy to blur: audit explains responsibility and policy, usage measures consumed resources, and evidence preserves proof material. They must link through common lineage, but they should not collapse into one log table or raw backend transcript.

Agent-capability-mediated usage semantics belong to `docs/core/agent-capability.md`. Future non-gateway metering direction belongs to `docs/core/metering.md`. This spec owns the concrete record-linking projection for audit, usage, and evidence records.

## Owns

- Cross-record linkage between `AuditEvent`, `UsageRecord`, `EvidenceBundle`, `CapabilityCall`, `PermissionDecision`, `VaultUse`, and `RuntimeEvidence`.
- Storage source-of-truth guidance for audit, usage, evidence indexes, and file-backed proof material.
- Product visibility and redaction rules for audit-visible, item-visible, diagnostics-only, and restricted evidence layers.
- Current protocol and NanoCore implementation projection for audit, usage, capability-call, verification, checkpoint, workspace-sync, and runtime evidence records.
- Producer obligations for recording or explicitly omitting audit, usage, and evidence at stable boundaries.
- Forward-compatible reader behavior for optional audit, usage, and evidence fields.

## Does Not Own

- Agent-capability-mediated usage semantics, rate limits, or budgets.
- Future system-wide metering policy outside concrete record projection.
- Pricing, billing, invoices, quotas, or cost allocation policy.
- Permission policy semantics.
- Vault secret storage.
- Artifact file semantics or workspace synchronization protocol semantics.
- Raw backend-native log formats.

## Core References

- `docs/core/audit.md`
- `docs/core/agent-capability.md`
- `docs/core/metering.md`
- `docs/core/storage.md`
- `docs/core/vault.md`
- `docs/core/permissions.md`
- `docs/specs/20260703-schema_evolution_record_envelope.md`

## Goals

- Define durable record families for audit, usage, and evidence.
- Decide which records are SQLite source of truth and which are file-backed evidence.
- Normalize OpenShell and worker sidecar evidence without making backend-native records product truth.
- Link every governed action to workspace, thread, turn, agent session, capability call, policy decision, vault grant, and artifact where applicable.
- Establish redaction and product visibility rules.

## Non-goals

- Do not define final table DDL.
- Do not implement billing.
- Do not expose raw backend logs to product surfaces.
- Do not store secret values, raw provider tokens, or unrestricted request payloads.
- Do not require every internal diagnostic event to be item-visible.

## Record Families

Use these record families:

- `AuditEvent`: explains who or what caused an action, what policy applied, and what happened.
- `UsageRecord`: measures consumed resources.
- `EvidenceBundle`: points to proof material and normalized manifests.
- `CapabilityCall`: records a gateway-mediated privileged call.
- `PermissionDecision`: records a policy outcome.
- `VaultUse`: records secret-reference use without secret material.
- `RuntimeEvidence`: records backend lifecycle and worker evidence summaries.

`CapabilityCall`, `UsageRecord`, `PermissionDecision`, and `VaultUse` are linked record families, not replacements for audit.

## Storage Ownership

SQLite source-of-truth records:

- audit events
- usage records
- capability calls
- permission decisions
- vault use rows
- evidence bundle indexes
- runtime evidence indexes

File-backed source-of-truth records:

- raw or redacted evidence files
- normalized evidence manifests
- transcript exports
- artifact files
- workspace change manifests
- context package traces

SQLite rows should link to file-backed evidence by stable evidence ids and digests.

## Storage Scope Homing

Every durable audit, usage, capability-call, permission-decision, and vault-use row carries `ownerScope` per the record envelope, and the scope decides the home database:

- Rows with workspace lineage — turns, items, capability calls, context packages, worker sessions, workspace sync, workspace-scoped vault use — home in `workspace.sqlite`, and their evidence files home under the workspace `evidence/` tree. A workspace backup or export is therefore self-contained, including its own audit history.
- Server control-plane rows — auth sessions, server config changes, provider account lifecycle, gateway account rotation, scheduler operations, migrations — home in `core.sqlite`, with evidence under `server/evidence/`.
- Rows that concern only a user identity — login events, user config changes — home in `user.sqlite`.

When one event spans scopes, the primary row homes at the responsibility subject. A workspace turn consuming a server-owned provider account records its usage row at the workspace, because the workspace is the attribution and billing subject; the server side MAY keep a derived aggregate, and derived aggregates MUST be marked derived and rebuildable, never a second source of truth.

Cross-scope linkage uses ids and digests only. Correctness MUST NOT depend on cross-database foreign keys or joins; read models MAY aggregate across scopes.

Workspace deletion MUST produce a sealed, server-owned audit closure export under `server/exports/` before removal. The export is envelope-wrapped and contains the workspace's audit events, permission decisions, vault-use rows, usage aggregates, and evidence manifest digests; restricted raw evidence is included only when its retention class requires it. Records under `legal-hold` retention block deletion until the hold is released. After deletion, the closure export is the only remaining record of the workspace and is governed by retention classes like any other server-owned record.

## Schema Evolution

Audit, usage, capability-call, permission-decision, vault-use, evidence-bundle, and runtime-evidence records follow `docs/specs/20260703-schema_evolution_record_envelope.md`, which owns the general unknown-field and required-feature rules.

Domain-specific additions owned by this spec:

- Fields that affect responsibility, policy outcome, permission, vault use, resource attribution, retention, redaction, evidence promotion, or product visibility are authority-bearing for these record families.
- Unknown evidence kinds may be retained as restricted evidence when policy allows it, but they must not be promoted into canonical items, artifacts, workspace changes, audit events, usage records, permission decisions, or vault-use records until NanoCore understands and verifies them.

## AuditEvent

`AuditEvent` should carry:

- audit event id
- event category
- severity
- actor summary
- responsible user or automation summary
- workspace id when applicable
- thread id when applicable
- turn id when applicable
- agent id when applicable
- agent session id when applicable
- item id when applicable
- capability call id when applicable
- permission decision id when applicable
- vault grant id when applicable
- resource summary
- action
- outcome
- policy reference
- evidence bundle ids
- timestamp
- redaction level
- required features when the audit record depends on a newer required semantic

Audit events are immutable.

## UsageRecord

`UsageRecord` should carry:

- usage record id
- workspace id
- thread id when applicable
- turn id when applicable
- agent session id when applicable
- capability call id when applicable
- provider reference
- category
- closed measurement unit, including `tokens` and estimated `usd`
- quantity
- model id when applicable
- endpoint family when applicable
- cache metrics when applicable
- cost estimate when available, explicitly represented as telemetry rather than billing truth
- measurement source
- timestamp
- required features when the usage row depends on a newer required semantic

Usage categories:

- `llm`
- `tool`
- `runtime`
- `storage`
- `network`
- `sandbox`

Usage rows may be aggregated for diagnostics, but raw metering rows should remain queryable until retention policy deletes or compacts them.

## Current Implementation Projection

The current implementation provides the record families below but still retains the two evidence surfaces rejected by the accepted simplification contract, so alignment remains diverged until the linked change plan lands:

- `packages/protocol/src/models/usage.ts` exports `UsageRecordSchema`, generated JSON Schema, and conformance coverage. Usage rows now include `sourceIds` for workspace data source lineage when a measurement touches catalog-backed workspace data.
- `packages/protocol/src/models/audit.ts` exports `AuditEventSchema`, generated JSON Schema, and conformance coverage. `workspaceId` is nullable because server-scope audit events do not belong to a workspace. Audit events now carry optional `permissionDecisionId` and `vaultGrantId` linkage fields for policy and vault lineage.
- `packages/protocol/src/models/capability.ts` exports `CapabilityCallSchema`, generated JSON Schema, and conformance coverage. Capability calls now include `sourceIds` for workspace data source lineage when a call touches catalog-backed workspace data.
- `apps/nanocore/src/llm/gateway-usage.ts` records process-local LLM gateway usage summaries for diagnostics. These are not durable `UsageRecord` rows.
- `apps/nanocore/src/bootstrap/audit.ts` writes durable server-scope boot lifecycle rows to `boot_audit_events` and now projects boot start, boot outcome, and orderly shutdown into server-owned general `AuditEvent` rows. It records a boot start row after migrations make storage writable, including the data-root layout version, data-root lock acquisition summary, and any stale holder that was broken, records the boot outcome after phase execution completes, and records the first orderly shutdown event on `SIGINT` / `SIGTERM` after HTTP close and before data-root lock release.
- `apps/nanocore/src/audit-events.ts` provides the first general audit recorder skeleton for server and workspace databases. Core DB and workspace databases create `audit_events` through `0014_audit_events`, `workspace_0014_audit_events`, and the `0040_audit_event_linkage` migration; `recordServerAuditEvent` and `recordWorkspaceAuditEvent` validate against `AuditEventSchema`, preserve optional capability call, permission decision, and vault grant lineage, and reject raw payload-shaped field names before writing rows. Server-owned audit events are exposed through `GET /api/app/audit/events`, `client.app.listServerAuditEvents`, the read-only MCP tool `openkit.read_server_audit_events`, and the resource `openkit://audit/events`; workspace-owned audit events are exposed through `GET /api/app/workspaces/:workspaceId/audit/events`, `client.app.listWorkspaceAuditEvents`, the read-only MCP tool `openkit.read_workspace_audit_events`, and the resource `openkit://workspaces/{workspaceId}/audit/events`.
- Access-token lifecycle routes in `apps/nanocore/src/auth/access-token-routes.ts` now write server-owned general `AuditEvent` rows for successful bootstrap consumption, token issuance, token revocation, and token rotation. These events record stable action names, token ids, scopes, owners, and authenticated actor ids when present, but never record bootstrap tokens, plaintext access-token secrets, token hashes, credential-store material, or raw authorization headers.
- Server-owned vault-use evidence rows are exposed through `GET /api/app/vault/use-records`, `client.app.listServerVaultUseRecords`, the read-only MCP tool `openkit.read_vault_use_records`, and the resource `openkit://vault/use-records`. Workspace-owned vault-use evidence rows are exposed through `GET /api/app/workspaces/:workspaceId/vault/use-records`, `client.app.listWorkspaceVaultUseRecords`, the read-only MCP tool `openkit.read_workspace_vault_use_records`, and the resource `openkit://workspaces/{workspaceId}/vault/use-records`. Both surfaces contain only non-secret `VaultUse` metadata and linked audit ids, not credential material or backend secret locators, and their authorization follows the owning matrix in `docs/specs/20260704-vault_backend_implementation.md`.
- `apps/nanocore/src/policy/permission-decisions.ts` writes durable `PermissionDecision` rows for boot policy self-checks, OpenAI-compatible LLM gateway policy outcomes, Goal Mode worker-launch allow decisions, real bounded worker-turn launch decisions, and policy-originated approval or escalation rows. Boot and gateway decisions are server-scoped; workspace decisions are stored in the owning `workspace.sqlite`. Both server- and workspace-owned permission decisions now receive a linked `AuditEvent` row through the general audit recorder with `permissionDecisionId` filled. Server-owned permission decisions are exposed through `GET /api/app/permission-decisions`, `client.app.listServerPermissionDecisions`, the read-only MCP tool `openkit.read_server_permission_decisions`, and the resource `openkit://permission-decisions`; workspace-owned permission decisions are exposed through `GET /api/app/workspaces/:workspaceId/permission-decisions`, `client.app.listWorkspacePermissionDecisions`, the read-only MCP tool `openkit.read_workspace_permission_decisions`, and the resource `openkit://workspaces/{workspaceId}/permission-decisions`.
- `apps/nanocore/src/capability/usage-ledger.ts` writes workspace-scoped `CapabilityCall` and `UsageRecord` rows through a shared recorder skeleton, persists stable source id arrays for source-aware calls, and now emits linked terminal `AuditEvent` rows when capability calls finish, fail, cancel, or recover after restart. Authenticated worker knowledge search, knowledge read, knowledge proposal, artifact read, and diagnostic read routes now persist durable `CapabilityCall` rows and one linked `UsageRecord` row with `category: "tool"`, `unit: "capability_calls"`, and quantity `1` for each successful route call. Workspace Knowledge Store entry writes, source registration, source read, retrieval, maintenance writes, Knowledge Manager answer, proposal draft, repair suggestion, health check, and context preparation now persist durable `knowledge` capability calls and one linked `category: "tool"`, `unit: "capability_calls"` usage row for each successful App API operation. QuickChatAgent LLM calls now persist durable `CapabilityCall` and linked `UsageRecord` rows when provider usage is available. Public `/v1/chat/completions` and `/v1/responses` calls routed through the pi-ai adapter now persist durable `CapabilityCall` and linked `UsageRecord` rows when the request carries `metadata.openkit.workspaceId`; unattributed public calls remain process-local diagnostics only. Worker MCP tool producers also use this recorder for durable tool-call usage, terminal worker checkpoints now emit one durable `runtime.worker_turn` capability call plus one `category: "runtime"`, `unit: "sandbox_sessions"` usage row, workspace export writes now emit one durable `storage.workspace_export` capability call plus linked `category: "storage"` usage rows for exported file count and exported byte count, workspace import writes now emit one durable `storage.workspace_import` capability call plus linked storage usage rows for imported file count and imported byte count, and attempted host-side Git push execution now emits one durable `workspace.git.push` capability call plus one `category: "network"`, `unit: "requests"` usage row when the fixed Git runner is invoked. Workspace import strips unknown optional fields from imported capability calls and usage records before storage.
- Workspace-attributed pi-ai gateway calls now project one terminal raw usage observation into positive input, output, cache-read, and cache-write `tokens` rows plus one positive estimated-`usd` row when reported. Provider-error and aborted terminal observations are recorded before public normalization; public responses, errors, diagnostics, and durable rows never retain the raw usage object or prompt-cache key.
- `apps/nanocore/src/evidence-bundles.ts` stores first-slice workspace-owned compact `EvidenceBundle` indexes in `workspace.sqlite` through `0043_evidence_bundles`. The accepted contract keeps automatic producer-owned bundle creation and readback through `GET /api/app/workspaces/:workspaceId/evidence-bundles`, `client.app.listWorkspaceEvidenceBundles`, and the `openkit://workspaces/{workspaceId}/evidence-bundles` resource; it does not expose a manual App API, Core Client, or MCP creation command. The current implementation temporarily retains `POST /api/app/workspaces/:workspaceId/evidence-bundles`, `client.app.createEvidenceBundle`, and `openkit.create_evidence_bundle` pending the linked evidence-surface simplification change plan. The first slice stores product-safe lineage refs, redacted evidence refs, content digests, retention class, sensitivity class, import status, required features, and creation time; it does not store raw artifact content, raw transcripts, backend-private payloads, or restricted evidence files. The first retention compaction slice can expire old `ephemeral-diagnostic` bundles by clearing raw and redacted evidence refs and marking the row `expired` without deleting the governed index, while leaving `turn-evidence`, `workspace-audit`, and `legal-hold` rows intact. Workspace export/import carries these rows through `records/evidence-bundles.jsonl`; imported bundles strip unknown optional fields, and imported bundles carrying unknown evidence ref kinds are stored as `quarantined` so unsupported evidence cannot arrive as promoted proof.
- `apps/nanocore/src/runtime/runtime-evidence.ts` stores first-slice workspace-owned normalized `RuntimeEvidence` indexes in `workspace.sqlite` through `0044_runtime_evidence`. The terminal-checkpoint producer writes one runtime evidence row when a worker checkpoint first transitions from non-terminal to terminal, using product-safe checkpoint lineage, backend/session summary, terminal outcome, stop reason, content digest, and required feature metadata without copying raw backend payloads or diagnostics text. The materialization producer now writes one runtime evidence row when a workspace materialization record is first stored, using product-safe backend kind, backend version when present in readiness evidence, policy digest, materialized-root summary, and capability evidence kinds. NanoCore exposes readback through `GET /api/app/workspaces/:workspaceId/runtime-evidence`, `client.app.listWorkspaceRuntimeEvidence`, and the MCP `openkit://workspaces/{workspaceId}/runtime-evidence` resource. Workspace export/import carries these rows through `records/runtime-evidence.jsonl`, and imported runtime evidence strips unknown optional fields before storage.
- `apps/nanocore/src/runtime/workspace-sync-records.ts` persists staged workspace review records and now emits one linked workspace `AuditEvent` plus one compact `EvidenceBundle` index when a review is first staged. Change-set payloads inherit `sourceId` from the existing materialization record when worker manifests omit it, so downstream review records retain catalog-source lineage without trusting the worker to restate it. Upserted review updates do not duplicate the audit or evidence rows.
- `apps/nanocore/src/runtime/workspace-apply-results.ts` persists review-gated workspace apply results and now emits one linked workspace `AuditEvent` plus one compact `EvidenceBundle` index when a new apply result is stored. Idempotent replays do not duplicate the audit or evidence rows.
- `apps/nanocore/src/runtime/goal-store.ts` persists Goal Mode goals and tasks, and now emits workspace `AuditEvent` rows when a goal or goal task is created and when a goal or goal task status changes. These audit summaries intentionally omit goal and task title/objective text.
- `apps/nanocore/src/runtime/worker-checkpoints.ts` persists worker checkpoint rows and now emits one workspace `AuditEvent` when a checkpoint first transitions into a terminal worker stage. Repeated terminal updates do not duplicate the audit row.
- `apps/nanocore/src/runtime/goal-verification-records.ts` stores app-local goal verification evidence with redacted command, summary, item ids, artifact ids, and output pointers, and now emits one workspace `AuditEvent` when verification evidence is stored.
- `apps/nanocore/src/runtime/goal-review-records.ts` stores app-local goal task review records with redacted reason and verification evidence, and now emits one workspace `AuditEvent` when a review record is stored.
- `apps/nanocore/src/runtime/pending-user-turns.ts` stores app-local pending human input rows and now emits workspace `AuditEvent` rows when pending user turns are first enqueued and when they are consumed. These audit rows record thread, request, item lineage, and a stable pending-turn resource without storing raw user input or content digests.
- `apps/nanocore/src/config/runtime-config-files.ts` detects authority-bearing workspace data source catalog edits and the NanoCore runtime config route records workspace `AuditEvent` rows when `kind`, `access`, `sensitivity`, or `vaultGrantRef` changes for a source. These audit rows record the source id and changed authority fields without locator or credential material.
- `POST /api/app/workspace-imports` records a workspace `AuditEvent` row with action `workspace.import` after a verified import is persisted, binding the request id, imported workspace id, and redacted source workspace id without recording export paths or raw imported payloads.
- `apps/nanocore/src/storage/schema/worker-turn-checkpoints.ts` stores redacted worker checkpoint diagnostics and compact terminal evidence references, and terminal checkpoint transitions now promote a product-safe normalized runtime evidence index.
- Workspace synchronization records store evidence references, redaction status, verification summaries, materialization records, staged reviews, and apply results. The compact `EvidenceBundle` ledger now automatically indexes first-slice materialization readiness evidence, staged review evidence refs, patch digests, and apply-result lineage, but workspace synchronization does not yet automatically promote raw backend transport material into bundle rows.
- OpenShell backend code emits redacted launch, teardown, transcript, artifact, and backend evidence summaries.
- Internal-agent, provider, repository, workspace, checkpoint, and runtime diagnostics include redaction helpers and tests for token, host-path, provider-secret, and raw-secret-shaped values.

The current usage schema has durable workspace storage, a shared recorder, internal QuickChat LLM usage, workspace-attributed public LLM gateway usage for pi-ai, native OpenAI-compatible, and Codex provider paths, worker MCP tool-call usage, first-slice Knowledge Store entry create, entry update, entry delete, source registration, source read, retrieval, observation, claim, promotion, conflict, resolution, and Knowledge Manager answer, proposal draft, repair suggestion, health check, and context preparation usage, terminal worker-turn runtime usage, workspace export/import storage usage, and first-slice host Git push network request usage. Future knowledge gateway operations, additional storage producers, additional network producers, and broader sandbox usage producers can extend the same record model without blocking the V1 implementation.

Current `UsageRecordSchema` ownership fields include `workspaceId`, optional `threadId`, optional `turnId`, optional `itemId`, optional `capabilityCallId`, optional `agentId`, optional `agentSessionId`, and `sourceIds`.

The usage schema currently has no user ID or automation identity field. User-level attribution must be added intentionally if a producer or billing surface requires it.

Current measurement fields include `unit`, `quantity`, `category`, `providerRef`, `modelId`, `source`, `recordedAt`, and `requestId`. The closed unit vocabulary includes `usd` only for provider-reported cost estimates; it does not establish billing, currency conversion, or allocation policy.

The current `category` enum covers `llm`, `tool`, `runtime`, `storage`, and `network`. This target spec still keeps `sandbox` as a future conceptual category until an active sandbox usage producer lands.

The current implementation has a boot-lifecycle durable audit table, boot lifecycle server `AuditEvent` producers, first server- and workspace-scoped general `audit_events` tables and recorder skeletons, terminal capability-call audit producers, public server and workspace audit-event readback, server and workspace permission-decision audit producers with permission-decision linkage, public server and workspace permission-decision readback, server/workspace VaultUse audit producers with vault-grant linkage when grant-backed, vault admin server `AuditEvent` producers linked to `vault_admin_audit_events`, access-token lifecycle server `AuditEvent` producers for bootstrap consumption, token issuance, token revocation, and token rotation, staged workspace-review audit producers, workspace apply-result audit producers, goal and goal-task creation audit producers, goal and goal-task status transition audit producers, terminal worker-checkpoint audit producers, first-slice terminal worker-checkpoint and materialization-readiness `RuntimeEvidence` producers with import-boundary unknown-field stripping, terminal worker-turn runtime usage producers, workspace export/import storage usage producers, goal verification audit producers, goal review audit producers, pending-user-turn enqueue and consume audit producers, scheduler admission retry and cancel workspace audit producers, workspace data source catalog authority-edit audit producers, workspace import audit producers, first-slice workspace-owned compact `EvidenceBundle` indexes with App API/Core Client/MCP read-create exposure, import-boundary unknown-field stripping, import-boundary unknown-kind quarantine, and ephemeral-diagnostic compaction, durable QuickChat and workspace-attributed public LLM usage producers for pi-ai, native OpenAI-compatible, and Codex gateway paths, durable worker knowledge/artifact/diagnostic capability usage producers, durable worker MCP usage producers, usage-ledger and Git push record import unknown-field stripping, and first-slice durable permission decision producers for boot policy self-checks, LLM gateway policy outcomes, Goal Mode worker-launch allow decisions, worker-turn launch decisions, and policy-originated approval or escalation rows. Future product boundary producers can fill the available permission decision and vault grant linkage as those boundaries ship.

## EvidenceBundle

`EvidenceBundle` should carry:

- evidence bundle id
- owner scope
- workspace id when applicable
- thread id when applicable
- turn id when applicable
- agent session id when applicable
- backend type when applicable
- source kind
- normalized summary
- raw evidence refs
- redacted evidence refs
- content digests
- retention class
- sensitivity class
- import status
- created timestamp
- required features when the evidence bundle depends on a newer required semantic

Evidence import status:

- `collected`
- `verified`
- `normalized`
- `promoted`
- `quarantined`
- `expired`

Only `promoted` evidence can be treated as supporting canonical product records.

Unknown or unsupported evidence kinds must remain unpromoted.

## Retention Classes

The first implementation should use explicit retention classes instead of ad hoc deletion.

Baseline retention classes:

| Class | Purpose | Default handling |
| --- | --- | --- |
| `ephemeral-diagnostic` | Short-lived health checks, retries, and optional feature negotiation. | Delete or compact aggressively after diagnostics windows close. |
| `turn-evidence` | Evidence needed to explain one worker turn, artifact, workspace review, or verification result. | Retain with the turn until workspace retention policy compacts or archives it. |
| `workspace-audit` | Audit, usage, permission, capability, and vault-use rows needed for workspace governance. | Retain according to workspace audit policy and export with workspace audit bundles. |
| `restricted-raw` | Raw backend logs, raw payload snippets, sensitive operational traces, and quarantined evidence. | Restrict by default, retain for a bounded window, and expose only redacted manifests. |
| `legal-hold` | Material explicitly held by policy, administrator action, or external compliance requirement. | Do not compact or delete until the hold is removed. |

When a record has both product and restricted evidence, the product-safe record should reference the restricted evidence bundle by id and digest rather than duplicating restricted content.

## Runtime Evidence

Runtime evidence includes:

- sandbox create request summary
- backend capability negotiation summary
- policy apply summary
- provider attach summary
- sidecar startup summary
- heartbeat summary
- file upload and download manifests
- transcript collection summary
- workspace change collection summary
- teardown summary
- backend error summary
- runtime-native event capture and runtime-origin index collection summary when `worker.runtime-provenance.v1` is required

OpenShell-native records are evidence inputs. NanoCore-owned runtime evidence records are normalized outputs.

## OpenShell Evidence Normalization Baseline

The first OpenShell evidence importer should normalize only the fields needed for launch debugging, turn replay, audit linkage, and product-safe diagnostics.

Normalize:

- backend type and backend version when available
- local or remote placement
- gateway or target summary without secret endpoint tokens
- sandbox name or backend session summary as a redacted locator
- workspace id, thread id, turn id, agent session id, and package snapshot id when known
- policy file digest and policy summary
- worker image, source, or sandbox profile summary
- upload manifest paths, sizes, and digests
- download manifest paths, sizes, and digests
- transcript collection summary
- artifact collection summary
- workspace change manifest summary
- control relay status and last heartbeat timestamp
- capability route summary
- exit code, signal, stop reason, or timeout reason
- redacted stdout and stderr summaries
- stable backend error code and redacted message
- created, started, completed, and collected timestamps when available

Do not normalize raw OpenShell payloads into product records merely because the backend exposes them. Raw OCSF or backend-native payloads remain restricted evidence unless an accepted spec promotes a field into the OpenKit runtime evidence shape.

## Product Visibility

Item-visible:

- user-relevant approvals, denials, blocked states, artifact notices, review events, and final worker summaries

Audit-visible:

- policy decisions, capability calls, vault use, backend lifecycle, provider routing, usage attribution, and evidence import

Diagnostics-only:

- health checks, retry counts, backend feature negotiation, and degraded optional capability details

Raw restricted evidence:

- backend-native logs, raw request or response payloads, and sensitive operational traces

Product APIs must not expose raw restricted evidence.

## Redaction

Records must not contain:

- secret values
- raw authorization headers
- API keys
- raw provider account ids
- raw prompt cache keys
- unrestricted file contents
- backend-private session tokens
- full host paths
- raw environment variables

When a value is needed for correlation, store a stable redacted label or digest.

## Producer Obligations

NanoCore should emit or import audit and usage records at these boundaries:

- app API command accepted or denied
- MCP operation accepted or denied
- worker session launch
- AEP snapshot materialization
- sandbox lifecycle changes
- permission decision
- approval requirement and decision
- capability call
- vault grant use
- workspace review and apply
- artifact registration
- knowledge proposal and review
- runtime teardown

If a producer is not implemented, diagnostics must not claim that audit or usage is complete.

## Resolved Decisions

- Audit explains responsibility, policy path, affected resource, and outcome; usage measures consumed resources; evidence preserves proof material. They link by lineage but remain separate records.
- Agent-capability-mediated usage belongs to Agent Capability. This spec owns durable record projection and linkage, not gateway usage policy.
- Workspace-scoped audit and usage rows should live in workspace-owned storage. Server-scope rows should live in server-owned storage. Rows with no workspace context are server-scoped.
- Failed policy checks that consume no upstream or runtime resource should emit audit and permission records, not usage records.
- Context package traces are file-backed context trace records. They may be referenced by audit events and evidence bundles when they prove what a worker saw.
- Raw backend logs and OpenShell-native records are evidence inputs only; normalized OpenKit records decide product meaning.
- Unknown evidence kinds are evidence inputs only and must not be promoted until NanoCore understands and verifies their schema and lineage.
- Evidence bundle creation is owned by NanoCore domain producers at stable materialization, review, apply, verification, runtime, or audit boundaries. Public App API, Core Client, and MCP surfaces are read-only for evidence bundles and must not expose a manual bundle-creation command.
- Process-local gateway usage summaries are diagnostics, not durable usage records.
- Provider-reported cost is stored only as a positive estimated-`usd` usage row with normal capability lineage; it is not an invoice or billing authority.
- The first retention classes are `ephemeral-diagnostic`, `turn-evidence`, `workspace-audit`, `restricted-raw`, and `legal-hold`.
- Audit-family rows home in the database of their `ownerScope`; workspace-lineage rows live in `workspace.sqlite` so workspace export and deletion are self-contained.
- Spanning events home at the responsibility subject; server-side copies are derived aggregates, never a second source of truth.
- Workspace deletion produces a sealed server-owned audit closure export before removal; `legal-hold` blocks deletion.
- The first OpenShell evidence normalization pass should keep product-safe launch, policy, upload/download, transcript, artifact, workspace-change, control, capability, outcome, and redacted error summaries while leaving raw backend-native payloads as restricted evidence.

## Deferred / Future Work

- Wire product boundary producers to the durable audit event recorder.
- Add durable usage producers for future knowledge gateway metering, additional storage producers, network producers, broader sandbox lifecycle measurements, and any denied or failed capability attempts where measurable resources are consumed.
- Extend first-slice `EvidenceBundle` records with restricted raw evidence files, additional automatic producer promotion, and richer evidence-kind normalization; extend first-slice `RuntimeEvidence` beyond terminal worker checkpoints and materialization readiness into richer OpenShell launch, heartbeat, file-transfer, transcript, workspace-change, teardown, and backend-error normalization.
- Wire every relevant producer to fill the available permission decision and vault-use audit links.
- Extend retention compaction beyond the first `ephemeral-diagnostic` bundle slice into scheduled maintenance, restricted raw evidence files, workspace policy configuration, and broader retention classes.
- Normalize broader OpenShell evidence fields beyond the first terminal-checkpoint and materialization-readiness runtime evidence slices.
- Implement the ownership-scope homing and workspace deletion closure export defined in Storage Scope Homing.
- Extend schema evolution fixtures beyond the current unsupported required-feature, evidence-bundle/runtime-evidence/usage-ledger/Git-push unknown-field stripping, and evidence-kind quarantine slices to cover broader authority-bearing fail-closed cases.

## Testing Strategy

- Schema tests for audit, usage, and evidence records.
- Producer tests for key NanoCore boundaries.
- Import tests for OpenShell-style evidence.
- Redaction tests with provider tokens, host paths, and env vars.
- Query tests by workspace, thread, turn, agent session, capability call, and policy decision.
- Retention tests for raw evidence and compacted usage.
- Schema evolution tests proving optional fields are tolerated while unsupported responsibility, policy, vault, retention, redaction, and evidence-promotion semantics fail closed.
- Contract tests proving manual evidence-bundle creation is absent from App API, OpenAPI, Core Client, and MCP while automatic producers and read-only bundle access remain available.

## Risks & Mitigations

- Risk: Raw logs are mistaken for audit. Mitigation: only normalized audit rows answer policy and responsibility questions.
- Risk: Usage totals cannot be attributed. Mitigation: require lineage on every usage-producing gateway and runtime boundary.
- Risk: Evidence storage grows without bound. Mitigation: use retention classes and compaction.
- Risk: Audit becomes too noisy for users. Mitigation: separate item-visible, audit-visible, diagnostics-only, and restricted evidence layers.

## Links

- `docs/core/audit.md`
- `docs/core/agent-capability.md`
- `docs/core/storage.md`
- `docs/core/metering.md`
- `docs/core/vault.md`
- `docs/specs/20260703-schema_evolution_record_envelope.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260629-openkit_policy_model.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260703-worker_agent_capability.md`
- [Evidence Surface Simplification](../changes/202607111848520001-evidence_surface_simplification.md)
- `docs/specs/20260711-worker_runtime_subagent_provenance.md`
