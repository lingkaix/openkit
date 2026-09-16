# Agents

This directory owns authored agent definitions and the resolution path from configuration to an executable, inspectable agent setup.

## Boundaries

- Keep manifest shape, selection, readiness, setup resolution, transport selection, resolved setup evidence, catalog projection, and catalog routes here.
- Workspace-visible Agent catalog entries are a live read of current `runtimeConfig().agentManifests`. Missing authored role is `kind: null`. Missing authored readiness stays `health.unknown` with `checkedAt: null` and does not hide supply. Launch `computeReadiness` defaults stay launch-only.
- `../config/` loads authored files, `../providers/` owns configured provider instances, and `../runtime/` executes the resolved setup.
- Application-internal coordinators and Quick Chat agents belong to `../internal-agents/`, not this directory.
- Storage schemas and migrations remain under `../storage/` even when agent setup evidence is recorded here.

## Verification

Run the focused catalog, readiness, selector, setup resolver, setup ledger, and configuration loader tests affected by the change, followed by the package gates in the [NanoCore source guide](../README.md).
