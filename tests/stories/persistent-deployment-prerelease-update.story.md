---
id: persistent-deployment-prerelease-update
title: Update a persistent deployment to the published prerelease
persona: Operator updating a deployment that already has real work
entrypoint: skill
default_tool: openkit
timeout_seconds: 1800
requires_real_provider: false
requires_real_codex: false
contracts: docs/specs/20260910-app_update_delivery.md, docs/specs/20260829-release_management.md, docs/specs/20260704-nanocore_bootstrap_readiness.md, docs/specs/20260802-nanohost_runtime_and_transport.md, docs/specs/20260708-container_image_packaging.md, docs/specs/20260715-multi_user_workspace_system.md, docs/core/contract-evolution.md, docs/specs/20260713-work_resource_interaction_model.md, docs/specs/20260704-remote_auth_credential_bootstrap.md
---

## Intent

Persona: An operator whose deployment already holds real work.

Ask: Get this deployment ready to use on the published prerelease. Keep my existing work readable when the release carries it forward. If the operator has reset this pre-stable deployment, verify the release's data warning, our designated accounts' sign-in, and that I can save and read a new Workspace Material note.

## Starting World

The persistent deployment initially runs an earlier published release and carries that release's real data. The published prerelease is the target. Carry-forward starts with that predecessor still installed. A disclosed pre-stable reset starts the Actor run after the authorized operator has completed reset setup and installed the target. This story does not use an exact-source update.

## Setup

The stage manager confirms the predecessor's real data before any transition and does not replace it with test data. It declares one disposition in the existing run parameters: carry-forward or a disclosed explicit reset before `v0.1.0`. The target release and chosen disposition are ordinary user context in the sole ask. The published release disclosure and user ask identify that disposition; missing or contradictory selection prevents run admission. Every required predicate for the chosen disposition must be witnessed. Predicates scoped to the other disposition are explicitly inapplicable, not unwitnessed optional predicates.

For a reset, the stage manager or operator completes the separately authorized stopped-process procedure and required fencing before the Actor run. No failed helper request triggers a reset. Exact installed-build attribution and operator authorization remain setup prerequisites. Operator reports are not product outcome records and do not replace helper receipts. The Actor receives only the persona, the sole ask, and ordinary authorized access; it uses no host SSH, direct files, repository source, or private reset procedure. The account list and credentials stay in operator custody outside the repository and evidence. Use existing protected credential delivery for authorized public sign-in without placing secrets in the Actor prompt. The pre-`v0.1.0` scope follows the engineer's interpretation of NONNEG-001 and COMPAT-001 in [Pre-Stable Data Continuity](../../docs/decisions/20261014-pre_stable_data_continuity.md).

## Outcome Predicates

- Channel inside-out, tier required. Carry-forward only: the public update receipt succeeded for the published prerelease digest. A mocked receipt or operator report cannot replace it. This predicate is inapplicable to a disclosed pre-stable reset. The record is the helper receipt owned by `docs/specs/20260910-app_update_delivery.md`.
- Channel inside-out, tier required. Carry-forward only: the succeeded helper receipt retains the previous and candidate image identities and records that the previous App was not restored. This predicate is inapplicable to a disclosed pre-stable reset; a reset supplies no previous-image recovery proof. The record is the helper receipt owned by `docs/specs/20260910-app_update_delivery.md`.
- Channel inside-out, tier optional. When helper candidate verification fails, the failed receipt records whether the previous App was restored. The judge skips this predicate when no helper verification fails, including a reset without a helper receipt. The record is the failed receipt. `docs/specs/20260910-app_update_delivery.md` owns that receipt.
- Channel inside-out, tier optional. When a failed helper receipt records a restoration, the authenticated diagnostics boot projection shows readiness with an empty blocking set, and the runtime-target read shows the NanoHost and deployment ready. The judge skips this predicate when no restoration is recorded. The records are the diagnostics boot projection and the runtime-target observation. `docs/specs/20260704-nanocore_bootstrap_readiness.md` owns that projection. `docs/specs/20260802-nanohost_runtime_and_transport.md` owns that observation.
- Channel outside-in, tier optional. When a failed helper receipt records a restoration, the public health response and the Web entry show that the restored deployment is serving. The judge skips this predicate when no restoration is recorded. `docs/specs/20260708-container_image_packaging.md` names the health observation. The Web entry is the public product surface.
- Channel inside-out, tier required. Carry-forward only: Workspace records that existed before the update remain readable through a public Workspace read. This predicate is inapplicable to a disclosed pre-stable reset. The public read and authentication comparison witness preservation of the Data Root and protected configuration. The record is the Workspace owned by `docs/specs/20260715-multi_user_workspace_system.md`.
- Channel inside-out, tier required. Carry-forward only: the retained-authentication metadata projection matches across replacement, except the last-used fields. This predicate is inapplicable to a disclosed pre-stable reset. The comparison and Workspace read witness preservation of the Data Root and protected configuration. The record is the retained-authentication projection owned by `docs/specs/20260910-app_update_delivery.md`.
- Channel outside-in, tier required. Disclosed pre-stable reset only: the target's published release notes state that it cannot read the predecessor's retained data and identify the reset disposition. This predicate is inapplicable to carry-forward. The observation is the published release disclosure through the release's public interface, owned by `docs/specs/20260829-release_management.md`.
- Channel outside-in, tier required. The accounts the engineer designates for this deployment can sign in through the public product interface after the chosen transition. The observation is each authorized account's successful public sign-in response, with secrets and personal account data excluded from evidence. `docs/specs/20260704-remote_auth_credential_bootstrap.md` and `docs/specs/20260715-multi_user_workspace_system.md` own authentication and identity; `docs/specs/20260829-release_management.md` owns the protected-account invariant.
- Channel inside-out, tier required. Disclosed pre-stable reset only: a new attempt-specific Workspace-native Markdown or plain-text Material note exists and a public Material read returns its exact authored content. This predicate is inapplicable to carry-forward. The record is the Material and its revision, owned by `docs/specs/20260713-work_resource_interaction_model.md`, in an authorized Workspace owned by `docs/specs/20260715-multi_user_workspace_system.md`. No Provider or Worker is required for this new-work observation.
- Channel outside-in, tier required. The public health response and Web entry show that the target deployment is serving. `docs/specs/20260708-container_image_packaging.md` owns the health observation. The Web entry is the public product surface.
- Channel inside-out, tier required. The authenticated diagnostics boot projection shows readiness with an empty blocking set before any Worker is admitted. The record is the diagnostics boot projection owned by `docs/specs/20260704-nanocore_bootstrap_readiness.md`.
- Channel inside-out, tier required. The runtime-target read shows the exact currently configured NanoHost and deployment ready. Carry-forward preserves the identity pair on the successor connection. A reset validates the current authorized binding and infers no predecessor continuity. The record is the runtime-target observation owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`.

## Perturbations

None.

## Integrity Invariants

The declared disposition cannot change during the run. Missing evidence for an applicable required predicate is inconclusive and cannot pass. An inapplicable carry-forward predicate proves no continuity or rollback for a reset. Operator setup evidence is not a product outcome observation.

## Evidence To Collect

Collect public health, Web entry, account sign-in responses, authenticated diagnostics, and runtime-target observations for both paths. For carry-forward, also collect the public helper receipt with previous/candidate image identities, predecessor and successor Workspace reads, and retained-authentication comparison. For a reset, collect the target's public release disclosure and new Material/revision reads with exact authored content. Collect diagnostics before Worker admission. Keep the unchanged conditional failed-update rollback observations when witnessed. Retain setup attribution separately; no private operator report determines an L6 product predicate. Evidence contains no personal account data or secrets.

## Cleanup

The stage manager removes only attempt-owned disposable evidence and the attempt's new work fixture through its public owner. It preserves the current Data Root, protected configuration, designated accounts, and unrelated retained work. Cleanup authorizes no reset.

## Failure Triage Notes

- A product failure means an applicable receipt claims success without the published digest, a required carry-forward read or authentication comparison shows loss, designated-account sign-in fails because of the product, new reset-path work cannot be saved or read, diagnostics has a blocking condition, or runtime readiness fails.
- An environment failure means the predecessor deployment or target publication is missing, reset setup is not authorized or complete, the public disclosure needed for that reset is unavailable, or the host refuses the update for capacity before a product result exists.
- A tool failure means the administrator client or evidence collector fails on its own.
- An inconclusive result means required applicable public evidence is missing, contradictory, or cannot establish the observed result.
- The likely lower layer is the App-update host-domain test or the owning authentication, Material, diagnostics, or runtime read contract. This story proves neither a host reset procedure nor a first install or cold start.
