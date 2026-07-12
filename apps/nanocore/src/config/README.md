# Configuration

This directory owns NanoCore-specific configuration discovery, loading, precedence, runtime snapshots, reload behavior, and configuration routes.

## Boundaries

- Keep environment, mode, bind-host, data-root, server, workspace, agent, and provider configuration loading here.
- Accept only configuration that has a current runtime consumer; bind, CORS, public URL, sign-up, and gateway policy are startup-owned, while unsupported proxy, route-selection, or diagnostic toggles must be rejected instead of silently ignored.
- Cross-package contract schemas remain in their owning packages; this directory performs NanoCore-specific file I/O and runtime projection.
- `../agents/` and `../providers/` own resolved runtime concepts after loading, so configuration code must not introduce parallel registries.
- Secret values must remain behind explicit references or backend-private state and must not enter snapshots, diagnostics, or generated configuration.
- A failed reload must not publish a partially updated runtime snapshot.
- Reload failure diagnostics must redact the concrete data root, and provider or agent changes must remain restart-required while production services capture those inputs at startup.

## Verification

Run the focused loader, precedence, runtime snapshot, reload, file, and route tests affected by the change, followed by the package gates in the [NanoCore source guide](../README.md).
