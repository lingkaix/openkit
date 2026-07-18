# Vault Backend Implementation

Status: Accepted
Implementation: Partial

## Owns

- The `VaultBackend` boundary that NanoCore uses to resolve, store, rotate, revoke, list, and health-check secret material.
- The two v1 backends: `os-keychain` and `encrypted-file`, including backend selection defaults per deployment mode.
- Key management for the encrypted-file backend: the raw key-file source, envelope encryption, unlock model, and lock-state behavior.
- Versioning, rotation grace, and revocation mechanics at the backend layer, beneath the vault record model.
- `VaultUse` audit emission at every backend resolution of secret material.
- Storage and export rules for secret material: where it may live, where it must never appear, and how it is excluded from workspace export.
- Scope homing rules for secret material stored in a shared physical backend.

## Does Not Own

- `VaultReference`, `VaultGrant`, `InjectionPlan`, `InjectionReceipt`, and `VaultUse` record semantics, which belong to `docs/specs/20260703-vault_secret_injection.md`. This spec implements the backend beneath those records and emits them; it does not redefine them.
- Injection paths into workers and OpenShell provider derivation, which belong to `docs/specs/20260703-openshell_mechanism_internalization.md`.
- Permission policy for `vault.use` and grant authorization, which belong to `docs/specs/20260629-openkit_policy_model.md` and `docs/specs/20260703-policy_enforcement_mapping.md`.
- Workspace backup and export packaging, which belongs to `docs/specs/20260704-workspace_backup_export_import.md`; this spec only fixes what secret material export must exclude and how references re-bind.
- Storage layout ownership trees, which belong to `docs/specs/20260703-storage_layout_record_ownership.md`; this spec projects the encrypted store into that layout.

## Core References

- `docs/core/vault.md`
- `docs/core/storage.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`
- `docs/deployment.md`

## Summary

This spec chooses and specifies the first concrete secret vault backends, discharging the vault spec's resolved decision that the backend product choice belongs in a dedicated implementation spec.

The clean target is one `VaultBackend` boundary with two first-class v1 implementations. `os-keychain` delegates secret material to the OS-native keychain and is the default for desktop-embedded local mode. `encrypted-file` is an OpenKit-owned encrypted store under the data root using envelope encryption, is the default for server mode, and can be selected explicitly on desktop. This resolves the storage core doc's open point: both OS keychains and a local encrypted vault file are supported.

Secret material is versioned by (vault reference id, version), rotation writes new versions with grace expiry on prior versions, revocation cascades per the vault spec, and every resolution emits a `VaultUse` audit row. Secret material never touches SQLite or normal workspace files, and it is excluded from workspace export by default.

## Goals / Non-goals

### Goals

- Define the `VaultBackend` boundary precisely enough that the two v1 backends and future backends are interchangeable beneath the vault record model.
- Give server mode a headless, durable, inspectable-in-shape (never in value) encrypted store with real cryptographic guarantees.
- Give desktop-embedded local mode OS-native keychain integration with the encrypted store as an explicit configured alternative.
- Define the one configured raw key-file source, the locked state, and the unlock operation so boot never blocks on vault availability.
- Bind versioning, rotation grace, and revocation cascade to the backend layer so downstream expiry projection (OpenShell credential expiry) tracks vault truth.
- Make every secret resolution auditable by reference, version, path, and actor without recording the value.

### Non-goals

- Do not implement external secret manager backends (HashiCorp Vault, AWS Secrets Manager, cloud KMS) in v1.
- Do not redefine vault records, grant lifetimes, injection visibility classes, or receipt shapes.
- Do not define the workspace backup archive format.
- Do not design hardware-backed key storage (TPM, Secure Enclave key derivation) beyond what the OS keychain provides natively.
- Do not build a secret-editing product UI in this slice beyond the admin operations named here.

## Background

`docs/specs/20260703-vault_secret_injection.md` owns the vault record model and explicitly defers the first concrete encrypted local vault backend to a dedicated implementation spec. `docs/core/vault.md` fixes the invariants: secret values stay out of prompts, records, logs, and normal workspace files; vault use is auditable by reference, scope, actor context, and injection path. `docs/core/storage.md` left open whether OpenKit uses OS keychains, a local encrypted vault file, or both.

Before this implementation, provider credentials resolved through `env:` secret references and the OpenShell derivation design referred to a Vault backend that did not yet exist. The current implementation projection below records the concrete backend and audited resolution paths that replaced that baseline.

## Decision

1. v1 ships two first-class backends behind one `VaultBackend` boundary: `os-keychain` (macOS Keychain, Windows Credential Manager, Linux Secret Service) and `encrypted-file` (an OpenKit-owned encrypted store under the data root). Both OS keychains and a local encrypted vault file are supported; the storage core doc's open point is closed as "both".
2. Backend defaults follow deployment mode: `os-keychain` is the default for desktop-embedded local mode; `encrypted-file` is the default for server mode and an explicit configured alternative on desktop. An unavailable OS keychain reports unavailable rather than switching backends at runtime.
3. The encrypted-file backend uses envelope encryption: one raw 32-byte master key wraps per-entry data keys; each entry is sealed with AEAD binding the vault reference id and version as associated data. The first implementation uses Node stdlib `aes-256-gcm`; libsodium/XChaCha20-Poly1305 remains a later hardening option only if the product needs that primitive.
4. The only configured V1 encrypted-file key source is an absolute owner-only raw key file. When it is absent or invalid at boot, the vault is `locked`, boot proceeds, vault-dependent operations fail typed, and readiness is degraded. Authenticated administrators may still submit raw key material through the existing unlock operation.
5. Secret material is addressed by (vault reference id, version). Rotation writes a new version and marks prior versions with a grace expiry; revocation of a reference invalidates all versions and cascades grant invalidation per the vault spec.
6. Every backend resolution of secret material produces a `VaultUse` audit row. Secret material lives only inside the backend; never in SQLite, never in normal workspace files; excluded from workspace export by default.

## Contract / Expected Behavior

### VaultBackend Boundary

A `VaultBackend` MUST implement these operations, all keyed by vault reference id and never by raw locator strings from callers:

- `resolve(referenceId, version?)`: return the secret material for the requested version, or the current version when unspecified. Resolution MUST fail typed when the reference is unknown, revoked, the version is expired past grace, or the backend is locked.
- `store(referenceId, material, metadata)`: write version 1 of a new reference's material, or fail if material already exists for the reference.
- `rotate(referenceId, material)`: write a new version and apply grace expiry to prior versions per the versioning rules below.
- `revoke(referenceId)`: invalidate all versions of the reference.
- `listReferences(scope?)`: return non-secret entry metadata (reference id, scope, current version, version count, rotation timestamps, expiry metadata) for inventory and reconciliation. It MUST NOT return secret material.
- `health()`: return backend availability and lock state (`available`, `locked`, `unavailable`) with a redacted diagnostic.

Rules:

- Secret material MUST only cross the boundary in `resolve` return values and `store`/`rotate` inputs. No other operation, error, or diagnostic may carry it.
- Backend errors MUST be typed (`vault-locked`, `reference-not-found`, `version-expired`, `reference-revoked`, `backend-unavailable`) and MUST NOT embed secret material or raw backend locators in messages.
- Reference metadata (the `VaultReference` record) remains SQLite source-of-truth per the storage layout spec; the backend stores material and per-entry material metadata only. The backend MUST NOT become a second home for reference records.
- One NanoCore process selects one backend at startup, and each `VaultReference` records that backend kind. Concurrent dual-backend operation and cross-backend re-store are not implemented in V1.

### os-keychain Backend

- The `os-keychain` backend MUST use the platform-native secret service: macOS Keychain, Windows Credential Manager, or the freedesktop Secret Service API on Linux.
- It is the default backend for desktop-embedded local mode per `docs/deployment.md`.
- Keychain entries MUST be namespaced under an OpenKit-owned service identifier that encodes the deployment id, vault reference id, and version, so entries are attributable and never collide with other applications or other OpenKit deployments.
- Keychain entry payloads carry the secret material and a minimal metadata envelope (reference id, version, scope, expiry metadata). The payload MUST NOT be relied on as the authoritative metadata source; reconciliation against `VaultReference` rows uses `listReferences`.
- When the keychain service is unavailable (headless session, locked login keychain, missing Secret Service), the backend MUST report `locked` or `unavailable` truthfully and MUST NOT switch backends. Selecting `encrypted-file` is an explicit startup configuration choice, not a per-call runtime fallback.

### encrypted-file Backend

- The `encrypted-file` backend is the default for server mode and an explicitly configured alternative on desktop.
- The store lives under the server-scope vault directory in the data root (`DATA_ROOT/server/vault/`), added as a sibling record family per the storage layout spec's structure evolution rules. It MUST NOT live inside any workspace tree.
- Cryptography uses envelope encryption:
  - Envelope encryption: one master key wraps per-entry data keys. Each entry version has its own data key.
  - Per-entry AEAD: Node stdlib `aes-256-gcm` for the first implementation, with the vault reference id and version bound as associated data. A ciphertext moved, copied, or renamed to another reference or version MUST fail decryption; this prevents ciphertext swapping.
  - Master key input: one raw 32-byte key supplied by the configured key file or authenticated admin unlock operation. V1 does not implement passphrase derivation, environment keys, KMS, or a key-source registry.
- Per-entry envelopes are the unit of write: rotation and revocation of one entry MUST NOT rewrite or re-encrypt the whole store.
- The store header records the format version, `raw-key-file` key kind, creation timestamp, verification nonce, and AES-GCM authentication tag. The tag authenticates the timestamp, format, key kind, and a fixed purpose without storing key bytes or recoverable ciphertext.
- Store files MUST be created with owner-only permissions (0600 files, 0700 directory) and writes MUST be atomic (write-new-then-rename) so a crash never leaves a partially written entry readable as valid.

### Master Key Sources And Lock State

The only configured V1 encrypted-file key source is `vault.encryptedFile.keyFilePath` in `config/server.jsonc`. The path MUST be absolute and name a regular non-symlink file owned by the NanoCore process user, with exact `0600` permissions and exactly 32 raw bytes. Production boot's general DATA_ROOT portability gate rejects config that embeds the current absolute data-root path, so operators configure this key as an external file that is not part of data-root backup. Loading MUST use one bounded `O_RDONLY | O_NOFOLLOW` descriptor plus `fstat` on that descriptor; any unsupported platform, filesystem, ownership, mode, length, or authentication failure remains redacted and locked.

Lock-state rules:

- If no valid configured key is available at boot, the vault is `locked`. Boot MUST proceed per `docs/specs/20260704-nanocore_bootstrap_readiness.md`: vault-dependent operations fail typed with `vault-locked`, and readiness reports the vault subsystem degraded.
- Boot and authenticated admin unlock both verify the key against the store header before exposing an available backend. A header may be initialized only for an empty safe store; a wrong key, malformed or unsupported header, tampered authentication metadata, or non-empty headerless store fails without rewriting the store.
- Lock is also an admin operation: it zeros the process-owned master-key buffer and returns the backend to `locked` without touching stored entries. Retained backend references MUST reject both reads and writes after lock or key replacement.
- The master key and unwrapped data keys live only in process memory and MUST never be written to logs, diagnostics, SQLite, or disk outside the configured key file. Temporary key-file and request buffers, failed replacement keys, process-owned master keys, and per-entry data keys MUST be zeroed at their lifecycle boundaries. Guarded-memory hardening is deferred until a concrete dependency is accepted.

### Versioning, Rotation, And Revocation

- Secret material is addressed by (vault reference id, version). Versions are monotonically increasing integers starting at 1.
- `rotate` writes version N+1 as current and marks all prior non-expired versions with a grace expiry timestamp (default grace configurable per reference; policy MAY set it to zero for immediate cutover).
- Within grace, `resolve` of an explicit prior version succeeds; `resolve` without a version always returns the current version. After grace, prior-version resolution fails typed with `version-expired`, and the backend SHOULD destroy the expired material.
- Expiry metadata MUST be projected into downstream consumers: rotation grace and version expiry feed OpenShell credential expiry metadata per `docs/specs/20260703-openshell_mechanism_internalization.md`, so gateway fail-closed behavior tracks vault truth.
- `revoke` invalidates all versions of a reference immediately, with no grace. Revocation MUST cascade grant invalidation and stale-session marking per the vault spec's revocation semantics; the backend's part is to guarantee no version of a revoked reference resolves again, and to destroy the material.
- Version transitions (rotate, expire, revoke) MUST be durably recorded in the backend before the new state is honored, and each transition emits an audit event.

### Vault-Use Audit Emission

- Every `resolve` that returns secret material MUST produce a `VaultUse` audit row carrying: vault reference id, version resolved, backend kind, resolving path (which grant, plan, or admin operation triggered resolution), actor context, scope, outcome, and timestamp. It MUST NOT carry the value, per `docs/core/vault.md` invariants.
- Failed resolutions (`vault-locked`, `version-expired`, `reference-revoked`) MUST also produce `VaultUse` rows with the failure outcome, so audit shows attempted use.
- `store`, `rotate`, `revoke`, unlock, and lock are audit events in their own right, homed per `docs/specs/20260703-audit_usage_evidence_records.md`.
- Batch resolutions (one derivation resolving several grants) emit one `VaultUse` row per reference resolved, not one per batch.

### Storage And Export Rules

- Secret material lives only inside the backend: keychain entries or the encrypted store file. It MUST NOT appear in SQLite, item logs, knowledge, artifacts, AEP snapshots, evidence bundles, or normal workspace files.
- The encrypted store file and the master key file are excluded from workspace export by default. Workspace export carries vault references as references only; import requires re-binding to local vault references, cross-referenced to `docs/specs/20260704-workspace_backup_export_import.md`.
- V1 has no secret-material Vault export. Workspace export carries only portable non-secret references, and data-root backup excludes the external master-key file; any future encrypted Vault export requires its own accepted design, key lifecycle, and audit contract.
- The vault directory is not a normal server files directory: tooling that scans, indexes, or syncs the data root MUST treat `server/vault/` as opaque.

### Scope Homing

- Server-scoped and workspace-scoped references MAY live in one physical backend (one keychain namespace, one encrypted store), but every entry MUST carry its owner scope in metadata and AEAD-protected entry headers.
- `resolve` callers MUST present the scope context they are acting in; a resolution whose actor scope differs from the reference's owner scope is cross-scope use and MUST be explicit and auditable per `docs/core/vault.md`, never an implicit fallthrough.
- `listReferences(scope)` MUST filter by scope so workspace-level surfaces never enumerate server-scoped references.

## Accepted Design

The backend layer is a NanoCore-internal module. Mode plus one explicit local setting selects `os-keychain` or `encrypted-file`, and each `VaultReference` row records its backend kind. `os-keychain` is implemented over platform secret-service adapters. `encrypted-file` is a directory-per-entry store (`server/vault/entries/<referenceId>/<version>.enc` plus a store header file), so per-entry envelopes map directly to per-file writes and atomic renames.

Unlock state is one process-local state holder that owns the master key in an ordinary mutable `Buffer`, zeros it at explicit lifecycle boundaries, and exposes lock state to readiness. Guarded-memory hardening remains deferred. The audit emitter wraps material resolution so the accepted credential-use paths record `VaultUse` evidence.

## Current Implementation Projection

- `VaultReference`, `VaultGrant`, `InjectionPlan`, and `InjectionReceipt` exist as first-slice durable non-secret server metadata in `core.sqlite`, and `VaultUse` exists as first-slice durable non-secret metadata in the scope-owning SQLite database. Workspace-scoped `VaultGrant`, `InjectionPlan`, and `InjectionReceipt` records now have App API, Core Client, and unified Skill bundled-CLI readback through workspace-filtered non-secret surfaces. AEP vault references and grants exist in `packages/config-schema/src/agent-environment.ts`.
- `apps/nanocore/src/vault/vault-backend.ts` defines the NanoCore-internal `VaultBackend` boundary, typed `VaultBackendError` codes, redacted backend health projection, non-secret inventory metadata, owner-scope metadata consistency validation, and a locked backend implementation whose material operations fail with `vault-locked` without carrying secret material in errors.
- `apps/nanocore/src/vault/vault-key-file.ts` implements the encrypted-file backend's raw key-file source validation: the path must be absolute; secure platforms must expose `O_NOFOLLOW` and the effective user id; one no-follow descriptor is checked for regular-file type, process-user ownership, exact `0600` permissions, and exact 32-byte length; a fixed 33-byte bounded read rejects trailing bytes; and every failure uses a typed redacted `VaultBackendError`.
- `apps/nanocore/src/vault/vault-store-directory.ts` implements the encrypted-file store directory permission boundary, and `apps/nanocore/src/storage/fs-layout.ts` now routes `server/vault/` creation through it: newly created store directories are forced to `0700`, empty broad-permission directories are tightened before material exists, and existing non-directory or non-empty broad-permission paths fail typed without leaking local paths.
- `apps/nanocore/src/vault/vault-encrypted-file-store.ts` owns the strict encrypted-file header and per-entry envelope format. It initializes `header.json` only for an empty safe store, authenticates the master key and header metadata before backend availability, rejects unsupported or extra header fields, writes owner-only files through same-directory rename, binds entries to reference id and version, and zeros temporary material and data-key buffers while sealing and opening with Node stdlib `aes-256-gcm`.
- `apps/nanocore/src/vault/vault-encrypted-file-backend.ts` creates an unlocked encrypted-file `VaultBackend` only after header initialization or verification succeeds. It implements `health`, `store`, `resolve`, `rotate`, `revoke`, and `listReferences` over encrypted entry files plus per-reference `state.json` records, and every retained instance checks that its shared owned key remains active before any material or inventory operation. Wrong-key construction zeros the candidate key and cannot rewrite the existing store.
- `apps/nanocore/src/vault/vault-os-keychain-backend.ts` creates an `os-keychain` `VaultBackend` over a platform keychain adapter. The default macOS adapter uses the built-in `security` CLI for generic-password reads, upserts, and deletes; the Linux adapter uses the freedesktop Secret Service `secret-tool` CLI for reads, writes, and deletes; the Windows adapter uses PowerShell plus the Windows Credential Manager API for generic credential reads, writes, and deletes while passing secret-bearing payloads through stdin instead of argv. Platforms without a native adapter truthfully report unavailable. The backend stores one secret-bearing keychain item per vault reference and one non-secret index item per deployment namespace, supports `health`, `store`, `resolve`, `rotate`, `revoke`, and `listReferences`, rejects inconsistent owner-scope metadata before writing material, preserves non-secret inventory after revocation, expires prior versions after rotation grace, and keeps secret material out of the inventory index.
- `apps/nanocore/src/vault/vault-references.ts` and `apps/nanocore/src/vault/vault-grants.ts` expose persistent revocation cascade helpers. Revoking a reference marks the reference revoked, revokes dependent grants, revokes active injection plans, and marks active injection receipts as `stale-session`; revoking one grant applies the same plan and receipt projection for that grant. This is the durable stale-session marking layer. Non-transient OpenShell provider materialization is currently fail-closed before effects, so no provider-detach path is advertised; whole-Cell recycle remains the teardown authority.
- `apps/nanocore/src/vault/vault-unlock-state.ts` owns one mutable encrypted-file master-key buffer shared with the active backend. Failed replacement preserves the current backend and zeros the candidate; successful replacement invalidates and zeros the previous key; lock zeros the current key and makes retained backend references fail typed with `vault-locked`. For `os-keychain`, the state starts directly from the platform adapter and does not accept encrypted-file unlock keys.
- `packages/app-api-schemas/src/vault-admin.ts` defines the redacted App API contract for vault admin status, unlock, lock, Codex auth JSON bootstrap, and workspace vault-reference discovery/rebind operations, including both `encrypted-file` and `os-keychain` backend kinds in status payloads. `apps/nanocore/src/vault/vault-admin-routes.ts` registers `GET /api/app/vault/status`, `GET /api/app/vault/use-records`, `POST /api/app/vault/unlock`, `POST /api/app/vault/lock`, `POST /api/app/vault/bootstrap/codex-auth-json`, `GET /api/app/workspaces/:workspaceId/vault/references`, `GET /api/app/workspaces/:workspaceId/vault/use-records`, and `POST /api/app/workspaces/:workspaceId/vault/references/:referenceId/rebind`. Global status, server VaultUse readback, unlock, lock, and bootstrap accept only the local actor or a `server-admin` bearer token; Better Auth sessions and workspace-scoped tokens receive `vault_admin_forbidden`. Better Auth sessions require active membership for workspace routes; workspace and workspace-readonly tokens require active membership plus a binding to the addressed workspace; local and `server-admin` actors are not workspace-bound; readonly tokens cannot rebind. Secret-bearing operations accept raw 32-byte key material, Codex auth JSON, and rebind material only as base64 request input, never echo submitted secret material in responses, rate-limit repeated failed unlock attempts per actor in the process-local window, and write server-scope `vault_admin_audit_events` rows plus linked server `AuditEvent` rows for unlock/lock/bootstrap success, unlock failure, bootstrap failure, and unlock rate-limit denial when Core DB storage is configured. `@openkit/core-client` and the unified `openkit` Skill's bundled CLI expose the same public contracts without adding an alternate authorization surface, and submitted base64 secret material remains redacted from CLI envelopes.
- The current Workspace vault routes therefore still allow a `server-admin` token without Workspace membership. The accepted multi-user target removes that content bypass: deployment-level vault administration remains administrator-only, while every Workspace reference, use-record, and rebind operation requires normal current membership, fixed-role policy, and token intersection.
- `apps/nanocore/src/vault/vault-use-audited-backend.ts` wraps any `VaultBackend` so `resolve` success and typed failure create non-secret `VaultUse` rows in the scope-owning database. The wrapper records reference id, resolved version when known, backend kind, resolving path, actor context, outcome, failure code, and timestamp without storing secret material. Server- and workspace-scoped audited resolutions also create linked `AuditEvent` rows with `vault.resolve`, actor lineage, outcome, severity, and typed failure code. Before material leaves the backend, the wrapper rejects implicit cross-scope resolution when the stored reference owner scope differs from the audited caller scope and no explicit grant is attached; explicit grant-backed cross-scope use remains available and audited. Provider `secretRef: vault://<referenceId>` resolution now uses this wrapper with the `provider` resolving path and the vault-aware resolver no longer falls back to `env:` by default. GitHub MCP backend-handle package resolution uses the same wrapper with grant, plan, receipt, and agent-session linkage. Codex auth JSON runtime-file package resolution uses the wrapper with `grant_codex_auth_json`, creates a runtime-file plan and receipt, and passes the resolved file content only through backend-private materialization context for upload to `/sandbox/.codex/auth.json`. Future credential-use paths should use the same audited boundary.
- The server-owned `server/vault/` directory required by the encrypted-file backend now exists in the data-root layout. When an app has a data root and no explicit vault state override, NanoCore defaults local mode to `os-keychain` and server mode to `encrypted-file`; `server.jsonc` can set `vault.localDefaultBackend` to `encrypted-file` as the local-mode alternative, and tests can inject an `os-keychain` adapter or default-platform command runner for deterministic local-mode coverage. OpenShell refresh status evidence collection exists for the current CLI surface; scheduler-cadenced polling and refresh-log import for a stable upstream log surface remain deferred future work.
- `apps/nanocore/src/bootstrap/vault.ts` checks one shared process Vault state during the existing non-critical boot phase. It loads the configured key only for a locked encrypted-file backend, zeros the temporary buffer in `finally`, reports available health as ready, and projects every missing or failed key as redacted `vault.locked` degraded readiness blocking only `vault.read`, `vault.use`, and `secret.inject`. The same state is reused by runtime callers and zeroed during orderly shutdown and process-exit cleanup.
- Provider credential resolution supports the first vault-backed shape, `secretRef: vault://<referenceId>`, for server-owned provider credentials. The public OpenAI-compatible LLM Gateway routes and Quick Chat internal-agent calls now resolve vault-backed provider credentials through the audited provider resolver and create non-secret `VaultUse` rows. Locked or otherwise failed vault-backed provider resolutions preserve the typed vault backend failure instead of collapsing into missing credentials; `/v1/chat/completions` now returns `vault-locked` with HTTP 423 for locked vault provider credentials and records the failed `VaultUse` row without calling the upstream provider. The provider registry no longer resolves `env:` references by default; `resolveEnvSecretRef` remains only as an explicit opt-in test or transition helper. Seeded provider templates and the DATA_ROOT config guide now document `vault://` provider references as the first-class credential shape, and runtime provider config projection now reports vault-resolved credentials as `apiKeySource: "vault"` instead of `env`; unresolved `secretRef` credentials report `apiKeySource: "missing"` rather than `not-required`. Host-side Git push no longer reads GitHub credential variables implicitly from NanoCore's global `process.env`; linked repository Git config can carry a non-secret `git.vaultGrantRef`, and the approved `workspace.git.push` route resolves that grant through the audited vault backend after push preflight and policy checks pass, creating injection plan, injection receipt, workspace-scoped `VaultUse`, and linked audit evidence before passing the token only as gateway-only child-process env. Future credential classes can reuse the audited backend boundary without blocking the V1 backend implementation.

## Alternatives Considered

### Single Backend: OS Keychain Only

Simplest surface and strongest OS integration on desktop. Rejected: server mode needs headless operation, and keychain services are absent or session-bound on headless Linux and in containers. A server deployment cannot depend on a login keychain.

### External Vault Service (HashiCorp Vault, Cloud Secret Managers)

Mature rotation, policy, and audit tooling. Deferred as a future backend behind the same `VaultBackend` boundary: it adds an operational dependency that the local-first and single-binary deployment postures cannot require, but nothing in the boundary precludes it.

### SQLCipher Whole-Database Encryption

Encrypting `core.sqlite` wholesale would let vault rows live beside other records. Rejected: secrets do not belong in SQLite per the vault core doc and the storage layout spec; whole-DB encryption also couples secret confidentiality to database lifecycle, makes per-entry rotation rewrite-heavy, and protects far more than it needs to while guaranteeing less (no per-entry AD binding).

## Consequences

- Server mode gets a real vault with no external service dependency; desktop gets native keychain behavior with an explicit encrypted-file alternative.
- The vault spec's `env:` projection can be retired on a schedule instead of hardening into production practice.
- OpenShell derivation gains a real material source with expiry metadata it can project.
- OpenKit takes on custody of cryptographic code for the encrypted store; the mitigation is stdlib AEAD only and a deliberately small format.
- A locked vault becomes a first-class operational state that readiness, diagnostics, and admin surfaces must present honestly.

## Rollout / Migration Plan

1. Land the `VaultBackend` boundary, typed errors, and the audit-emitting wrapper.
2. Ship `encrypted-file` first (it serves both modes), with store creation, unlock, lock, and the strict raw key-file boot source.
3. Ship `os-keychain` for desktop-embedded mode with the configured encrypted-file alternative.
4. Add rotation grace and expiry projection into OpenShell derivation.
5. Migrate existing `env:` provider secret references by explicit re-store into a backend; remove the `env:` resolution path in the same change, with no compatibility reader, per the internal development compatibility rule.

## Verification Status

Mapped to `docs/specs/20260529-test_strategy.md`:

Implemented gates:

- L0 repository format, lifecycle, lint, typecheck, build, OpenAPI drift, and package checks pass.
- L1 covers locked behavior, both concrete backends, encryption round trips, entry and header tamper, strict key-file loading, correct and wrong header keys, malformed and headerless stores, rotation, revocation, replacement, retained references, and buffer zeroization.
- L3 built-process coverage proves correct-key boot availability and a wrong-key restart that remains healthy with locked Vault. App API tests cover admin unlock, lock, redaction, auditing, rate limiting, and authorization.
- L5 currently proves the built NanoCore artifact starts and remains healthy; it does not yet provide a packaged secret store-and-resolve scenario.

Remaining completion gates:

- Add one shared L2 conformance fixture that runs the same operation and typed-error contract against both concrete backends.
- Add the full-data-root no-plaintext scan after store, rotate, resolve, export-reference, and restart flows.
- Add a packaged L5 encrypted-file store-and-resolve smoke and the opt-in L6 operator rotation and audit story.

The backend and key-file boot path are accepted for internal development. This spec remains `Partial` until the remaining L2, no-plaintext, packaged L5, and L6 gates pass.

## Risks & Mitigations

- Risk: custom store cryptography acquires subtle flaws. Mitigation: stdlib AEAD only, no hand-rolled primitives, a minimal versioned format, and tamper tests as permanent gates.
- Risk: an operator supplies a weakly protected, replaced, or wrong key file. Mitigation: absolute-path, no-follow, same-descriptor owner/mode/type/length checks, authenticated header verification, redacted degraded boot, and permanent negative tests.
- Risk: keychain platform differences leak into the boundary. Mitigation: platform adapters and focused tests keep quirks inside their owner; the shared L2 conformance fixture remains a completion gate.
- Risk: grace windows keep compromised material alive. Mitigation: revocation bypasses grace entirely; policy can set grace to zero per reference.
- Risk: the encrypted store is accidentally captured by workspace export or sync tooling. Mitigation: the opaque-directory rule and export exclusion are implemented; the full-data-root no-plaintext scan remains a completion gate.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: the encrypted-file store supports one active raw master key with no compatibility, recovery, or export layer; `os-keychain` stores one item per vault reference with versions inside the encrypted payload to reduce platform prompt and quota variance.

## Deferred / Future Work

- External secret manager backends (HashiCorp Vault, cloud KMS/secret managers) behind the same `VaultBackend` boundary.
- Hardware-backed master keys (TPM, Secure Enclave) as an additional key source.
- Automatic rotation schedules and rotation policy; this spec only provides the mechanics.
- Organization-scoped vault homing when the shared deployment scope arrives.
- Operator recovery-key workflows for the encrypted store.
- Explicit encrypted Vault export, including a separate export-key and audit design.

## Links

- `docs/specs/20260715-multi_user_workspace_system.md`
- `docs/specs/20260703-vault_secret_injection.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260703-openshell_mechanism_internalization.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260704-nanocore_bootstrap_readiness.md`
- `docs/specs/20260704-workspace_backup_export_import.md`
- `docs/specs/20260629-openkit_policy_model.md`
- `docs/specs/20260529-test_strategy.md`
- `docs/core/vault.md`
- `docs/core/storage.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`
