---
status: Accepted
implementation: Partial
---
# Vault Backend Implementation

## Owns

- The `VaultBackend` boundary that NanoCore uses to resolve, store, rotate, revoke, list, and health-check secret material.
- The one current NanoCore backend, `encrypted-file`, for both local and server deployment modes.
- The encrypted-file store, raw master-key file source, envelope encryption, unlock model, and lock-state behavior.
- Versioning, rotation grace, revocation, authenticated non-secret entry metadata, and failed-closed store-integrity behavior beneath the Vault record model.
- `VaultUse` audit emission at every backend resolution of secret material.
- Storage and export rules for secret material and scope homing within one deployment.

## Does Not Own

- `VaultReference`, `VaultGrant`, `VaultInjectionPlan`, `VaultInjectionReceipt`, and `VaultUse` record semantics, which belong to `docs/specs/20260703-vault_secret_injection.md`.
- Provider-subscription account existence, slot identity, account-to-reference binding, and reviewed orphan cleanup, which belong to `docs/specs/20260721-provider_subscription_accounts.md`.
- Injection paths into workers and OpenShell provider derivation, which belong to `docs/specs/20260703-openshell_mechanism_internalization.md`.
- Permission policy for `vault.use` and grant authorization, which belong to `docs/specs/20260629-openkit_policy_model.md` and `docs/specs/20260703-policy_enforcement_mapping.md`.
- Workspace backup and export packaging, which belongs to `docs/specs/20260704-workspace_backup_export_import.md`.
- Storage layout ownership trees, which belong to `docs/specs/20260703-storage_layout_record_ownership.md`.
- Runtime credential revocation effects, sandbox termination, epoch invalidation, cleanup, and transport, which belong to `docs/specs/20260802-nanohost_runtime_and_transport.md`.

## Core References

- `docs/core/vault.md`
- `docs/core/storage.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`

## Summary

NanoCore uses one `VaultBackend` implementation, `encrypted-file`, in both local and server modes. Ciphertext and authenticated non-secret entry metadata live under `DATA_ROOT/server/vault/`; the raw 32-byte master-key file is owner-only with exact `0600` permissions and lives outside `DATA_ROOT`.

Secret material is versioned by `(vault reference id, version)`. Rotation writes a new per-entry version, revocation makes every version unresolvable and destroys its material, every resolution emits redacted `VaultUse` evidence, and secret material never enters SQLite, normal workspace files, exports, errors, or diagnostics.

Codex and xAI/Grok provider-subscription credentials use this same store through distinct server-owned Vault references. Another provider, including Claude, may reuse the storage mechanism only after a separate accepted entitlement and provider contract authorizes that provider path.

## Goals / Non-goals

### Goals

- Define one direct backend path for every NanoCore deployment mode.
- Provide a headless encrypted store with strict key-file, permission, atomic-write, tamper, rotation, revocation, audit, and redaction behavior.
- Authenticate the provider and slot projection needed to detect provider-subscription material whose `account.json` metadata is missing, corrupt, or contradictory.
- Keep store-integrity failures enumerable and failed closed until explicitly reviewed cleanup proves safe destruction.

### Non-goals

- Do not define another backend, backend selector, fallback, compatibility reader, migration path, backend registry, journal, intent record, or replacement enumeration API.
- Do not implement passphrase derivation, environment master keys, KMS, external secret managers, hardware-backed keys, or a key-source registry.
- Do not redefine Vault records, grant lifetimes, injection visibility classes, receipt shapes, account metadata, or provider entitlement.
- Do not define workspace backup archives or a secret-editing product UI.

## Background

`docs/specs/20260703-vault_secret_injection.md` owns the Vault record and injection model, while this spec owns the concrete encrypted storage boundary. `docs/core/vault.md` requires secret values to remain outside prompts, records, logs, normal workspace files, and public diagnostics. `docs/core/storage.md` keeps Vault material outside ordinary storage records.

The prior alternate-backend design created deployment-mode selection, platform-specific persistence, duplicate material and inventory copies, and recovery machinery that were not justified by the accepted one-process, one-data-root, small-deployment baseline. The current authority removes that design and keeps the already implemented encrypted-file path as the sole target.

## Decision

1. `encrypted-file` is the only current NanoCore Vault backend kind and is used by both local and server modes.
2. The encrypted store lives under `DATA_ROOT/server/vault/`; it contains only ciphertext, strict non-secret inventory, and authenticated non-secret metadata, and it is never nested inside a Workspace tree.
3. The sole configured master-key source is an absolute regular non-symlink file outside `DATA_ROOT`, owned by the NanoCore process user, with exact `0600` permissions and exactly 32 raw bytes.
4. The store uses envelope encryption: one master key wraps a unique data key for each material version, and Node stdlib `aes-256-gcm` authenticates the ciphertext and its reference, version, ownership, expiry, and optional provider-slot metadata.
5. Each entry or state file is written independently through a same-directory write-new-then-rename operation with exact `0600` file permissions; Vault directories use `0700`.
6. A crash may leave an extra entry, missing state, stale state, or other enumerable disagreement. Normal resolution, inventory consumers, reconciliation, account mutation, and pair reuse fail closed on that disagreement; only the reviewed cleanup boundary may destroy attributable material and release the pair.
7. Rotation, revocation, lock state, typed redacted failures, audited resolution, and export exclusion remain part of the backend contract.

## Contract / Expected Behavior

### VaultBackend Boundary

A `VaultBackend` MUST implement these operations, all keyed by Vault reference id and never by raw locator strings from callers:

- `resolve(referenceId, version?)`: return the requested material version, or the current version when unspecified; fail typed when the reference is unknown, revoked, expired past grace, locked, unavailable, or internally inconsistent.
- `store(referenceId, material, metadata)`: write version 1 through one atomic entry-file replacement and then one separate atomic state-file replacement for a reference that has no material, or fail without overwriting existing or inconsistent state.
- `rotate(referenceId, material)`: write version N+1 through one atomic entry-file replacement and then advance the strict state through one separate atomic replacement; never overwrite an existing version.
- `revoke(referenceId)`: make every version immediately unresolvable, destroy all attributable material versions, and retain only the non-secret revocation inventory required for audit and orphan detection.
- `listReferences(scope?)`: return non-secret metadata for strict consistent live or revoked inventory rows, filtered by scope, and fail rather than omit any malformed, unauthenticated live material, missing required live entry, extra, or contradictory entry or state encountered in the addressed inventory.
- `health()`: return `available`, `locked`, or `unavailable` with a redacted diagnostic.

Rules:

- Secret material may cross the boundary only in `resolve` return values and `store` or `rotate` inputs.
- Backend errors use only `vault-locked`, `reference-not-found`, `version-expired`, `reference-revoked`, or `backend-unavailable` and never include material, raw locators, local paths, decrypted metadata, caught messages, or provider payloads.
- `VaultReference` metadata remains the generic SQLite source of truth. The backend owns material and material-integrity metadata and MUST NOT become account, binding, authorization, or provider-dispatch authority.
- `encrypted-file` is a fixed backend kind, not a deployment setting. There is no backend selection or runtime fallback.

### Authored Provider API Keys

`PUT /api/app/providers/{providerId}/api-key` is the deployment-admin operation for storing or replacing one authored provider profile's API key. The profile MUST be the unique valid file-backed profile with that exact id and MUST declare one safe `vault://<referenceId>` secret reference. The request contains only `{ apiKey }`; the redacted response contains only `{ configured: true, providerId }`. Raw key material may enter only the immediate request and `VaultBackend.store` or `rotate` input and MUST NOT appear in responses, diagnostics, audit, configuration, or Core metadata.

The first successful write stores backend version 1 and creates the exact server-owned Core `VaultReference` with display name `Provider API key`, secret kind `provider-api-key`, the configured backend kind and locator, active status, and version 1. A later write rotates the same reference and advances the Core version. Existing reference or backend metadata disagreement, missing paired authority, malformed or ambiguous provider configuration, a locked backend, and concurrent same-reference writes fail without claiming success; a new request may continue only from the exact accepted equal-version state or the backend-one-version-ahead prefix produced by the preceding ordered write. Failure after a fresh backend store revokes that material and returns recovery-required because the consumed reference id cannot be reused. This operation deliberately has no clear, revoke, compatibility, or implicit credential-discovery behavior; removal requires a future accepted lifecycle because a revoked reference id is not reusable.

`VaultEntryMetadata` has one optional provider-subscription inventory projection with this exact strict shape:

```ts
type ProviderSubscriptionAccountProjection = {
  subscriptionProviderId: "openai-codex" | "xai";
  accountSlotId: string;
};

type VaultEntryMetadata = {
  ownerScope: "server" | "user" | "workspace";
  workspaceId?: string;
  userId?: string;
  providerSubscriptionAccount?: ProviderSubscriptionAccountProjection;
};
```

`accountSlotId` matches `^[a-z0-9][a-z0-9_-]{0,63}$`. The nested object rejects missing, extra, or unsupported values and is permitted only when `ownerScope` is `server` and `workspaceId` and `userId` are absent. Invalid metadata fails as redacted typed `backend-unavailable` before material is stored. Rotation preserves the projection unchanged, revocation retains it only in non-secret inventory, and `listReferences` returns it without material.

The projection is non-secret and non-authoritative. It exists only so filesystem inventory can attribute encrypted material to a local provider and slot when account metadata is absent or invalid. It MUST NOT create or reconstruct an account, establish or change a binding, select a credential, authorize use, enter a public response, or add provider or slot columns to `vault_references`.

### Backend-Recognized Revoked Tombstone

An exact backend-recognized revoked tombstone for a current provider-subscription binding is not a new record, marker, MAC, journal, or state. It exists only when the current `encrypted-file` backend completes whole-inventory strict validation through `listReferences` and accepts exactly one current-binding inventory row with all of these values: `referenceId` equals the account binding; `backendKind` is `encrypted-file`; `ownerScope` is `server`; `workspaceId` and `userId` are absent; `providerSubscriptionAccount.subscriptionProviderId` and `accountSlotId` exactly equal the account pair; `revoked` is `true`; `currentVersion` and `versionCount` are equal positive safe integers; and the reference directory contains no material entry, writer entry temporary, state temporary, or unknown residue. The canonical revoked `state.json` inventory row is the only permitted remaining reference-directory artifact. Any whole-inventory failure, duplicate current-binding row, field mismatch, unsafe version, live or temporary material, or unknown residue means the predicate is not satisfied and the caller fails closed.

Because revocation destroys every encrypted entry, this predicate is not a claim that the tombstone itself has cryptographic authentication from surviving material. It is durable backend revocation proof established by strict backend inventory under the accepted owner-only-filesystem, single-NanoCore, single-writer threat boundary. It may be consumed only by the Provider Subscription Accounts contract to let an already-started logout or delete finish the exact generic Core revocation cascade and binding clear or account deletion. It does not authorize a Vault store, rotate, revoke, or other Vault write; ordinary account validity; same-reference persistence or reuse; metadata restoration; another recovery action; a public operation; or automatic repair.

### encrypted-file Store

- The store root is `DATA_ROOT/server/vault/` for both local and server modes.
- `header.json` authenticates the store format, `raw-key-file` key kind, creation timestamp, verification nonce, and fixed purpose without storing key bytes or recoverable material.
- Each material version lives at `entries/<referenceId>/<version>.enc`, and each reference has strict non-secret inventory at `entries/<referenceId>/state.json`.
- Every entry uses a unique data key and AES-256-GCM. Associated data authenticates the reference id, version, canonical creation timestamp, owner metadata, exact version-expiration projection, and optional provider-subscription projection. Moving, copying, or renaming ciphertext to another reference or version MUST fail authentication.
- A live `state.json` is trusted only when its identity, ownership, current version, version count, expiration data, revocation state, and optional provider-subscription projection agree with the authenticated entry set. After revocation destroys that entry set, the strict backend-recognized tombstone predicate above is the only accepted revoked-state validation.
- Per-entry envelopes are the unit of write; rotation or revocation of one reference MUST NOT re-encrypt the whole store.
- New files use exact `0600`, Vault directories use exact `0700`, and every file replacement uses same-directory write-new-then-rename so a torn write is never accepted as valid content.

The accepted single-NanoCore, single-writer deployment assumes an owner-only filesystem and excludes a hostile same-UID participant concurrently replacing parent directories between validation and a leaf `rename` or `unlink`. `O_NOFOLLOW` and descriptor identity protect opened leaf files, but Node stdlib provides no directory-fd `openat` or `unlinkat` guarantee; any detected mismatch MUST fail closed. This excluded deployment violation does not authorize a native dependency, recovery state, second backend, compatibility path, or broader security claim.

### Integrity And Orphan Detection

The backend's existing filesystem namespace is enumerable by internal directory traversal. This is an implementation property of the store and does not add a public operation, a new enumeration interface, or another durable record family.

Inventory MUST inspect every reference directory, strict state file, material-version filename, writer temporary, and unknown artifact in the addressed scope. A live entry authenticates its provider-slot projection before that projection may participate in account orphan checks; a revoked reference is accepted only through the backend-recognized tombstone predicate above. A missing required live entry, malformed, unauthenticated, extra, stale, temporary, or contradictory entry or state file is a redacted `backend-unavailable` integrity failure and MUST NOT be omitted, inferred from a path, repaired from `account.json`, used to reconstruct metadata, or treated as absence.

A process crash between independently atomic entry and state writes may leave a complete orphan file or stale projection. The backend does not compensate, forward-settle, or automatically repair that state. Ordinary resolution, provider-account listing, reconciliation, account deletion, binding clear, and pair reuse remain failed closed until the reviewed cleanup procedure in `docs/specs/20260721-provider_subscription_accounts.md` authenticates attribution, revokes and destroys every attributable version, verifies absence or unresolvability, applies any existing generic Core revocation cascade, and only then removes residue.

### Master Key And Lock State

The configured key path is `vault.encryptedFile.keyFilePath` in `config/server.jsonc`. It MUST be absolute, outside `DATA_ROOT`, and name a regular non-symlink file owned by the NanoCore process user with exact `0600` permissions and exactly 32 raw bytes. Loading uses one bounded `O_RDONLY | O_NOFOLLOW` descriptor plus `fstat` on that descriptor; unsupported platforms or filesystems and every ownership, mode, type, length, or authentication failure remain redacted and locked.

- If no valid configured key is available at boot, boot proceeds with the Vault `locked`; Vault-dependent operations fail `vault-locked`, and readiness reports only the Vault subsystem degraded.
- Boot and authenticated admin unlock verify the key against `header.json` before exposing an available backend. A header may be initialized only for an empty safe store; a wrong key, malformed or unsupported header, tampered metadata, or non-empty headerless store never rewrites the store.
- Admin lock zeros the process-owned master-key buffer and returns the backend to `locked` without touching stored entries. Retained backend references reject reads and writes after lock or key replacement.
- Master keys, unwrapped data keys, temporary key-file buffers, request buffers, and failed replacement keys are zeroed at their lifecycle boundaries and never enter logs, diagnostics, SQLite, or disk outside the configured key file.

### Versioning, Rotation, And Revocation

- Versions are monotonically increasing integers beginning at 1.
- `rotate` atomically writes version N+1 before atomically advancing state and marks prior non-expired versions with the configured grace expiry.
- Within grace, explicit prior-version resolution succeeds; current resolution returns N+1. After grace, prior resolution fails `version-expired`, and the backend destroys expired material.
- `revoke` invalidates all versions immediately with no grace, guarantees that no version resolves again, and destroys every attributable material file.
- Each transition emits the audit event owned by the audit specification; backend and Core record updates remain separate ordered effects rather than a claimed cross-domain transaction.

### Vault-Use Audit Emission

- Every successful `resolve` emits a `VaultUse` row with reference id, resolved version, resolving path, actor context, owner scope, outcome, backend kind, and timestamp, never material.
- Failed resolution emits the same redacted evidence with its typed failure code.
- `store`, `rotate`, `revoke`, unlock, and lock emit their own audit actions as owned by `docs/specs/20260703-audit_usage_evidence_records.md`.
- Batch resolution emits one `VaultUse` row per reference.

### Storage, Export, And Scope

- Secret material lives only in encrypted entry files. It MUST NOT appear in SQLite, item logs, knowledge, artifacts, AEP snapshots, evidence bundles, normal workspace files, errors, or diagnostics.
- Workspace export carries non-secret Vault references only. It excludes `server/vault/`, and data-root backup excludes the external master-key file.
- Tooling that scans, indexes, syncs, or exports the data root treats `server/vault/` as opaque.
- One NanoCore deployment is one Vault trust domain. Server-, user-, and Workspace-scoped references may share the encrypted store, but every entry authenticates its owner scope and applicable owner id.
- A resolution whose caller scope differs from the reference owner scope is explicit cross-scope use and must carry the required grant and audit context.

## Accepted Design

The backend layer is a NanoCore-internal module with one fixed `encrypted-file` implementation. Its directory-per-reference layout maps entry and state changes to independently atomic file replacements while keeping the entire namespace enumerable for integrity and orphan checks.

Unlock state owns one mutable master-key `Buffer`, zeros it at explicit lifecycle boundaries, and exposes lock state to readiness. The audit wrapper surrounds material resolution so every accepted credential-use path records `VaultUse` evidence.

## Current Implementation Projection

- `VaultReference`, `VaultGrant`, `VaultInjectionPlan`, and `VaultInjectionReceipt` exist as durable non-secret metadata in `core.sqlite`, and `VaultUse` exists in the scope-owning SQLite database. Workspace-scoped metadata has filtered App API, Core Client, and unified Skill CLI readback.
- `apps/nanocore/src/vault/vault-backend.ts` defines the sole `encrypted-file` backend kind, the internal boundary, typed redacted errors, health projection, owner-scope metadata checks, locked implementation, and strict server-only `openai-codex | xai` provider-subscription projection with bounded slot validation.
- `apps/nanocore/src/vault/vault-key-file.ts` enforces an absolute canonical path outside `DATA_ROOT`, including parent-symlink aliases, no-follow descriptor loading and identity verification, process-user ownership, exact `0600`, regular-file type, and exact 32-byte content with redacted failures.
- `apps/nanocore/src/vault/vault-store-directory.ts` and `apps/nanocore/src/storage/fs-layout.ts` enforce the `0700` store directory, reject symlinked store children and unsafe existing paths, and keep path failures redacted.
- `apps/nanocore/src/vault/vault-encrypted-file-store.ts` implements the authenticated header, per-entry envelope, same-directory exclusive no-follow atomic replacement, reference-and-version binding, associated-data authentication of canonical creation time, ownership, exact expiration, and provider-slot metadata, and temporary and decrypt-intermediate buffer zeroization with Node stdlib `aes-256-gcm`.
- `apps/nanocore/src/vault/vault-encrypted-file-backend.ts` implements health, store, resolve, rotate, revoke, and strict enumerable inventory over encrypted entries and per-reference state; ordinary operations fail closed on malformed, missing, extra, stale, unsafe-version, temporary-file, symlink, metadata, or state disagreement, while explicit revoke alone may destroy mutually attributable canonical and complete writer-temporary material without touching unverifiable residue. Retained instances are invalidated after their owned key is replaced or locked.
- `apps/nanocore/src/vault/vault-references.ts` now provides generic Core helpers that distinguish a fresh reference insert from an idempotent match, accept only an equal or one-step active material-version projection, and transactionally revoke a reference, its dependent grants and plans, and active injection receipts as `stale-session`; focused tests cover conflicts, rollback, retry, missing or revoked references, and skipped or regressed versions. NanoHost terminates the affected sandbox and invalidates the complete Runtime Epoch when deletion cannot be proved; the deleted Cell implementation's whole-Cell recycle is historical only.
- The composed `apps/nanocore/src/llm/provider-subscription-accounts.ts` manager consumes those helpers and the encrypted-file backend for strict `account.json` binding, store, rotation, revocation, pair-scoped `CredentialStore` and stock `Models` views, handle invalidation, and safe reconciliation. Stock pi-ai device login, refresh, logout, and authenticated Codex and xAI inference now use those exact pair-scoped handles.
- The admin Vault API exposes redacted status, unlock, lock, Codex auth JSON bootstrap, authored provider API-key store or replacement, VaultUse readback, and Workspace reference discovery or rebind with server-admin and Workspace authorization, rate limiting, secret-input-only request fields, and linked audit evidence.
- The audited backend wrapper records resolution success and typed failure, rejects implicit cross-scope use, and supports provider, Codex runtime-file, GitHub MCP, and host Git push credential paths without exposing material.
- The local and server boot paths both compose the same locked encrypted-file state at `DATA_ROOT/server/vault/`, load the external key only through the bounded key-file path, zero the temporary buffer, report truthful degraded readiness, and reuse one process Vault state through shutdown.
- Provider `secretRef: vault://<referenceId>` resolution uses the audited wrapper for Gateway and Quick Chat calls, converts public failures to fixed provider-unavailable responses, and keeps typed Vault detail only in redacted internal evidence.
- Config, App API, storage, workspace-import, generated OpenAPI, and bundled-client projections admit only `encrypted-file`; the prior Keychain backend source, dedicated tests, platform adapters, backend selector, and alternate backend-kind branches are deleted.

The encrypted-file-only backend convergence, generic Core lifecycle helpers, startup composition, public provider-subscription routes, and pi-ai credential consumers are implemented and tested. The Vault backend itself still does not create accounts, infer bindings, expose provider-subscription operations, or release pairs. This spec remains `Partial` because the explicitly reviewed provider-pair cleanup surface owned by `docs/specs/20260721-provider_subscription_accounts.md` and credential-backed provider verification remain outstanding; no backend selector, alternate store, automatic repair, or second credential authority is introduced.

## Alternatives Considered

### SQLCipher Whole-Database Encryption

Rejected because secrets do not belong in SQLite, whole-database encryption couples credential custody to unrelated records, and it does not provide the required per-entry identity and provider-slot authentication.

## Consequences

- Local and server deployments share one backend path and one security model.
- NanoCore owns a small stdlib AEAD file format and an external raw-key operational requirement.
- A locked or internally inconsistent Vault is a truthful first-class degraded state.
- Store crashes can require reviewed cleanup, but they do not require another state machine, journal, compatibility reader, or automatic repair path.

## Rollout / Migration Plan

The same-release backend clean cut is complete: both deployment modes compose `encrypted-file`, schemas and stored backend-kind projections admit only that value, strict provider-slot authentication and failed-closed inventory checks are active, and the alternate backend, selection code, platform adapters, and dedicated tests are deleted. No data migration, import, fallback, compatibility path, or alternate-backend reader is provided; affected development credentials are stored again through the accepted encrypted-file path, while provider-subscription account and login cutover remains owned by `docs/specs/20260721-provider_subscription_accounts.md`.

## Verification Status

Focused coverage proves encrypted round trips, header and entry tamper rejection, provider-slot metadata and associated-data binding, canonical external key separation, correct and wrong keys, malformed and headerless stores, exact permissions, atomic replacement, safe version parsing, temporary-file and symlink containment, strict entry and state inventory, attributable revoke-only cleanup, rotation, revocation, retained-reference invalidation, buffer zeroization, admin authorization and redaction, audited resolution, both deployment-mode compositions, alternate-backend deletion, and healthy locked boot. Provider-subscription tombstone coverage must additionally prove whole-inventory validation, the exact unique revoked-row fields and safe equal versions, absence of every material, temporary, and unknown artifact, failed closure for every mismatch, and absence of any Vault write or ordinary-validity authority.

Remaining alignment requires the provider-subscription account, storage, credential-store, login, and reviewed pair-release integration owned by `docs/specs/20260721-provider_subscription_accounts.md`, plus its release-level and packaged acceptance evidence; no backend selector, alternate path, automatic repair, or second credential authority is authorized while that work remains incomplete.

## Risks & Mitigations

- Risk: file-store cryptography acquires subtle flaws. Mitigation: Node stdlib AEAD only, a minimal versioned format, authenticated identity metadata, and permanent tamper tests.
- Risk: an operator supplies a weakly protected, replaced, in-root, or wrong key file. Mitigation: external absolute path, no-follow same-descriptor validation, exact ownership, type, `0600`, length, and authenticated-header checks.
- Risk: a crash leaves a valid file that disagrees with inventory. Mitigation: enumerate the existing entry/state namespace, authenticate attribution, fail closed, and require reviewed cleanup before reuse.
- Risk: the encrypted store is captured by Workspace tooling. Mitigation: the opaque-directory rule and export exclusion remain permanent checks.

## Resolved Decisions

- `encrypted-file` is the sole current backend for local and server modes.
- The store has one active raw master key outside `DATA_ROOT` and no compatibility, recovery-key, selector, fallback, or export layer.
- Provider-subscription account metadata remains in `account.json`; encrypted entries authenticate only the non-secret provider-slot projection needed for orphan detection.
- Independently atomic entry and state writes plus failed-closed reviewed cleanup are sufficient for the accepted deployment baseline; no journal, intent record, registry, or new enumeration API is authorized.

## Deferred / Future Work

- Automatic rotation schedules and rotation policy; this spec provides only rotation mechanics.
- Operator recovery-key workflows for the encrypted store.
- Explicit encrypted Vault export with a separately accepted key lifecycle and audit contract.

## Links

- `docs/specs/20260721-provider_subscription_accounts.md`
- `docs/specs/20260715-multi_user_workspace_system.md`
- `docs/specs/20260703-vault_secret_injection.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260703-openshell_mechanism_internalization.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260704-nanocore_bootstrap_readiness.md`
- `docs/specs/20260704-workspace_backup_export_import.md`
- `docs/specs/20260629-openkit_policy_model.md`
- `docs/specs/20260529-test_strategy.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/core/vault.md`
- `docs/core/storage.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`
