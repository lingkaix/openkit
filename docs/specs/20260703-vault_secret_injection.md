# Vault And Secret Injection

Status: Accepted
Implementation: Implemented

## Summary

This spec defines the target vault and secret injection model for NanoCore and governed workers.

The clean target is simple: normal config, manifests, item logs, knowledge, artifacts, and worker-visible diagnostics carry secret references and grants only. Secret values live in vault backends or delegated provider homes, and every injection path is explicit, scoped, revocable, and audited.

## Owns

- Vault reference, grant, injection plan, injection receipt, and vault-use record requirements.
- Secret injection visibility categories for gateway, backend, sidecar, and worker runtime paths.
- How provider credentials, MCP credentials, external API credentials, repository credentials, runtime account slots, and explicit credential files are represented without storing secret values in normal records.
- The contract between vault references, Agent Environment Package snapshots, Agent Capability calls, worker runtime materialization, and audit events.
- Revocation and stale-session semantics for injected credentials.

## Does Not Own

- Concrete encrypted vault backend implementation.
- Permission policy itself.
- Sandbox containment rules beyond credential visibility.
- Provider-native auth payload formats.
- Agent Capability routing unrelated to credential use.
- Workspace export packaging beyond secret-reference behavior.

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

- Do not choose a final encrypted vault implementation.
- Do not store plaintext secret values in SQLite or workspace files.
- Do not let workers request arbitrary secrets by name.
- Do not expose raw secret material through App API, MCP, Web UI, logs, or diagnostics.
- Do not treat environment-variable shortcuts as the long-term vault model.

## Concepts

`VaultReference` is a non-secret stable reference to secret material.

`VaultGrant` records that a subject, session, capability, or provider path may use a vault reference.

`InjectionPlan` records how a granted secret may be made available.

`InjectionReceipt` records that an injection happened.

`VaultUse` is the audit-linked record of secret-reference use.

`SecretMaterial` is the actual credential value. It never belongs in normal OpenKit records.

## Ownership Scopes

Vault references may be:

- server-scoped
- user-scoped
- workspace-scoped
- organization-scoped in a future shared deployment

The scope determines who owns the reference metadata and which policy domain must authorize use.

Cross-scope use must be explicit. For example, a workspace may use a server-owned provider credential only through a server-approved provider instance and a workspace-visible grant.

## Secret Backends

Supported backend categories:

- environment-backed local development secret
- local encrypted vault
- OS keychain
- external secret manager
- delegated provider home
- OAuth account slot
- runtime-issued short-lived credential

Delegated provider homes are allowed when another tool owns its own credential storage. The OpenAI Codex account slot model is an example: OpenKit stores sanitized metadata and uses an isolated tool home, while the external tool owns its auth material.

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
- target agent id or agent session id when applicable
- target capability id when applicable
- allowed injection paths
- lifetime
- policy decision id
- approval id when required
- status
- created and expires timestamps

Grant lifetimes:

- `capability-call`
- `turn`
- `agent-session`
- `workspace`
- `server`

Longer lifetimes require stronger policy.

## Current Implementation Projection

The V1 implementation is in place:

- `packages/config-schema/src/agent-environment.ts` defines AEP vault references and grants. `VaultReference.kind` currently supports `secret-ref`, `runtime-ref`, and `grant-ref`. `VaultGrant.scope` currently supports `agent-session`, `turn`, and `workspace`.
- `apps/nanocore/src/vault/vault-references.ts` stores first-slice durable non-secret `VaultReference` metadata in `core.sqlite` through the `vault_references` table. This stores reference id, owner scope, display name, secret kind, backend kind, redacted backend locator, status, current version, and timestamps; it does not store secret material.
- `apps/nanocore/src/vault/vault-grants.ts` stores first-slice durable non-secret `VaultGrant` metadata in `core.sqlite` through the `vault_grants` table. This stores grant id, vault reference id, owner scope, target workspace/user ids, subject summary, target agent/session/capability ids, allowed injection path classes, lifetime, policy decision id, approval id, status, and timestamps; it does not store secret material or injection receipts.
- `apps/nanocore/src/injection-plans.ts` stores first-slice durable non-secret `InjectionPlan` metadata in `core.sqlite` through the `injection_plans` table. This stores plan id, grant id, package snapshot id, capability id, injection visibility, runtime target path or environment variable name when applicable, expiration behavior, revocation behavior, redaction rule, backend capability requirement, status, and timestamp; it does not store secret material or injection receipts.
- `apps/nanocore/src/injection-receipts.ts` stores first-slice durable non-secret `InjectionReceipt` metadata in `core.sqlite` through the `injection_receipts` table. This stores receipt id, plan id, grant id, agent session id, capability call id, redacted backend summary, injected/expires timestamps, revocation status, and audit event id; it does not store secret material or backend secret locators.
- Workspace-scoped `VaultGrant`, `InjectionPlan`, and `InjectionReceipt` metadata are exposed through `GET /api/app/workspaces/:workspaceId/vault/grants`, `GET /api/app/workspaces/:workspaceId/vault/injection-plans`, and `GET /api/app/workspaces/:workspaceId/vault/injection-receipts`, plus matching `@openkit/core-client` methods, MCP read-only tools, and MCP resources. The readback uses existing workspace export filters and returns non-secret metadata only.
- `apps/nanocore/src/vault/vault-use-records.ts` stores first-slice durable non-secret `VaultUse` metadata through the `vault_use_records` table. Server-scope rows home in `core.sqlite`; workspace-scope rows home in `workspace.sqlite`. The record stores use id, owner scope, workspace id when applicable, vault reference id, material version when known, backend kind, resolving path, linked grant/plan/receipt ids, actor ids, outcome, failure code, audit event id, and timestamp; it does not store secret material or backend secret locators, and it does not require the referenced vault row to exist so failed resolutions can be recorded. Server-scoped rows are exposed through `GET /api/app/vault/use-records`, `client.app.listServerVaultUseRecords`, the read-only MCP tool `openkit.read_vault_use_records`, and the resource `openkit://vault/use-records`; workspace-scoped rows are exposed through `GET /api/app/workspaces/:workspaceId/vault/use-records`, `client.app.listWorkspaceVaultUseRecords`, the read-only MCP tool `openkit.read_workspace_vault_use_records`, and the resource `openkit://workspaces/{workspaceId}/vault/use-records`. Authorization for both surfaces follows the owning matrix in `docs/specs/20260704-vault_backend_implementation.md`.
- The AEP schema recursively rejects raw secret-bearing fields such as `apiKey`, `clientSecret`, `secret`, `token`, and `password`.
- Provider profile and server config schemas reject inline provider secrets and require `secretRef` for configured credentials.
- Provider credential resolution supports `env:` secret references for first-slice local and server deployment, and NanoCore now resolves provider `secretRef: vault://<referenceId>` through the server vault backend with a non-secret `VaultUse` row on resolve success or typed failure. The OpenAI-compatible LLM Gateway routes, including `/v1/chat/completions`, use the same audited resolver for vault-backed provider credentials.
- Diagnostics and App API response schemas include raw-secret guards and redacted markers for secret references.
- Boot diagnostics now project the initial locked-vault state as degraded readiness and name `vault.read`, `vault.use`, and `secret.inject` as blocked operations until a concrete backend is unlocked.
- NanoCore now has an internal `VaultBackend` boundary with typed locked-backend failures, redacted backend health projection, owner-only raw key-file source validation, `0700` encrypted-file store directory enforcement in the data-root layout, an encrypted-file store helper that can seal/open caller-supplied material without storing plaintext, an unlocked encrypted-file backend first slice for `store`, `resolve`, `rotate`, `revoke`, and `listReferences` over encrypted entry files plus per-reference current-version, expiry, non-secret inventory, version-count, and revocation state, expired prior-version file destruction on failed expired resolve, revoked entry-file destruction, an `os-keychain` backend adapter with macOS Keychain, Linux Secret Service, and Windows Credential Manager implementations plus unavailable projections for platforms without native adapters yet, default local-mode `os-keychain` selection, default server-mode `encrypted-file` selection, configurable local-mode encrypted-file fallback through `server.jsonc`, server-admin-authorized vault status/unlock/lock, server VaultUse readback, and Codex auth JSON bootstrap per `docs/specs/20260704-vault_backend_implementation.md`, with server-scope admin audit and failed-unlock rate limiting, `VaultUse` audited backend wrapper that records resolve success and typed failure without storing secret material, emits linked `AuditEvent` rows for server- and workspace-scoped use, rejects implicit cross-scope resolution, and allows explicit grant-backed cross-scope use, and first persistent revocation cascade helpers that revoke grants and plans while marking active injection receipts as `stale-session`. Future credential-use paths can reuse this V1 boundary and add their own grant and injection wiring.
- OpenShell worker materialization no longer uploads host Codex auth files directly. GitHub MCP package resolution now has a first durable backend-handle path: when Core DB and an unlocked vault backend are available, NanoCore derives the AEP provider attachment from the durable `VaultGrant`, projects grant expiry into the AEP grant and injection receipt, creates an `InjectionPlan`, creates an `InjectionReceipt`, records a linked non-secret `VaultUse` row, passes credential material only through backend-private materialization context, upserts the OpenShell provider through env lookup, attaches the provider by id during sandbox creation, detaches attached providers from the OpenShell sandbox during backend teardown, and can detach providers from active materialized OpenShell sandboxes by matching revoked vault grant ids against AEP provider attachments. Codex auth JSON now has a durable runtime-file path: `grant_codex_auth_json` and `vault_codex_auth_json` create a runtime-file `InjectionPlan`, `InjectionReceipt`, linked non-secret `VaultUse`, and backend-private upload to `/sandbox/.codex/auth.json` without putting the credential value in the AEP snapshot or public materialization record. `POST /api/app/vault/bootstrap/codex-auth-json` can create that server-owned reference and grant from base64 request content without echoing the submitted auth JSON. Workspace vault references imported from portable exports are publicly discoverable through redacted App API, Core Client, Web, and MCP read surfaces before being rebound through base64 request-only material. Host-side Git push now has a gateway-only path: linked repository Git config stores only `git.vaultGrantRef`, the approved push route resolves that grant after policy/preflight checks, records an `InjectionPlan`, `InjectionReceipt`, workspace-scoped `VaultUse`, and linked audit event, then passes GitHub token material only as child-process env to the fixed Git push command. If that gateway-only material cannot be resolved, the Git push executor records a redacted `auth-failed` terminal `GitPushRecord` and does not invoke the child process. The remaining host-file upload configuration is limited to non-secret Codex `config.toml`.

Durable grant policy engine expansion, cross-scope grant review beyond metadata identity validation, complete OpenShell provider attach evidence normalization beyond the first redacted `provider get` summary, and audited backend resolution wiring for future credential-use classes remain deferred future work rather than V1 blockers.

The current fields are implementation schema choices for the Agent Environment Package slice. They do not replace the conceptual ownership scopes, grant lifetimes, injection plans, receipts, and audit-linked vault-use records defined by this spec.

## Injection Visibility

Injection paths must declare visibility:

- `gateway-only`: secret is used by NanoCore and never exposed to worker runtime.
- `backend-provider`: backend attaches the credential to a provider without exposing it to the process where possible.
- `sidecar-only`: sidecar can use the secret, but worker child process cannot.
- `runtime-env`: worker process sees an environment variable.
- `runtime-file`: worker process sees a mounted credential file.
- `runtime-token`: worker process receives a short-lived token.
- `external-handle`: worker receives a handle that an external system validates.

The preferred path is `gateway-only`. Worker-visible paths require stronger policy and audit.

## Injection Plan

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

## Injection Receipt

An injection receipt should carry:

- receipt id
- plan id
- grant id
- agent session id or capability call id
- backend summary
- injected at timestamp
- expires at timestamp
- revocation status
- audit event id

Receipts should be persisted as vault use records and audit events.

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

Provider config uses `secretRef`, `vaultRef`, or `grantRef` fields.

Provider instances must never contain:

- API keys
- bearer tokens
- refresh tokens
- authorization headers
- raw OAuth account ids
- raw auth files

When provider routing needs a credential, the gateway or backend resolves the grant and records a receipt.

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
- Inline provider secrets are not allowed in provider profiles or server config.
- `env:` secret references and delegated provider homes are acceptable first-slice local and server projections, but they are not the final vault backend model. Provider `secretRef: vault://<referenceId>` is the first implemented vault-backed provider credential shape.
- Workspace exports may include vault reference metadata, grant metadata, and redacted locators, but must not export secret material. Imports must require re-binding to local vault references.
- Workspace-lifetime grants are allowed only through explicit policy and should be reserved for stable gateway or provider paths. Worker-visible credential paths should default to shorter lifetimes.
- Worker-visible secret material requires an explicit policy decision and should require a human approval gate unless a workspace policy has preauthorized the exact low-risk path.
- Explicit OpenShell Codex auth file uploads have been removed. The durable `vault_codex_auth_json` path produces injection plans, receipts, and audit records for Codex auth JSON.
- Injection receipts are audit-first. Item-visible projection is limited to non-secret status and stale/degraded session explanations.
- The first concrete encrypted local vault backend should be chosen in a dedicated implementation spec. This spec owns the adapter contract, record requirements, visibility classes, and invariants, not the backend product choice.

## Deferred / Future Work

- Extend audited vault-use wiring to remaining MCP routing and any future runtime-file credential classes.
- Add grant approval, revocation, stale-session, and session-recycle behavior.
- Define workspace export and import re-binding workflows for vault references.

## Testing Strategy

- Schema tests for references, grants, plans, and receipts.
- Redaction tests proving secrets do not appear in config, AEP snapshots, item logs, audit summaries, or diagnostics.
- Gateway-only provider tests.
- Runtime-env injection tests with explicit policy approval.
- Revocation tests that mark affected sessions stale.
- MCP credential materialization tests.
- Cross-scope grant denial tests.

## Risks & Mitigations

- Risk: Local env shortcuts become de facto production vaults. Mitigation: label env-backed secrets as development only unless deployment policy explicitly allows them.
- Risk: Workers leak runtime-env secrets. Mitigation: prefer gateway-only and short-lived runtime tokens.
- Risk: OAuth account slots expose tool-private state. Mitigation: store only sanitized metadata and isolate delegated homes.
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
