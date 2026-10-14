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

Ask: Update this deployment to the published prerelease. If this pre-stable release requires a reset, follow its documented procedure and keep our required accounts usable. Otherwise, keep my existing work readable.

## Starting World

One persistent deployment is running an earlier published release. It carries that release's real data. The published prerelease is the update target. This story does not use an exact-source update.

## Setup

The stage manager confirms that the real data of the earlier published release is already present. The stage manager does not replace that data with test data. The published release record determines the disposition: carry forward, or an explicit reset before `v0.1.0` under Release Management. A reset requires the separate operator procedure and authority; no failed helper request triggers one. The account list and credentials stay with the operator, outside the story and evidence. The pre-`v0.1.0` scope follows the engineer's interpretation of NONNEG-001 and COMPAT-001 in [Pre-Stable Data Continuity](../../docs/decisions/20261014-pre_stable_data_continuity.md).

## Outcome Predicates

- Channel inside-out, tier required. For carry-forward, the public update receipt succeeded for the published prerelease digest. For a disclosed pre-stable reset, the operator evidence establishes the installed published digest and completion of the authorized reset procedure instead. No helper receipt is fabricated for that reset. A mocked receipt is not success. The records are the helper receipt or the authorized reset evidence. `docs/specs/20260910-app_update_delivery.md` owns that receipt.
- Channel inside-out, tier optional. For carry-forward, the succeeded receipt retains the previous image identity and the candidate image identity, and it records that the previous App was not restored. The judge skips this predicate for an explicit reset; a reset supplies no previous-image recovery proof. The record is the helper receipt. `docs/specs/20260910-app_update_delivery.md` owns that receipt.
- Channel inside-out, tier optional. When helper candidate verification fails, the failed receipt records whether the previous App was restored. The judge skips this predicate when no helper verification fails, including a reset without a helper receipt. The record is the failed receipt. `docs/specs/20260910-app_update_delivery.md` owns that receipt.
- Channel inside-out, tier optional. When a failed helper receipt records a restoration, the authenticated diagnostics boot projection shows readiness with an empty blocking set, and the runtime-target read shows the NanoHost and deployment ready. The judge skips this predicate when no restoration is recorded. The records are the diagnostics boot projection and the runtime-target observation. `docs/specs/20260704-nanocore_bootstrap_readiness.md` owns that projection. `docs/specs/20260802-nanohost_runtime_and_transport.md` owns that observation.
- Channel outside-in, tier optional. When a failed helper receipt records a restoration, the public health response and the Web entry show that the restored deployment is serving. The judge skips this predicate when no restoration is recorded. `docs/specs/20260708-container_image_packaging.md` names the health observation. The Web entry is the public product surface.
- Channel inside-out, tier optional. For carry-forward, Workspace records that existed before the update remain readable through a public Workspace read. The judge skips predecessor-record continuity for a disclosed pre-stable reset; skipped continuity is not a continuity pass. That read and the retained-authentication comparison are the public witnesses of the retained Data Root and protected configuration. The story names no host path. The record is the Workspace. `docs/specs/20260715-multi_user_workspace_system.md` owns the Workspace.
- Channel inside-out, tier optional. For carry-forward, the retained-authentication metadata projection matches across the replacement, except the last-used fields. The judge skips this metadata comparison for a disclosed pre-stable reset; required-account usability remains mandatory. That comparison and the Workspace read are the public witnesses of the retained Data Root and protected configuration. The story names no host path. The record is the retained-authentication metadata projection. `docs/specs/20260910-app_update_delivery.md` owns that projection.
- Channel outside-in, tier required. The accounts the engineer names for this deployment stay registered and usable after the update or reset. The operator reports observed usability without personal account data or credentials. `docs/specs/20260829-release_management.md` owns that invariant.
- Channel outside-in, tier required. The public health response and the Web entry show that the updated deployment is serving. `docs/specs/20260708-container_image_packaging.md` names the health observation. The Web entry is the public product surface.
- Channel inside-out, tier required. The authenticated diagnostics boot projection shows readiness with an empty blocking set before any Worker is admitted. The record is the diagnostics boot projection. `docs/specs/20260704-nanocore_bootstrap_readiness.md` owns that projection.
- Channel inside-out, tier required. The runtime-target read shows the exact currently configured NanoHost and deployment ready. For carry-forward, it shows the same identity pair on the successor connection. For an explicit reset, it validates the current authorized binding and does not infer predecessor identity or continuity. The predicate does not claim that the NanoHost process restarted. The record is the runtime-target observation. `docs/specs/20260802-nanohost_runtime_and_transport.md` owns that observation. `docs/specs/20260910-app_update_delivery.md` owns the successor connection.

## Perturbations

None.

## Integrity Invariants

None.

## Evidence To Collect

The stage manager keeps the public health response, the Web entry, the authenticated diagnostics read, and the runtime-target read. For carry-forward, it also keeps the public update receipt, retained-authentication comparison, and public Workspace read. For an explicit pre-stable reset, it keeps the release disclosure, scoped operator evidence, installed digest, and account-usability observations without personal account data or secrets. The stage manager collects the diagnostics read before any Worker admission. When the optional restoration case is witnessed, the stage manager also keeps that restored deployment's public health response, Web entry, authenticated diagnostics read, and runtime-target read.

## Cleanup

The stage manager removes attempt-owned evidence state only. The stage manager does not remove the Data Root, the protected configuration, or retained Workspace data.

## Failure Triage Notes

- A product failure means the receipt claims success without the published digest, a required carry-forward Workspace read is lost, a reset lacks disclosure or authorization, a required account is unusable, the diagnostics blocking set is not empty, or the runtime target is not ready.
- An environment failure means the deployment of the earlier published release is missing, the published digest is missing, or the host refuses the update for capacity before a product result exists.
- A tool failure means the administrator client or the evidence collector fails on its own.
- An inconclusive result means a required receipt, reset evidence, account-usability observation, or readiness read was never witnessed.
- The likely lower layer is the app-update host-domain test and the selected-host update proof in `docs/specs/20260910-app_update_delivery.md`.
