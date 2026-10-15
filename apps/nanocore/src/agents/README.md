# Agents

This directory owns authored agent definitions and the resolution path from configuration to an executable, inspectable agent setup.

## Boundaries

- Keep manifest shape, selection, readiness, setup resolution, transport selection, resolved setup evidence, catalog projection, and catalog routes here.
- Workspace-visible Agent catalog entries are a live read of current `runtimeConfig().agentManifests`. Missing authored role is `kind: null`. Missing authored readiness stays `health.unknown` with `checkedAt: null` and does not hide supply. Launch `computeReadiness` defaults stay launch-only.
- Setup composition uses the existing Gateway planner to check current supply. With `routing.autoFailover: false`, only the primary can establish readiness; enabled failover permits an available backup. Retained configured logical IDs without eligible supply cannot enter a new executable setup or an `all` expansion.
- Live callers supply `subscriptionAccounts` and `providerCredentialConfigured` through `AgentSetupResolverDependencies`. Setup delegates those checks to the existing Gateway resolver on each resolution; missing supply blocks dependent models, and later restoration or revocation changes only later setups. Omitting the hooks retains configuration-only resolution for boot and tests.
- Setup resolution requires declarations for `/usr/local/bin/node` and `/usr/local/bin/openkit-worker-shim` before it can return a ready setup. Missing paths return `agent_setup.missing_control_binary` without exposing other authored paths. Image contents and host availability still require their existing proof.
- `../config/` loads authored files, `../providers/` owns configured provider instances, and `../runtime/` executes the resolved setup.
- Application-internal coordinators and Quick Chat agents belong to `../internal-agents/`, not this directory.
- Storage schemas and migrations remain under `../storage/` even when agent setup evidence is recorded here.

## Verification

Run the focused catalog, readiness, selector, setup resolver, setup ledger, and configuration loader tests affected by the change, followed by the package gates in the [NanoCore source guide](../README.md).

Setup composition resolves selected-profile `reasoningEffort` before the base Agent `models.reasoningEffort`. Unknown values fail through setup diagnostics before launch. This default applies at a new Turn admission; editing it cannot rewrite an admitted Turn or its immutable package.

Agent discovery, detail and health refresh use the exact `createAgentOperationImplementations` map; current Worker inventory uses `createWorkerOperationImplementations` in `workspace-workers.ts`. Their canonical inputs and outputs come from the shared family tables. Workspace candidates, Thread audience, current administrator eligibility, exact package pointers and audit-controlled usage remain with their native owners.

Resolved setup snapshots preserve explicitly authored `allowEncodedSlash` without inserting a default into historical grant shapes. Run `setup-ledger.test.ts` for omission, false and true evidence preservation.
