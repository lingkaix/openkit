---
id: persistent-deployment-prerelease-update
title: Update a persistent deployment to the published prerelease
persona: Operator updating a deployment that already has real work
entrypoint: skill
default_tool: openkit
timeout_seconds: 1800
requires_real_provider: false
requires_real_codex: false
contracts: docs/specs/20260910-app_update_delivery.md, docs/specs/20260829-release_management.md, docs/specs/20260704-nanocore_bootstrap_readiness.md, docs/specs/20260802-nanohost_runtime_and_transport.md, docs/specs/20260708-container_image_packaging.md, docs/specs/20260715-multi_user_workspace_system.md, docs/core/contract-evolution.md
---

## Intent

Persona: An operator whose deployment already holds real work.

Ask: Update this deployment to the published prerelease and keep my existing work readable.

## Starting World

One persistent deployment is running the previous release. It carries that release's real data. The published prerelease is the update target. This story does not use an exact-source update.

## Setup

The stage manager confirms that the previous release's data is already present. The stage manager does not replace that data with test data.

## Outcome Predicates

- Channel inside-out, tier required. The public update receipt succeeded for the published prerelease digest. A mocked receipt is not that receipt. The record is the helper receipt. `docs/specs/20260910-app_update_delivery.md` owns that receipt.
- Channel inside-out, tier required. The succeeded receipt retains the previous image identity and the candidate image identity, and it records that the previous App was not restored. The record is the helper receipt. `docs/specs/20260910-app_update_delivery.md` owns that receipt.
- Channel inside-out, tier optional. When candidate verification fails, the failed receipt records whether the previous App was restored. The judge skips this predicate when candidate verification does not fail. The record is the failed receipt. `docs/specs/20260910-app_update_delivery.md` owns that receipt.
- Channel inside-out, tier optional. When the failed receipt records a restoration, the authenticated diagnostics boot projection shows readiness with an empty blocking set, and the runtime-target read shows the NanoHost and deployment ready. The judge skips this predicate when no restoration is recorded. The records are the diagnostics boot projection and the runtime-target observation. `docs/specs/20260704-nanocore_bootstrap_readiness.md` owns that projection. `docs/specs/20260802-nanohost_runtime_and_transport.md` owns that observation.
- Channel outside-in, tier optional. When the failed receipt records a restoration, the public health response and the Web entry show that the restored deployment is serving. The judge skips this predicate when no restoration is recorded. `docs/specs/20260708-container_image_packaging.md` names the health observation. The Web entry is the public product surface.
- Channel inside-out, tier required. Workspace records that existed before the update remain readable through a public Workspace read. That read and the retained-authentication comparison are the public witnesses of the retained Data Root and protected configuration. The story names no host path. The record is the Workspace. `docs/specs/20260715-multi_user_workspace_system.md` owns the Workspace.
- Channel inside-out, tier required. The retained-authentication metadata projection matches across the replacement, except the last-used fields. That comparison and the Workspace read are the public witnesses of the retained Data Root and protected configuration. The story names no host path. The record is the retained-authentication metadata projection. `docs/specs/20260910-app_update_delivery.md` owns that projection.
- Channel outside-in, tier required. The public health response and the Web entry show that the updated deployment is serving. `docs/specs/20260708-container_image_packaging.md` names the health observation. The Web entry is the public product surface.
- Channel inside-out, tier required. The authenticated diagnostics boot projection shows readiness with an empty blocking set before any Worker is admitted. The record is the diagnostics boot projection. `docs/specs/20260704-nanocore_bootstrap_readiness.md` owns that projection.
- Channel inside-out, tier required. The runtime-target read shows the same NanoHost and deployment ready on the successor connection. The predicate does not claim that the NanoHost process restarted. The record is the runtime-target observation. `docs/specs/20260802-nanohost_runtime_and_transport.md` owns that observation. `docs/specs/20260910-app_update_delivery.md` owns the successor connection.

## Perturbations

None.

## Integrity Invariants

None.

## Evidence To Collect

The stage manager keeps the public update receipt, the public health response, the Web entry, the authenticated diagnostics read, and the runtime-target read. The stage manager also keeps the retained-authentication comparison and the public Workspace read. The stage manager collects the diagnostics read before any Worker admission. When the optional restoration case is witnessed, the stage manager also keeps that restored deployment's public health response, Web entry, authenticated diagnostics read, and runtime-target read.

## Cleanup

The stage manager removes attempt-owned evidence state only. The stage manager does not remove the Data Root, the protected configuration, or retained Workspace data.

## Failure Triage Notes

- A product failure means the receipt claims success without the published digest, a Workspace read is lost, the diagnostics blocking set is not empty, or the runtime target is not ready.
- An environment failure means the previous-release deployment is missing, the published digest is missing, or the host refuses the update for capacity before a product result exists.
- A tool failure means the administrator client or the evidence collector fails on its own.
- An inconclusive result means a required receipt or readiness read was never witnessed.
- The likely lower layer is the app-update host-domain test and the selected-host update proof in `docs/specs/20260910-app_update_delivery.md`.
