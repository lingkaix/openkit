---
status: Accepted
implementation: Partial
---
# NanoCore Config And Identity Contract

## Summary

This spec consolidates the current NanoCore identity, auth, runtime config, server config, and data-layout guidance.

OpenKit treats NanoCore as the kernel source of truth. Local mode remains a single-user development path. Server mode uses Better Auth-backed session behavior for protected product APIs and is the authenticated path for the accepted single-deployment multi-user Workspace model.

Historical identity and config specs have been moved under `docs/specs/superseded/nanocore-config-identity/` and remain supporting detail.

## Owns

- The current NanoCore local-mode and server-mode identity contract.
- The relationship between Better Auth implementation details and OpenKit identity concepts.
- Runtime config loading, validation, reload posture, and public config-editing boundaries.
- Server config and data-root behavior at the implementation-contract level.
- Public channel server-mode credential boundaries consumed by the Agent Skill Interface.
- The deployment configuration, validation, reload posture, and redacted diagnostics for exactly one configured NanoHost identity, NanoCore rendezvous endpoint, and non-secret NanoHost credential reference.
- The replacement path for historical identity, auth, config, and data-layout specs.

## Does Not Own

- Canonical identity concepts already owned by `docs/core/identity.md`.
- Authorization policy, permission decisions, roles, or policy enforcement.
- Vault secret storage, secret injection, or credential material lifecycle.
- Complete physical storage layout, database schema, backup policy, or migration plan.
- Workspace membership, invitation, role, owner-transfer, or user-lifecycle behavior.
- App API route design, Web UI editing UX, or Agent Skill Interface operation design.
- Agent setup, AEP resolution, worker scheduling, runtime placement, or workspace synchronization.
- Runtime Epoch lifecycle, OpenShell effects, transport replacement, route-family credentials, or sandbox-local Integration bindings.

## Core References

- `docs/core/identity.md`
- `docs/core/communication.md`
- `docs/core/storage.md`
- `docs/core/permissions.md`
- `docs/core/vault.md`

## Goals

- Keep local mode, server mode, auth middleware, runtime config, and data-root behavior understandable from one current entry point.
- Preserve Better Auth as the current server-mode auth implementation.
- Keep bundled CLI server-mode access on public NanoCore token-auth contracts.
- Keep runtime config reload and config UI behavior aligned with NanoCore public APIs.
- Keep the one configured NanoHost identity and rendezvous configuration explicit, secret-free, and separate from user, administrator, worker, and route credentials.
- Make remaining config, auth, data-root, and identity gaps explicit without treating historical specs as active guidance.

## Non-goals

- Do not preserve historical internal config paths or old environment names as supported behavior.
- Do not treat historical local identity shortcuts as production security.
- Do not expose secrets, cookies, auth files, provider tokens, raw config files, or private data-root paths through CLI result envelopes or public product records.
- Do not accept a Cell owner, Cell epoch, Cell helper, SSH lifecycle target, Gateway URL or forward, container-runtime endpoint, sandbox-direct NanoCore endpoint, or route token as target deployment configuration.

## Current Contract

Local mode is optimized for single-user development and dogfooding. Its implicit local human is a projection of the Core `User` record family with `kind = local`, not a separate identity type. Product surfaces should still carry explicit workspace and user-facing state where the App API requires it.

When NanoCore runs as a desktop-embedded Core, every Core endpoint MUST bind only to a loopback interface. `OPENKIT_BIND_HOST` and `server.bind.host` may select a loopback address, but neither is authority to widen that boundary; startup MUST reject any desktop-embedded configuration that resolves to a non-loopback address.

Server mode is the path for authenticated product operation. It uses Better Auth-backed session behavior today, and protected product APIs should enforce the server-mode auth contract.

For every protected route, the shared authentication middleware owns the failure for a missing, invalid, or disabled server-mode actor. It returns the strict `ApiError` envelope with HTTP `401`, code `core.auth.unauthenticated`, and fixed message `Authentication required.` before route-specific work. Route handlers must inherit this result and must not redefine, translate, or replace its code or message.

Server-mode authentication establishes the request actor. It does not by itself prove workspace membership, role authority, policy grants, or permission approval. Those checks belong to identity membership records, permission policy, and the policy enforcement mapping.

One server-mode deployment is one personal or small-team trust domain, not a legal tenant host. Better Auth owns authentication and session mechanics; NanoCore owns canonical users, Workspace relationships, authorization facts, and product policy.

Runtime config is managed through NanoCore-owned routes and schemas. The Agent Skill Interface may expose product-level CLI operations for listing, validating, updating, and reloading runtime config, but it must not become a raw file editor or secret browser.

The target deployment configuration contains exactly one configured NanoHost identity, one dedicated native HTTP/2 listener bind, one distinct NanoCore rendezvous endpoint that the NanoHost initiates its authoritative connection toward, and one non-secret reference to the NanoHost transport credential. The NanoHost identity is a deployment-scoped projection of Core `IntegrationIdentity`; the credential is a scoped Core `Token` projection and remains distinct from human sessions, administrator tokens, worker-control tokens, inference tokens, capability tokens, OpenShell credentials, and Vault material.

`server.bind` owns only the ordinary Client/Core HTTP/1.1 and SSE listener. `nanohost.bind` owns the exact host and port of the separate native HTTP/2 listener, while `nanohost.rendezvousUrl` owns the origin advertised to the NanoHost and may differ from the local bind host when an accepted deployment maps the endpoint. The two listeners MUST use distinct local TCP ports; sharing one port on different interface addresses is not supported. The App listener rejects `/api/nanohost/transport/*`; the NanoHost listener accepts only that private prefix and rejects every App API, authentication, Gateway, diagnostics, and SSE path. No frontend, reverse proxy, ordinary fetch client, or synthetic application request may substitute for the native NanoHost connection context.

NanoCore creates no NanoHost listener when `nanohost` configuration is absent. When it is present, `nanohost.bind.host`, `nanohost.bind.port`, and `nanohost.rendezvousUrl` are required together. Plaintext HTTP/2 is valid only when both the listener bind and rendezvous host are exact same-host loopback. A non-loopback bind or rendezvous requires HTTPS plus the existing readable server certificate and private-key inputs; missing, contradictory, colliding, or unusable listener configuration fails startup before product admission without falling back to the App listener. Orderly shutdown closes both listeners under the one NanoCore process deadline, and restart creates both from the current immutable startup snapshot before accepting new connections.

The configured NanoHost identity, listener bind, rendezvous endpoint, and credential reference are startup-owned and restart-required. A change fences the old NanoHost connection and cannot authorize work until the replacement identity and connection pass the runtime-and-transport owner's validation. Missing, malformed, duplicated, stale, revoked, wrong-nanohost, or contradictory values fail startup or keep the target non-ready with redacted diagnostics. Reload MUST NOT keep the predecessor connection authoritative, infer credential rotation, rebind either listener, or mutate a running Runtime Epoch in place.

The target schema and environment boundary contain no Cell, SSH lifecycle, Gateway-forward, direct Gateway, container-runtime, placement, or sandbox-direct endpoint field. NanoCore reads no process environment variable for those concerns, and an unrelated unknown process environment value conveys no runtime authority. SSH may remain operator installation, verification, or break-glass tooling, but it is not NanoCore runtime configuration.

The authored schema accepts only fields with a current runtime owner. Startup networking owns `server.bind`, `server.publicBaseUrl`, and `server.cors.origins`; Better Auth owns `auth.signup.enabled`; central defaults own the Core and Gateway provider/model selections; Gateway policy owns its enabled flag and provider allowlist. Environment variables may explicitly override deployment values only within the constraints owned by this contract, including the desktop-embedded loopback boundary. Unsupported proxy trust, configurable route/auth markers, duplicate Gateway defaults, unused workspace/agent defaults, data-root metadata, diagnostic toggles, the old duplicate feature-flag block, and a consumer-free server extension bag are rejected rather than silently accepted.

The bundled CLI server-mode contract uses the `OPENKIT_NANOCORE_TOKEN` explicit ephemeral override and persistent credential-storage rules owned by `docs/specs/20260704-remote_auth_credential_bootstrap.md`. Historical raw `OPENKIT_NANOCORE_COOKIE` and `OPENKIT_NANOCORE_AUTHORIZATION` passthrough remain removed and are not compatibility inputs. Token values are credential material and must not be printed, logged, persisted in change records, or exposed in artifacts.

## Current Implementation Projection

The NanoCore config, authentication, bundled CLI credential substrate, and V1 shared-Workspace identity and authorization lifecycle are implemented. Broader config recovery, secret-backed editing, and deployment diagnostics remain deferred outside the closed V1 contract:

- Better Auth is the current server-mode auth implementation.
- The Better Auth table layout may use provider-owned table names such as `session`. Core identity doctrine still names the conceptual record `AuthSession`; implementation table names must not redefine the product concept.
- Local mode resolves an implicit local human `User` through `LOCAL_USER_ID` with `kind = local` when no authenticated server-mode subject exists; this is a projection of the ordinary Core `User` family, not another identity type.
- `apps/nanocore/src/auth/middleware.ts` attaches actor context and enforces server-mode authentication for protected APIs.
- Core owns fixed `owner`, `editor`, and `viewer` access derived from the canonical owner and active membership records. Invitations, member access changes and removal, leave, ownership transfer, bounded administrator recovery, and canonical-user disable are implemented through centralized operation authorization and caller-owned effect checks; disabling a user revokes live sessions and tokens without deleting history.
- Server-mode bearer-token authentication, first-boot bootstrap, scoped token administration, the reusable credential-storage substrate, and the bundled CLI credential path are implemented by `docs/specs/20260704-remote_auth_credential_bootstrap.md` and `docs/specs/20260713-openkit_agent_skill_interface.md`. Current access tokens are owned by a responsible human `User`; `AutomationIdentity` token issuance and membership remain outside V1 until separately specified.
- The bundled CLI reads `OPENKIT_NANOCORE_TOKEN` as the explicit ephemeral override or resolves an endpoint-scoped stored credential, sends fixed `openkit-cli` / `agent-skill` channel metadata, and ignores the removed raw `OPENKIT_NANOCORE_COOKIE` and `OPENKIT_NANOCORE_AUTHORIZATION` passthrough variables.
- `apps/nanocore/src/config/bind-host.ts` resolves the App HTTP/1.1 listener host and port from explicit environment overrides, then the startup server config, then mode defaults. It currently accepts an explicit non-loopback `OPENKIT_BIND_HOST` or `server.bind.host` value in local mode instead of rejecting it, so the desktop-embedded loopback-only contract is not yet fully implemented. The NanoHost native HTTP/2 listener instead uses the explicit restart-required `nanohost.bind` and never consumes those App-listener overrides.
- Server mode constructs Better Auth explicitly from the startup config, requires a deployment-specific secret of at least 32 characters, applies `server.publicBaseUrl`, shares `server.cors.origins` with browser CORS, and enforces `auth.signup.enabled` through Better Auth's sign-up policy.
- `apps/nanocore/src/config/runtime-config.ts` loads provider registry, agent configs, agent manifests, workspace configs, gateway defaults, and runtime config status from the data root or supplied in-memory inputs.
- Server browser CORS admits only exact configured origins and returns `403 Forbidden` before route work for every rejected origin; local mode additionally permits exact loopback browser origins.
- Runtime config reload planning distinguishes hot-swappable, session-scoped, restart-required, and rejected changes.
- Provider registries and authored agent configuration are restart-required because production scheduler services capture those dependencies at startup; reload never claims that a newer snapshot has changed an already constructed dispatcher.
- Runtime config reload marks the affected current AgentSession stale for later-Turn reuse. The next authorized Turn either reuses an exact compatible current AgentSession or internally retires and replaces it under the continuity owner. Ordinary App API, Core Client, bundled CLI, and Web surfaces expose no AgentSession restart action, identifier, or history; authorized operator diagnostics may report only a redacted stale-runtime boundary and product-safe availability.
- `apps/nanocore/src/config/runtime-config-files.ts` owns safe runtime config file reads, writes, validation, schema lookup, optimistic revision checks, and path containment.
- Provider and agent config loaders reject unknown or unsafe fields, inline raw secret shapes, unsafe workspace paths, and unsupported runtime setup shapes.

The configured `RuntimeTarget` projection to NanoHost, configured identity, credential reference, predecessor-fenced connection, and single rendezvous path are implemented. Legacy Cell, SSH lifecycle, Gateway-forward, Sandbox-direct configuration, public stale-AgentSession diagnostics, and restart actions are absent rather than retained as compatibility inputs.

The target data-root ownership layout is defined by `docs/specs/20260703-storage_layout_record_ownership.md`, and the complete shared-Workspace identity and authorization lifecycle is defined by `docs/specs/20260715-multi_user_workspace_system.md`. Their storage, schema, policy, and migration work remains outside this config and identity contract.

## Deferred / Future Work

The following items remain outside this config and identity contract:

- enterprise organizations, legal tenant isolation, custom roles, groups, and delegated role administration
- deeper audit labels for non-auth policy and workflow records
- secret-slot and vault-backed config editing
- data-root migration and backup policy
- broader server deployment recovery and auth/session verification
- config diff preview, rollback, and restart-required warnings

## Resolved Decisions

- Local mode is for single-user development and must not be treated as the production security model.
- Server mode is the authenticated product path.
- One server-mode deployment is one trust domain; multi-user Workspace sharing does not imply multi-tenancy.
- Server-mode authentication is not workspace authorization; membership facts and permission decisions remain separate required checks.
- Better Auth is an implementation provider for auth sessions; it does not rename the OpenKit conceptual `AuthSession`.
- Runtime config editing must go through NanoCore-owned routes and schemas, not raw file browsing through the bundled CLI.
- NanoCore bearer tokens used by the bundled CLI are credential material and must not be printed, logged, persisted in documentation, or exposed in artifacts.
- Historical identity, auth, config, and data-layout specs are supporting detail, not active guidance.
- One configured NanoHost uses an `IntegrationIdentity` and a distinct scoped `Token`; configuration stores only the identity, NanoCore rendezvous endpoint, and non-secret credential reference, never raw route or OpenShell credentials.
- Changes to the NanoHost projected by the configured `RuntimeTarget` are restart-required, and no legacy Cell, SSH lifecycle, Gateway-forward, or sandbox-direct configuration family or compatibility alias exists.

## Reference Specs

The historical auth, identity, config, and data-layout specs have been moved under `docs/specs/superseded/nanocore-config-identity/`.

They remain useful for implementation background, but this spec and the core identity/storage docs are the current entry points.

## Links

- [Identity Model](../core/identity.md)
- [Storage Model](../core/storage.md)
- [Permissions Model](../core/permissions.md)
- [Vault Model](../core/vault.md)
- [Single-Deployment Multi-User Workspace System](./20260715-multi_user_workspace_system.md)
- [NanoHost Runtime And Transport](./20260802-nanohost_runtime_and_transport.md)
- [OpenKit Agent Skill Interface](./20260713-openkit_agent_skill_interface.md)
