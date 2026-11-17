---
status: Accepted
kind: mechanism
implementation: Partial
aspect: vault
---
# OpenShell Mechanism Internalization

This specification owns the internalization boundary between NanoCore's canonical Vault and Policy records and NVIDIA OpenShell's borrowed Providers v2 and sandbox-policy enforcement mechanisms: deterministic derivation of OpenShell provider profiles, provider instances, and `_provider_*` network policy layers, static placeholder rewrite and Gateway-delegated refresh rules, evidence normalization into NanoCore records, drift control across official OpenShell releases, and capability equivalence requirements for non-OpenShell container backends.

## Scope

### Owns

- The internalization principle for OpenShell-backed credential injection, injection audit, and policy enforcement: NanoCore definitions (`VaultReference`, `VaultGrant`, `VaultInjectionPlan`, `VaultInjectionReceipt`, `VaultUse`, `PermissionDecision`) are canonical, while OpenShell provider profiles, instances, and `_provider_*` policy layers are derived, disposable enforcement artifacts.
- Deterministic derivation rules, Gateway namespace prefixes (`okp-` / `oki-`), profile and effective-policy digest verification, placeholder environment rewrite, fail-closed expiry, and the split between NanoCore-managed (`static`, `external`) and Gateway-delegated (`oauth2_refresh_token`, `oauth2_client_credentials`, `google_service_account_jwt`) refresh strategies.
- Import and normalization of OpenShell-side injection, refresh, attachment, revocation, and enforcement events into `VaultInjectionReceipt`, `VaultUse`, and `AuditEvent` records with backend session lineage.
- Drift control and upgrade-regression requirements for the consumed OpenShell surface, and equivalence requirements for non-OpenShell container backends.

### Does Not Own

- Canonical Vault records, credential access declarations, and harness Login lifecycle in `docs/specs/20260703-vault_secret_injection.md`, or encrypted Vault storage in `docs/specs/20260704-vault_backend_implementation.md`.
- Canonical `PermissionDecision` records, enforcement points, and approval linkage in `docs/specs/20260703-policy_enforcement_mapping.md`, or the `@openkit/policy-kernel` NGAC model in `docs/specs/20260629-openkit_policy_model.md`.
- Audit, usage, and evidence schemas and retention classes in `docs/specs/20260703-audit_usage_evidence_records.md`.
- Runtime Epoch placement, OpenShell lifecycle, cleanup, readiness, and transport in `docs/specs/20260802-nanohost_runtime_and_transport.md`.
- Workspace synchronization, session-static materialization, and review gating in `docs/specs/20260704-session_static_workspace_materialization.md` and `docs/specs/20260703-workspace_synchronization.md`, or OpenShell-internal upstream roadmap items not adopted here.

### Core

- `docs/core/vault.md`
- `docs/core/policy.md`
- `docs/core/evidence.md`
- `docs/core/sandbox.md`
- `docs/core/mediation.md`
- `docs/core/storage.md`

## Contract / Expected Behavior

### Internalization Principle

- NanoCore MUST be able to regenerate every OpenShell provider profile, provider instance definition, and derived policy artifact from `VaultReference`, `VaultGrant`, `VaultInjectionPlan`, `PermissionDecision`, AEP snapshot, and Workspace records alone (`apps/nanocore/src/runtime/provider-credential-binding.ts`, `apps/nanohost/src/openshell_provider.rs`, `apps/nanohost/src/openshell_policy.rs`). NanoCore-owned provider access shape definitions (credential declaration, endpoint policy, binaries, refresh strategy selection) are configuration-schema records referenced by Vault references and AEP snapshots and replace reading OpenShell built-in profiles as product truth.
- Generated OpenShell artifacts MUST NOT be edited in place on the Gateway to change OpenKit behavior; the change path is to update NanoCore records, regenerate, and re-derive.
- Public App API, remote MCP, administrator CLI, Web UI, and Action Center surfaces MUST expose only NanoCore record IDs and redacted summaries, never OpenShell profile IDs, instance names, policy YAML, Gateway internals, or placeholder variable values.
- The mapping layer that renders NanoCore records into OpenShell artifacts and imports OpenShell evidence back MUST carry an explicit mapping version (current `mappingMajor` is `1` in `apps/nanohost/src/openshell_provider_delivery.rs`), and every derived artifact and imported record MUST record that mapping version and the actual OpenShell release identity used by the runtime (#809).

### Derivation Contract

Inputs to derivation for one Sandbox launch or Provider attach operation are:

- The `VaultGrant` rows scoped to the AgentSession, with their `VaultInjectionPlan` rows.
- The `PermissionDecision` rows that allowed `vault.use` for each grant and `network.egress` for each declared endpoint family.
- The AEP snapshot's declared credential requirements and network policy intent.
- Workspace and AgentSession identity for lineage.

Outputs are:

- Zero or more generated provider profiles (custom profile definitions imported to the Gateway), one per OpenKit-defined provider access shape.
- Zero or more provider instances created from those profiles, holding concrete credential values resolved from the Vault backend at delivery time.
- The structured Sandbox base policy owned by `docs/specs/20260703-policy_enforcement_mapping.md`.
- Attach operations binding provider instances to the Sandbox.

Rules:

- NanoCore MUST NOT create an OpenShell provider instance, configure refresh, or attach a provider without an `allow` `PermissionDecision` for `vault.use` on the corresponding `VaultReference` and an active `VaultGrant`; a `deny` decision prevents attachment entirely.
- Generated profile IDs and instance names MUST be OpenKit-derived, lowercase kebab-case identifiers that encode stable NanoCore lineage without embedding secret material or raw account identifiers and without colliding with built-in profile IDs or reserved aliases.
- Gateway-side namespace ownership (`apps/nanohost/src/openshell_provider_delivery.rs`, `apps/nanohost/src/openshell_provider.rs`): each configured NanoHost owns a reserved identifier prefix on its loopback-only stock Gateway, where each namespace component is the first `32` lowercase hex characters of `SHA-256` over its input bytes (deployment and Workspace components hash their UTF-8 IDs; the shape component hashes `serde_json::to_vec(accessShape)`; the grant/instance component hashes UTF-8 `grantId + ":" + providerInstanceId`). Generated profiles are scoped one per provider access shape per deployment (`okp-<deploymentComponent>-<shapeComponent>-v<mappingMajor>`), and provider instances are scoped one per grant-and-instance pair (`oki-<deploymentComponent>-<workspaceComponent>-<grantComponent>`) so instance credentials never cross Workspace boundaries. NanoHost MUST NOT mutate Gateway artifacts outside its own prefix, MUST treat foreign `okp-`/`oki-` artifacts as invalid Epoch state, and MUST record a drift diagnostic when artifacts inside its prefix disagree with regenerated state. Because a profile carries no secret material and serves one shape for one deployment, a shape change that should not propagate to all its instances requires a new shape ID rather than an in-place edit.
- Credential values flow from the Vault backend through governed `vault.binding-deliver` supply directly into the OpenShell provider create or update operation and MUST NOT be persisted in NanoCore records, AEP snapshots, generated task files, logs, or diagnostics.
- Credential expiry known to NanoCore rotation metadata MUST be projected into OpenShell credential expiry metadata so OpenShell's fail-closed expiry tracks NanoCore truth.
- Derivation MUST be deterministic for non-secret parts: identical NanoCore inputs and mapping version produce byte-identical profile and structured policy artifacts whose digests are recorded as runtime evidence. As named code-owned exceptions to RFC 8785 (`docs/specs/20261021-protocol_identifiers_and_enums.md`), native `profile_digest` (`apps/nanohost/src/openshell_provider.rs`) is the unprefixed lowercase `SHA-256` hex over the serialized structured profile JSON (including profile identity/description/category, ordered credentials and admitted refresh descriptors, endpoint documents, binary paths, inference/discovery flags, and sorted annotations, while rejecting unsupported dynamic token-grant fields before hashing), and the native effective-policy digest (`apps/nanohost/src/openshell_provider_policy.rs`) is the unprefixed lowercase `SHA-256` hex over `serde_json::to_vec(policy_document(expected))` computed only after both expected and observed policies are representable and their complete typed structures compare equal.
- When a grant is revoked or expires, NanoCore revokes the corresponding package authority and NanoHost terminates the affected Sandbox. A runtime provider detach MAY reduce access before termination completes, but never substitutes for teardown proof or releases scheduler capacity; if Sandbox deletion cannot be proved, NanoHost invalidates the complete Runtime Epoch and keeps capacity fenced until fresh-empty readiness (`docs/specs/20260802-nanohost_runtime_and_transport.md`).

### Generic HTTP Bearer Release Scope

The accepted `v0.1.0` scope includes the Provider placeholder channel (`sandbox-provider` -> `backend-provider`) and Gateway-delegated refresh for generic HTTP bearer credentials (`docs/specs/20260703-vault_secret_injection.md#delivery-channels`):

- Initial static `sandbox-provider` delivery keeps launch preparation reference-only. Governed delivery creates and attaches the generated profile and instance, verifies complete typed effective-policy equality and digest agreement, and records a canonical `VaultInjectionReceipt`. In-place replacement requires a proved governed native operation.
- Gateway-delegated refresh (`oauth2_refresh_token`, `oauth2_client_credentials`, `google_service_account_jwt`) keeps strict effective-policy comparison and bounded evidence normalization.
- Enablement of delegated refresh retains existing grants, explicit approval-gated delegation, exact effective-policy equality, secret redaction, and canonical receipt, `VaultUse`, and `AuditEvent` evidence through the governed Vault operation family and standard Policy insertion points.
- This scope adds no subscription token responder: Codex uses its host-managed token channel, LLM Gateway subscription accounts remain separate (`docs/specs/20260721-provider_subscription_accounts.md`), and on-demand credential helpers and the restricted SSH agent facade use outbound Worker carriage under `docs/specs/20260703-vault_secret_injection.md#on-demand-credential-channels` without a metadata listener or Docker socket.
- For a profile's required token endpoint, the selected official OpenShell release must support endpoint override or a qualified interception facility; if neither exists, that profile fails closed without forking OpenShell or weakening endpoint or policy checks.

### Delegated Refresh Obligations

A configured access shape carries optional, secret-free `refresh` intent: strategy, exact HTTPS token URL without credentials, query or fragment, and bounded scopes. Configuration names material keys only. The delegated Vault material is one JSON object with exactly the strategy's keys:

- `oauth2_client_credentials`: `client_id` and `client_secret`.
- `google_service_account_jwt`: `client_email`, `private_key`, optional `subject`, and at least one scope.
- `oauth2_refresh_token` parses, but delegation refuses with `credential_delegation_blocked` before Policy evaluation or effects because whole-family recovery of a rotated root is unproved. Configuration loading reports a value-free warning with that reason while retaining valid Gateway configuration.

The two admitted strategies do not change their root. Core's current material version remains the recoverable family, and a Gateway holder never writes material back. `vault.binding-deliver` for a `backend-provider` plan evaluates `vault.delegate-refresh` beside `vault.use` under the [refresh-delegation allowance](20260703-policy_enforcement_mapping.md#scope-owned-statement-format-f3). The PermissionDecision proposal binds `accessShapeDigest`; withdrawal of the rechecked delegation authority refuses the operation.

The retained `credentialWriter` permits delegation only while Core is the writer. Otherwise delivery refuses `credential_family_busy`. Core-side rotation refuses that same reason while a Gateway writer is pending or active; a fenced holder accepts a new root version. These caller checks precede backend writes, while the native version and writer CAS remain authoritative. Delegated replacement refuses; revoke and deliver anew.

Delegated-refresh comparison covers the complete typed policy, base plus all Provider layers, and refuses an unsupported non-default native authority field before normalization. Native evidence summaries (`apps/nanohost/src/openshell_provider_evidence.rs`) retain only allowlisted status, strategy, bounded timestamps, and counts. They never retain native identifiers, account data, secret material, or arbitrary error text. A missing native observation is marked incomplete.

Gateway-delegated refresh activation requires these obligations through existing owners, without new Core record families or retained formats:

- **Delegation**: The Vault operation and Policy/`PermissionDecision` chain must authorize the exact NanoHost, Gateway, strategy, and material keys (never established by the native adapter or using the Codex refresher or a harness lease/write-back protocol).
- **Predecessor fencing**: Before replacing a native profile, instance, or refresh configuration, the Runtime Epoch owner must prove which predecessor can still use or mint material (native creation or a status read is not fencing proof).
- **Rotation acceptance**: NanoCore must accept the exact authorized Vault generation, grant, and lineage into its receipt, `VaultUse`, and Audit owners after completed native effects (never treating a native status or profile import alone as a canonical receipt or selecting a `VaultReference` by a native name).
- **Revocation**: Revoking the grant or delegation must revoke package authority, terminate the affected Sandbox, and fence the complete Epoch when removal is unproved (refresh deletion, detach, or missing status alone never proves revocation or releases capacity).
- **Upstream qualification**: The installed official release must prove Provider enablement, required token-endpoint facilities, full effective-policy observation, and (for delegated refresh) an observable stock status surface plus real placeholder rewrite, expiry, delegated mint, and teardown observations.

### Credential Injection Semantics

OpenKit adopts the following OpenShell mechanisms for `backend-provider` and `runtime-file` credential delivery:

- **Placeholder environment plus Gateway rewrite (`backend-provider`)**: The Worker process environment receives placeholder variables (which MUST NOT use OpenShell's reserved `v<digits>_` prefix), and real values are resolved only in outbound HTTP traffic at the Gateway proxy; each injection is represented by a `VaultInjectionPlan` with `injectionVisibility: "backend-provider"` and `targetEnvVarName` set to the placeholder name.
- **Fail-closed expiry**: OpenShell skipping expired credentials at environment build and rejecting expired retained generations during placeholder resolution is the required behavior; NanoCore never works around expiry by re-injecting stale values and surfaces a degraded or blocked session with a redacted diagnostic.
- **Split refresh strategy ownership (`apps/nanohost/src/openshell_provider_refresh.rs`)**:
  - `static` and `external` are NanoCore-managed: when Vault backend material rotates, NanoCore updates the provider instance credential and expiry metadata, and the Gateway never mints tokens for them.
  - `oauth2_refresh_token`, `oauth2_client_credentials`, and `google_service_account_jwt` are delegated to the OpenShell Gateway refresh worker when enabled: gateway-delegated refresh is default-deny and may be enabled only when Policy grants `vault.delegate-refresh` through an explicit approval-gated `PermissionDecision` naming the configured NanoHost and Gateway, the strategy, and the material keys (`refresh_token`, `client_secret`, `private_key`) leaving the Vault boundary, covered by its own `VaultInjectionPlan` and `VaultInjectionReceipt`.
- **Static exposure granularity vs endpoint-scoped grants**: Static placeholder injection is scoped to `Sandbox x attached Provider` plus policy layers, never endpoint- or binary-scoped static secrecy (`VaultInjectionPlan` MUST NOT claim endpoint-scoped static injection). Dynamic token grants (SPIFFE JWT-SVID exchange) are not adopted (`apps/nanohost/src/openshell_provider.rs` rejects token-grant fields); any grant whose policy requires endpoint-scoped exposure MUST be satisfied by isolating the credential in its own Sandbox or refused before launch.
- **Ephemeral `runtime-file` carrier (`docs/specs/20260703-vault_secret_injection.md#runtime-file-visibility`)**: Static `runtime-file` delivery uses NanoHost's memory-backed single-file mount sources derived and validated through the pinned native driver configuration (`apps/nanohost/src/credential_carrier.rs`), keeping retained-source validation intact without enabling arbitrary host binds; verified import and read-only mount observations precede the `VaultInjectionReceipt`, and unknown removal terminates or fences through the Runtime Epoch lifecycle.

### Injection Receipts And Vault-Use Audit

Every OpenShell-side event relevant to credential governance maps to NanoCore records:

- Successful provider instance creation or credential update with real material -> `VaultInjectionReceipt` + `VaultUse` + `AuditEvent`.
- Successful refresh configuration handing material to the Gateway -> `VaultInjectionReceipt` + `VaultUse` + `AuditEvent`.
- Each Gateway-managed refresh mint or rotation observed by NanoCore -> `VaultUse` + `AuditEvent`, preserving the imported secret-safe refresh log line or status row as restricted evidence.
- Provider attachment, runtime revoke detach, affected-Sandbox termination, and Runtime Epoch invalidation -> `AuditEvent` linked to the grant, plan, `PermissionDecision`, package snapshot, and AgentSession.
- Observable expired-credential fail-closed events and placeholder resolution rejections -> `AuditEvent` with outcome and redacted reason.

Rules:

- Every record carries lineage to the backend session (`workspaceId`, `agentSessionId`, `packageSnapshotId`, and redacted Gateway/Sandbox locator summary) under `docs/specs/20260703-audit_usage_evidence_records.md`.
- OpenShell refresh status output, provider records, effective policy dumps, and refresh logs (when a stable surface exists) are `restricted-raw` evidence inputs that NanoHost collects/normalizes and NanoCore imports into its own records (quarantining unrecognized payloads as restricted evidence and applying OpenKit redaction so token values, refresh material, authorization headers, or raw account IDs are never persisted); product surfaces never read Gateway state in place.
- If NanoCore cannot observe a delegated refresh class, diagnostics MUST report `VaultUse` audit for that class as incomplete rather than complete. Enablement uses NanoHost collection and NanoCore canonical acceptance, and adds no second poller, second native projector, or NanoCore Gateway client.

### Policy Mechanism Mapping

- `@openkit/policy-kernel` evaluates NGAC facts and `docs/specs/20260703-policy_enforcement_mapping.md` records `PermissionDecision` rows. Allowed `network.egress` decisions plus AEP network intent compile into Sandbox base policy `network_policies` entries (`apps/nanocore/src/runtime/worker-governance-backend.ts`, `apps/nanohost/src/openshell_policy.rs`), and allowed `vault.use` decisions compile into backend-private credential materialization whose generated OpenShell profiles contribute `_provider_*` endpoint and binary layers (an OpenShell provider attachment is an enforcement artifact, never an AEP or Worker-visible LLM Provider route).
- Endpoint and L7 detail in generated artifacts (host, port, protocol, access presets, allow/deny rules, binaries) comes from NanoCore-owned provider access shape definitions rather than copying OpenShell built-in profiles at runtime.
- NanoHost verifies that expected `_provider_*` layers are present and that the complete typed expected and observed effective policies and their digest match (`apps/nanohost/src/openshell_client.rs`, `apps/nanohost/src/openshell_provider_policy.rs`); if a Gateway policy override suppresses provider layers or `providers_v2_enabled` is off, launch/attach fails closed with a redacted diagnostic. OpenShell network deny events and policy audit output are enforcement evidence only and never rewrite NanoCore policy state.
- Upstream OpenShell roadmap items not adopted as enforcement mechanisms—profile-driven static placement (`auth_style`, `header_name`, `query_param`, `path_template` are populated as declared intent only), endpoint/binary-scoped static injection, startup policy prover, OCSF refresh telemetry, and `inference_capable` profile mounting—remain treated as unavailable.
- Non-OpenShell container backends MUST satisfy equivalent capability gates: a backend that does not declare `provider-attachments` and `credential-placeholder` MUST NOT receive `backend-provider` plans (restricting grants to `gateway-only` or explicitly approved `runtime-env`, `runtime-file`, or `runtime-token` paths), and a backend that cannot enforce required `network-policy` containment fails closed before launch with derived, regenerable, digest-recorded enforcement inputs.

### Drift Control

- NanoCore validates the exact typed authorization intent for every OpenKit-authored provider profile and Sandbox policy before requesting a runtime effect (`apps/nanocore/src/runtime/nanohost-session-dispatch.ts`), and NanoHost renders and strictly parses native artifacts into the selected OpenShell SDK types (`apps/nanohost/src/openshell_policy.rs`, `apps/nanohost/src/openshell_provider.rs`), refusing missing, unknown, malformed, or unsupported fields on both sides before launch or attach.
- Adopting an upstream OpenShell release is an explicit dependency update under the NanoHost runtime owner's upgrade gate (`docs/specs/20260802-nanohost_runtime_and_transport.md`, `apps/nanohost/openshell/release.json`) with no live runtime schema fetching: upgrade qualification runs first with accepted OpenKit parameters across structured-policy carriage, credential/network enforcement, `_provider_*` layers, denial behavior, lifecycle cleanup, and load/failure bounds, failing closed on Gateway artifact rejection, unknown evidence fields, or missing `_provider_*` layers.

## Acceptance

- L0 lint rejects OpenShell-native types entering `@openkit/protocol` or public schemas.
- L5 built-artifact smoke reports the expected mapping version and the actual OpenShell release identity.
- Deterministic projector, SDK parser, and redaction verification proves byte-identical non-secret profile and policy derivation, `okp-`/`oki-` namespace isolation, rejection of unknown/malformed intent or token-grant fields, effective-policy `_provider_*` layer and digest verification, denied `vault.use` blocking attachment, expired-credential fail-closed rejection, revocation Sandbox termination and unproved-deletion Runtime Epoch invalidation, and real-OpenShell L6 placeholder HTTP rewrite with canonical plan, receipt, `VaultUse`, and effective-policy evidence (`#604`).

## Implementation

- Typed Sandbox policy/provider intent, static Provider binding, and Turn execution: `apps/nanocore/src/runtime/`, `apps/nanocore/src/vault/`.
- Native OpenShell policy/provider rendering, effective-policy digest check, ephemeral file carrier, and dormant refresh adapters: `apps/nanohost/src/`, `apps/nanohost/openshell/`.
- Credential declaration and environment schemas: `packages/config-schema/src/`, `packages/app-api-schemas/src/`, `packages/policy-kernel/src/`.

## Implementation Gaps

- Static Provider in-place replacement, delegated refresh runtime projection/collection and real-OpenShell qualification - Native writer ownership and human-authored delegation authority are implemented, but static `replace` refuses, `oauth2_refresh_token` remains blocked without whole-family recovery, and production refresh projection/collection and real-OpenShell qualification remain incomplete - #604
- Fine-grained NGAC `PermissionDecision` row compilation for every individual OpenShell policy fragment - Launch binds to NanoCore policy snapshot lineage and durable gateway/vault/worker `PermissionDecision` rows, without a separate decision row per derived policy fragment - #373
- Explicit OpenShell release identity field on each native static Provider protection proof object - Native proof records mapping version, `profile_digest`, and effective-policy digest while the OpenShell release pin is enforced at the runtime boundary (`apps/nanohost/openshell/release.json`) - #809

## Decisions

- [Disabled Backend Provider Refresh Scope](../decisions/20261016-disabled_backend_provider_refresh_scope.md)
- [Ephemeral Worker Credential Carrier](../decisions/20261031-ephemeral_worker_credential_carrier.md)
