---
status: Accepted
implementation: Partial
---
# Worker Credential Access Declarations

## Owns

- The generic resolved worker credential declaration contract that replaces hard-coded worker credential use cases with list-driven launch-time resolution.
- The launch-time flow from credential declaration to `VaultGrant` validation, `VaultInjectionPlan`, `VaultInjectionReceipt`, `VaultUse`, and backend-private materialization context.
- The first three generic worker credential visibility classes: sandbox-provider, runtime file, and runtime environment variable.
- The rule that sandbox-provider is the default shape for HTTP API credentials when the worker can present a placeholder in a header, query parameter, or path.
- The fallback rules for worker-visible runtime files and runtime environment variables.

## Does Not Own

- The canonical vault record model, which belongs to `docs/specs/20260703-vault_secret_injection.md`.
- Concrete vault backend storage, which belongs to `docs/specs/20260704-vault_backend_implementation.md`.
- OpenShell mechanism ownership, drift control, provider schema snapshots, and provider evidence import, which belong to `docs/specs/20260703-openshell_mechanism_internalization.md`.
- The full `AgentEnvironmentPackage` contract, which belongs to `docs/specs/20260616-agent_environment_package.md`.
- The authored Agent Manifest credential-requirement form and the `workspace.jsonc` requirement-binding form, which belong to `docs/specs/20260703-agent_manifest_aep_resolution.md`.
- NanoCore gateway-mediated upstream calls for worker capabilities.
- Future OpenKit-owned credential proxy design.

## Core References

- `docs/core/architecture.md`
- `docs/core/work-model.md`
- `docs/core/vault.md`
- `docs/core/agent-capability.md`
- `docs/core/sandbox.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`
- `docs/core/agent-session.md`

## Summary

OpenKit already has the correct security model for worker credentials: workers should consume tools, providers, local files, or endpoints, while NanoCore owns vault resolution, grants, injection records, receipts, and audit.

The current implementation proves runtime-file upload, host-side Git push, and selected Worker MCP gateway-only credentials. It resolves sandbox-provider declarations and their durable grant lineage, but stock OpenShell provider attachment is fail-closed because Providers v2 would otherwise add profile-owned endpoints that are absent from the immutable AEP network policy. The MCP Gateway separately resolves only catalog-declared Workspace Vault grants into bounded stdio environment or HTTP header/query sinks and never exposes the material to the worker.

This spec generalizes the worker launch-time credential path without adding a new secret system.

The target is one credential declaration list consumed during Agent Environment Package resolution.

Each resolved declaration points at an existing `VaultGrant`, chooses one supported visibility class, and supplies only non-secret materialization metadata such as Provider ids, credential key names, target paths, or environment variable names. A reusable Agent Manifest declares a stable credential requirement instead of a concrete Workspace grant, and `workspace.jsonc` binds that requirement to the Workspace's own grant before resolution.

NanoCore resolves the grant before worker launch, writes the existing injection and vault-use records, and passes secret material only through backend-private materialization context.

`sandbox-provider` is the default for HTTP API credentials because the worker receives a placeholder rather than the real secret, and the selected sandbox backend resolves the placeholder only while forwarding an outbound request.

Runtime-file and runtime-env are supported as fallback paths for tools that cannot use sandbox-provider.

## Goals / Non-goals

### Goals

- Replace hard-coded worker credential ids with generic declarations while preserving the existing vault, plan, receipt, and audit chain.
- Support sandbox-provider credentials for external HTTP APIs used by worker-installed CLIs.
- Support runtime-file credentials for tools that require a sandbox-local credential file.
- Support runtime-env credentials for legacy tools that require a real environment variable.
- Keep AEP snapshots, product read models, diagnostics, logs, and evidence free of secret values.
- Fail worker launch before sandbox creation when a required credential declaration cannot be authorized, resolved, or enforced by the selected backend.
- Keep the first implementation small enough to land through package schema, NanoCore resolver, OpenShell materialization, and focused tests.

### Non-goals

- Do not implement NanoCore gateway proxying or upstream delegation in this slice.
- Do not build a generic secret editing UI.
- Do not implement custom OpenShell provider profile import or update in the first slice.
- Do not implement gateway-managed refresh metadata, OAuth refresh delegation, or dynamic token grants in the first slice.
- Do not claim endpoint-scoped static credential exposure when OpenShell static placeholders are effectively scoped to the attached provider and sandbox policy.
- Do not let workers request arbitrary vault references by name at runtime.
- Do not preserve compatibility with the existing hard-coded GitHub and Codex resolver paths once the generic declarations replace them.

## Background

`docs/specs/20260703-vault_secret_injection.md` already defines `VaultReference`, `VaultGrant`, `VaultInjectionPlan`, `VaultInjectionReceipt`, and `VaultUse`.

`docs/specs/20260703-openshell_mechanism_internalization.md` already adopts OpenShell Providers v2 as the first enforcement backend for sandbox-provider credential injection.

The public declaration name is intentionally backend-neutral because future sandbox backends may provide equivalent provider or proxy credential injection without being OpenShell.

`docs/specs/20260616-agent_environment_package.md` owns the resolved AEP envelope and cross-boundary invariants passed to worker governance backends; this specification owns the credential declarations projected into that envelope.

The implementation currently has narrow credential paths with fixed ids such as `vault_github_read`, `grant_github_read`, `vault_codex_auth_json`, and `grant_codex_auth_json`.

Those fixed ids are useful proof points, but they are not a scalable product contract.

The missing piece is a generic declaration shape that can describe credential access for a worker-supplied CLI without adding a separate secret flow.

## Decision

OpenKit will add generic worker credential access declarations to the NanoCore worker package resolution path.

The first supported declaration visibilities are:

- `sandbox-provider`
- `runtime-file`
- `runtime-env`

`sandbox-provider` is the default for HTTP API credentials when the worker can read a placeholder from an environment variable and put it in an HTTP header, query parameter, or URL path.

`runtime-file` is the fallback for tools that require a credential file in the sandbox.

`runtime-env` is the last fallback for tools that require the actual secret value in a process environment variable.

Every resolved declaration MUST reference a `VaultGrant`, not a raw `VaultReference`. The authored reusable-requirement and Server-only direct-grant forms are owned by `docs/specs/20260703-agent_manifest_aep_resolution.md` and are not redefined here.

The grant owns authorization and lifetime, while the reference owns the stable secret identity and backend material.

NanoCore MUST resolve declarations before backend materialization.

Workers MUST NOT call NanoCore or the vault backend at runtime to fetch arbitrary secrets.

## Contract / Expected Behavior

### Resolved Declaration Shape

The Agent Manifest owner defines the two authored requirement forms and the exact Workspace binding. This specification begins after that composition and owns the AEP's resolved worker credential declaration list. Every resolved entry carries both the authored declaration `id` and its stable `requirementId` when one exists, plus the exact resolved `vaultGrantId`:

The implementation may place this under an AEP `credentials` section or under an OpenKit extension namespace, but the contract must preserve these fields:

```json
{
  "id": "foo_api",
  "requirementId": "github-token",
  "vaultGrantId": "grant_foo_api",
  "visibility": "sandbox-provider",
  "provider": {
    "instanceId": "provider_foo_api",
    "type": "generic",
    "credentialKey": "FOO_API_KEY",
    "profileId": "okp-local-foo-api-v1"
  }
}
```

Runtime-file declarations use `targetPath` instead of `provider`.

```json
{
  "id": "bar_config",
  "requirementId": "bar-config",
  "vaultGrantId": "grant_bar_config",
  "visibility": "runtime-file",
  "targetPath": "/sandbox/.config/bar/credentials.json"
}
```

Runtime-env declarations use `targetEnvVarName`.

```json
{
  "id": "legacy_cli_key",
  "requirementId": "legacy-cli-key",
  "vaultGrantId": "grant_legacy_cli_key",
  "visibility": "runtime-env",
  "targetEnvVarName": "LEGACY_API_KEY"
}
```

All declaration ids, requirement ids, Provider instance ids, profile ids, target paths, and environment variable names are non-secret.

The declaration MUST NOT include `apiKey`, `token`, `password`, `clientSecret`, `secret`, authorization headers, raw credential file contents, or inline secret values.

### Shared Resolution Rules

NanoCore MUST compose each Workspace binding before validating the resolved declaration and before worker package materialization. A missing, duplicate, wrong-Agent, wrong-Workspace, wrong-scope, inactive, expired, revoked, or target-incompatible required binding fails readiness before a Vault resolution or backend effect. An optional unbound requirement remains absent and is recorded as unavailable without inventing a grant.

Validation MUST require an active `VaultGrant`, an active target `VaultReference`, matching owner scope and reference identity, exact current-package matches for every non-null grant `userId`, `workspaceId`, `targetAgentId`, and `targetAgentSessionId`, unexpired grant lifetime, and an allowed injection path that matches the requested declaration visibility.

A nullable grant identity or target field means that the grant adds no constraint for that dimension; it does not act as inferred identity, wildcard authority, or a bypass for the remaining checks. A non-null `targetCapabilityId` requires the exact active callable capability route in the current AEP. Backend `requiredCapabilities` and static Skill or MCP supply ids do not satisfy that proof, so the current disabled AEP capability plane MUST reject every capability-targeted credential grant before durable injection records, vault resolution, or backend-private sink effects.

Validation MUST fail closed when the selected backend cannot enforce the requested visibility.

Validation MUST reject duplicate declaration or requirement ids, duplicate Workspace bindings, duplicate target environment variables, duplicate target paths, and conflicting Provider instance ids within one package.

NanoCore MUST create one `VaultInjectionPlan` before resolution, one `VaultUse` record for the resolution outcome, and one `VaultInjectionReceipt` only after backend-private materialization completes successfully.

NanoCore MUST record failed vault resolution attempts through the audited backend wrapper when the failure occurs after grant lookup.

NanoCore MUST pass resolved secret material only through backend-private materialization context.

NanoCore MUST keep AEP snapshots and product-safe materialization records redacted.

### Sandbox Provider Visibility

`sandbox-provider` declarations map to the existing vault spec visibility class `backend-provider`.

The selected sandbox backend MUST receive provider credential material only through backend-private provider credential context.

The backend MUST create or update the provider instance before sandbox creation or before dynamic provider attach.

The backend MUST attach the provider instance to the sandbox.

Replacing the value behind an already attached OpenShell sandbox-provider credential uses the backend's proved dynamic replacement path and becomes effective without restarting the Sandbox or native Agent process. Adding a new provider declaration that the running Integration did not materialize follows ordinary post-Turn process staleness and resume unless the backend proves an in-place attach for that exact declaration.

The worker process should receive only the sandbox-provider placeholder value for the declared credential key.

The worker consumes the credential by passing the placeholder in a supported HTTP request location.

Supported request locations are header value, Basic auth header value, query parameter value, and URL path segment, matching the selected sandbox backend's provider mechanism.

The proxy resolves the placeholder to the real credential at request forwarding time.

NanoCore MUST NOT claim endpoint-scoped static credential exposure for this visibility.

Endpoint and binary rules contribute to sandbox policy, but static placeholder exposure remains sandbox-times-provider plus policy enforcement until dynamic token grants are adopted.

OpenShell profile and policy artifacts remain derived backend artifacts, not product records.

The first implementation SHOULD support built-in OpenShell provider types and generic provider instances through the OpenShell adapter.

Custom provider profile import and update remain future work.

### Runtime File Visibility

`runtime-file` declarations map to the existing vault spec visibility class `runtime-file`.

The selected backend MUST upload a backend-private temporary file to the declared absolute sandbox target path.

The temporary host file MUST be outside normal workspace storage and SHOULD use owner-only file permissions before upload.

A runtime-file declaration MUST not target paths outside the sandbox namespace accepted by the backend.

Runtime-file materialization MUST override any legacy host-file credential upload for the same target path.

Revocation of an already-running runtime-file credential MUST mark affected receipts and sessions stale when the backend cannot remove or mutate the running process-visible file safely.

Adding or changing a runtime-file value never rewrites the active process file view unless the selected runtime and backend prove safe in-place replacement. The value enters a later AEP; the current per-Turn Codex path reads it when the next child starts and resumes the same AgentSession and native conversation through its existing private handle. An adapter that retains a native process between Turns must refuse reuse until its accepted replacement behavior completes; no replacement Thread or product-visible restart action is created.

### Runtime Environment Visibility

`runtime-env` declarations map to the existing vault spec visibility class `runtime-env`.

The selected backend MUST merge the resolved secret value into the sandbox process environment under the declared target environment variable.

This visibility is worker-visible and MUST require explicit grant permission for `runtime-env`.

Runtime-env declarations MUST be treated as higher risk than sandbox-provider and runtime-file declarations.

Runtime-env values MUST NOT appear in AEP snapshots, sandbox summaries, product logs, command summaries, transcripts, or diagnostics.

Revocation of an already-running runtime-env credential MUST mark affected receipts and sessions stale because process environments cannot be safely mutated in place.

Adding or changing a runtime-env value never rewrites a running process environment. It enters a later AEP and therefore the next per-Turn Codex child; any adapter that retains a native process between Turns must refuse reuse until its accepted post-Turn replacement behavior completes.

### Worker Consumption Model

Workers consume concrete runtime affordances, not vault records.

For sandbox-provider declarations, the worker sees a provider-supplied placeholder environment variable and uses it through an HTTP client or CLI.

For runtime-file declarations, the worker sees a sandbox-local file.

For runtime-env declarations, the worker sees a real environment variable.

In all cases, `VaultReference`, `VaultGrant`, `VaultInjectionPlan`, `VaultInjectionReceipt`, and `VaultUse` remain Core control-plane records.

### Public Surface Rules

App API, end-user CLI, Web, exported package snapshots, and diagnostic readback MAY expose declaration id, visibility, grant id, redacted reference id, target path, target environment variable name, provider instance id, provider type, plan id, receipt id, status, revocation status, and audit event id.

They MUST NOT expose secret values, provider placeholder values, authorization headers, raw credential file contents, host temporary paths, raw backend provider handles, or unrestricted OpenShell provider output.

### Failure Semantics

Worker launch MUST fail before sandbox creation when a required declaration cannot be resolved.

Failure responses and diagnostics MUST use stable non-secret error codes.

Representative error codes include `credential_declaration_invalid`, `vault_grant_not_found`, `vault_grant_inactive`, `vault_grant_expired`, `vault_reference_inactive`, `credential_visibility_not_allowed`, `backend_credential_visibility_unsupported`, `vault_locked`, and `credential_materialization_failed`.

When one declaration fails, NanoCore MUST NOT partially launch the worker with the remaining declarations.

## Proposed Design

### Schema

Add a worker credential declaration schema in `packages/config-schema`.

The first schema should be small and strict.

It should use a discriminated union on `visibility`.

`sandbox-provider` requires provider metadata.

`runtime-file` requires `targetPath`.

`runtime-env` requires `targetEnvVarName`.

The schema should reject secret-shaped inline fields through the existing AEP raw-secret guard.

### Resolver

Add one shared NanoCore resolver that accepts declarations, package lineage, AgentSession id, Core DB, vault backend, and backend-private sinks.

The resolver should replace the fixed GitHub MCP provider resolver and the fixed Codex auth runtime-file resolver.

The resolver uses the accepted sequence: plan, audited vault resolution with `VaultUse`, successful backend-private materialization sink, then receipt.

The resolver should use the same `VaultUseAuditedBackend` wrapper as existing V1 flows.

### Backend Context

Extend `WorkerGovernanceMaterializationContext` with a small runtime-env credential list.

Keep existing provider credential and runtime-file credential lists.

OpenShell materialization should upsert providers, create runtime-file uploads, and merge runtime-env values into sandbox environment.

The materialization record should continue to show only redacted summaries.

### Sandbox Provider Adapter

The first sandbox-provider adapter should support OpenShell built-in provider types and `generic`.

The declaration should provide `provider.type`, `provider.instanceId`, and `provider.credentialKey`.

Generated profile support should remain limited to current snapshot-backed paths until a second implementation slice needs custom profile import or update.

Provider-derived network policy should remain under the OpenShell mechanism internalization rules.

### Replacement Of Hard-Coded Paths

The GitHub MCP path should become a credential declaration with sandbox-provider visibility.

The Codex auth JSON path should become a credential declaration with runtime-file visibility.

The old fixed-id helper functions should be removed in the same change once equivalent declarations are generated from the current catalog/bootstrap inputs.

Because OpenKit is still internal, no compatibility reader for the old hard-coded helper path is required.

## Current Implementation Projection

The current implementation is partial.

`packages/config-schema/src/agent-environment.ts` accepts `sandbox-provider`, `runtime-file`, and `runtime-env` declarations.

`apps/nanocore/src/runtime/agent-environment.ts` generates and resolves `sandbox-provider` declarations for provider-backed credentials.

The manifest and resolver accept reusable `requirementId` declarations and compose them with per-Workspace `credentialBindings`. Required missing bindings fail setup, optional missing bindings are omitted, and the same manifest can resolve to different Workspace-scoped VaultGrants without exposing the choice to the worker.

The shared launch-time declaration resolver validates every non-null durable grant user, workspace, agent, session, and capability constraint against the current package context before it creates injection records or resolves secret material; it still rejects a non-null `targetCapabilityId` because that resolver is not a capability sink. The selected MCP Gateway owns its separate per-call current-authority check and accepts only `mcp`, `mcp.list_tools`, or `mcp.call_tool` targets matching the exact operation.

The shared worker resolver creates the plan, performs audited Vault resolution, completes the backend-private sink, and only then persists the receipt. Backend resolution failure or sink failure may leave redacted plan and `VaultUse` evidence but creates no receipt.

The durable GitHub MCP and Codex auth JSON materialization paths have already moved to the shared declaration resolver.

`apps/nanocore/src/runtime/worker-governance-backend.ts` defines backend-private runtime-file uploads and runtime-env materialization, and the production worker-turn path carries those resolved arrays through NanoHost to the exact OpenShell effect. It still rejects backend-private Provider credentials before any OpenShell Provider or Sandbox effect and does not advertise `provider-attachments`; only the exact internally generated trusted-inference Provider remains. Runtime-file and runtime-env receipts therefore prove sink completion, while sandbox-provider receipt support remains unavailable rather than overstated.

`apps/nanocore/src/vault/vault-use-audited-backend.ts` already records vault resolve success and typed failure without storing secret material.

`packages/config-schema/src/agent-environment.ts` already has AEP vault references, grants, provider attachments, raw-secret guards, backend capabilities, and redaction helpers.

The public declaration visibility is `sandbox-provider`; it maps to the durable vault injection visibility `backend-provider`. The declaration and durable records do not authorize current OpenShell materialization until an accepted AEP design carries the exact provider endpoint and binary policy needed to prove policy equality.

## Alternatives Considered

### Make Runtime Env The Default

Rejected.

Runtime env is easy, but it exposes the real secret to the worker process and every child process that inherits the environment.

It should remain a fallback for tools that cannot use sandbox-provider or runtime-file.

### Use Runtime File For All CLI Credentials

Rejected.

Some tools need files, but many HTTP CLIs can use environment variables in headers or query parameters.

For those tools, sandbox-provider keeps the real credential out of the worker process and adds proxy-level enforcement and fail-closed behavior.

### Build A NanoCore Credential Proxy First

Deferred.

NanoCore gateway-mediated upstream calls are valuable for capability APIs, but they require OpenKit-owned upstream adapters and do not cover generic worker-installed CLIs as directly as sandbox-provider.

### Keep Adding Hard-Coded Credential Paths

Rejected.

Hard-coded paths prove the model but create duplicate grant validation, plan creation, receipt creation, and backend materialization code.

The next step should be one shared declaration resolver.

## Consequences

- The common worker CLI credential path becomes list-driven and reviewable.
- sandbox-provider becomes the default implementation for HTTP API credentials.
- Runtime-file and runtime-env remain available without pretending they are as safe as sandbox-provider.
- AEP snapshots can explain what credential access was prepared without exposing values.
- Existing GitHub and Codex credential paths can be simplified by deleting special-case code.
- Custom provider profiles, refresh delegation, and dynamic token grants stay out of the first implementation.

## Rollout / Migration Plan

1. Add the credential declaration schema in `packages/config-schema` with tests.
2. Add a shared NanoCore credential declaration resolver with tests around grant validation, plan creation, receipt creation, audited vault resolution, and redaction.
3. Extend worker materialization context and OpenShell backend support for generic runtime-env credentials.
4. Convert the existing GitHub MCP credential path to a generated `sandbox-provider` declaration.
5. Convert the existing Codex auth JSON path to a generated `runtime-file` declaration.
6. Add generic runtime-file and runtime-env tests with non-GitHub, non-Codex fixture credentials.
7. Add generic sandbox-provider tests using a built-in or generic OpenShell provider fixture.
8. Update App API, Core Client, end-user operation-catalog, and readback surfaces only where existing redacted AEP or vault read models need to display generic declaration metadata.
9. Remove replaced hard-coded helper paths in the same change.
10. Add reusable requirement declarations, Workspace grant bindings, strict scope validation, and focused two-Workspace fixtures using one manifest with different grants.
11. Carry the resolved backend-private credential arrays through the production NanoHost materialization seam and prove real sink effects before writing a success receipt.
12. Implement and prove dynamic existing-provider replacement, next-Turn activation of newly added or process-static credentials on the current per-Turn runtime, and refusal or accepted post-Turn replacement for any implemented adapter that retains a native process between Turns.

## Testing Strategy / Acceptance Criteria

- L1 schema tests cover valid declarations, missing target fields, duplicate ids, invalid visibility, secret-shaped inline fields, invalid target paths, and invalid environment variable names.
- L1 resolver tests prove invalid grants fail before materialization, expired grants fail closed, inactive references fail closed, disallowed visibility fails closed, and successful declarations create plan, receipt, and vault-use records.
- One table-driven L1 resolver test varies grant user, workspace, agent, and capability constraints and proves every mismatch leaves backend-private sinks, injection plans, injection receipts, and vault-use records empty.
- L1 redaction tests prove secret values, provider placeholder values, host temporary paths, and raw credential file contents are absent from AEP snapshots and product-safe materialization records.
- L1 OpenShell backend tests prove provider credentials are upserted before sandbox creation, runtime files are uploaded through backend-private temporary files, runtime env values are merged only into sandbox env, and none of those values appear in returned materialization summaries.
- L2 contract tests prove the generated schemas, OpenAPI, and end-user CLI projections expose only non-secret metadata when those surfaces are updated.
- L3 NanoCore black-box tests prove a worker package can launch with one generic sandbox-provider credential and one generic runtime-file credential through a deterministic OpenShell stub.
- L3 composition tests prove the same reusable Agent Manifest requirement resolves to different Workspace-scope grants in two Workspaces, fails before effects when one required binding is absent, and exposes the same non-secret worker target in both cases.
- L3 lifecycle tests prove an existing OpenShell Provider value can be replaced in place when the backend supports it, while a newly added runtime-file or runtime-env credential waits for the active Turn barrier, replaces only the native process, and resumes the same Thread and AgentSession.
- L6 story acceptance can later prove a real OpenShell sandbox uses a provider placeholder to call an external HTTP API while NanoCore records the plan, receipt, vault-use, and redacted evidence chain.

Acceptance requires that GitHub MCP and Codex auth JSON no longer need bespoke credential material resolver branches, reusable requirements bind independently per Workspace, successful receipts follow actual backend sink completion, documented replacement behavior is observed, and all current secret-leak redaction tests continue to pass.

## Risks & Mitigations

- Risk: Product code treats sandbox-provider as endpoint-scoped static credential injection.
  Mitigation: The declaration and receipt must record `backend-provider` semantics honestly, and tests must reject endpoint-scoped claims for static placeholders.
- Risk: Runtime-env becomes the convenient default.
  Mitigation: Runtime-env requires explicit grant permission and product-safe diagnostics should label it worker-visible.
- Risk: Generic declarations duplicate provider access shape ownership from OpenShell mechanism internalization.
  Mitigation: This spec owns declaration plumbing only; OpenShell profile and policy derivation remain owned by `docs/specs/20260703-openshell_mechanism_internalization.md`.
- Risk: Custom provider support grows before a second real use case.
  Mitigation: First implementation supports built-in and generic provider types only.
- Risk: Secret values leak through tests, snapshots, logs, or materialization summaries.
  Mitigation: Add focused redaction tests at schema, resolver, backend, and App API readback boundaries.

## Open Questions

None.

## Deferred / Future Work

- Custom OpenShell provider profile import and update.
- Gateway-managed refresh metadata and refresh evidence import for generic declarations.
- Dynamic token grants for endpoint-scoped credential placement.
- NanoCore gateway-mediated upstream calls for capability APIs that should not expose even placeholder credentials to workers.
- Product UI for creating, approving, and reviewing reusable credential declarations.
- Non-OpenShell backend equivalence for sandbox-provider declarations.

## Links

- `docs/specs/20260703-vault_secret_injection.md`
- `docs/specs/20260704-vault_backend_implementation.md`
- `docs/specs/20260703-openshell_mechanism_internalization.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260703-policy_enforcement_mapping.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260709-worker_sandbox_freedom_policy.md`
- NVIDIA OpenShell Providers: `https://docs.nvidia.com/openshell/latest/sandboxes/manage-providers`
- NVIDIA OpenShell Providers v2: `https://docs.nvidia.com/openshell/latest/sandboxes/providers-v2`
