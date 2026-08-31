# Configuration

This directory owns NanoCore-specific configuration discovery, loading, precedence, runtime snapshots, reload behavior, and configuration routes.

## Boundaries

- Keep environment, mode, bind-host, data-root, server, workspace, agent, and provider configuration loading here.
- Load Server resources and fallbacks, shared Workspace composition, and User preferences as distinct owners; resolve explicit selection, User, Workspace, then Server without treating Server supply as a Workspace ceiling.
- Keep `gateway.jsonc`, `internal-role-profiles.jsonc`, `providers/*.provider.jsonc`, `agents/*.agent.jsonc`, `workspaces/*/config/workspace.jsonc`, and `users/*/config/user.jsonc` distinct in snapshots and diagnostics.
- Accept only configuration that has a current runtime consumer; bind, CORS, public URL, sign-up, and gateway policy are startup-owned, while unsupported proxy, route-selection, or diagnostic toggles must be rejected instead of silently ignored.
- Cross-package contract schemas remain in their owning packages; this directory performs NanoCore-specific file I/O and runtime projection.
- `../agents/` and `../providers/` own resolved runtime concepts after loading, so configuration code must not introduce parallel registries.
- Secret values must remain behind explicit references or backend-private state and must not enter snapshots, diagnostics, or generated configuration.
- A failed reload must not publish a partially updated runtime snapshot.
- Reload failure diagnostics must redact the concrete data root. Accepted Workspace-name changes refresh the joined store projection immediately; session-scoped Agent changes apply to later composition, while startup-captured Provider changes remain restart-required.

## Verification

Run the focused loader, precedence, runtime snapshot, reload, file, and route tests affected by the change, followed by the package gates in the [NanoCore source guide](../README.md).
