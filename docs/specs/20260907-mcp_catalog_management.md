---
status: Accepted
implementation: Partial
kind: concept
updated: "2026-10-03"
---
# MCP Catalog Management

## Owns

- Independent MCP catalog configuration versions, source provenance, current selection, Workspace bindings, and create/update/remove operations.
- Translation of an imported portable MCP declaration into the existing Gateway's effective catalog record, including gateway-side package resources.
- The distinction between a configuration version, a resolved catalog digest, a tool schema snapshot, and a remote server's reported software version.

## Does Not Own

- MCP protocol, Gateway routing, process supervision, tool schemas, call validation, credentials, approval gates, usage, or audit record semantics; `docs/specs/20260704-worker_mcp_tool_supply.md` remains their accepted owner.
- Skill lifecycle, Agent Plugin packaging, a new connection service, MCP server isolation, a dependency installer, OAuth onboarding, or a legacy SSE transport.
- Worker-native upstream connections or a catalog-selected execution placement.

## Core References

- `docs/core/agent-capability.md`
- `docs/core/agent-supply.md`
- `docs/core/storage.md`
- `docs/core/permissions.md`
- `docs/core/vault.md`
- `docs/core/audit.md`

## Summary

An MCP resource can be created directly or imported from a plugin and managed independently. Immutable configuration revisions make changes and rollback inspectable; the existing Gateway remains the only executor. A configuration digest identifies what OpenKit configured, not the current implementation of a remotely maintained third-party service.

This contract extends management of the existing Workspace MCP catalog. The Gateway owner defines its effective-entry projection and execution behavior. Immutable configuration history and catalog version and binding management are implemented. Raw restricted package inspection and original-package export remain deferred.

## Goals / Non-goals

Provide versioned create, read, update, selection, rollback, enable/disable, and removal with source lineage and current authorization. Reuse the existing stdio and Streamable HTTP transports. Do not rebuild community servers, promise all community packages are executable, or make MCP management into a Skill evaluation system.

## Decision

- The resource identity is its owning scope and stable catalog id. Workspace installations are the default; Server-supplied entries remain read-only projections.
- Immutable `McpConfigVersion` records own non-secret connection configuration; a mutable Workspace binding owns enablement, tool policy, timeout, schema policy, and Vault references.
- An effective Gateway entry is the resolved projection of one exact configuration revision and current authorized binding, never a separately editable copy.
- A plugin records exact MCP membership but does not own the MCP resource's later revisions.

## Contract / Expected Behavior

### Version identity and binding

Each version stores its id, non-secret validated transport declaration, optional upstream version label, source provenance, and exact imported package-root digest for every plugin-imported stdio declaration. The current pointer selects one existing revision. Re-importing identical normalized configuration reuses its identity; a reused publisher label cannot collapse different configurations.

Use `digestFormat: openkit-mcp-config-v1` and SHA-256 over ASCII `openkit-mcp-config-v1`, a zero byte, and UTF-8 canonical JSON of exactly the object `{ "declaration": validatedDeclaration, "packageRootDigest": digestOrNull }`, where `digestOrNull` is the exact package-root tree digest or null. Canonical JSON recursively sorts object keys by ascending UTF-16 code units, preserves array order, uses JSON string/number encoding without whitespace, and rejects duplicate keys, non-finite values, and unrecognized fields before hashing. Input formatting changes do not change identity. The digest is `sha256:` plus 64 lowercase hexadecimal digits. Vault values, binding state, timestamps, display metadata, and upstream observations are excluded.

The Workspace binding carries current enablement, credential references and injection destinations, allowed/denied/approval-required tools, timeout, and schema pin/tracking policy under the Gateway owner. Binding changes have an expected revision and affect the effective `catalogDigest`; they do not rewrite the imported configuration or publisher label. The effective Gateway entry also carries the selected configuration version's `packageRootDigest`, so a plugin-tree change that keeps the same command and arguments still changes `catalogDigest` and invalidates a stale AEP. The existing tool-schema snapshot digest and optional server-reported software version remain separate observations. A pinned schema is not proof of immutable remote software.

The existing immutable MCP configuration version and mutable Workspace binding are the Gateway's connection configuration format; no separate proxy configuration file or credential store is introduced. Each credential binding MAY declare `presentation`, with closed values `raw` and `bearer`; omission retains exact raw injection without rewriting retained records or changing their existing effective digest. Presentation belongs to the binding, follows its expected-revision and effective-digest rules, and never changes the immutable transport declaration's digest. The credential binding is an authority-bearing section: a present `presentation` field is required semantics, and every reader MUST understand its value or reject admission before resolution or upstream contact; dropping it or falling back to raw is forbidden. Strict admission of this section is the equivalent contract gate, including retained binding and effective-entry readers. Unsupported values fail closed; unrelated safely additive content remains subject to Contract Evolution's tolerant-reader rules. Current producers and consumers MUST preserve the recognized field through management, storage, and execution projections. The engineer's ruling on this credential model is recorded in [a decision record](../decisions/20261003-mcp_credential_presentation.md).

### Server Scope And Workspace Projection

The existing catalog document carries closed `scope: workspace | server`; its trusted path and query supply the complete owner, including the Workspace identity where applicable. A retained document without `scope` means Workspace only when loaded from its owning Workspace path. Reads do not rewrite retained bytes. Its next authorized existing compare-and-set publication carries explicit `scope: workspace` forward, preserving all existing versions, selections, bindings, descriptive additions and immutable digests. Server queries require explicit `scope: server`; missing, unknown or path-mismatched scope fails closed. This is an additive normalization in the existing reader/writer, with no legacy implementation, dual publication or second catalog. `server/catalog/catalog.json` and `workspaces/<workspaceId>/catalog/catalog.json` remain the unique per-scope files under the [Storage Layout owner](20260703-storage_layout_record_ownership.md#installed-agent-resource-storage).

Server MCP administration uses the same configuration/version, binding, revision and integrity owner. Only current deployment-administrator authority can read restricted Server declarations or create, stage, select, update, disable or remove them. Server operations do not create or import Server Skill/Plugin content, change those families, or allocate Server process-data directories. A new standalone Server binding receives one distinct stable Core-assigned package-data key; effective mutable data lives separately in each consuming Workspace under that key. Neither a Workspace caller nor a transport declaration can select another binding's data. Removal makes the entry unavailable and disables its binding while retaining configuration/version and call lineage. It does not delete Vault material or retained process data.

The Workspace view composes current Server MCP supply with its own catalog. Any local MCP entry with the same id suppresses the Server projection, including inactive, disabled, unavailable and removed entries; disabling or removing a local entry cannot silently activate shared credentials. Authorized management identifies this collision. The owning Workspace catalog's `mcp.disabledServerIds` is an exact unique list of shared ids whose projection is disabled; omission is empty. It supplies no edit, replacement credential, tool-policy or enablement authority over the Server binding. It is not applicable in Server scope and must be empty there. A Workspace without a local catalog can select shared supply without copying or creating a catalog. Existing Workspace effective digests do not change due to additive scope normalization. Shared effective digests bind their Server origin as well as the existing effective fields.

Server mutations use the existing command ledger under exact initiating actor and Server scope, current administrator rechecks, expected catalog/binding revisions, required Audit and receipt. The existing append-only Audit may record a pre-dispatch `unknown` fact as a fence. A complete receipt replays a current authorized read of its identified catalog resource and exact immutable version where applicable, not a reconstructed past mutable binding or reload result. Changed input under the same request conflicts. A pre-effect Audit without the matching receipt requires inspection and `recovery_required`, never inferred success or another dispatch. Catalog file publication, Core evidence, runtime reload and connection cleanup are separate effects; no Core SQL transaction claims to make them atomic. Report saved/current state and actual activation or cleanup failure separately. A retry after an unknown effect cannot reconstruct authority from directories or current bytes.

Server disablement, removal and credential revocation block later effects through the current canonical catalog and Vault checks even if a runtime-config reload fails. Loaded configuration is a composition projection, not permission to ignore the catalog's current canonical binding. The effect path re-derives origin, local suppression/disablement and exact binding before resolution and dispatch, including after asynchronous discovery. Existing Workspace-only behavior stays unchanged. Composition keeps the admitted local Workspace view and cannot activate a saved but unadmitted local declaration. Catalog observation cannot create or revive a Workspace directory. Server publication is effective through the canonical shared projection and does not reload unrelated authored configuration. An already dispatched effect settles truthfully and is never described as undone.

### Portable declarations and gateway-side resources

The importer validates the declared public format version and maps its supported transport to the existing stdio or Streamable HTTP owner. Unsupported legacy SSE or client-specific fields remain unavailable with a component-specific reason; no guessed transport fallback exists. Format parsing uses locally supported schemas and does not fetch a schema from package-controlled input.

For stdio, preserve separate executable token and arguments, non-secret environment values, and package-relative working-directory semantics. `McpConfigVersion` references the one `PluginVersion`-owned immutable source tree by scoped identity and tree digest; it neither owns a second root snapshot nor hashes the cyclic catalog membership graph. NanoCore verifies and privately materializes that referenced root for the Gateway, including empty directories. For imported stdio declarations, omitted `cwd` selects the verified plugin root. Expand only the two standard placeholders once in `args`, `env` values, and `cwd`, leaving other text literal; never expand `command`, environment keys, URLs, or headers. Validate an explicit `cwd` against the standard's root/data path forms and containment. Supply Core-owned `PLUGIN_ROOT` and `PLUGIN_DATA` after the configured environment, and create the binding's writable data directory before spawn. Reject configured reserved names and Vault bindings targeting them. These declarations follow [Agent Plugins sections 7.2.1 and 9](https://agent-plugins.org/specification). Bare commands use the declared deployment runtime; bundled executables stay inside the verified root. Direct unbundled MCP creation may use the existing deployment command environment without a package root; package-relative declarations require an explicit verified package-root reference rather than a guessed host directory. Missing executable dependencies produce unavailability, never shell concatenation, install hooks, or automatic dependency installation.

Mutable package data is owned by the MCP binding, not by package content. A Core-assigned `packageDataKey` is scoped to the Workspace and original installation id, or to the standalone MCP entry id when no installation exists. MCP members imported as one installation receive the same key; an independent installation or cross-Workspace copy receives a fresh key. Callers cannot choose another installation's key. The key and its directory survive version updates, configuration rollback, and explicit independent adoption of an MCP member; adopted bindings retain their exact key after plugin uninstall. Uninstall removes only its automatic binding references, never independently adopted ones or the data itself. Purge requires no remaining live binding reference and current deletion authority; otherwise the directory remains retained. The catalog binding fields are the sole reference authority and no separate data registry is added. Existing single-worker-slot and server-state limitations remain unchanged.

Non-secret fixed HTTP headers are distinct from Vault-managed authentication. Vault bindings win on collision with package headers or environment values; reserved integration variables cannot be overridden. Package import grants no access to ambient credentials. Raw secrets must not enter package/configuration records, public summaries, or audit payloads. Private source/package configuration stays in restricted configuration inspection; worker and ordinary catalog summaries contain no upstream endpoint, executable configuration, or credential material.

The initial managed HTTP path rejects redirects before following them. An endpoint move requires an explicitly configured and authorized new endpoint revision; no package header, Vault-generated authentication, or request body is forwarded to a redirect target. This applies at the actual Gateway fetch boundary, not only during package validation, and introduces no automatic authorization flow or transport fallback.

### Admission and authority

Importing a declaration records an inactive, unbound configuration; it does not connect, spawn, probe tools, authorize an endpoint, or grant credentials. Explicit enablement requires a valid exact configuration, an explicit allowed tool set, required Vault bindings, and current permission. A user can inspect missing prerequisites without creating a runnable server.

Workspace management uses current `workspace.configure`; ordinary metadata reads use `workspace.read`. Server-owned mutations and restricted raw configuration inspection use deployment-admin authority. Because stdio executes in NanoCore's host context under the accepted Gateway contract, approval/activation of a new or changed stdio command or package executable requires deployment-admin authority even when the catalog is Workspace-owned. A plugin installation cannot convert ordinary Workspace write permission into host code execution. HTTP enablement remains under existing Gateway and Vault policy. This is not a new MCP sandboxing design.

Create, stage-version, select-version, update-binding, disable, and remove are distinct owner-local effects. A staged revision does not become current automatically. Default/rollback selection compares expected current digest; binding changes compare expected binding revision. A stale request fails `conflict` with no hidden overwrite. Selecting an earlier revision does not restore expired/revoked Vault grants, old permissions, upstream data, schema policy, or process data.

### Runtime selection, invalidation, and failure

Agent setup references a catalog id, optionally an exact revision constraint, never an endpoint or command. NanoCore resolves the entry's current revision and authorized binding into the existing effective entry and stamps AEP supply with exact configuration and binding lineage plus its effective catalog digest. An exact constraint that differs from current selection blocks readiness; the configuration owner must explicitly select that revision first. This slice does not introduce simultaneous per-version server instances behind one entry.

No catalog operation hot-rewrites an admitted AEP or runtime-native configuration. The Gateway's current catalog/authorization checks still apply on every call. A changed effective entry invalidates a stale AEP under the existing mismatch/denial behavior; later work must resolve a new package and session through existing owners. Disabling/removing a resource or revoking a grant prevents further admissions and uses existing supervisor teardown. An already upstream-contacting call retains its honest existing outcome; there is no promise to undo its external effect.

Missing configurations, unsupported declarations, absent binaries, authentication failures, unavailable endpoints, schema drift, and integrity errors remain distinguishable in authorized management diagnostics. Worker-visible failures use the existing normalized Gateway errors. Failed connection is not invalid package syntax and must not invalidate unrelated components. No background importer, repair daemon, or alternate connection path is introduced.

NanoCore-owned upstream OAuth discovery, registration, consent, callbacks, token acquisition, refresh, and scope escalation remain deferred. An integration known to require that lifecycle is unavailable for activation with the management reason “Upstream OAuth connection required; NanoCore OAuth onboarding and refresh are not implemented,” unless a separately documented and explicitly configured static alternative is supported. Import remains inert; missing authentication fields do not establish unauthenticated access, and a 401 alone does not establish OAuth-only support. A configured static credential that is rejected produces an authentication-failure diagnostic, not an invented OAuth diagnosis; workers retain normalized Gateway errors. This release adds no non-secret HTTP query map; requested query options remain explicitly unsupported and MUST NOT be silently discarded or stored as Vault secrets. Foreign plugin placeholders require explicit configuration and Vault rebinding, never ambient interpolation.

### Storage, idempotency, and deletion

Scope-owned catalog files are canonical for configurations, versions, current pointers, and bindings; immutable package roots use ordinary bounded installed-resource storage under Storage Core and the shared tree contract in the Skill specification. The old writable runtime-config entry and the new catalog must not remain competing authorities after implementation. A generated effective-entry projection is never accepted as a source mutation.

Reuse the normal request-id ledger, expected-revision checks, staged publication, and audit owners. Publish complete immutable content before exposing references. Success requires durable mutation, required audit, and receipt evidence; partial publication remains inspectable `recovery_required`. Restart does not reset corrupt authority, advance a pointer, reconstruct a receipt, or activate a server from files found on disk. A complete receipt can replay with current authorization; changed input under one request id conflicts.

Removal blocks future selection but retains version and call lineage. Physical purge refuses versions needed by current selection, installed or explicitly retained plugin versions, unexpired AEP/call evidence, or legal holds. A retained MCP version needing a package root retains that exact PluginVersion-owned source tree even after plugin uninstall. Removed-package metadata may retain digest-only unavailable-content history only after all such dependencies and byte-retention obligations end. Credential deletion belongs to Vault and is never a plugin-uninstall cascade. Mutable process data follows the binding-key purge rule, not rollback. A reconnect is a fresh Gateway attempt under current authority, not an import transaction retry across effect domains.

Portable Workspace export uses only redacted MCP version/source lineage under `docs/specs/20260704-workspace_backup_export_import.md`; executable configuration, active bindings, package-data keys, mutable process data, and source authority do not travel. Import leaves required content unavailable and the entry inactive until exact authorized reimport, rebinding, and current selection. Full data-root backup retains complete same-deployment state.

## Proposed Design

Extend the existing MCP catalog resolver and management surface, keeping the Gateway's effective entry and supervisor intact. App API, Core Client, OpenAPI, and the remote MCP and administrator CLI expose the same scoped management operations and redacted readiness information. No independent MCP runtime, generic lifecycle engine, or publisher-version resolver is required.

## Current Implementation Projection

The migrated resource and Agent catalog families use the canonical definition-derived `client.operations` map, JSON bindings and MCP/CLI projections under [Operation Definition](20261002-operation_definition.md). Native catalog, selection, supply and authorization owners retain their existing outcomes; former routes and client namespaces are absent.

Workspace MCP configuration versions and bindings live in `workspaces/<id>/catalog/catalog.json`. NanoCore projects enabled bindings into the Gateway's existing effective catalog; `mcp-servers.jsonc` is not a competing authority. Stdio declarations carry non-secret environment values and optional `cwd`; HTTP declarations carry non-secret headers. Ordinary-user catalog create/select/binding operations are on the App API, CLI, and Web Catalog screen. Stdio enablement still requires deployment-admin authority. The update-binding App API and CLI operation carries optional credential bindings, replacing them when supplied and preserving existing bindings when omitted. Credential bindings preserve optional raw/bearer presentation through management, storage, and the effective projection. The foreign HTTP plugin importer rejects an explicit `auth` object and a `query` field with fixed management reasons, and accepts a query string already part of the endpoint URL. Immutable configuration history is implemented; raw restricted package inspection and original-package export remain deferred.

## Alternatives Considered

Package-owned MCP evolution unnecessarily couples a standalone integration to package publication. Reusing a publisher label as configuration identity fails for unversioned or mutable services. A second effective catalog would split Gateway authority. These alternatives are rejected.

## Consequences

Configuration rollback is precise and inspectable but cannot roll back remote service code or external state. Native worker loading remains a local Gateway projection. Trusted stdio remains a deployment responsibility.

## Rollout / Migration Plan

Implement configuration-version plus binding resolution, non-secret package fields, restricted management views, and HTTP redirect rejection through `docs/specs/20260704-worker_mcp_tool_supply.md`, preserving its runtime, credential, schema, approval, usage, and failure contracts. Use the existing storage layout owner and retire the old mutable configuration shape directly. Do not add a compatibility reader or a second effective catalog authority.

## Testing Strategy / Acceptance Criteria

Retained catalog framing, version provenance and binding observations ignore and preserve owned descriptive additions during revision-protected rewrites; public and Gateway projections include only known fields. Historical configuration identity remains the digest of the exact admitted declaration and package root, never a stripped declaration rehashed under its old digest. Executable transport declarations, credential bindings and sinks, and effect-facing binding authority remain exact, with corruption and stale revisions refused.

1. Formatting-only changes retain configuration identity; semantic changes and package-root changes create new versions and change the effective `catalogDigest`. Binding changes affect effective identity independently of publisher/configuration labels.
2. Imported stdio uses the verified package root when `cwd` is absent, receives correct reserved root/data variables, and preserves data across update and adoption. Expansion is nonrecursive, forbidden fields remain literal, and reserved-name or containment violations fail. Import stages inactive configurations without upstream contact. Missing bindings and unauthorized stdio activation fail; allowed HTTP and deployment-approved stdio use the existing governed Gateway.
3. Compare-and-set updates reject stale writers. Rollback restores an exact configuration while preserving current grants, policy, schema choice, and mutable process data.
4. A changed/disabled effective entry rejects a stale AEP before new upstream contact. Worker payloads and generated configuration contain no upstream topology or canary credentials.
5. Restart/interruption is truthful, referenced versions cannot be purged, and an unavailable MCP does not disable an unrelated Skill. The plugin story proves combined consumption through the existing real worker path.
6. An HTTP server redirecting to another origin fails before contacting the target, and neither fixed headers nor canary Vault authentication reaches it. The same rejecting path covers same-origin redirects without silently changing the configured endpoint.

## Risks & Mitigations

Mutable third-party behavior limits reproducibility, so tool-schema and software observations remain separately recorded. Package scripts may be executable host code, so importing is inert and deployment trust governs activation. Scope and source lineage prevent a package name from impersonating another catalog entry.

## Deferred / Future Work

MCP process sandboxing, automatic dependency provisioning, OAuth onboarding, legacy SSE, remote software pinning beyond publisher support, automatic upgrades, and concurrent stateful session isolation require separate accepted scope. See [Runtime selection, invalidation, and failure](#runtime-selection-invalidation-and-failure) for the upstream OAuth and query-option deferral rules.

## Related Specifications

- `docs/specs/20260711-skill_catalog_versioning_pinning.md`
- `docs/specs/20260907-agent_plugin_packaging_and_worker_supply.md`
- `docs/specs/20260704-worker_mcp_tool_supply.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260703-vault_secret_injection.md`
- [Agent Plugins MCP declaration format](https://agent-plugins.org/specification).

HTTP endpoint declarations and their effective transports share one credential-free HTTP/HTTPS URL criterion, including before new configuration publication. Userinfo credentials and fragments are invalid. Browser configuration writes validate this criterion before mutation-cache or transport admission; fixed errors exclude the rejected value. Valid retained endpoint bytes/digests remain unchanged. A retained invalid credential-bearing declaration fails closed and requires explicit administrator repair with protected Vault grant bindings; readers never extract, relocate, rewrite or print its material.

## Explicit Bounded Discovery Preview

A current deployment administrator MAY explicitly preview tools from an exact retained Server or Workspace MCP configuration before an allowlist or persistent enablement. This is one temporary `tools/list` observation through the existing SDK Gateway, with protocol initialization only; it grants no `tools/call`, activation, binding publication, selection, OAuth lifecycle or future execution authority. Inactive configuration creation accepts an explicit empty allowlist and creates no binding; activation and ordinary binding updates retain their nonempty allowlist requirement. Retained data and ordinary Worker admission stay unchanged.

The preview identifies the canonical catalog scope, entry, retained immutable version digest, exact catalog revision and nullable binding revision. Null means no binding, not a fabricated zero revision. Removed, missing, stale, scope-mismatched or ambiguous identity fails before material resolution or connection. It uses that canonical declaration directly rather than pretending an inactive entry passed Worker admission. Optional transient credential bindings use the existing strict slot/grant/sink shape, are explicitly supplied for this invocation and never persist. They require current exact-scope Gateway-only grants and matching active backend/Core reference identity. Human preview cannot satisfy Agent or AgentSession targets; a capability target, when present, must equal `mcp.list_tools`. Current administrator, catalog, grant and material authority is rechecked after asynchronous discovery before results are returned. Revocation cannot recall material already delivered upstream.

Each preview uses a fresh instance of the existing supervisor, with a finite whole-operation deadline of at most thirty seconds, sixty-four discovery pages and a 512KiB tool-list bound. No partial list is accepted. Temporary stdio process data and placeholder expansion use a trusted temporary context; any package root must match the exact retained immutable package. Preview cannot create consuming-Workspace MCP data or reuse Worker sessions. It awaits client/process closure and removes temporary data after proven closure. Failure or uncertain teardown never claims completed cleanup or successful preview; safe fixed errors exclude endpoint, transport details and secret material.

The public result is bounded tool metadata and exact source identity, with observation time. It is not a stored preview entity, remote schema authority, activation receipt or tool execution proof. Existing operation Policy/Audit and exact VaultUse/injection plans/receipts retain their separate meanings; absent Worker lineage remains absent. Discovery is a read observation, with no persistent preview result or replay guarantee. Each new explicit invocation may contact upstream again; clients never retry it automatically. Restart retains configuration and ordinary Vault evidence, not a reconstructible preview list. Acceptance proves real fake-HTTP discovery with zero `tools/call` and unchanged catalog/binding bytes, no Workspace data, current/stale/revoked refusal, whole-operation timeout, bounds, canary exclusion and awaited temporary stdio teardown.

Human preview admits only an exact scope-lifetime grant from the supported issuers (`workspace` or `server`). It cannot satisfy a Turn or AgentSession lifetime. Workspace observation rechecks the canonical active Core registry and Workspace read authority; Workspace material use also requires current `vault.use`. A cached filesystem Workspace cannot override a Core deletion fence. The complete emitted observation, including initialization metadata, shares the existing 512KiB MCP result bound. Descriptive preview readers ignore inert additions; strict input and known core values remain required.
