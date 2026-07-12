# Configuration

This directory owns NanoCore-specific configuration discovery, loading, precedence, runtime snapshots, reload behavior, and configuration routes.

## Boundaries

- Keep environment, mode, bind-host, data-root, server, workspace, agent, and provider configuration loading here.
- Cross-package contract schemas remain in their owning packages; this directory performs NanoCore-specific file I/O and runtime projection.
- `../agents/` and `../providers/` own resolved runtime concepts after loading, so configuration code must not introduce parallel registries.
- Secret values must remain behind explicit references or backend-private state and must not enter snapshots, diagnostics, or generated configuration.
- A failed reload must not publish a partially updated runtime snapshot.

## Verification

Run the focused loader, precedence, runtime snapshot, reload, file, and route tests affected by the change, followed by the package gates in the [NanoCore source guide](../README.md).
