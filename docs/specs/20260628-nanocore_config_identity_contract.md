# NanoCore Config And Identity Contract

Status: Accepted
Implementation: Partial

## Summary

This spec consolidates the current NanoCore identity, auth, runtime config, server config, and data-layout guidance.

OpenKit treats NanoCore as the kernel source of truth. Local mode remains a single-user development path. Server mode uses Better Auth-backed session behavior for protected product APIs and is the foundation for future remote and multi-user deployments.

Historical identity and config specs have been moved under `docs/specs/superseded/nanocore-config-identity/` and remain supporting detail.

## Owns

- The current NanoCore local-mode and server-mode identity contract.
- The relationship between Better Auth implementation details and OpenKit identity concepts.
- Runtime config loading, validation, reload posture, and public config-editing boundaries.
- Server config and data-root behavior at the implementation-contract level.
- Public channel server-mode credential boundaries consumed by the Agent Skill Interface.
- The replacement path for historical identity, auth, config, and data-layout specs.

## Does Not Own

- Canonical identity concepts already owned by `docs/core/identity.md`.
- Authorization policy, permission decisions, roles, or policy enforcement.
- Vault secret storage, secret injection, or credential material lifecycle.
- Complete physical storage layout, database schema, backup policy, or migration plan.
- App API route design, Web UI editing UX, or Agent Skill Interface operation design.
- Agent setup, AEP resolution, worker scheduling, runtime placement, or workspace synchronization.

## Core References

- `docs/core/identity.md`
- `docs/core/storage.md`
- `docs/core/permissions.md`
- `docs/core/vault.md`
- `docs/deployment.md`

## Goals

- Keep local mode, server mode, auth middleware, runtime config, and data-root behavior understandable from one current entry point.
- Preserve Better Auth as the current server-mode auth implementation.
- Keep bundled CLI server-mode access on public NanoCore token-auth contracts.
- Keep runtime config reload and config UI behavior aligned with NanoCore public APIs.
- Make remaining config, auth, data-root, and identity gaps explicit without treating historical specs as active guidance.

## Non-goals

- Do not preserve historical internal config paths or old environment names as supported behavior.
- Do not treat historical local identity shortcuts as production security.
- Do not expose secrets, cookies, auth files, provider tokens, raw config files, or private data-root paths through CLI result envelopes or public product records.

## Current Contract

Local mode is optimized for single-user development and dogfooding. It can use simplified identity assumptions, but product surfaces should still carry explicit workspace and user-facing state where the App API requires it.

Server mode is the path for authenticated product operation. It uses Better Auth-backed session behavior today, and protected product APIs should enforce the server-mode auth contract.

Server-mode authentication establishes the request actor. It does not by itself prove workspace membership, role authority, policy grants, or permission approval. Those checks belong to identity membership records, permission policy, and the policy enforcement mapping.

Runtime config is managed through NanoCore-owned routes and schemas. The Agent Skill Interface may expose product-level CLI operations for listing, validating, updating, and reloading runtime config, but it must not become a raw file editor or secret browser.

The authored schema accepts only fields with a current runtime owner. Startup networking owns `server.bind`, `server.publicBaseUrl`, and `server.cors.origins`; Better Auth owns `auth.signup.enabled`; central defaults own the Core and Gateway provider/model selections; Gateway policy owns its enabled flag and provider allowlist. Environment variables may explicitly override deployment values. Unsupported proxy trust, configurable route/auth markers, duplicate Gateway defaults, unused workspace/agent defaults, data-root metadata, diagnostic toggles, the old duplicate feature-flag block, and a consumer-free server extension bag are rejected rather than silently accepted.

The bundled CLI server-mode contract uses the `OPENKIT_NANOCORE_TOKEN` explicit ephemeral override and persistent credential-storage rules owned by `docs/specs/20260704-remote_auth_credential_bootstrap.md`. Historical raw `OPENKIT_NANOCORE_COOKIE` and `OPENKIT_NANOCORE_AUTHORIZATION` passthrough remain removed and are not compatibility inputs. Token values are credential material and must not be printed, logged, persisted in change records, or exposed in artifacts.

## Current Implementation Projection

The NanoCore config and identity substrate satisfies the accepted V1 contract, while the accepted bundled CLI projection remains unimplemented:

- Better Auth is the current server-mode auth implementation.
- The Better Auth table layout may use provider-owned table names such as `session`. Core identity doctrine still names the conceptual record `AuthSession`; implementation table names must not redefine the product concept.
- Local mode resolves an implicit local user through `LOCAL_USER_ID` when no authenticated server-mode subject exists.
- `apps/nanocore/src/auth/middleware.ts` attaches actor context and enforces server-mode authentication for protected APIs.
- Server-mode bearer-token authentication, first-boot bootstrap, scoped token administration, and the reusable credential-storage substrate are implemented by `docs/specs/20260704-remote_auth_credential_bootstrap.md`; the accepted bundled CLI projection remains pending.
- The removal-only `mcp/` package currently reads `OPENKIT_NANOCORE_TOKEN` or the desktop credential store and ignores the removed raw `OPENKIT_NANOCORE_COOKIE` and `OPENKIT_NANOCORE_AUTHORIZATION` passthrough variables; this is parity evidence, not a continuing channel contract.
- `apps/nanocore/src/config/bind-host.ts` resolves host and port from explicit environment overrides, then the startup server config, then mode-safe defaults.
- Server mode constructs Better Auth explicitly from the startup config, requires a deployment-specific secret of at least 32 characters, applies `server.publicBaseUrl`, shares `server.cors.origins` with browser CORS, and enforces `auth.signup.enabled` through Better Auth's sign-up policy.
- `apps/nanocore/src/config/runtime-config.ts` loads provider registry, agent configs, agent manifests, workspace configs, gateway defaults, and runtime config status from the data root or supplied in-memory inputs.
- Server browser CORS admits only exact configured origins and returns `403 Forbidden` before route work for every rejected origin; local mode additionally permits exact loopback browser origins.
- Runtime config reload planning distinguishes hot-swappable, session-scoped, restart-required, and rejected changes.
- Provider registries and authored agent configuration are restart-required because production scheduler services capture those dependencies at startup; reload never claims that a newer snapshot has changed an already constructed dispatcher.
- Runtime config stale-session diagnostics expose typed `inspect`, `restart_session`, and `request_human` choices through the public diagnostics read model, and the App API and Core Client expose a restart action that retires the stale session record so the next worker launch uses the current runtime config version. The current MCP projection is removal-only, and the bundled CLI operation remains pending.
- `apps/nanocore/src/config/runtime-config-files.ts` owns safe runtime config file reads, writes, validation, schema lookup, optimistic revision checks, and path containment.
- Provider and agent config loaders reject unknown or unsafe fields, inline raw secret shapes, unsafe workspace paths, and unsupported runtime setup shapes.

The target data-root ownership layout is defined by `docs/specs/20260703-storage_layout_record_ownership.md`. That physical storage migration remains owned by the storage-layout spec, not by this config and identity contract.

## Deferred / Future Work

The following items remain outside this V1 contract:

- richer workspace roles and shared-tenancy permission policy beyond active membership
- deeper audit labels for non-auth policy and workflow records
- secret-slot and vault-backed config editing
- data-root migration and backup policy
- broader server deployment recovery and auth/session verification
- config diff preview, rollback, and restart-required warnings

## Resolved Decisions

- Local mode is for single-user development and must not be treated as the production security model.
- Server mode is the authenticated product path.
- Server-mode authentication is not workspace authorization; membership facts and permission decisions remain separate required checks.
- Better Auth is an implementation provider for auth sessions; it does not rename the OpenKit conceptual `AuthSession`.
- Runtime config editing must go through NanoCore-owned routes and schemas, not raw file browsing through the bundled CLI.
- NanoCore bearer tokens used by the bundled CLI or temporary legacy MCP projection are credential material and must not be printed, logged, persisted in documentation, or exposed in artifacts.
- Historical identity, auth, config, and data-layout specs are supporting detail, not active guidance.

## Reference Specs

The historical auth, identity, config, and data-layout specs have been moved under `docs/specs/superseded/nanocore-config-identity/`.

They remain useful for implementation background, but this spec and the core identity/storage docs are the current entry points.

## Links

- [Identity Model](../core/identity.md)
- [Storage Model](../core/storage.md)
- [Permissions Model](../core/permissions.md)
- [Vault Model](../core/vault.md)
- [OpenKit Agent Skill Interface](./20260713-openkit_agent_skill_interface.md)
