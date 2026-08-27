---
status: Accepted
implementation: Partial
---
# Vault And Secret Injection

## Summary

This spec defines the target vault and secret injection model for NanoCore and governed workers.

The clean target is simple: normal config, manifests, item logs, knowledge, artifacts, and worker-visible diagnostics carry secret references and grants only. NanoCore secret values live in its encrypted-file Vault backend, and every injection path is explicit, scoped, revocable, and audited.

## Owns

- Vault reference, grant, injection plan, injection receipt, and vault-use record requirements.
- Secret injection visibility categories for gateway, backend, and worker runtime paths.
- How provider credentials, MCP credentials, external API credentials, repository credentials, runtime account slots, and explicit credential files are represented without storing secret values in normal records.
- The contract between vault references, Agent Environment Package snapshots, Agent Capability calls, worker runtime materialization, and audit events.
- Revocation and stale-session semantics for injected credentials.

## Does Not Own

- Concrete encrypted vault backend implementation.
- Permission policy itself.
- Sandbox containment rules beyond credential visibility.
- Provider-native auth payload formats.
- Agent Capability routing unrelated to credential use.
- Runtime Epoch lifecycle, sandbox termination, cleanup, and transport, which belong to `docs/specs/20260802-nanohost_runtime_and_transport.md`.
- Workspace export/import portability and re-binding workflows, which belong to `docs/specs/20260704-workspace_backup_export_import.md`; this spec owns only Vault-reference and grant safety constraints plus unbound-import semantics.

## Core References

- `docs/core/vault.md`
- `docs/core/permissions.md`
- `docs/core/sandbox.md`
- `docs/core/agent-capability.md`
- `docs/core/agent-session.md`
- `docs/core/storage.md`
- `docs/core/audit.md`

## Goals

- Define vault records and secret-reference ownership.
- Define grant, injection, receipt, and audit semantics.
- Support provider credentials, MCP server credentials, external API credentials, repository credentials, and runtime account slots.
- Keep secrets out of prompts, item logs, knowledge, artifacts, AEP snapshots, and normal config files.
- Make secret visibility explicit before a worker starts.

## Non-goals

- Do not define the encrypted-file format or master-key handling owned by `docs/specs/20260704-vault_backend_implementation.md`.
- Do not store plaintext secret values in SQLite or workspace files.
- Do not let workers request arbitrary secrets by name.
- Do not expose raw secret material through App API, end-user CLI, Web UI, logs, or diagnostics.
- Do not treat environment-variable shortcuts as the long-term vault model.

## Concepts

`VaultReference` is a non-secret stable reference to secret material.

`VaultGrant` records that a subject, session, capability, or provider path may use a vault reference.

`VaultInjection` is the umbrella lifecycle for one governed secret injection, from an approved pre-effect plan through resolution and a completed sink effect.

`VaultInjectionPlan` is the non-secret pre-effect record of how a granted secret may be made available. It is not use authority or evidence that injection happened.

`VaultInjectionReceipt` is the non-secret record that a planned injection completed successfully. Denied, failed, interrupted, and unproven attempts have no receipt.

`VaultUse` is the current audit-linked evidence record for a successful or failed secret-reference resolution. It is not proof that a downstream sink completed.

`VaultAudit` remains a future consolidated projection and has no current schema, service, table, or public record.

`SecretMaterial` is the actual credential value. It never belongs in normal OpenKit records.

## Ownership Scopes

Vault references may be:

- server-scoped
- user-scoped
- workspace-scoped

The scope determines who owns the reference metadata and which policy domain must authorize use.

Cross-scope use must be explicit. For example, a workspace may use a server-owned provider credential only through a server-approved provider instance and a workspace-visible grant.

## Secret Backend

NanoCore has one current Vault backend kind: `encrypted-file`. Local and server modes use the same backend contract and storage boundary; there is no deployment-mode selector, alternate backend, or runtime fallback. Concrete ciphertext, authenticated metadata, and master-key handling belong to `docs/specs/20260704-vault_backend_implementation.md`.

Provider login flows may produce credential material and runtime-issued credentials may be injected through governed paths, but neither is a separate NanoCore Vault backend category. Codex and xAI subscription credentials share the encrypted-file backend through their distinct server-owned references. Another provider, including Claude, may reuse that storage only after a separate accepted entitlement and provider contract authorizes the provider path.

## Reference Shape

A vault reference should carry:

- reference id
- owner scope
- display name
- secret kind
- backend kind
- backend locator, redacted where needed
- rotation metadata
- status
- sensitivity
- allowed use domains
- created and updated timestamps

It must not carry the secret value.

## Grant Shape

A vault grant should carry:

- grant id
- vault reference id
- subject summary
- owner scope
- target workspace id when applicable
- target agent id or AgentSession id when applicable
- target capability id when applicable
- allowed injection paths
- lifetime
- policy decision id
- approval id when required
- status
- created and expires timestamps

Nullable grant identity and target fields have exact constraint semantics. A non-null `userId`, `workspaceId`, `targetAgentId`, `targetAgentSessionId`, or `targetCapabilityId` restricts use to the exact matching current execution fact, while `null` adds no constraint for that dimension and never bypasses owner-scope, reference-identity, policy, lifetime, or injection-path validation.

An AEP credential declaration may consume a grant only when NanoCore can prove every non-null constraint from the package being resolved. Manifest backend `requiredCapabilities` and static Skill or MCP supply ids are not callable capability proof. When the current AEP capability plane is disabled or does not contain the exact active capability route, a non-null `targetCapabilityId` must fail closed before any injection plan, receipt, vault use, secret resolution, or backend-private sink effect.

Immediately before material leaves the Vault backend or an injection sink is invoked, a Workspace-attributed use applies the current-authority predicate from `docs/specs/20260715-multi_user_workspace_system.md` with `vault.use`, the authenticated request actor or owning AEP `scope.triggerActor`, and the exact active target-matching target-issued VaultGrant as the effect authority. Every non-null grant constraint must match the current execution. The grant is the durable result of its issuance policy; optional `approvalId` and `policyDecisionId` fields are immutable lineage and not another use-time decision owner. If `approvalId` is non-null, it must use the target-issued namespace and the same grant must carry a non-null `policyDecisionId`, but use-time enforcement does not re-run or reconstruct the Approval workflow. A null or stale responsible user, removed membership, role or policy denial, inactive or imported grant, missing required lineage, or target mismatch permits no resolution or injection. The existing audited wrapper may write a redacted failed `VaultUse` and AuditEvent, but neither record becomes authority. Material already injected through a runtime file or environment cannot be recalled atomically. Credential or grant revocation terminates the affected sandbox at the next governed boundary; if deletion cannot be proved, the NanoHost invalidates the complete Runtime Epoch and holds capacity until fresh-empty readiness. NanoCore accepts no stale-authority publication, and cleanup never proves recall of material already exposed. An already-submitted worker-native request may finish under the explicit bounded compromise in the multi-user specification. This rule adds no mutable AEP, dynamic revocation protocol, session state, or recovery workflow.

Grant lifetimes:

- `capability-call`
- `turn`
- `agent-session`
- `workspace`
- `server`

Longer lifetimes require stronger policy.

## Current Implementation Projection

The current implementation includes:

- `packages/config-schema/src/agent-environment.ts` defines AEP vault references and grants. `VaultReference.kind` currently supports `secret-ref`, `runtime-ref`, and `grant-ref`. `VaultGrant.scope` currently supports `agent-session`, `turn`, and `workspace`.
- `apps/nanocore/src/vault/vault-references.ts` stores first-slice durable non-secret `VaultReference` metadata in `core.sqlite` through the `vault_references` table. This stores reference id, owner scope, display name, secret kind, backend kind, redacted backend locator, status, current version, and timestamps; it does not store secret material.
- `apps/nanocore/src/vault/vault-grants.ts` stores first-slice durable non-secret `VaultGrant` metadata in `core.sqlite` through the `vault_grants` table. This stores grant id, vault reference id, owner scope, target workspace/user ids, subject summary, target agent/session/capability ids, allowed injection path classes, lifetime, policy decision id, approval id, status, and timestamps; it does not store secret material or injection receipts.
- `apps/nanocore/src/vault-injection-plans.ts` stores durable non-secret `VaultInjectionPlan` metadata through the `vault_injection_plans` table, and `apps/nanocore/src/vault-injection-receipts.ts` stores durable non-secret `VaultInjectionReceipt` metadata through the `vault_injection_receipts` table.
- Workspace-scoped grant, plan, and receipt metadata are currently exposed through `GET /api/app/workspaces/:workspaceId/vault/grants`, `GET /api/app/workspaces/:workspaceId/vault/injection-plans`, and `GET /api/app/workspaces/:workspaceId/vault/injection-receipts`, plus the `WorkspaceVaultInjectionPlan`, `ListWorkspaceVaultInjectionPlansResponse`, `WorkspaceVaultInjectionReceipt`, and `ListWorkspaceVaultInjectionReceiptsResponse` public types, the matching `client.app.listWorkspaceVaultInjectionPlans` and `client.app.listWorkspaceVaultInjectionReceipts` methods, and the unified Skill/CLI `vault.grant-list`, `vault.injection-plan-list`, and `vault.injection-receipt-list` operations.
- `apps/nanocore/src/vault/vault-use-records.ts` stores first-slice durable non-secret `VaultUse` metadata through the `vault_use_records` table. Server-scope rows home in `core.sqlite`; workspace-scope rows home in `workspace.sqlite`. The record stores use id, owner scope, workspace id when applicable, vault reference id, material version when known, backend kind, resolving path, linked grant/plan/receipt ids, actor ids, outcome, failure code, audit event id, and timestamp; it does not store secret material or backend secret locators, and it does not require the referenced vault row to exist so failed resolutions can be recorded. Server-scoped rows are exposed through `GET /api/app/vault/use-records`, `client.app.listServerVaultUseRecords`, and the unified Skill/CLI `vault.server-use-list` operation; workspace-scoped rows are exposed through `GET /api/app/workspaces/:workspaceId/vault/use-records`, `client.app.listWorkspaceVaultUseRecords`, and the unified Skill/CLI `vault.use-list` operation. Authorization for both surfaces follows the owning matrix in `docs/specs/20260704-vault_backend_implementation.md`.
- The AEP schema recursively rejects raw secret-bearing fields such as `apiKey`, `clientSecret`, `secret`, `token`, and `password`.
- Provider profile and server config schemas reject inline provider secrets and URL userinfo. The removed `extraHeaders` and `extraBody` fields have no consumer and are rejected as unknown fields without a compatibility path; configured credentials require `secretRef`.
- Provider credential resolution supports `env:` secret references for first-slice local and server deployment, and NanoCore now resolves provider `secretRef: vault://<referenceId>` through the server vault backend with a non-secret `VaultUse` row on resolve success or typed failure. The OpenAI-compatible LLM Gateway routes, including `/v1/chat/completions`, use the same audited resolver for vault-backed provider credentials.
- Diagnostics and App API response schemas include raw-secret guards and redacted markers for secret references.
- Boot diagnostics now project the initial locked-vault state as degraded readiness and name `vault.read`, `vault.use`, and `secret.inject` as blocked operations until a concrete backend is unlocked.
- NanoCore has one internal `VaultBackend` implementation, `encrypted-file`, for `store`, `resolve`, `rotate`, `revoke`, and `listReferences`; both local and server composition use that locked encrypted-file state at `DATA_ROOT/server/vault/`. Config, App API, storage, import, OpenAPI, and bundled-client projections admit only `encrypted-file`, and the prior Keychain backend, backend selector, platform adapters, alternate-backend literals, and dedicated tests are deleted. The backend validates the strict server-owned provider-slot projection, authenticates ownership, creation time, expiration, and provider-slot metadata as associated data, rejects entry, state, version, temporary-file, and symlink disagreement during ordinary operations, permits only attributable revoke cleanup, and enforces an owner-only exact-`0600` raw key file whose canonical path remains outside `DATA_ROOT`. Server-admin-authorized vault status, unlock, lock, server VaultUse readback, Codex auth JSON bootstrap, failed-unlock rate limiting, audited resolution, explicit cross-scope grants, and persistent revocation cascades are implemented.
- OpenShell worker materialization no longer uploads host runtime configuration directly. GitHub sandbox-provider resolution creates durable grant, plan, receipt, and `VaultUse` rows, but the current OpenShell backend rejects the backend-private provider credential before provider or sandbox effects because the AEP does not yet carry the exact Providers v2 endpoint and binary policy. Codex auth JSON has a durable runtime-file path through `grant_codex_auth_json` and `vault_codex_auth_json`, and host-side Git push has a gateway-only path through `git.vaultGrantRef`. The shared worker declaration resolver and host Git push resolver currently persist the receipt before backend resolution and sink completion; a failed resolution can therefore retain a receipt even though no successful injection occurred. The current reference-revocation cascade also marks every active receipt `stale-session`, without checking whether its visibility path could retain material. Both projections are broader than the accepted `VaultInjectionReceipt` completion and lifecycle meanings and must be aligned without treating premature or blanket status rows as authority, completed injection evidence, or proof of retained material. Secret values remain absent from AEP snapshots, public materialization records, exports, logs, and product records.

The provider-neutral subscription account manager and its `account.json` storage and binding lifecycle, pi-ai login, refresh, and logout path, and reviewed provider-pair cleanup remain incomplete under `docs/specs/20260721-provider_subscription_accounts.md`; the encrypted-file backend now supplies their required authenticated inventory and revoke mechanisms without implementing account authority. Durable grant policy engine expansion, cross-scope grant review beyond metadata identity validation, a policy-equivalent non-transient OpenShell provider attachment path, and audited backend resolution wiring for future credential-use classes also remain incomplete, so this spec is `Partial`.

The current fields are implementation schema choices for the Agent Environment Package slice. They do not replace the conceptual ownership scopes, grant lifetimes, injection plans, receipts, and audit-linked vault-use records defined by this spec.

## Injection Visibility

Injection paths must declare visibility:

- `gateway-only`: secret is used by NanoCore and never exposed to worker runtime.
- `backend-provider`: backend attaches the credential to a provider without exposing it to the process where possible.
- `runtime-env`: worker process sees an environment variable.
- `runtime-file`: worker process sees a mounted credential file.
- `runtime-token`: worker process receives a short-lived token.
- `external-handle`: worker receives a handle that an external system validates.

The preferred path is `gateway-only`. Worker-visible paths require stronger policy and audit.

## Vault Injection Plan

An injection plan should carry:

- plan id
- grant id
- package snapshot id
- capability id when applicable
- injection visibility
- target path or env var name when visible to runtime
- expiration behavior
- revocation behavior
- redaction rule
- backend capability requirement

The AEP snapshot may reference injection plans and grants, but it must not include secret values.

## Vault Injection Receipt

An injection receipt should carry:

- receipt id
- plan id
- grant id
- AgentSession id or capability call id
- backend summary
- injected at timestamp
- expires at timestamp
- revocation status
- audit event id

The receipt is written only after the sink effect completes successfully. Authorization refusal, backend resolution failure, sink failure, interruption, or an unproven completion may emit redacted `VaultUse` or audit evidence but MUST NOT create a receipt. The receipt remains immutable evidence and never becomes authority for a later injection.

The receipt id, successful completion fact, original plan and grant linkage, AgentSession or capability-call lineage, backend summary, injection time, and original audit linkage are immutable. `revocationStatus` and other explicitly owned lifecycle projections may advance after completion, but they do not alter the original completion fact, rewrite lineage, or prove that exposed material was recalled.

## Lifecycle And Failure Rules

- `VaultGrant` is the use authority. A plan, receipt, `VaultUse`, or audit event MUST NOT create, extend, recover, or substitute for a grant.
- A plan is created after current grant and target validation and before backend resolution or sink invocation. A failed attempt may leave the plan as truthful pre-effect history.
- Backend resolution writes one `VaultUse` success or typed failure. Successful resolution alone does not prove injection completion.
- Rotation preserves the reference identity and advances backend material version. New injection attempts use the current version unless an explicitly selected prior version remains inside backend grace; past grace, resolution fails as expired.
- Revocation blocks future resolution and advances dependent plan lifecycle status without changing the plan's original identity, intent, target, grant lineage, or creation fact. A receipt is marked `stale-session` only when already injected runtime material may remain reachable; the existing runtime lifecycle owns stopping or recycling that environment.
- Expiry is checked at each governed use or sink boundary. `expiresAt`, expiration behavior, and stored status are durable facts, not a claim that a background process advances statuses automatically.
- Missing or stale authority, missing lineage, target mismatch, backend lock or unavailability, revoked material, expired material, and integrity disagreement fail closed with product-safe diagnostics. They create no receipt and authorize no automatic repair.
- If an interruption leaves sink completion unproven, NanoCore MUST NOT infer success from the plan or fabricate a receipt. Existing runtime inspection or teardown establishes safety; a later injection requires current authority.
- Confirmed or unexcluded sandbox containment loss makes every potentially reachable injected credential stale. New resolution and injection stop immediately; the affected Turn and AgentSession are interrupted; the complete Runtime Epoch is invalidated through its existing owner; and no unaccepted output is published. Potentially exposed references and material versions are routed to the existing revoke or rotation owner according to their backend capability and policy, without storing secret material in the containment evidence. Cleanup does not prove recall, and a later use requires current authority and fresh containment.

## Receipt Visibility Projection

Injection receipts are audit-first records.

Item-visible projection should be limited to non-secret operational status:

- credential use requested
- approval required
- credential use granted or denied
- credential unavailable
- credential injected through a named non-secret visibility class
- session stale or degraded because revocation cannot affect an already-running process

Audit-only receipt detail includes:

- vault reference id
- vault grant id
- injection plan id
- injection receipt id
- backend locator summary
- target path, environment variable name, token handle, or provider attachment detail
- policy decision id
- approval id
- revocation status
- exact timestamps and retention metadata

Product diagnostics may cite receipt ids, grant ids, visibility class, policy decision id, and redacted backend summaries. They must not show secret values, raw provider tokens, raw account identifiers, raw credential file contents, authorization headers, or unrestricted target paths.

## Provider Credentials

Authored provider profiles and server config use `secretRef` as their only credential path. `vaultRef` and `grantRef` belong to internal vault and injection records, not provider config.

Provider `baseUrl` values must not contain URL username or password userinfo. The consumer-free `extraHeaders` and `extraBody` fields are removed from authored provider config, and current schemas must reject them as unknown fields without compatibility handling.

Provider instances must never contain:

- API keys
- bearer tokens
- refresh tokens
- authorization headers
- raw OAuth account ids
- raw auth files

When provider routing needs a credential, the gateway or backend validates the grant, records audited resolution as `VaultUse`, performs the injection sink effect, and records a receipt only after that effect succeeds.

## MCP Credentials

MCP servers may need credentials through environment variables, headers, or OAuth.

NanoCore must resolve MCP credentials through vault grants and generate a runtime-specific MCP config that references the injection path, not the raw secret value.

Workers must not receive an MCP server command that includes plaintext credentials.

## Worker Runtime Credentials

Worker-visible credentials are allowed only when the target runtime cannot function through gateway-only or backend-provider injection.

The worker AEP must declare:

- why the worker must see the credential
- how long it is valid
- where it is visible
- how it is revoked
- which policy decision allowed it
- which audit event records it

## Revocation

Revocation should support:

- disable future use
- revoke grant
- revoke short-lived token
- stop or recycle affected worker sessions
- mark sessions stale
- rotate backend material when supported

If revocation cannot affect an already-running process, NanoCore must mark the session stale or degraded and explain the limitation.

## Resolved Decisions

- Normal config, manifests, AEP snapshots, item logs, knowledge, artifacts, diagnostics, and protocol payloads carry secret references, grants, or redacted markers only.
- Inline provider secrets and URL userinfo are not allowed in provider profiles or server config. The consumer-free `extraHeaders` and `extraBody` fields are removed and rejected as unknown fields without compatibility handling; authored credentials use `secretRef` only.
- `env:` secret references remain an explicit development-only input where separately allowed; they are not a Vault backend. Provider `secretRef: vault://<referenceId>` is the implemented Vault-backed provider credential shape.
- Workspace exports may include non-secret `VaultReference`, `VaultGrant`, `VaultInjectionPlan`, `VaultInjectionReceipt`, and `VaultUse` history at the exact paths owned by the portability specification, but must not export secret material or treat any imported row as target access authority. Imports keep references unbound and remint grants into the reserved import namespace; that imported grant identity remains permanently non-authorizing after rebind, and fresh authorization creates a distinct target-issued grant before use.
- Workspace-lifetime grants are allowed only through explicit policy and should be reserved for stable gateway or provider paths. Worker-visible credential paths should default to shorter lifetimes.
- Worker-visible secret material requires an explicit policy decision and should require a human approval gate unless a workspace policy has preauthorized the exact low-risk path.
- Explicit OpenShell Codex auth file uploads have been removed. The durable `vault_codex_auth_json` path produces injection plans, receipts, and audit records for Codex auth JSON.
- Injection receipts are audit-first. Item-visible projection is limited to non-secret status and stale/degraded session explanations.
- The encrypted-file backend choice and mechanics are owned by `docs/specs/20260704-vault_backend_implementation.md`. This spec owns the reference, grant, injection, receipt, visibility, and audit contract rather than the concrete file format.

## Deferred / Future Work

- Extend audited vault-use wiring to remaining MCP routing and any future runtime-file credential classes.
- Add remaining grant approval and stale-session projections; runtime revocation follows affected-sandbox termination and unproved-deletion epoch invalidation without adding a Vault-owned cleanup lifecycle.

## Testing Strategy

- Schema tests for references, grants, plans, and receipts.
- Redaction tests proving secrets do not appear in config, AEP snapshots, item logs, audit summaries, or diagnostics.
- Gateway-only provider tests.
- Runtime-env injection tests with explicit policy approval.
- Revocation tests that mark affected sessions stale, terminate the affected sandbox, and invalidate the epoch when deletion cannot be proved.
- MCP credential materialization tests.
- Cross-scope grant denial tests.
- Provider-subscription custody tests proving NanoCore persists Codex and xAI credentials only through their Vault references and never creates, reads, or retains a provider-specific credential home.

## Risks & Mitigations

- Risk: Local env shortcuts become de facto production vaults. Mitigation: label env-backed secrets as development only unless deployment policy explicitly allows them.
- Risk: Workers leak runtime-env secrets. Mitigation: prefer gateway-only and short-lived runtime tokens.
- Risk: A provider authentication adapter retains a second credential copy outside Vault. Mitigation: NanoCore persists subscription credentials only through Vault and forbids provider-specific credential homes.
- Risk: Grants outlive their intended task. Mitigation: default to turn or capability-call lifetime.

## Links

- `docs/core/vault.md`
- `docs/core/permissions.md`
- `docs/core/agent-capability.md`
- `docs/core/storage.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260629-openkit_policy_model.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
