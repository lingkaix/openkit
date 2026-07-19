# OpenShell Mechanism Internalization

Status: Accepted
Implementation: Partial

## Owns

- The internalization principle for OpenShell-backed credential injection, injection audit, and policy enforcement mechanisms: NanoCore definitions are canonical, OpenShell mechanisms are a borrowed enforcement backend.
- The derivation contract from NanoCore vault grants, injection plans, and NGAC-derived `PermissionDecision` records to OpenShell provider profiles, provider instances, and `_provider_*` policy layers.
- The credential injection semantics OpenKit adopts from OpenShell Providers v2, including placeholder environment variables with gateway rewrite, fail-closed expiry, and the split of refresh strategy ownership between NanoCore and the OpenShell gateway refresh worker.
- The rule that OpenShell-side injection, refresh, attachment, revocation, and whole-Cell teardown events are imported back into NanoCore `InjectionReceipt`, `VaultUse`, and `AuditEvent` records with lineage to the backend session.
- The pinned-boundary and drift-control contract for the OpenShell surface OpenKit depends on, including the schema snapshot package and the conformance check over generated artifacts.
- The equivalence requirements for credential and network enforcement on non-OpenShell container backends.

## Does Not Own

- The canonical vault record model (`VaultReference`, `VaultGrant`, `InjectionPlan`, `InjectionReceipt`, `VaultUse`), which belongs to `docs/specs/20260703-vault_secret_injection.md`.
- The canonical `PermissionDecision` model, enforcement points, and approval linkage, which belong to `docs/specs/20260703-policy_enforcement_mapping.md`.
- The `@openkit/policy-kernel` NGAC model, which belongs to `docs/specs/20260629-openkit_policy_model.md`.
- Audit, usage, and evidence record schemas and retention classes, which belong to `docs/specs/20260703-audit_usage_evidence_records.md`.
- Disposable OpenShell Cell placement and lifecycle, workspace synchronization, session-static workspace layout, and review gating, which belong to `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`, `docs/specs/20260704-session_static_workspace_materialization.md`, and `docs/specs/20260703-workspace_synchronization.md`.
- The general vendor snapshot packaging contract, which belongs to `docs/specs/20260522-vendor_snapshot_packages.md`; this spec applies that pattern to a new boundary.
- OpenShell-internal behavior, CLI design, or upstream roadmap.

## Core References

- `docs/core/vault.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`
- `docs/core/sandbox.md`
- `docs/core/agent-capability.md`
- `docs/core/storage.md`

## Summary

OpenKit will borrow NVIDIA OpenShell's Providers v2 mechanisms as the first enforcement backend for credential injection, injection-related audit, and the mechanism layer of policy enforcement. The core policy model remains NGAC through `@openkit/policy-kernel`; OpenShell enforces, it does not decide.

The clean target is a strict derivation flow: NanoCore-owned records (`VaultReference`, `VaultGrant`, `InjectionPlan`, `InjectionReceipt`, `VaultUse`, `PermissionDecision`) remain the source of truth. OpenShell provider profiles, provider instances, and provider-contributed `_provider_*` network policy layers are derived artifacts that NanoCore generates from its own records at sandbox launch or attach time. The OpenShell surface OpenKit depends on is treated as a pinned, versioned external boundary with a schema snapshot package and a conformance check, so the OpenKit standard does not drift with OpenShell changes. OpenShell-native records and logs are imported back as NanoCore audit, usage, and evidence records; they are never read in place as product truth.

## Goals / Non-goals

### Goals

- Reuse OpenShell's hardened credential mechanisms: provider profiles, provider instances, placeholder environment variables resolved in outbound HTTP traffic at the gateway, secret-safe refresh, and fail-closed expiry handling.
- Keep NanoCore schemas canonical and make every OpenShell artifact regenerable from NanoCore records.
- Compile NGAC access decisions into OpenShell base sandbox policy and provider-derived policy layers without making OpenShell policy YAML canonical.
- Reflect every product-relevant OpenShell injection, refresh, attachment, revocation, and whole-Cell teardown event as NanoCore `InjectionReceipt`, `VaultUse`, and `AuditEvent` records with backend session lineage.
- Pin the OpenShell profile and policy schema surface as a versioned snapshot and detect upstream drift before it silently changes OpenKit behavior.
- Define what equivalent enforcement means for local non-OpenShell container backends.

### Non-goals

- Do not build an OpenKit-owned injection proxy in this slice.
- Do not adopt OpenShell roadmap items that are not current behavior. Profile-driven explicit credential placement and endpoint- or binary-scoped static credential injection MUST be treated as unavailable.
- Do not make OpenShell provider profiles, provider instances, policy YAML, gateway names, or sandbox ids part of public App API, unified Skill operation catalog, bundled CLI, or Web UI contracts.
- Do not preserve compatibility layers for earlier OpenKit-internal credential upload shapes; the explicit Codex credential file upload path is replaced, not aliased.
- Do not fork or patch OpenShell. The backend supports only official unmodified CLI and Gateway artifacts at the exact version pinned by the snapshot package.
- Do not define the encrypted vault backend; that remains owned by the vault spec.

## Background

OpenShell Providers v2 turns providers into profile-backed access bundles. A provider profile declares credentials (`env_vars`, `auth_style`, `header_name`, `query_param`, `path_template`), refresh metadata (strategies `static`, `external`, `oauth2_refresh_token`, `oauth2_client_credentials`, `google_service_account_jwt`, with refresh material declarations and expiry metadata), endpoint policy, and binary policy. A provider instance stores concrete credential and config values for one gateway. When `providers_v2_enabled` is set, attached providers contribute reserved `_provider_*` network policy layers to a just-in-time composed effective policy on top of the sandbox-authored base policy. Static credentials are delivered as placeholder environment variables and resolved into real values only in outbound HTTP requests at the gateway proxy, so real secret values are not present in the sandbox process environment. The gateway skips expired credentials when building the provider environment and rejects expired retained credential generations during placeholder resolution, failing closed. A gateway refresh worker mints short-lived tokens for the OAuth2 and Google JWT strategies and emits secret-safe refresh logs.

These mechanisms overlap heavily with what the vault spec requires: reference-not-value delivery, `backend-provider` visibility, fail-closed expiry, and secret-safe audit. Rebuilding them now would duplicate hardened, security-critical infrastructure.

The risk of borrowing is definitional capture. If OpenKit stores provider profiles and instances as its product records, the OpenKit credential and policy standard drifts whenever OpenShell changes its schema, CLI, or composition rules, and non-OpenShell backends inherit an OpenShell-shaped contract. The policy model spec already forbids this for policy YAML. This spec extends the same discipline to the whole Providers v2 surface.

## Decision

OpenKit internalizes the definition layer and borrows the mechanism layer.

1. NanoCore-owned schemas are the source of truth: `VaultReference`, `VaultGrant`, `InjectionPlan`, `InjectionReceipt`, and `VaultUse` from the vault spec, and `PermissionDecision` from the policy enforcement mapping spec. No OpenShell-native shape may become durable OpenKit product state or public protocol shape.
2. OpenShell provider profiles, provider instances, and provider policy layers are derived artifacts. NanoCore generates them from its own records at sandbox launch or provider attach time, and they MUST be regenerable from NanoCore state at any time.
3. The OpenShell surface OpenKit depends on is a pinned external boundary: a versioned mapping layer in NanoCore plus a schema snapshot package following the vendor snapshot pattern in `docs/specs/20260522-vendor_snapshot_packages.md`.
4. OpenShell-native records and logs (provider records, refresh status, refresh logs, effective policy, network deny events) are evidence inputs. NanoCore imports them into its own audit, usage, and evidence records per the storage lineage rules; product surfaces read only NanoCore records.
5. `@openkit/policy-kernel` NGAC decisions remain the only authorization decision source. OpenShell enforcement is a derived mechanism, and a backend enforcement event never rewrites the policy graph by itself.

## Contract / Expected Behavior

### Internalization Principle

- NanoCore MUST be able to regenerate every OpenShell provider profile, provider instance definition, and derived policy artifact from `VaultReference`, `VaultGrant`, `InjectionPlan`, `PermissionDecision`, AEP snapshot, and workspace records alone.
- Generated OpenShell artifacts MUST NOT be edited in place on the gateway as a way of changing OpenKit behavior. The change path is: change NanoCore records, regenerate, re-derive.
- Public App API, unified Skill, bundled CLI, Web UI, and Action Center surfaces MUST expose only NanoCore record ids and redacted summaries, never OpenShell profile ids, instance names, policy YAML, gateway internals, or placeholder variable values.
- The mapping layer (the code that renders NanoCore records into OpenShell artifacts and imports OpenShell evidence back) MUST carry an explicit mapping version, and every derived artifact and imported record MUST record the mapping version and the schema snapshot id used.

### Derivation Contract

Inputs to derivation are, for one sandbox launch or attach operation:

- the `VaultGrant` rows scoped to the agent session, with their `InjectionPlan` rows,
- the `PermissionDecision` rows that allowed `vault.use` for each grant and `network.egress` for each declared endpoint family,
- the AEP snapshot's declared provider attachments and network policy intent,
- workspace and agent session identity for lineage.

Outputs are:

- zero or more generated provider profiles (custom profile YAML imported to the gateway), one per OpenKit-defined provider access shape,
- zero or more provider instances created from those profiles, holding concrete credential values resolved from vault backends at creation time,
- the sandbox base policy YAML already owned by the policy enforcement mapping spec,
- attach operations binding provider instances to the sandbox.

Rules:

- NanoCore MUST NOT create an OpenShell provider instance, configure refresh, or attach a provider without an `allow` `PermissionDecision` for `vault.use` on the corresponding vault reference and an active `VaultGrant`. A `deny` decision MUST prevent the attachment entirely.
- Generated profile ids and instance names MUST be OpenKit-derived, lowercase kebab-case identifiers that encode stable NanoCore lineage without embedding secret material or raw account identifiers. They MUST NOT collide with built-in profile ids or reserved aliases.
- Gateway-side namespace ownership: each NanoCore deployment owns a reserved identifier prefix on every gateway it manages, derived from a stable deployment id (`okp-<deployment>-` for profiles, `oki-<deployment>-` for instances). Generated profiles are scoped one per provider access shape per deployment (`okp-<deployment>-<shape>-v<mappingMajor>`); provider instances are scoped one per vault grant (`oki-<deployment>-<workspace>-<grant>`), so instance credentials never cross workspace boundaries. NanoCore MUST NOT mutate gateway artifacts outside its own prefix, MUST treat foreign `okp-`/`oki-` prefixed artifacts as belonging to another deployment and leave them untouched, and MUST record a drift diagnostic when artifacts inside its own prefix do not match regenerated state. Because a profile carries no secret material and serves exactly one shape for one deployment, a profile update propagates only to that deployment's instances of that one shape; a shape change that should not propagate to all its instances is a new shape id, never an in-place edit.
- Credential values MUST flow from the vault backend directly into the OpenShell provider create or update operation. They MUST NOT be persisted in NanoCore records, AEP snapshots, generated task files, logs, or diagnostics on the way through.
- Credential expiry known to NanoCore rotation metadata MUST be projected into OpenShell credential expiry metadata (`--credential-expires-at`) so OpenShell's fail-closed expiry behavior tracks NanoCore truth.
- Derivation MUST be deterministic for the non-secret parts: the same NanoCore inputs and mapping version produce byte-identical profile YAML and policy YAML. Digests of generated artifacts MUST be recorded as runtime evidence.
- When a grant is revoked or expires, NanoCore MUST revoke the corresponding package authority and recycle the owning disposable Cell. A runtime provider detach MAY reduce access before recycle completes, but it is not teardown proof and MUST NOT release scheduler capacity. Fresh-epoch replacement removes the provider instance and sandbox together; NanoCore does not require or attempt provider or sandbox deletion as final cleanup.
- Provider profile updates on the gateway affect every instance of that profile type. NanoCore MUST therefore scope generated profiles so that one profile serves exactly one OpenKit provider access shape under NanoCore control, and MUST NOT reuse or mutate profiles owned by another deployment or by hand-managed gateway state.

### Credential Injection Semantics

OpenKit adopts the following OpenShell mechanisms as its `backend-provider` injection path:

- Placeholder environment plus gateway rewrite. The worker process environment carries placeholder variables; real values are resolved only in outbound HTTP traffic at the gateway proxy. Each such injection MUST be represented as an `InjectionPlan` with visibility `backend-provider`, and the plan's target env var name is the placeholder name.
- Fail-closed expiry. OpenShell skipping expired credentials at environment build and rejecting expired retained generations during placeholder resolution is the adopted behavior. NanoCore MUST NOT work around it by re-injecting stale values; an expired credential produces a degraded or blocked session with an explanatory, redacted diagnostic.
- Refresh strategy ownership is split:
  - `static` and `external` strategies are NanoCore-managed. NanoCore is the external process: when vault backend material rotates, NanoCore updates the provider instance credential and expiry metadata. The gateway never mints tokens for these.
  - `oauth2_refresh_token`, `oauth2_client_credentials`, and `google_service_account_jwt` are delegated to the OpenShell gateway refresh worker. NanoCore configures refresh with material resolved from vault grants, marks secret material keys, and lets the gateway mint and rotate short-lived access tokens. Handing refresh material to the gateway is itself a secret delegation and MUST be covered by its own `InjectionPlan`, `InjectionReceipt`, and policy decision.
  - Delegation policy: gateway-delegated refresh is default-deny. The three gateway-mintable strategies MAY be enabled only for a vault reference whose policy grants `vault.delegate-refresh` through an explicit approval-gated `PermissionDecision`, recorded per delegated gateway. The approval MUST name the gateway, the strategy, and the material keys (`refresh_token`, `client_secret`, `private_key`) leaving the vault boundary. `static` and `external` strategies require no delegation decision because refresh material never leaves NanoCore-managed rotation. Revoking the grant or delegation MUST revoke package authority and recycle the owning Cell so the fresh epoch contains no retained refresh state.
- Dynamic token grants (SPIFFE JWT-SVID exchange) are the only current OpenShell mechanism with endpoint-scoped credential placement, but they are not part of the first slice. Until adopted (see Deferred / Future Work), a grant that requires endpoint-scoped exposure MUST be satisfied by sandbox isolation or refused, per the constraints below.

Constraints imposed by current OpenShell behavior:

- Static placeholder injection is not endpoint- or binary-scoped. The effective exposure granularity for a static credential is the sandbox times the attached provider: any process the sandbox may run can present the placeholder toward any endpoint the provider's policy layer allows. `InjectionPlan` records MUST NOT claim endpoint-scoped injection for static credentials.
- A grant whose policy requires endpoint-scoped credential exposure MUST be satisfied by a dynamic token grant, by isolating the credential in its own sandbox, or by refusing the launch. It MUST NOT be satisfied by pretending the static path is scoped.
- Placeholder env var names MUST NOT use OpenShell's reserved `v<digits>_` prefix.

### Injection Receipts And Vault-Use Audit

Every OpenShell-side event that matters to credential governance MUST be reflected in NanoCore records:

- Provider instance creation or credential update with real material → `InjectionReceipt` + `VaultUse` + `AuditEvent`.
- Refresh configuration handing material to the gateway → `InjectionReceipt` + `VaultUse` + `AuditEvent`.
- Each gateway-managed refresh mint or rotation that NanoCore observes → `VaultUse` + `AuditEvent`, with the imported secret-safe refresh log line or refresh status row preserved as restricted evidence.
- Provider attachment, runtime revoke detach when performed, and whole-Cell teardown → `AuditEvent` linked to the grant, injection plan, permission decision, package snapshot, and agent session.
- Expired-credential fail-closed events and placeholder resolution rejections, when observable → `AuditEvent` with outcome and redacted reason.

Rules:

- Every such record MUST carry lineage to the backend session: workspace id, agent session id, package snapshot id, and a redacted backend session locator (gateway name summary and sandbox summary), consistent with the OpenShell evidence normalization baseline in the audit spec.
- OpenShell refresh status output, provider records, effective policy dumps, and refresh logs when the installed OpenShell version exposes a stable log surface are evidence inputs with `restricted-raw` handling. NanoCore MUST import and normalize them into its own records; product surfaces MUST NOT read gateway state in place as product truth.
- Imported records MUST never contain token values, refresh material, authorization headers, or raw account identifiers. OpenShell's refresh logs are expected to be secret-safe by design when available, but the importer MUST still apply OpenKit redaction rules before persistence.
- If NanoCore cannot observe a delegated refresh class (for example the gateway is unreachable for status polling), diagnostics MUST report vault-use audit for that class as incomplete rather than presenting audit as complete.
- Import mechanism and cadence: NanoCore polls gateway refresh status on the same cadence as scheduler target health probing (per `docs/specs/20260703-durable_scheduler_design.md`: 60 seconds for targets with live leases, 5 minutes otherwise). Secret-safe refresh logs are collected at session release when the installed OpenShell version exposes a stable log surface. Structured refresh telemetry replaces polling when upstream ships it (see Deferred / Future Work).

### Policy Mechanism Mapping

- `@openkit/policy-kernel` evaluates NGAC facts; the enforcement mapping spec turns kernel outcomes into `PermissionDecision` rows. This spec adds the compilation step: allowed `network.egress` decisions plus AEP network intent compile into the sandbox base policy `network_policies` entries; allowed `vault.use` decisions compile into provider attachments whose generated profiles contribute `_provider_*` endpoint and binary layers.
- Endpoint and L7 detail in generated artifacts (host, port, protocol, access presets, allow rules, deny rules, binaries) MUST come from NanoCore-owned provider access shape definitions, not from copying OpenShell built-in profiles at runtime. Built-in OpenShell profiles MAY inform the initial shape definitions, but the definitions live in NanoCore.
- NanoCore MUST record the effective policy digest (base plus provider layers, as reported by the gateway) as runtime evidence for each launch, and MUST verify that expected `_provider_*` layers are present. If a gateway-global policy override suppresses provider layers, or `providers_v2_enabled` is off so attached providers contribute no policy layers, the expected enforcement is absent and NanoCore MUST fail the launch closed with a redacted diagnostic.
- OpenShell network deny events and policy audit output are enforcement evidence. They MAY create audit or Action Center records but MUST NOT rewrite NanoCore policy state.

Known enforcement gaps to design around (OpenShell roadmap items treated as unavailable):

- Profile-driven explicit credential placement: `auth_style`, `header_name`, `query_param`, and `path_template` are stored and validated but do not drive static injection. NanoCore MUST still populate them in generated profiles as declared intent, and MUST NOT rely on them for enforcement.
- Endpoint- and binary-scoped static credential injection: not real; see the injection constraints above.
- Policy prover on startup: not run automatically; OpenKit's own conformance check and effective-policy verification fill this role.
- Refresh telemetry as OCSF events: not available; NanoCore imports refresh status and secret-safe logs instead.
- Inference mounting from `inference_capable` profiles: not wired; inference routing remains NanoCore-owned and out of scope here.

Non-OpenShell container backends MUST provide equivalent enforcement through the backend capability model:

- A backend that does not declare `provider-attachments` and `credential-placeholder` capabilities MUST NOT receive `backend-provider` injection plans. Grants for such backends are limited to `gateway-only` visibility through the NanoCore agent capability gateway, or to explicitly policy-approved `runtime-env`, `runtime-file`, or `runtime-token` plans under the vault spec's stronger-policy rule.
- A backend that cannot enforce a required `network-policy` capability for a decision that demands network containment MUST fail before launch with a redacted diagnostic, per the policy model's capability-based portability rule.
- The compiled enforcement inputs for other backends (for example container network options) are derived artifacts under the same rules: regenerable, digest-recorded, never canonical.

### Drift Control

- A schema snapshot package pins the OpenShell surface this spec depends on: the provider profile schema (fields, credential declaration shape, refresh strategy enum and material keys, category enum, token grant fields), the sandbox policy schema (version `1`, `filesystem_policy`, `landlock`, `process`, `network_policies`, endpoint and rule objects), composition rules (`_provider_*` reservation, base-versus-effective policy semantics, global override suppression), reserved namespaces (`v<digits>_` env prefix, built-in profile ids), and the CLI subcommand surface the mapping layer invokes. The package follows the vendor snapshot contract: metadata, checksums, a refresh procedure, and a package-local `test` script; runtime MUST NOT live-fetch it.
- A conformance check MUST validate every generated provider profile and policy artifact against the pinned snapshot before it is sent to a gateway. Generation-time validation failure blocks the launch or attach, fails closed, and produces a redacted diagnostic. `openshell provider profile lint` MAY be used as a secondary check but MUST NOT replace the snapshot validation.
- The mapping layer MUST detect upstream drift signals at runtime: any CLI or Gateway version other than exact stock `0.0.80`, gateway rejection of previously valid artifacts, unknown fields or enum values in imported evidence, or missing expected `_provider_*` layers. Drift signals MUST be surfaced as diagnostics and, when enforcement-relevant, MUST fail closed rather than degrade silently.
- Adopting an upstream OpenShell change is an explicit maintenance act: refresh the snapshot, review the diff as an external boundary update, bump the mapping version, and only then change dependent NanoCore behavior. Silent adaptation to upstream changes is not allowed.

## Accepted Design

The mapping layer lives in NanoCore as an OpenShell boundary module with three parts:

1. A renderer that turns NanoCore provider access shapes, grants, plans, and decisions into profile JSON, instance create/update/refresh-configure operations, sandbox attachment, and optional runtime revoke detach, tagged with mapping version and snapshot id.
2. An importer that polls or collects provider records, refresh status, secret-safe refresh logs, and effective policy digests, normalizes them into `InjectionReceipt`, `VaultUse`, `AuditEvent`, and runtime evidence records, and quarantines unrecognized payloads as restricted evidence.
3. A conformance checker that validates rendered artifacts against the snapshot package and asserts runtime invariants (expected provider layers present, no reserved-key violations, no secret-shaped values in rendered non-secret fields).

NanoCore-owned provider access shape definitions (credential declaration, endpoint policy, binaries, refresh strategy selection) are configuration-schema records referenced by vault references and AEP snapshots. They are the internalized replacement for reading OpenShell built-in profiles as truth.

The snapshot package is `packages/openshell-schema-snapshot`, exported as `@openkit/openshell-schema-snapshot`, following `docs/specs/20260522-vendor_snapshot_packages.md` (dated snapshot directories, metadata, checksums, package-local validation). Its snapshot metadata pins exact stock OpenShell `0.0.80`; deployment configuration cannot widen that boundary.

## Current Implementation Projection

- `packages/openshell-schema-snapshot` pins exact stock OpenShell `0.0.80` release provenance, provider profile surface, sandbox policy surface, NanoCore-consumed CLI surface, reserved namespaces, checksums, and package-local conformance tests. The snapshot separates the complete tagged upstream categories, built-in profile ids, protocols, access modes, and enforcement modes from the narrower OpenKit-emitted mapping.
- `apps/nanocore/src/runtime/openshell-policy.ts` renders derived OpenShell filesystem, process, and network policy YAML from runtime inputs and validates generated policy YAML through `@openkit/openshell-schema-snapshot` before a sandbox launch can use it. The V1 path binds worker launch to NanoCore policy snapshot lineage and uses durable permission decisions for the implemented gateway and vault enforcement points; richer NGAC-to-policy-row compilation for every OpenShell policy fragment remains future hardening.
- OpenShell worker materialization does not project host-native runtime configuration. Runtime credentials and files may enter a sandbox only through manifest-declared AEP credential authority and backend-private materialization.
- `packages/policy-kernel` returns `allow`/`deny` with traces, and NanoCore has durable `PermissionDecision` rows for the current boot, gateway, vault, and worker enforcement slices used by the V1 OpenShell-backed path.
- `VaultReference` and `VaultGrant` exist as first-slice AEP schema fields and durable non-secret NanoCore metadata; `InjectionPlan`, `InjectionReceipt`, and `VaultUse` exist as first-slice durable non-secret NanoCore metadata. Worker-side GitHub MCP package resolution can derive a logical AEP provider attachment and backend-private credential input from a durable `VaultGrant`, but current OpenShell materialization rejects that input before provider or sandbox effects because the AEP does not yet carry the exact Providers v2 endpoint and binary policy. Runtime-file and runtime-environment declarations remain materializable. Final teardown revokes process-local authority and recycles the complete Cell into a verified fresh empty epoch.
- The production TypeScript CLI adapter uses only the official platform path (`/usr/bin/openshell` on Linux and `/opt/homebrew/bin/openshell` on macOS) and exact version `0.0.80`. Across that adapter and the fixed Cell helper, the retained stock CLI surface is version and Gateway inspection; Providers v2 get/set; provider profile export/import; provider get/create/update/refresh-status; and sandbox create/list/exec/download. The helper owns Providers v2 enablement and stable-empty sandbox inspection; the TypeScript adapter owns the remaining runtime commands. Sandbox delete, provider delete or detach, host doctor, custom binary selection, insecure Gateway flags, and version ranges are absent.
- Local placement reaches the Cell Gateway at fixed `http://127.0.0.1:17670`. Remote placement uses an operator-managed SSH local-forward from the remote Cell's loopback-only Gateway to a credential-free loopback HTTP origin on the NanoCore host. Lifecycle control is a separate fixed SSH helper command with forwarding disabled; NanoCore does not create or own the tunnel. The remote sandbox receives an independently configured credential-free HTTP(S) worker-control URL ending exactly at `/api/worker-control`.
- AEP provider attachment declarations are currently logical metadata only. The OpenShell launcher passes `--provider` only for the internally generated transient trusted-inference provider; it rejects backend-private non-transient provider credentials, while runtime-file and runtime-environment attachments remain file or environment materialization.
- The V1 mechanism-internalization boundary is partially implemented. Exact trusted-inference profile generation, generated artifact validation, transient provider upsert and attachment, product-safe provider evidence, and whole-Cell teardown are implemented. Non-transient Providers v2 attachment remains disabled until the AEP can prove exact effective policy equality; refresh-log import remains unavailable because stock `0.0.80` exposes no stable refresh-log export surface. The separate full real Codex `0.144.1` root-plus-two-child provenance acceptance independently passed on A1 against stock OpenShell `0.0.80`; it does not close the remaining provider-policy, refresh-log, or richer policy-compilation gaps owned here.

## Alternatives Considered

### Build An OpenKit-Owned Injection Proxy Now

OpenKit could implement its own egress proxy with credential rewrite, refresh workers, and L7 policy, giving full control of the standard, endpoint-scoped injection from day one, and zero upstream drift exposure. Rejected for now: this is a large, security-critical build (TLS termination, HTTP rewriting, OAuth2 and service-account minting, expiry handling, secret-safe logging) that duplicates a hardened mechanism OpenShell already provides, and it would delay the product slices that need injection working. The honest cost of not building it is accepting OpenShell's current granularity limits and carrying a pinned external boundary. The internalized definition layer is designed so that a future OpenKit proxy can replace the OpenShell mechanism behind the same NanoCore records; this alternative is deferred, not dismissed.

### Use OpenShell Definitions Directly As Source Of Truth

OpenKit could store provider profiles and provider instances as its product records and treat gateway state as canonical. This is the fastest path: no mapping layer, no derivation code, no import step. Rejected: the OpenKit credential and policy standard would then drift with every upstream schema, CLI, or composition change; public contracts would be shaped by a vendor surface; non-OpenShell backends would inherit an OpenShell-shaped contract they cannot honestly implement; and audit truth would live in gateway logs OpenKit does not own. This also directly violates the policy model spec's guardrails against OpenShell policy becoming product truth.

### Wait For OpenShell Roadmap Scoped Injection Before Integrating

OpenKit could postpone credential integration until OpenShell ships profile-driven explicit placement and endpoint-scoped static injection. Rejected: it blocks OpenKit on an external roadmap with no committed dates, and the placeholder-env mechanism plus dynamic token grants already satisfy the `backend-provider` visibility class the vault spec prefers. The gaps are handled by honest `InjectionPlan` visibility and fail-closed rules instead of waiting.

## Consequences

- OpenKit gets working, hardened credential injection and provider-scoped network policy quickly, at the cost of maintaining a mapping layer and a snapshot package.
- Credential exposure granularity in the first slice is sandbox-times-provider, not endpoint-scoped, and this limit is recorded honestly in `InjectionPlan` records rather than papered over.
- Every OpenShell artifact becomes disposable: gateways can be rebuilt from NanoCore records, which simplifies recovery and multi-gateway placement later.
- Refresh material delegation to the gateway is an explicit, audited cross-boundary decision instead of an implicit side effect.
- Upstream OpenShell changes become scheduled boundary maintenance instead of surprise behavior changes.
- A future OpenKit-owned proxy or a non-OpenShell backend can be introduced behind the same NanoCore records without changing public contracts.

## Rollout / Migration Plan

1. Land durable `VaultGrant`, `InjectionPlan`, `InjectionReceipt`, `VaultUse`, and `PermissionDecision` records (owned by their specs) far enough to serve as derivation inputs.
2. Create the OpenShell schema snapshot package with the profile schema, policy schema, composition rules, reserved namespaces, and CLI surface, plus package-local validation.
3. Implement the renderer and conformance checker; generate provider profiles, instances, and attachments for one provider access shape end to end, gated on `vault.use` decisions.
4. Implement the importer: receipts on create/update/refresh-configure/attachment/revocation, refresh-status normalization, whole-Cell teardown evidence, and effective-policy digest verification with fail-closed provider-layer checks.
5. Replace the explicit Codex credential file upload path with grant-derived provider attachment in the same change; remove the old path without a compatibility reader.
6. Extend to gateway-managed refresh strategies with delegated-material receipts, then to non-OpenShell backend equivalence checks.

## Testing Strategy / Acceptance Criteria

- L0: repository checks ensure the snapshot package carries `AGENTS.md`, `README.md`, metadata, checksums, and a `test` script; lint rejects OpenShell-native types leaking into `@openkit/protocol` or public schemas.
- L1: unit tests for the renderer (deterministic YAML output for fixed inputs, kebab-case id derivation, reserved-namespace rejection, expiry projection) and the importer (normalization, quarantine of unknown fields); redaction tests proving rendered artifacts and imported records never contain secret-shaped values, tokens, or raw account ids.
- L2: contract and conformance tests validating generated profile and policy artifacts against the pinned snapshot; schema tests for `InjectionReceipt`, `VaultUse`, and `AuditEvent` lineage fields; drift tests where a mutated snapshot or an artifact with unknown fields fails the conformance check closed.
- L3: NanoCore black-box tests with a deterministic OpenShell stub covering: denied `vault.use` produces no provider attachment; allowed grants produce attachment plus receipt plus audit rows with backend session lineage; expired credential produces fail-closed launch with redacted diagnostic; suppressed `_provider_*` layers block launch; revocation invalidates package authority and runtime detach does not substitute for required whole-Cell recycle.
- L4: not applicable beyond existing Web surfaces showing redacted audit summaries; any Web assertions stay at existing audit views.
- L5: smoke checks that built artifacts embed the expected mapping version and snapshot id.
- L6: one opt-in story: launch a worker with a granted provider credential through a real OpenShell gateway, observe the worker call the provider endpoint via placeholder rewrite, and verify NanoCore holds the receipt, vault-use, audit, and effective-policy evidence chain without secret material anywhere in product records.

Acceptance requires: derivation is deterministic and regenerable; every injection-relevant OpenShell event class in the contract has an importer producing NanoCore records or an explicit incompleteness diagnostic; the conformance check blocks non-conforming artifacts; and the Codex file upload path is gone.

## Risks & Mitigations

- Risk: the mapping layer quietly becomes a second definition layer. Mitigation: mapping code owns no schema; it consumes NanoCore records and the snapshot, and conformance tests fail when it invents fields.
- Risk: sandbox-times-provider exposure granularity is treated as endpoint scoping. Mitigation: `InjectionPlan` visibility rules above, plus tests asserting plans never claim scoping the mechanism cannot deliver.
- Risk: delegated refresh material makes the Gateway a shadow vault. Mitigation: delegation requires its own plan, receipt, and policy decision, and revocation must recycle the owning Cell so no refresh state survives into the replacement epoch.
- Risk: upstream schema changes break launches at inconvenient times. Mitigation: pinned snapshot with fail-closed drift detection converts breakage into a diagnosed boundary maintenance task.
- Risk: importer gaps silently under-report vault use. Mitigation: audit completeness is asserted per event class; unobservable classes must be reported as incomplete per the audit core doc.

## Resolved Decisions

Previously blocking questions are resolved in the contract above: Gateway namespace ownership uses per-deployment reserved prefixes with per-shape-per-deployment profiles and per-grant instances, and Gateway-delegated refresh is default-deny behind approval-gated `vault.delegate-refresh` decisions for all three Gateway-mintable strategies. SPIFFE dynamic token grants are excluded from the first slice, refresh evidence import uses status polling on the scheduler probe cadence when observable, and `@openkit/openshell-schema-snapshot` pins exact stock OpenShell `0.0.80` rather than a version range.

## Deferred / Future Work

- An OpenKit-owned injection proxy replacing the OpenShell mechanism behind the same NanoCore records, if scoping gaps or deployment needs make it worthwhile.
- Adopting SPIFFE dynamic token grants as the endpoint-scoped injection path for deployments that can provide a Workload API.
- Adopting released stock upstream features (profile-driven placement, endpoint-scoped static injection, OCSF refresh events, policy prover integration) through a reviewed exact-version snapshot refresh and mapping version bump. OpenKit will not fork or patch OpenShell to obtain them.
- Multi-gateway derivation and placement-aware provider instance management.
- Equivalent-enforcement adapters for Docker, Kubernetes, and managed sandbox backends beyond the capability-gating rules defined here.

## Links

- `docs/specs/20260703-vault_secret_injection.md`
- `docs/specs/20260703-policy_enforcement_mapping.md`
- `docs/specs/20260629-openkit_policy_model.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`
- `docs/specs/20260704-session_static_workspace_materialization.md`
- `docs/specs/20260522-vendor_snapshot_packages.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/core/vault.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`
- External: NVIDIA OpenShell "Providers v2" and "Policy Schema Reference" documentation (pinned via the snapshot package, not linked as live truth).
