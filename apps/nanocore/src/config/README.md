# Configuration

This directory owns NanoCore-specific configuration discovery, loading, precedence, runtime snapshots, reload behavior, and configuration routes.

## Boundaries

- Keep environment, mode, bind-host, data-root, server, workspace, agent, and provider configuration loading here.
- Load Server resources and fallbacks, shared Workspace composition, and User preferences as distinct owners; resolve explicit selection, User, Workspace, then Server without treating Server supply as a Workspace ceiling.
- Keep `gateway.jsonc`, `internal-role-profiles.jsonc`, `providers/*.provider.jsonc`, `agents/*.agent.jsonc`, `workspaces/*/config/workspace.jsonc`, `workspaces/*/config/data-sources.jsonc`, `workspaces/*/catalog/catalog.json`, and `users/*/config/user.jsonc` distinct in snapshots and diagnostics.
- Accept only configuration that has a current runtime consumer; bind, CORS, public URL, sign-up, and gateway policy are startup-owned, while unsupported proxy, route-selection, or diagnostic toggles must be rejected instead of silently ignored.
- Cross-package contract schemas remain in their owning packages; this directory performs NanoCore-specific file I/O and runtime projection.
- `../agents/` and `../providers/` own resolved runtime concepts after loading, so configuration code must not introduce parallel registries.
- Secret values must remain behind explicit references or backend-private state and must not enter snapshots, diagnostics, or generated configuration.
- New Agent config templates must name the immutable image-owned Python environment under `/opt/openkit/venv`; writable user-created environments remain runtime data and are not default template authority.
- MCP catalog changes are session-scoped; stdio enablement requires deployment-admin. Catalog App API mutations reload the runtime snapshot and close Gateway sessions for that Workspace.
- A failed reload must not publish a partially updated runtime snapshot.
- Reload failure diagnostics must redact the concrete data root. Accepted Workspace-name changes refresh the joined store projection immediately; session-scoped Agent changes apply to later composition, while startup-captured Provider changes remain restart-required.

## Verification

Run the focused loader, precedence, runtime snapshot, reload, file, and route tests affected by the change, followed by the package gates in the [NanoCore source guide](../README.md).

`administration-configuration.ts` projects existing Provider catalog metadata and Gateway logical-model bindings into immutable private candidate Artifacts. It preserves credential/endpoint/extension fields, validates source revisions and dependencies, and reuses the file service for application. Human application records a start Item before effects and an immutable outcome plus command receipt afterward; interrupted effects require inspection rather than automatic retry. Provider changes may remain restart-required.

`model-catalog.ts` loads strict `config/model-catalog.jsonc` and projects its exact vendor/native-ID entries beneath profile overlays, leaving both authored files unchanged. The runtime snapshot tracks the complete catalog, including unused entries, and retains active catalog and Provider metadata until restart. Generic file operations expose the `model-catalog` kind under the existing deployment-admin boundary.
