---
status: Accepted
implementation: Partial
---
# NanoCore Config And Identity Contract

## Summary

This spec consolidates the current NanoCore identity, auth, Server, Workspace, User, Gateway, internal-role, and runtime-config guidance.

OpenKit treats NanoCore as the kernel source of truth. Local mode remains a single-user development path. Server mode uses Better Auth-backed session behavior for protected product APIs and is the authenticated path for the accepted single-deployment multi-user Workspace model.

Historical identity and config specs have been moved under `docs/specs/superseded/nanocore-config-identity/` and remain supporting detail.

## Owns

- The current NanoCore local-mode and server-mode identity contract.
- The relationship between Better Auth implementation details and OpenKit identity concepts.
- Runtime config loading, validation, reload posture, and public config-editing boundaries.
- Server config and data-root behavior at the implementation-contract level.
- The concrete configuration-scope relationship and file ownership for Server resources, Workspace shared composition, User preference, Gateway logical models, and internal-role execution profiles.
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
- Logical-model route eligibility, fallback behavior, Agent Manifest composition fields, or internal-role runtime semantics beyond locating their owning configuration files.
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
- Do not accept a Cell owner, Cell epoch, Cell helper, SSH lifecycle target, Gateway URL or forward, container-runtime endpoint, sandbox-direct NanoCore endpoint, route token, or worker-visible Provider route as target deployment configuration.

## Current Contract

Local mode is optimized for single-user development and dogfooding. Its implicit local human is a projection of the Core `User` record family with `kind = local`, not a separate identity type. Product surfaces should still carry explicit workspace and user-facing state where the App API requires it.

When NanoCore runs as a desktop-embedded Core, every Core endpoint MUST bind only to a loopback interface. `OPENKIT_BIND_HOST` and `server.bind.host` may select a loopback address, but neither is authority to widen that boundary; startup MUST reject any desktop-embedded configuration that resolves to a non-loopback address.

Server mode is the path for authenticated product operation. It uses Better Auth-backed session behavior today, and protected product APIs should enforce the server-mode auth contract.

For every protected route, the shared authentication middleware owns the failure for a missing, invalid, or disabled server-mode actor. It returns the strict `ApiError` envelope with HTTP `401`, code `core.auth.unauthenticated`, and fixed message `Authentication required.` before route-specific work. Route handlers must inherit this result and must not redefine, translate, or replace its code or message.

Server-mode authentication establishes the request actor. It does not by itself prove workspace membership, role authority, policy grants, or permission approval. Those checks belong to identity membership records, permission policy, and the policy enforcement mapping.

One server-mode deployment is one personal or small-team trust domain, not a legal tenant host. Better Auth owns authentication and session mechanics; NanoCore owns canonical users, Workspace relationships, authorization facts, and product policy.

Runtime config is managed through NanoCore-owned routes and schemas. The Agent Skill Interface may expose product-level CLI operations for listing, validating, updating, and reloading runtime config, but it must not become a raw file editor or secret browser.

The Web deployment-admin Configuration surface may project exact authored JSONC sources only through those same NanoCore runtime-config routes. Local mode uses its implicit local actor. Server mode uses the current Better Auth session client, while NanoCore derives deployment-admin authority only when the active canonical User owns a currently usable `server-admin` Token; the browser does not accept, recover, persist, log, route, render, or cache that Token. File listing, reads, validation, revision-protected writes, and reload retain NanoCore authority, path containment, secret rejection, last-known-good, and restart-required semantics.

The target deployment configuration contains exactly one configured NanoHost identity, one dedicated native HTTP/2 listener bind, one distinct NanoCore rendezvous endpoint that the NanoHost initiates its authoritative connection toward, and one non-secret reference to the NanoHost transport credential. The NanoHost identity is a deployment-scoped projection of Core `IntegrationIdentity`; the credential is a scoped Core `Token` projection and remains distinct from human sessions, administrator tokens, worker-control tokens, inference tokens, capability tokens, OpenShell credentials, and Vault material.

`server.bind` owns only the ordinary Client/Core HTTP/1.1 and SSE listener. `nanohost.bind` owns the exact host and port of the separate native HTTP/2 listener, while `nanohost.rendezvousUrl` owns the origin advertised to the NanoHost and may differ from the local bind host when an accepted deployment maps the endpoint. The two listeners MUST use distinct local TCP ports; sharing one port on different interface addresses is not supported. The App listener rejects `/api/nanohost/transport/*`; the NanoHost listener accepts only that private prefix and rejects every App API, authentication, Gateway, diagnostics, and SSE path. No frontend, reverse proxy, ordinary fetch client, or synthetic application request may substitute for the native NanoHost connection context.

NanoCore creates no NanoHost listener when `nanohost` configuration is absent. When it is present, `nanohost.bind.host`, `nanohost.bind.port`, and `nanohost.rendezvousUrl` are required together. Plaintext HTTP/2 is valid only when both the listener bind and rendezvous host are exact same-host loopback. A non-loopback bind or rendezvous requires HTTPS plus the existing readable server certificate and private-key inputs; missing, contradictory, colliding, or unusable listener configuration fails startup before product admission without falling back to the App listener. Orderly shutdown closes both listeners under the one NanoCore process deadline, and restart creates both from the current immutable startup snapshot before accepting new connections.

The configured NanoHost identity, listener bind, rendezvous endpoint, and credential reference are startup-owned and restart-required. A change fences the old NanoHost connection and cannot authorize work until the replacement identity and connection pass the runtime-and-transport owner's validation. Missing, malformed, duplicated, stale, revoked, wrong-nanohost, or contradictory values fail startup or keep the target non-ready with redacted diagnostics. Reload MUST NOT keep the predecessor connection authoritative, infer credential rotation, rebind either listener, or mutate a running Runtime Epoch in place.

The target schema and environment boundary contain no Cell, SSH lifecycle, Gateway-forward, direct Gateway, container-runtime, placement, or sandbox-direct endpoint field. NanoCore reads no process environment variable for those concerns, and an unrelated unknown process environment value conveys no runtime authority. SSH may remain operator installation, verification, or break-glass tooling, but it is not NanoCore runtime configuration.

The authored schema accepts only fields with a current runtime owner. Startup networking owns `server.bind`, `server.publicBaseUrl`, and `server.cors.origins`; Better Auth owns `auth.signup.enabled`; `server.defaults.defaultAgentId` owns only the final Server Agent fallback; the dedicated Gateway file owns Gateway enablement, logical models, routes, and its final logical-model fallback. Environment variables may explicitly override deployment values only within the constraints owned by this contract, including the desktop-embedded loopback boundary. Unsupported proxy trust, configurable route/auth markers, duplicate Gateway defaults, removed Core or Gateway Provider/model defaults, Workspace-record execution defaults, data-root metadata, diagnostic toggles, the old duplicate feature-flag block, and a consumer-free server extension bag are rejected rather than silently accepted.

## Configuration Scope And Files

Server is the shared resource and baseline-configuration provider, Workspace is the durable shared authored-composition scope, and User is the personal preference subject defined by Core Concepts and Identity. Ordinary persistent preference resolves User first, then Workspace, then Server. A request or current Orchestrator choice is more specific only when the owning command admits it.

The clean target uses these canonical authored files:

```text
DATA_ROOT/config/server.jsonc
DATA_ROOT/config/gateway.jsonc
DATA_ROOT/config/internal-role-profiles.jsonc
DATA_ROOT/config/providers/<providerId>.provider.jsonc
DATA_ROOT/config/agents/<agentId>.agent.jsonc
DATA_ROOT/users/<userId>/config/user.jsonc
DATA_ROOT/workspaces/<workspaceId>/config/workspace.jsonc
```

`server.jsonc` owns deployment, auth, listener, NanoHost, and final `defaults.defaultAgentId` values. It contains no `coreProviderId`, `coreModel`, `gatewayProviderId`, or `gatewayModel`, and it does not duplicate the Gateway logical-model catalog.

`gateway.jsonc` owns `schemaVersion`, enablement, one optional `defaultLogicalModelId`, and the logical-model catalog. The Gateway owner defines logical-model and route fields and behavior; this contract owns only that the file is Server-scoped, strictly validated, revision-editable, and reloadable.

`internal-role-profiles.jsonc` is the sole Server file that projects the already accepted Internal Role Execution Profile. This contract owns only its path, Server scope, strict validation, revision editing, and reload participation; `docs/specs/20260813-internal_agent_runtime.md` owns its fields, defaults, and role-resolution semantics. It contains no worker Agent Manifest, AEP, Sandbox, Harness, or AgentSession configuration.

`workspace.jsonc` owns the editable Workspace `name`, Workspace-shared `defaultAgentId`, Agent Manifest bindings, internal-role bindings, logical-model visibility or preference, Skill and MCP composition, credential-requirement bindings, Workspace roots, and other Workspace-owned resources accepted by their owners. `workspace-record.json` retains only system-owned identity, ownership, lifecycle, revision, and timestamp facts. A binding may add Workspace-owned resources and override or extend the referenced Server supply using stable field identities; it does not create another resolver or an unrelated full Workspace-local Agent Manifest.

`user.jsonc` owns personal per-Workspace Agent, profile, logical-model, and applicable internal-role preferences. It stores no Server default, Workspace-shared behavior, Provider credential, Gateway route, Sandbox placement, AgentSession identity, or native runtime state.

All authored files use strict schemas, explicit `schemaVersion`, the shared required-feature registry when behavior needs a feature gate, and namespaced descriptive extensions. Unknown authority-bearing behavior remains invalid. This change adds no compatibility alias, generic unknown-field activation, routing plugin registry, or parallel configuration transaction protocol.

## Selection, Composition, And Resolution

Worker Agent selection resolves explicit request or Orchestrator `agentId`, User preference for the Workspace, `workspace.jsonc.defaultAgentId`, then `server.jsonc.defaults.defaultAgentId`. Missing or unavailable final fallback returns a typed configuration or readiness error; file order never selects an Agent.

Profile and logical-model preference resolve independently from Agent identity. The request may select `profileId` and logical `modelId`; otherwise User preference, Workspace Agent or role binding, the selected profile or Server execution profile, and the Gateway final logical default apply in that order where each field exists. A model value never derives or changes `agentId`.

One Server Agent Manifest, one Workspace binding when present, one selected nested profile, and applicable User preference are authored inputs to one composition step. Composition produces one setup with source provenance before the Agent Manifest resolver validates catalogs, grants, policy, runtime proof, compatibility, and materialization. Resolution and materialization remain one-way non-authoring projections.

## Reload And Failure Contract

A successful reload publishes one new immutable runtime-config snapshot for later reads and resolutions. An admitted internal-role provider call remains pinned to its accepted logical-model contract, and an admitted worker Turn remains pinned to its immutable AEP snapshot and compatibility key; ordinary reload never mutates either in place or interrupts the active Turn.

Changes to private route members of an existing logical model apply to the next Provider call admitted after reload without restarting a worker because the concrete route is not worker state. Adding or removing a logical model does not mutate an admitted AEP, including one produced from manifest `models: all`; the changed catalog enters only a later composed setup and AEP. Workspace and User preference changes apply to the next command or resolution. Agent, profile, internal-role, Skill, credential-requirement, and process-static model-catalog changes also apply through the next composed setup and AEP. The current Codex adapter starts one native child per Turn, so the next Turn reads the later AEP and resumes the exact native conversation from the AgentSession-private state root without a separate replacement action. An implemented adapter that retains a native process between Turns must either prove that it can apply the changed setup in place or refuse another Turn on that process after the active Turn; its accepted runtime owner must define any replacement and resume behavior before such an adapter is dispatchable.

An additive Skill may be materialized immediately and is observed according to the native runtime's own reload behavior. Externally enforced policy and an existing OpenShell credential replacement take effect through their existing owner. A new runtime-environment or runtime-file credential never mutates the active process environment or file view; it enters a later AEP and therefore the next per-Turn Codex child, while a future resident-process adapter must use its accepted post-Turn refusal or replacement behavior. This contract adds no reload-plan record, durable transaction, user-facing restart action, or product recovery lifecycle.

Invalid syntax, schema failure, missing required references, incompatible composition, unavailable logical model, unsupported runtime route, or missing credential binding rejects the new snapshot or the exact later resolution before effects. The last known good snapshot remains authoritative when reload rejects a file. Restart reads only the clean current file names and schemas; removed fields or files are errors rather than compatibility inputs.

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
- `apps/nanocore/src/config/runtime-config.ts` loads the canonical Server, Provider, Agent Manifest, Gateway, internal-role profile, User, Workspace, and Workspace data-source files into one validated last-known-good snapshot. Gateway defaults come only from `gateway.jsonc`; Server configuration contains only deployment settings and `defaults.defaultAgentId`.
- Server browser CORS admits only exact configured origins and returns `403 Forbidden` before route work for every rejected origin; local mode additionally permits exact loopback browser origins.
- Runtime config reload planning distinguishes hot-swappable, session-scoped, restart-required, and rejected changes. The removed `staleWhenPackageChanges` field is absent from both reload output and the AEP schema.
- Provider registry changes are restart-required because constructed dispatchers capture them, while Agent composition changes are session-scoped and affect later AgentSession materialization without mutating an active Turn. The removed `session.staleWhenPackageChanges` field has no compatibility projection; runtime replacement follows the existing per-Turn child and AgentSession resume lifecycle.
- `apps/nanocore/src/config/runtime-config-files.ts` owns safe runtime config file reads, writes, validation, schema lookup, optimistic revision checks, and path containment.
- `apps/web/src/screens/settings/ConfigurationScreen.tsx` projects those existing routes as a server-admin-gated file tree and JSONC source editor without direct filesystem access or a second configuration contract.
- Provider and agent config loaders reject unknown or unsafe fields, inline raw secret shapes, unsafe workspace paths, and unsupported runtime setup shapes.

The configured `RuntimeTarget` projection to NanoHost, configured identity, credential reference, predecessor-fenced connection, and single rendezvous path are implemented. Legacy Cell, SSH lifecycle, Gateway-forward, Sandbox-direct configuration, public stale-AgentSession diagnostics, and restart actions are absent rather than retained as compatibility inputs.

The implemented data-root ownership layout is defined by `docs/specs/20260703-storage_layout_record_ownership.md`, and the complete shared-Workspace identity and authorization lifecycle is defined by `docs/specs/20260715-multi_user_workspace_system.md`. Their storage, schema, policy, and migration semantics remain owned outside this config and identity contract.

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
- Server supplies resources and fallback defaults, Workspace composes shared behavior, and User supplies the most specific persistent preference without any of those defaults becoming a generic resource ceiling.
- `gateway.jsonc`, `internal-role-profiles.jsonc`, `user.jsonc`, and `workspace.jsonc` are distinct authored owners; `server.jsonc` contains only its own deployment fields and final Agent fallback.
- User → Workspace → Server is the ordinary persistent-preference order, explicit request or Orchestrator selection is more specific when admitted, and model preference never selects an Agent.
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
