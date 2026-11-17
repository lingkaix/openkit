---
status: Accepted
kind: mechanism
implementation: Implemented
aspect: vault
---
# Vault Backend Implementation

This specification owns the NanoCore `VaultBackend` interface, the sole `encrypted-file` backend implementation used in both local and server deployment modes, its external raw master-key file and envelope-encryption format, per-reference versioning, rotation grace, destructive revocation, strict enumerable inventory and revoked-tombstone predicates, `VaultUse` resolution emission, and public Workspace and Server shared-MCP secret administration.

## Scope

### Owns

- The internal `VaultBackend` boundary (`resolve`, `store`, `rotate`, `revoke`, `listReferences`, `health` in `apps/nanocore/src/vault/vault-backend.ts`) and the sole `encrypted-file` backend implementation (`DATA_ROOT/server/vault/`) for both local and server modes, with no backend selector, fallback, compatibility reader, passphrase derivation, environment master key, KMS, external secret manager, journal, or replacement enumeration API.
- The external raw `32`-byte master-key file contract (`vault.encryptedFile.keyFilePath`), `aes-256-gcm` envelope encryption, unlock/lock lifecycle, failed-unlock rate limiting, per-entry versioning, rotation grace, destructive revocation, authenticated `VaultEntryMetadata` (including the server-only `providerSubscriptionAccount` projection), and the backend-recognized revoked tombstone predicate.
- `VaultUse` emission at every backend material resolution, data-root export and backup exclusions for secret material and master keys, and public Workspace secret administration (`vault.secret-*`, `vault.grant-*`), authored Provider API-key storage (`vault.provider-api-key-set`), and Server shared-MCP secret administration (`mcp-credential`).

### Does Not Own

- `VaultReference`, `VaultGrant`, `VaultInjectionPlan`, `VaultInjectionReceipt`, and `VaultUse` record semantics, credential access declarations, and harness Login lifecycle in `docs/specs/20260703-vault_secret_injection.md`.
- Provider-subscription account lifecycle, slot identity, `account.json` binding, and reviewed orphan cleanup in `docs/specs/20260721-provider_subscription_accounts.md`.
- Worker credential delivery channels and OpenShell provider derivation in `docs/specs/20260703-openshell_mechanism_internalization.md`, or Runtime Epoch lifecycle, Sandbox termination, and transport in `docs/specs/20260802-nanohost_runtime_and_transport.md`.
- Permission Policy and enforcement points in `docs/specs/20260629-openkit_policy_model.md` and `docs/specs/20260703-policy_enforcement_mapping.md`.
- Physical `DATA_ROOT` layout in `docs/specs/20260703-storage_layout_record_ownership.md`, or Workspace backup and export archives in `docs/specs/20260704-workspace_backup_export_import.md`.

### Core

- `docs/core/vault.md`
- `docs/core/storage.md`
- `docs/core/policy.md`
- `docs/core/evidence.md`

## Contract / Expected Behavior

### VaultBackend Boundary

A `VaultBackend` (`apps/nanocore/src/vault/vault-backend.ts`, `apps/nanocore/src/vault/vault-encrypted-file-backend.ts`) MUST implement these operations, all keyed by `VaultReference` ID and never by raw locator strings from callers:

- `resolve(referenceId, version?)`: return the requested material version, or the current version when unspecified; fail typed when the reference is unknown, revoked, expired past grace, locked, unavailable, or internally inconsistent.
- `store(referenceId, material, metadata)`: write version `1` through one atomic entry-file replacement and then one separate atomic state-file replacement for a reference that has no material, or fail without overwriting existing or inconsistent state.
- `rotate(referenceId, material)`: write version `N+1` through one atomic entry-file replacement and then advance the strict state through one separate atomic replacement; never overwrite an existing version.
- `revoke(referenceId)`: make every version immediately unresolvable, destroy all attributable material versions, and retain only the non-secret revocation inventory required for audit and orphan detection.
- `listReferences(scope?)`: return non-secret metadata for strict consistent live or revoked inventory rows, filtered by scope, and fail rather than omit any malformed, unauthenticated live material, missing required live entry, extra, or contradictory entry or state encountered in the addressed inventory.
- `health()`: return `available`, `locked`, or `unavailable` with a redacted diagnostic.

Rules:

- Secret material may cross the boundary only in `resolve` return values and `store` or `rotate` inputs.
- Backend errors use only `vault-locked`, `reference-not-found`, `version-expired`, `reference-revoked`, or `backend-unavailable` and never include material, raw locators, local paths, decrypted metadata, caught messages, or provider payloads.
- `VaultReference` metadata remains the generic SQLite source of truth (`apps/nanocore/src/vault/vault-references.ts` and `apps/nanocore/src/storage/vault-native.ts` distinguish a fresh reference insert from an idempotent match, accept only an equal or one-step-ahead active material-version projection, and transactionally revoke a reference, its dependent grants and plans, and active injection receipts according to proved visibility). The backend owns material and material-integrity metadata and MUST NOT become account, binding, authorization, or provider-dispatch authority.
- `encrypted-file` is a fixed backend kind in both local and server modes across config, App API, storage, import, OpenAPI, and bundled-client projections; there is no backend selection or runtime fallback. Codex and xAI/Grok provider-subscription credentials share this store through distinct server-owned `VaultReference`s (`apps/nanocore/src/llm/provider-subscription-accounts.ts`), and another provider (including Claude) may reuse the storage mechanism only after a separate accepted entitlement and provider contract authorizes that path. The `vault.bootstrap-codex-auth` operation acquires a User-owned Codex harness Login under User Policy, `PermissionDecision`, and Audit (`docs/specs/20260703-vault_secret_injection.md#harness-subscription-logins`) as an explicit exception to Server administration without relaxing any other Vault operation.

### Public Workspace Secret Administration

Deployment-admin actors may create Workspace references from request-only material, rotate their material, revoke references, and create, narrow, or revoke Workspace-lifetime grants for supported sinks (`CreateWorkspaceVaultSecretRequestSchema`, `RotateWorkspaceVaultSecretRequestSchema`, `CreateWorkspaceVaultGrantRequestSchema`, and `NarrowWorkspaceVaultGrantRequestSchema` in `packages/app-api-schemas/src/vault-admin.ts`). Workspace authorization applies to the addressed Workspace, and a currently usable administrator credential satisfies that Workspace authorization under the Administrator Eligibility rule in [Core Policy](../core/policy.md); Workspace bearer Tokens and ordinary sessions without derived deployment-admin authority cannot mutate this administrative surface. Existing filtered reference and grant lists remain the redacted inventory authority.

`POST /api/app/operations/vault.secret-create` accepts `CreateWorkspaceVaultSecretRequestSchema`, assigns a fresh reference ID (`UUIDv7`), stores encrypted backend version `1`, then creates matching Workspace Core metadata. `secretKind` is a bounded lowercase classification identifier, never a credential value. `vault.secret-rotate` accepts `RotateWorkspaceVaultSecretRequestSchema` and preserves reference and grant identities. After current administrator and exact Workspace reference admission, `vault.secret-revoke` commits the Core reference/grant/plan/receipt revocation cascade before backend material destruction, then attempts backend destruction and awaits runtime interruption and binding cleanup; backend failure cannot roll back the Core fence or skip runtime cleanup, success requires both backend destruction and proved runtime closure (unproved cleanup retains `recovery_required` and Runtime Epoch rules), and revoked IDs remain redacted history that is never reused or physically deleted from Core.

`vault.grant-create` (`CreateWorkspaceVaultGrantRequestSchema`) addresses a matching active Workspace reference:

- Omitted or `gateway-only` `injectionPath` creates a fresh Workspace-lifetime `gateway-only` grant for selected MCP use under `docs/specs/20260703-vault_secret_injection.md` and `docs/specs/20260704-worker_mcp_tool_supply.md`.
- Explicit `runtime-env` `injectionPath` accepts only a `github-token` reference and creates a Workspace-lifetime grant limited to `runtime-env` (used by an Agent Manifest `requirementId: github-token` declaration with `targetEnvVarName: GITHUB_TOKEN` via `credentialBindings` for explicit user-space private clone/fetch or native Git push, while default hosting uses catalog-bound `gateway-only` MCP grants under [Hosting Through Gateway MCP](../decisions/20261002-hosting_through_gateway_mcp.md)); a `runtime-env` grant cannot substitute for a `gateway-only` MCP grant, and a `gateway-only` grant never authorizes Sandbox environment injection.
- Explicit `runtime-file` `injectionPath` creates a high-risk Workspace-lifetime `runtime-file` grant under `docs/specs/20260703-vault_secret_injection.md#runtime-file-visibility`.
- Optional `targetAgentId` and `targetAgentSessionId` restrict use to exact matching current execution facts. Public `targetCapabilityId` admits only exact `mcp.list-tools` or `mcp.call-tool` (never an `mcp` wildcard or arbitrary string), and `runtime-env` and `runtime-file` grants reject any `targetCapabilityId` because their consumers are not capability routes. Omitted targets add no restriction and bypass no scope, actor, Policy, lifetime, or sink check. Each creation allocates a new grant ID, preserves the reference and its material version, requires any `expiresAt` to be a future canonical UTC timestamp, and adds no binding automatically.

`vault.grant-list` provides redacted review of retained constraints and lifecycle facts. `vault.grant-narrow` (`NarrowWorkspaceVaultGrantRequestSchema` -> `NarrowWorkspaceVaultGrantResponseSchema`) addresses a supported Workspace-lifetime `gateway-only`, GitHub `runtime-env`, or `runtime-file` grant: every supplied dimension must retain or reduce original authority with at least one strict reduction (a non-null target cannot be cleared or replaced, `allowedInjectionPaths` must be a non-empty subset, and `expiresAt` must be canonical, future, and no later than the original bound), while scope, reference, lifetime, `issuance`, and approval/Policy lineage stay unchanged and unsupported, inactive, expired, `imported-history`, or mismatched grants are rejected. Narrowing atomically revokes the original grant and dependent injection projections, creates a distinct target-issued replacement, and writes initiating-human Audit in one Core transaction without touching the backend (so narrowing works while locked, while bindings require an explicit update and retries against the revoked original return `409`). Wrong-scope or missing grants return `404`, invalid or non-narrowing constraints return `400`, and stale/conflicting authority returns `409`.

`vault.grant-revoke` revokes a supported Workspace grant and dependent injection state in one Core transaction and remains available while the backend is locked. Request and review workflows are owned by `docs/specs/20260703-vault_secret_injection.md#supported-grant-request-and-review`.

Each transition emits redacted administrative Audit evidence. Secret input is confined to the immediate request and `VaultBackend.store`/`rotate` call; responses expose only the redacted reference or grant shape with `Cache-Control: no-store`, CLI material arrives on stdin JSON (never argv), and Web clears password inputs on submit, discards mutation responses, and stores no material in caches, browser storage, URLs, or error objects. Missing or wrong-scope records, Core/backend identity/owner/locator/version disagreement, non-GitHub `runtime-env` requests, unsupported paths, or past expiry fail without mutation. Locked or unavailable storage refuses operations that resolve, store, or rotate material, including when Core or native publication capability is missing. Metadata grant narrowing and grant revocation stay available while locked and keep their cleanup and fencing requirements. Those metadata operations do not require unlock. Because ordered backend and Core writes are not a single transaction, a failed fresh metadata insert triggers best-effort destruction of newly stored material, while other partial or interrupted effects return a fixed redacted failure requiring inventory and Audit inspection before a new request without automatic reconstruction or version advancement.

### Authored Provider API Keys

`vault.provider-api-key-set` (`POST /api/app/operations/vault.provider-api-key-set`) is the deployment-admin operation for storing or replacing one authored Provider profile's API key. The public response is only the redacted configured observation for that provider:

- The profile MUST be the unique valid file-backed profile with that exact `providerId` and declare one canonical `vault://<referenceId>` in `secretRef`. New API-key Provider profile authoring (Web create form and server template) allocates one independent canonical `vault` `UUIDv7` via the shared Protocol generator and persists `vault://<referenceId>` in `secretRef` (retaining the same candidate across pending Web create retries for the same `providerId`, while a changed `providerId` allocates a fresh reference); reading, reload, key replacement, and recovery consume the recorded `secretRef` without deriving it from `providerId` or discovering another reference.
- The first successful write stores backend version `1` and creates the server-owned active `encrypted-file` `VaultReference` for that provider API key. A later write rotates the same reference and advances the Core version. Reference/backend disagreement, missing paired authority, malformed/ambiguous Provider configuration, a locked backend, or concurrent same-reference writes fail closed (resuming only from equal-version state or the backend-one-version-ahead prefix of a prior ordered write), and failure after a fresh backend store revokes that material and returns `recovery_required` because a consumed reference ID is never reused. Provider `secretRef: vault://<referenceId>` resolution for Gateway and Quick Chat calls uses the audited wrapper, converts public failures to fixed provider-unavailable responses, and keeps typed Vault detail only in redacted internal evidence.

`VaultEntryMetadata` and `ProviderSubscriptionAccountProjection` (`apps/nanocore/src/vault/vault-backend.ts`) own the strict optional provider-subscription inventory projection on encrypted entries. The projection is permitted only when owner scope is server and Workspace and User ids are absent. Invalid metadata fails as redacted `backend-unavailable` before storing material. Rotation preserves the projection, revocation retains it only in non-secret `state.json` inventory, and `listReferences` returns it without material; it exists solely so filesystem inventory can attribute encrypted material to a local provider and slot when `account.json` is absent or invalid, and never creates/reconstructs an account, changes a binding, authorizes use, enters public responses, or adds columns to `vault_references`.

### Backend-Recognized Revoked Tombstone

An exact backend-recognized revoked tombstone for a current provider-subscription binding (`apps/nanocore/src/vault/vault-encrypted-file-backend.ts`, consumed by `apps/nanocore/src/llm/provider-subscription-accounts.ts`) exists only when `listReferences` completes whole-inventory strict validation and accepts exactly one current-binding row with `referenceId` equal to the account binding, `backendKind: "encrypted-file"`, `ownerScope: "server"`, absent `workspaceId` and `userId`, matching `providerSubscriptionAccount.subscriptionProviderId` and `accountSlotId`, `revoked: true`, equal positive safe integers `currentVersion` and `versionCount`, and zero material entry files, writer temporaries, state temporaries, or unknown residue in the reference directory (leaving only canonical revoked `state.json`). Any mismatch or residue fails closed. It is durable backend revocation proof under the single-NanoCore owner-only-filesystem boundary and may be used only by `docs/specs/20260721-provider_subscription_accounts.md` to let an already-started logout or delete finish the generic Core revocation cascade and binding clear/account deletion; it never authorizes a Vault write, ordinary account validity, reference reuse, metadata restoration, or automatic repair.

### encrypted-file Store

- The store root is `DATA_ROOT/server/vault/` (`0700` directories, `0600` files, rejecting symlinked children and unsafe paths in `apps/nanocore/src/vault/vault-store-directory.ts` and `apps/nanocore/src/vault/vault-encrypted-file-store.ts`) for both local and server modes, and is never nested inside a Workspace tree.
- `header.json` authenticates the store without storing key bytes or recoverable material. Header and entry envelopes use the shared retained-v1 `schemaVersion: 1` marker via `readRetainedV1` and `writeRetainedV1`, including header verification associated data, and fail closed on a missing, unknown, or predecessor marker without a legacy reader.
- Each material version lives at `entries/<referenceId>/<version>.enc`, and each reference has strict non-secret inventory at `entries/<referenceId>/state.json`. Every entry uses a unique data key and Node stdlib `aes-256-gcm`. Associated data binds the entry, so moving, copying, or renaming ciphertext fails authentication. `apps/nanocore/src/vault/vault-encrypted-file-store.ts` owns the envelope.
- A live `state.json` is trusted only when it agrees with the authenticated entry set. After revocation destroys the entry set, only the backend-recognized revoked tombstone predicate above is accepted. Per-entry envelopes are written independently via same-directory exclusive `O_NOFOLLOW` write-new-then-rename (`0600`) without re-encrypting the whole store, assuming the single-NanoCore owner-only-filesystem boundary and failing closed on any detected descriptor or directory mismatch.

### Integrity And Orphan Detection

Internal directory traversal inspects every reference directory, `state.json`, `<version>.enc`, writer temporary, and unknown artifact in the addressed scope without adding a public enumeration API or second record family. A live entry authenticates its provider-slot projection before participating in account orphan checks; any missing required live entry, malformed, unauthenticated, extra, stale, temporary, or contradictory entry or state file fails closed as redacted `backend-unavailable` (never omitted, inferred from a path, repaired from `account.json`, or treated as absence). A crash between independently atomic entry and state writes is never auto-repaired; ordinary resolution, provider-account listing, reconciliation, account deletion, binding clear, and pair reuse remain failed closed until either explicit `revoke` destroys mutually attributable canonical and complete writer-temporary material or the reviewed cleanup procedure in `docs/specs/20260721-provider_subscription_accounts.md` completes.

### Master Key And Lock State

The sole configured master-key source is `vault.encryptedFile.keyFilePath` in `config/server.jsonc` (`apps/nanocore/src/vault/vault-key-file.ts`), which MUST be an absolute canonical path outside `DATA_ROOT` (rejecting parent-symlink aliases) naming a regular non-symlink file owned by the NanoCore process user with exact `0600` permissions and `32` raw bytes, loaded via one `O_RDONLY | O_NOFOLLOW` descriptor and `fstat`:

- If no valid configured key is available at boot, boot proceeds with the Vault `locked` (`apps/nanocore/src/vault/vault-unlock-state.ts`), Vault-dependent operations (`vault.read`, `vault.use`, `secret.inject`) fail `vault-locked`, and readiness reports the Vault subsystem degraded.
- Boot and authenticated `server-admin` unlock verify the key against `header.json` before exposing an available backend (failed-unlock rate limiting refuses after a current default of `5` failures within `60,000 ms` in `apps/nanocore/src/vault/vault-operation-implementations.ts`). `header.json` is initialized only for an empty safe store; a wrong key, malformed/unsupported header, tampered metadata, or non-empty headerless store never rewrites the store.
- Admin lock zeros the process-owned master-key buffer and returns the backend to `locked` without touching stored entries, invalidating retained backend instances. Master keys, unwrapped data keys, temporary key-file buffers, decrypt intermediates, request buffers, and failed replacement keys are zeroed at their lifecycle boundaries and never enter logs, diagnostics, SQLite, or disk outside the configured key file.

### Versioning, Rotation, And Revocation

- Versions are monotonically increasing safe positive integers beginning at `1`.
- `rotate` atomically writes version `N+1` before atomically advancing `state.json` and marks prior non-expired versions with the configured grace expiry (`rotationGraceMs`, current default `0 ms` in `apps/nanocore/src/vault/vault-encrypted-file-backend.ts`). Within grace, explicit prior-version resolution succeeds while current resolution returns `N+1`; after grace, prior-version resolution fails `version-expired` and expired material is destroyed.
- `revoke` invalidates all versions immediately with zero grace, guarantees that no version resolves again, and destroys every attributable material file, emitting the audit event owned by `docs/specs/20260703-audit_usage_evidence_records.md`.

### Vault-Use Audit Emission

- Every successful `resolve` (and each reference in a batch resolution) emits one redacted `VaultUse` row (`apps/nanocore/src/vault/vault-use-audited-backend.ts`) and never includes material. Failed resolution emits the same redacted row with its typed failure code. `store`, `rotate`, `revoke`, unlock, and lock emit their own `AuditEvent` actions under `docs/specs/20260703-audit_usage_evidence_records.md`.

### Storage, Export, And Scope

- Secret material lives only in encrypted `entries/<referenceId>/<version>.enc` files and never enters SQLite, item logs, Knowledge, Artifacts, AEP snapshots, evidence bundles, normal workspace files, errors, or diagnostics.
- Workspace export carries non-secret Vault references only and excludes `server/vault/`, data-root backup excludes the external master-key file, and tooling that scans, indexes, syncs, or exports `DATA_ROOT` treats `server/vault/` as opaque.
- One NanoCore deployment is one Vault trust domain: `server`, `user`, and `workspace` references share `DATA_ROOT/server/vault/` while every entry authenticates its `ownerScope` and owner ID, and any resolution whose caller scope differs from `ownerScope` is explicit cross-scope use requiring the governing grant and Audit context.

### Server Shared-MCP Secret Administration

Current deployment-administrator authority may manage Server `VaultReference` and `VaultGrant` records only for the shared-MCP classification `mcp-credential` (`apps/nanocore/src/vault/server-mcp-authority.ts`, `apps/nanocore/src/vault/vault-operation-implementations.ts`):

- This path lists redacted metadata, accepts material only in create/rotate requests, and supports grant issuance, strict revoke-and-replace narrowing, grant revocation, and reference revocation. Server grants use `server` lifetime and `gateway-only` visibility with optional exact Agent, AgentSession, operation (`mcp.list-tools` / `mcp.call-tool`), and future expiry bounds, admitting no User lifecycle, Worker-visible sink, Provider key, subscription account, bootstrap reference, source credential, or automatic binding.
- Reference creation, rotation, and revocation follow the ordered backend/Core effect rules, and grant narrowing reuses the single Core transaction and initiating-human Audit while preserving reference, `server` scope, lifetime, and lineage.
- The Server catalog's exact current shared-MCP binding supplies the cross-scope use authority in `docs/specs/20260704-worker_mcp_tool_supply.md#shared-server-origin-and-vault-use` (a Workspace-owned declaration cannot consume a Server grant); the audited backend records Server `VaultUse` in `core.sqlite` while its linked `AuditEvent` retains consuming Workspace, actor, and capability-call lineage.

## Acceptance

- Cryptographic, filesystem, and lifecycle verification proves `aes-256-gcm` round trips, header and entry associated-data tamper rejection (including cross-reference/version moves and `providerSubscriptionAccount` binding), external `0600` regular no-follow `32`-byte master-key validation outside `DATA_ROOT`, `0700` store directory and symlink/temporary-file rejection, strict whole-inventory validation and the exact backend-recognized revoked tombstone predicate, version advancement and grace expiry, destructive revocation, buffer zeroization on lock/key replacement, healthy locked boot in both local and server modes, and exact Workspace, Provider API-key, and Server shared-MCP (`mcp-credential`) administrative boundaries with zero secret leakage across inventory, Audit, CLI, or Web caches.

## Implementation

- Encrypted-file store, master-key loader, unlock state, audited backend wrapper, and Vault operations: `apps/nanocore/src/vault/`.
- Retained reference, grant, plan, receipt, and `VaultUse` SQLite schemas and native codecs: `apps/nanocore/src/storage/`, `apps/nanocore/src/storage/schema/`.
- Provider API-key and subscription account consumers: `apps/nanocore/src/providers/`, `apps/nanocore/src/llm/`.
- Public Vault administration and injection schemas: `packages/app-api-schemas/src/`, `packages/protocol/src/`.

## Implementation Gaps

None.

## Decisions

- [Hosting Through Gateway MCP](../decisions/20261002-hosting_through_gateway_mcp.md)
